import json
from datetime import datetime, timezone

from backend.test_app import clients, create_pair, register, snapshot, database, service


def medication(**changes):
    return {'name': 'Тестовый препарат', 'dose': 'По назначению врача', 'times': ['09:00'],
            'start': datetime.now(timezone.utc).date().isoformat(), 'indication': 'Цель назначения',
            'sideEffects': 'Сведения из проверенной инструкции', 'interactions': 'Требует проверки', **changes}


def citation(**changes):
    return {'source': 'РЛС', 'title': 'Тестовая инструкция', 'section': 'Взаимодействия',
            'url': 'https://www.rlsnet.ru/drugs/test', 'quote': 'Тестовая цитата из документа.',
            'target': 'interactions', **changes}


def test_card_prescriptions_publish_without_visit_preserve_history_and_marks(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    register(other, 'other')
    path = f"/api/patients/{p['id']}/prescriptions"
    body = {'version': 1, 'prescriptions': [medication(citations=[citation()])]}
    assert pat.put(path, json=body).status_code == 403
    assert other.put(path, json=body).status_code == 404
    assert doc.put(path, json=body).status_code == 200
    first = snapshot(pat)
    original = first['prescriptions'][0]
    assert original['visitId'] is None and first['visits'] == []
    assert original['citations'] == [citation()]
    assert original['sideEffects'] == body['prescriptions'][0]['sideEffects']
    assert 'СЕКРЕТНАЯ ЗАМЕТКА' not in json.dumps(first, ensure_ascii=False)
    mark = {'date': original['start'], 'time': '09:00', 'status': 'taken'}
    assert pat.put(f"/api/prescriptions/{original['id']}/mark", json=mark).status_code == 200
    retained = {key: value for key, value in original.items() if key not in ('visitId', 'patientId', 'active')}
    assert doc.put(path, json={'version': 2, 'prescriptions': [retained, medication(name='Второй')]}).status_code == 200
    second = snapshot(pat)
    assert next(m for m in second['prescriptions'] if m['id'] == original['id'])['active']
    assert second['marks'][0]['prescriptionId'] == original['id']
    assert doc.put(path, json={'version': 3, 'prescriptions': [{**retained, 'dose': 'Уточнённая доза'}]}).status_code == 200
    third = snapshot(pat)
    assert len([m for m in third['prescriptions'] if m['active']]) == 1
    assert next(m for m in third['prescriptions'] if m['id'] == original['id'])['dose'] == original['dose']
    assert not next(m for m in third['prescriptions'] if m['id'] == original['id'])['active']
    assert third['marks'] == second['marks']
    assert pat.put(f"/api/prescriptions/{original['id']}/mark", json=mark).status_code == 404
    assert doc.put(path, json={'version': 2, 'prescriptions': []}).status_code == 409
    assert snapshot(pat)['prescriptions'] == third['prescriptions']
    assert doc.put(path, json={'version': 4, 'prescriptions': []}).status_code == 200
    assert not any(m['active'] for m in snapshot(pat)['prescriptions'])
    assert snapshot(pat)['marks'] == third['marks']


def test_ids_and_citation_urls_are_validated_and_private_citations_stay_private(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    path = f"/api/patients/{p['id']}/prescriptions"
    assert doc.put(path, json={'version': 1, 'prescriptions': [medication(id='some-other-patient-id')]}).status_code == 409
    for url in ['javascript:alert(1)', 'https://www.rlsnet.ru.evil.example/drugs/test',
                'https://www.rlsnet.ru@evil.example/drugs/test', 'http://www.rlsnet.ru/drugs/test']:
        assert doc.put(path, json={'version': 1, 'prescriptions': [medication(citations=[citation(url=url)])]}).status_code == 422
    clinical = f"/api/patients/{p['id']}/clinical"
    assert doc.put(clinical, json={'version': 1, 'diagnosis': 'Сохранить диагноз', 'note': 'Приватно'}).status_code == 200
    assert doc.put(clinical, json={'version': 2, 'citations': [citation()]}).status_code == 200
    card = snapshot(doc)['patients'][0]
    assert card['diagnosis'] == 'Сохранить диагноз' and card['note'] == 'Приватно'
    assert card['citations'] == [citation()]
    assert 'Тестовая цитата' not in json.dumps(snapshot(pat), ensure_ascii=False)
    assert doc.put(path, json={'version': 3, 'prescriptions': [medication()]}).status_code == 200
    med = snapshot(doc)['prescriptions'][0]
    duplicate = medication(id=med['id'])
    assert doc.put(path, json={'version': 4, 'prescriptions': [duplicate, duplicate]}).status_code == 409


def test_visit_snapshot_detects_card_changes_and_publishes_citations_atomically(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    path = f"/api/patients/{p['id']}/prescriptions"
    assert doc.put(path, json={'version': 1, 'prescriptions': [medication()]}).status_code == 200
    visit = doc.post('/api/visits', json={'patientId': p['id'], 'scheduled': datetime.now(timezone.utc).isoformat()}).json()
    v = snapshot(doc)['visits'][0]
    assert v['prescriptions'][0]['name'] == 'Тестовый препарат' and v['patientVersion'] == 2
    body = {'version': 1, 'patientVersion': 2, 'plan': 'План', 'prescriptions': [medication(citations=[citation()])], 'citations': [citation()]}
    assert doc.put(f"/api/visits/{visit['id']}", json=body).status_code == 200
    assert 'Тестовая цитата' not in json.dumps(snapshot(pat), ensure_ascii=False)
    assert doc.put(path, json={'version': 2, 'prescriptions': [medication(name='Новый препарат')]}).status_code == 200
    assert doc.put(f"/api/visits/{visit['id']}", json={**body, 'version': 2, 'confirm': True}).status_code == 409
    old_client_body = {key: value for key, value in body.items() if key != 'patientVersion'}
    assert doc.put(f"/api/visits/{visit['id']}", json={**old_client_body, 'version': 2, 'confirm': True}).status_code == 409
    assert snapshot(doc)['visits'][0]['status'] == 'draft'
    assert doc.put(f"/api/visits/{visit['id']}", json={**body, 'version': 2, 'patientVersion': 3, 'confirm': True}).status_code == 200
    after = snapshot(pat)
    assert after['visits'][0]['citations'] == [citation()]
    assert next(m for m in after['prescriptions'] if m['active'])['citations'] == [citation()]
    assert snapshot(doc)['patients'][0]['citations'] == [citation()]


def test_legacy_visit_requires_review_of_current_prescriptions(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    path = f"/api/patients/{p['id']}/prescriptions"
    assert doc.put(path, json={'version': 1, 'prescriptions': [medication()]}).status_code == 200
    visit = doc.post('/api/visits', json={'patientId': p['id'], 'scheduled': datetime.now(timezone.utc).isoformat()}).json()
    # Drafts saved before card prescribing had neither a snapshot nor its version.
    with database.transaction() as db:
        db.execute('UPDATE visits SET data=? WHERE id=?', (json.dumps({'title': 'Старый черновик'}), visit['id']))
    current = medication(name='Назначено из карточки')
    assert doc.put(path, json={'version': 2, 'prescriptions': [current]}).status_code == 200
    before = snapshot(pat)['prescriptions']
    body = {'version': 1, 'plan': 'План', 'prescriptions': [], 'confirm': True}
    assert doc.put(f"/api/visits/{visit['id']}", json=body).status_code == 409
    # Reviewing unrelated clinical fields must not authorize replacing medications.
    assert doc.put(f"/api/visits/{visit['id']}", json={**body, 'clinicalDraft': {'version': 3}}).status_code == 409
    assert snapshot(pat)['prescriptions'] == before
    assert snapshot(doc)['visits'][0]['status'] == 'scheduled'
    assert doc.put(f"/api/visits/{visit['id']}", json={**body, 'patientVersion': 3, 'prescriptions': [current]}).status_code == 200
    assert [m['name'] for m in snapshot(pat)['prescriptions'] if m['active']] == [current['name']]


def test_card_change_between_visit_check_and_commit_rolls_back_publication(clients, monkeypatch):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    assert doc.put(f"/api/patients/{p['id']}/prescriptions", json={'version': 1, 'prescriptions': [medication()]}).status_code == 200
    visit = doc.post('/api/visits', json={'patientId': p['id'], 'scheduled': datetime.now(timezone.utc).isoformat()}).json()
    before = snapshot(pat)['prescriptions']
    original = service.patient_row
    calls = 0

    def concurrent_card_edit(db, user, patient_id=None):
        nonlocal calls
        row = original(db, user, patient_id)
        calls += 1
        if calls == 2:  # Access checked; version read, but publication has not locked the database yet.
            clinical = {**json.loads(row['clinical']), 'note': 'Одновременная правка карточки'}
            with database.transaction() as other:
                other.execute('UPDATE patients SET version=version+1,clinical=? WHERE id=?', (json.dumps(clinical), p['id']))
        return row

    monkeypatch.setattr(service, 'patient_row', concurrent_card_edit)
    result = doc.put(f"/api/visits/{visit['id']}", json={'version': 1, 'patientVersion': 2, 'plan': 'Устаревший план', 'prescriptions': [], 'confirm': True})
    assert result.status_code == 409
    assert snapshot(pat)['prescriptions'] == before
    state = snapshot(doc)
    assert state['visits'][0]['version'] == 1 and state['visits'][0]['status'] == 'scheduled'
    assert state['patients'][0]['version'] == 3 and state['patients'][0]['note'] == 'Одновременная правка карточки'


def test_existing_database_migration_keeps_prescriptions_and_marks(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    visit = doc.post('/api/visits', json={'patientId': p['id'], 'scheduled': datetime.now(timezone.utc).isoformat()}).json()
    assert doc.put(f"/api/visits/{visit['id']}", json={'version': 1, 'plan': 'План', 'prescriptions': [medication()], 'confirm': True}).status_code == 200
    med = snapshot(pat)['prescriptions'][0]
    assert pat.put(f"/api/prescriptions/{med['id']}/mark", json={'date': med['start'], 'time': '09:00', 'status': 'taken'}).status_code == 200
    with database.transaction() as db:
        db.execute('PRAGMA foreign_keys=OFF')
        db.executescript('''CREATE TABLE old_prescriptions(
            id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
            visit_id TEXT NOT NULL REFERENCES visits(id), data TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
            INSERT INTO old_prescriptions SELECT * FROM prescriptions;
            DROP TABLE prescriptions;
            ALTER TABLE old_prescriptions RENAME TO prescriptions;
            DELETE FROM schema_version WHERE version=3;''')
    database.init_db()
    assert snapshot(pat)['prescriptions'][0] == med
    assert snapshot(pat)['marks'][0]['prescriptionId'] == med['id']
    with database.transaction() as db:
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert doc.put(f"/api/patients/{p['id']}/prescriptions", json={'version': 2, 'prescriptions': [medication(name='Из карточки')]}).status_code == 200
