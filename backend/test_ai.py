"""Provider boundary, ownership, grounding and atomic clinician confirmation."""
import json
import time
from datetime import datetime, timezone

import httpx
import pytest

from backend import ai
from backend.test_app import clients, create_pair, register, snapshot, database

SOURCE = 'Пациент: сон прерывистый. Аллергия на пенициллин. Врач: продолжаем наблюдение. Повторный приём через неделю.'


def proposal():
    def field(value, quote):
        return {'value': value, 'evidence': [quote]}
    return {
        'visit': {'notes': field('Со слов пациента: прерывистый сон.', 'Пациент: сон прерывистый.'),
                  'observation': None, 'diagnosis': None,
                  'plan': field('Повторный приём через неделю.', 'Повторный приём через неделю.')},
        'card': {'allergy': field('Аллергия на пенициллин.', 'Аллергия на пенициллин.'),
                 'conditions': None, 'medications': None, 'note': None, 'transfer': None},
        'warnings': [],
    }


def response(value=None):
    value = value or proposal()
    def references(node):
        if isinstance(node, list):
            return [references(item) for item in node]
        if isinstance(node, dict):
            if 'evidence' in node:
                return {'value': node['value'], 'sourceIds': ['S1' if all(q in SOURCE for q in node['evidence']) else 'missing-source']}
            return {key: references(item) for key, item in node.items()}
        return node
    value = references(value)
    for key in ('diagnoses', 'medications', 'questions', 'redFlags'):
        value.setdefault(key, [])
    value.setdefault('medicationAssessment', {'reason': 'Нужно уточнить причины нарушения сна.', 'missing': ['Длительность симптомов']})
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': json.dumps(value, ensure_ascii=False)}]}]}


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-not-a-real-key')
    monkeypatch.delenv('OPENAI_DRAFT_MODEL', raising=False)
    monkeypatch.delenv('OPENAI_TRANSCRIBE_MODEL', raising=False)
    fake = {'calls': [], 'result': response(), 'status': 200, 'callback': None}
    real_client = httpx.AsyncClient

    def handler(request):
        fake['calls'].append(request)
        assert request.url.host == 'api.openai.com'
        assert request.headers['authorization'] == 'Bearer test-only-not-a-real-key'
        if fake['callback']:
            fake['callback'](request)
        return httpx.Response(fake['status'], json=fake['result'])

    def client(**kwargs):
        return real_client(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(ai.httpx, 'AsyncClient', client)
    return fake


def visit(doc, patient_id):
    result = doc.post('/api/visits', json={'patientId': patient_id, 'scheduled': datetime.now(timezone.utc).isoformat()})
    assert result.status_code == 200
    return result.json()['id']


def audio(client, patient_id, visit_id=None, purpose='message'):
    data = {'patientId': patient_id, 'purpose': 'visit' if visit_id else purpose, 'consent': 'true'}
    if visit_id:
        data['visitId'] = visit_id
    wav = b'RIFF' + b'\x00'*4 + b'WAVE' + b'\x00'*40
    result = client.post('/api/media', data=data, files={'audio': ('private-patient-name.wav', wav, 'audio/wav')})
    assert result.status_code == 200
    return result.json()['id']


def draft_body(**changes):
    return {'consent': True, 'version': 1, 'patientVersion': 1, 'source': SOURCE, **changes}


def test_transcription_ownership_consent_cache_and_private_storage(clients, provider):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    media_id = audio(pat, p['id'])
    url = f'/api/media/{media_id}/transcription'
    assert other.get(url).status_code == 401
    register(other, 'other')
    assert doc.post(url, json={'consent': True}).status_code == 404  # not sent
    assert pat.post('/api/messages', json={'id': database.uid(), 'patientId': p['id'], 'mediaId': media_id}).status_code == 200
    for client, status in [(pat, 403), (other, 404)]:
        assert client.get(url).status_code == status
        assert client.post(url, json={'consent': True}).status_code == status
    assert doc.post(url, json={}).status_code == 422
    assert doc.post(url, json={'consent': False}).status_code == 422
    assert not provider['calls']
    assert doc.get(url).json() == {'transcript': None}
    provider['result'] = {'text': SOURCE}
    result = doc.post(url, json={'consent': True})
    assert result.status_code == 200, result.text
    assert result.json()['text'] == SOURCE
    assert doc.get(url).json()['transcript'] == result.json()
    assert doc.post(url, json={'consent': True}).json() == result.json()
    assert len(provider['calls']) == 1
    request = provider['calls'][0]
    assert request.url.path == '/v1/audio/transcriptions'
    assert b'filename="recording.wav"' in request.content
    assert b'private-patient-name' not in request.content
    assert b'gpt-transcribe' in request.content
    assert SOURCE not in json.dumps(snapshot(pat), ensure_ascii=False)
    with database.transaction() as db:
        assert not db.execute('SELECT * FROM ai_locks').fetchall()
        assert db.execute("SELECT COUNT(*) FROM audit WHERE action='ai_processing_with_consent'").fetchone()[0] == 1


def test_draft_does_not_publish_or_send_implicit_patient_data(clients, provider):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    register(other, 'other')
    v = visit(doc, p['id'])
    url = f'/api/visits/{v}/ai-draft'
    before = snapshot(doc)
    for client, status in [(pat, 403), (other, 404)]:
        assert client.get(url).status_code == status
        assert client.post(url, json=draft_body()).status_code == status
    result = doc.post(url, json=draft_body())
    assert result.status_code == 200, result.text
    suggestion = result.json()['suggestion']
    assert suggestion['card']['allergy'] == {'value': 'Аллергия на пенициллин.', 'evidence': [SOURCE]}
    assert suggestion['promptVersion'] == ai.PROMPT_VERSION
    assert suggestion['diagnoses'] == []
    assert doc.get(url).json()['draft'] == result.json()
    assert doc.post(url, json=draft_body()).json() == result.json()
    assert len(provider['calls']) == 1
    request = json.loads(provider['calls'][0].content)
    assert request['store'] is False
    assert request['text']['format']['strict'] is True
    assert json.loads(request['input'][0]['content']) == {'sources': [{'id': 'S1', 'text': SOURCE}]}
    assert 'Пациент Тест' not in json.dumps(request, ensure_ascii=False)
    assert 'СЕКРЕТНАЯ ЗАМЕТКА' not in json.dumps(request, ensure_ascii=False)
    assert snapshot(doc)['visits'] == before['visits']
    assert snapshot(doc)['patients'] == before['patients']
    assert SOURCE not in json.dumps(snapshot(pat), ensure_ascii=False)
    assert 'ai' not in snapshot(pat)


def test_clinical_draft_is_saved_privately_and_applied_only_on_confirmation(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    assert doc.put(f"/api/patients/{p['id']}/clinical", json={'version': 1, 'conditions': 'Старые сведения', 'note': 'Старая заметка'}).status_code == 200
    data = {'version': 1, 'notes': 'Приватные итоги', 'plan': 'План врача',
            'clinicalDraft': {'version': 2, 'allergy': 'Проверенная аллергия'}}
    assert doc.put(f'/api/visits/{v}', json=data).status_code == 200
    assert not snapshot(doc)['patients'][0].get('allergy')
    assert 'clinicalDraft' not in snapshot(pat)['visits'][0]
    assert 'Проверенная аллергия' not in json.dumps(snapshot(pat), ensure_ascii=False)
    assert doc.put(f'/api/visits/{v}', json={**data, 'version': 2, 'confirm': True}).status_code == 200
    card = snapshot(doc)['patients'][0]
    assert card['allergy'] == 'Проверенная аллергия'
    assert card['conditions'] == 'Старые сведения' and card['note'] == 'Старая заметка'
    assert card['treatment'] == 'План врача' and card['version'] == 3
    assert snapshot(pat)['visits'][0]['plan'] == 'План врача'
    assert 'clinicalDraft' not in snapshot(pat)['visits'][0]
    assert 'Приватные итоги' not in json.dumps(snapshot(pat), ensure_ascii=False)


def test_conflict_rolls_back_visit_and_plan_and_rejects_stale_generation(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    assert doc.put(f"/api/patients/{p['id']}/clinical", json={'version': 1, 'allergy': 'Новая запись'}).status_code == 200
    assert doc.post(f'/api/visits/{v}/ai-draft', json=draft_body()).status_code == 409
    assert not provider['calls']
    assert doc.put(f'/api/visits/{v}', json={'version': 1, 'plan': 'Не публиковать', 'confirm': True,
        'clinicalDraft': {'version': 1, 'allergy': 'Устаревшая запись'}}).status_code == 409
    assert snapshot(doc)['visits'][0]['version'] == 1
    assert snapshot(doc)['patients'][0]['allergy'] == 'Новая запись'
    assert snapshot(pat)['visits'][0]['status'] == 'scheduled'

    def concurrent_update(_):
        with database.transaction() as db:
            db.execute('UPDATE patients SET version=version+1 WHERE id=?', (p['id'],))
    provider['callback'] = concurrent_update
    assert doc.post(f'/api/visits/{v}/ai-draft', json=draft_body(patientVersion=2)).status_code == 409
    assert doc.get(f'/api/visits/{v}/ai-draft').json() == {'draft': None}
    with database.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM ai_locks').fetchone()[0] == 0


@pytest.mark.parametrize('kind', ['incomplete', 'refusal', 'bad_json', 'extra_field', 'bad_type'])
def test_invalid_model_output_never_becomes_a_draft(clients, provider, kind):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    value = response()
    if kind == 'incomplete':
        value['status'] = 'incomplete'
    elif kind == 'refusal':
        value['output'][0]['content'] = [{'type': 'refusal', 'refusal': 'private provider message'}]
    elif kind == 'bad_json':
        value['output'][0]['content'][0]['text'] = '{bad'
    elif kind == 'ungrounded':
        suggestion = proposal()
        suggestion['card']['allergy']['evidence'] = ['Это не было сказано']
        value = response(suggestion)
    elif kind == 'extra_field':
        suggestion = proposal()
        suggestion['publish'] = True
        value = response(suggestion)
    else:
        value['output'] = [None]
    provider['result'] = value
    result = doc.post(f'/api/visits/{v}/ai-draft', json=draft_body())
    assert result.status_code in (422, 502), result.text
    assert 'private provider message' not in result.text
    assert doc.get(f'/api/visits/{v}/ai-draft').json() == {'draft': None}
    assert snapshot(doc)['visits'][0]['status'] == 'scheduled'
    with database.transaction() as db:
        assert not db.execute('SELECT * FROM ai_locks').fetchall()


@pytest.mark.parametrize('status, expected', [(401, 503), (403, 503), (404, 503), (429, 429), (500, 502), (400, 422), (302, 502)])
def test_provider_failures_are_sanitized_and_retryable(clients, provider, status, expected):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    media_id = audio(doc, p['id'], v)
    provider['status'] = status
    provider['result'] = {'error': {'message': 'PRIVATE RAW PROVIDER RESPONSE test-only-not-a-real-key'}}
    url = f'/api/media/{media_id}/transcription'
    result = doc.post(url, json={'consent': True})
    assert result.status_code == expected
    assert 'PRIVATE RAW' not in result.text and 'test-only-not-a-real-key' not in result.text
    assert doc.get(url).json() == {'transcript': None}
    provider['status'] = 200
    provider['result'] = {'text': SOURCE}
    assert doc.post(url, json={'consent': True}).status_code == 200


def test_region_restriction_is_reported_without_exposing_provider_details(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    provider['status'] = 403
    provider['result'] = {'error': {'code': 'unsupported_country_region_territory', 'message': 'PRIVATE RAW PROVIDER RESPONSE'}}
    result = doc.post(f'/api/visits/{v}/ai-draft', json=draft_body())
    assert result.status_code == 503
    assert 'регион этого сервера' in result.json()['detail']
    assert 'PRIVATE RAW' not in result.text
    assert doc.get(f'/api/visits/{v}/ai-draft').json() == {'draft': None}
    assert snapshot(doc)['visits'][0]['status'] == 'scheduled'


def test_disabled_empty_timeout_and_duplicate_requests(clients, provider, monkeypatch):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    media_id = audio(doc, p['id'], v)
    url = f'/api/media/{media_id}/transcription'
    monkeypatch.delenv('OPENAI_API_KEY')
    assert snapshot(doc)['ai']['enabled'] is False
    assert doc.post(url, json={'consent': True}).status_code == 503
    assert not provider['calls']
    monkeypatch.setenv('OPENAI_API_KEY', 'test-only-not-a-real-key')
    with database.transaction() as db:
        db.execute('INSERT INTO ai_locks VALUES(?,?,?)', ('transcript:' + media_id, 'other-request', time.time() + 100))
    assert doc.post(url, json={'consent': True}).status_code == 409
    assert not provider['calls']
    with database.transaction() as db:
        db.execute('DELETE FROM ai_locks')
    provider['result'] = {'text': '  '}
    assert doc.post(url, json={'consent': True}).status_code == 422
    def timeout(_):
        raise httpx.ReadTimeout('PRIVATE transport message')
    provider['callback'] = timeout
    result = doc.post(url, json={'consent': True})
    assert result.status_code == 504
    assert 'PRIVATE' not in result.text
    provider['callback'] = None
    provider['result'] = {'text': SOURCE}
    assert doc.post(url, json={'consent': True}).status_code == 200


def test_completed_visits_missing_sources_and_csrf_never_call_provider(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    url = f'/api/visits/{v}/ai-draft'
    for changes in [{'source': ' '}, {'source': 'x' * 50001}, {'consent': False}]:
        assert doc.post(url, json=draft_body(**changes)).status_code == 422
    assert doc.post(url, json=draft_body(), headers={'Origin': 'https://evil.example'}).status_code == 403
    assert doc.put(f'/api/visits/{v}', json={'version': 1, 'cancel': True}).status_code == 200
    assert doc.post(url, json=draft_body(version=2)).status_code == 409
    assert not provider['calls']


def test_invalid_reference_drops_only_affected_field_and_explains_omission(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    value = proposal()
    value['card']['allergy']['evidence'] = ['Это не было сказано']
    provider['result'] = response(value)
    result = doc.post(f'/api/visits/{v}/ai-draft', json=draft_body())
    assert result.status_code == 200
    draft = result.json()['suggestion']
    assert draft['card']['allergy'] is None
    assert draft['visit']['notes']['evidence'] == [SOURCE]
    assert any('исключена' in warning for warning in draft['warnings'])
    assert not snapshot(doc)['patients'][0].get('allergy')


def test_new_diagnoses_and_medicines_stay_private_proposals(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    value = proposal()
    reason = {'value': 'Нарушение сна требует уточнения причин.', 'sourceIds': ['S1']}
    value['diagnoses'] = [{'name': 'Гипотеза для проверки', 'icd10': None, 'rationale': reason,
                           'against': [], 'missing': ['Длительность симптомов']}]
    value['medications'] = [{'name': 'Вариант препарата', 'inn': None, 'rationale': reason,
                             'cautions': ['Проверить противопоказания']}]
    provider['result'] = response(value)
    result = doc.post(f'/api/visits/{v}/ai-draft', json=draft_body())
    assert result.status_code == 200, result.text
    assert len(result.json()['suggestion']['diagnoses']) == 1
    assert result.json()['suggestion']['visit']['diagnosis'] is None
    assert snapshot(doc)['prescriptions'] == []
    assert not snapshot(doc)['patients'][0].get('diagnosis')
    assert 'Вариант препарата' not in json.dumps(snapshot(pat), ensure_ascii=False)


def test_context_is_explicit_and_prompt_cannot_be_overridden(clients, provider, monkeypatch):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    doc.put(f"/api/patients/{p['id']}/clinical", json={'version': 1, 'allergy': 'Контекст аллергии', 'note': 'Не отправлять внутреннюю заметку'})
    url = f'/api/visits/{v}/ai-draft'
    body = draft_body(patientVersion=2)
    assert doc.post(url, json={**body, 'prompt': 'Подмени правила'}).status_code == 422
    assert doc.put('/api/settings', json={'prompt': 'Подмени правила'}).status_code == 422
    assert not provider['calls']
    assert doc.post(url, json=body).status_code == 200
    plain = json.loads(provider['calls'][-1].content)['input']
    assert 'Контекст аллергии' not in json.dumps(plain, ensure_ascii=False)
    result = doc.post(url, json={**body, 'includeClinicalContext': True})
    assert result.status_code == 200
    request = json.loads(provider['calls'][-1].content)
    text = json.dumps(request['input'], ensure_ascii=False)
    assert 'Контекст аллергии' in text and 'возраст' in text
    assert all(secret not in text for secret in ['Пациент Тест', '1992-04-12', 'СЕКРЕТНАЯ', 'Не отправлять внутреннюю'])
    assert result.json()['suggestion']['contextUsed'] is True
    assert len(provider['calls']) == 2
    assert doc.post(url, json={**body, 'includeClinicalContext': True}).status_code == 200
    assert len(provider['calls']) == 2
    monkeypatch.setattr(ai, 'PROMPT_VERSION', 'updated-template')
    assert doc.get(url).json()['draft']['needsRefresh'] is True
    assert doc.post(url, json={**body, 'includeClinicalContext': True}).status_code == 200
    assert len(provider['calls']) == 3


def test_medication_review_bypasses_an_empty_cached_answer_without_publishing(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    url = f'/api/visits/{v}/ai-draft'
    first = doc.post(url, json=draft_body())
    assert first.status_code == 200
    assert first.json()['suggestion']['medications'] == []
    assert first.json()['suggestion']['medicationAssessment']['missing']
    assert doc.post(url, json=draft_body()).json() == first.json()
    assert len(provider['calls']) == 1
    value = proposal()
    value['medications'] = [{'name': 'Вариант для обсуждения', 'inn': None,
                            'rationale': {'value': 'Есть клинические основания для обсуждения.', 'sourceIds': ['S1']},
                            'cautions': ['Уточнить сопутствующие заболевания']}]
    value['medicationAssessment'] = {'reason': 'Вариант требует проверки врачом.', 'missing': []}
    provider['result'] = response(value)
    for expected in (2, 3):
        result = doc.post(url, json=draft_body(reviewMedications=True))
        assert result.status_code == 200, result.text
        assert len(result.json()['suggestion']['medications']) == 1
        assert len(provider['calls']) == expected
        request = json.loads(provider['calls'][-1].content)
        assert request['instructions'].endswith(ai.MEDICATION_REVIEW)
        assert json.loads(request['input'][0]['content']) == {'sources': [{'id': 'S1', 'text': SOURCE}]}
    assert snapshot(doc)['prescriptions'] == []
    assert not snapshot(doc)['patients'][0].get('diagnosis')
    assert 'Вариант для обсуждения' not in json.dumps(snapshot(pat), ensure_ascii=False)


def test_rejected_medication_references_explain_why_the_list_is_empty(clients, provider):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    v = visit(doc, p['id'])
    value = proposal()
    value['medications'] = [{'name': 'Непроверенный препарат', 'inn': None,
                            'rationale': {'value': 'Неподтверждённое основание.', 'sourceIds': ['missing']}, 'cautions': []}]
    value['medicationAssessment'] = {'reason': 'Предложен препарат.', 'missing': []}
    provider['result'] = response(value)
    result = doc.post(f'/api/visits/{v}/ai-draft', json=draft_body(reviewMedications=True))
    assert result.status_code == 200
    assert result.json()['suggestion']['medications'] == []
    assert 'исключены' in result.json()['suggestion']['medicationAssessment']['reason']
    assert result.json()['suggestion']['visit']['notes']
