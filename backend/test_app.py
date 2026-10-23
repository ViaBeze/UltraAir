"""Boundary tests: authentication, ownership, publication and durable delivery."""
import importlib
import json
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient

os.environ['RYADOM_TESTING'] = '1'
from backend import db as database
service = importlib.import_module('backend.app')
HEADERS = {'X-Ryadom': '1', 'Origin': 'http://127.0.0.1:4173'}
PASSWORD = 'Test-only-password-123!'


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(database, 'DATA', tmp_path)
    monkeypatch.setattr(service, 'DATA', tmp_path)
    with TestClient(service.app, headers=HEADERS) as primary:
        secondary = TestClient(service.app, headers=HEADERS)
        stranger = TestClient(service.app, headers=HEADERS)
        yield primary, secondary, stranger
        secondary.close()
        stranger.close()


def register(client, suffix='one'):
    r = client.post('/api/auth/register', json={'login': 'doctor.' + suffix, 'name': 'Доктор Тест', 'password': PASSWORD, 'consent': True})
    assert r.status_code == 200, r.text
    return r.json()


def create_pair(doc, pat):
    register(doc)
    r = doc.post('/api/patients', json={'name':'Пациент Тест', 'birth':'1992-04-12','note':'СЕКРЕТНАЯ ЗАМЕТКА', 'consent': True})
    assert r.status_code == 200, r.text
    patient = r.json()
    token = patient['inviteUrl'].split('#')[1]
    r = pat.post('/api/auth/activate', json={'token':token, 'password':PASSWORD,'consent':True})
    assert r.status_code == 200, r.text
    return patient, token, r.json()


def snapshot(client):
    r = client.get('/api/state')
    assert r.status_code == 200, r.text
    return r.json()


def test_auth_invite_recovery_and_session_revocation(clients):
    doc, pat, anonymous = clients
    patient, token, activated = create_pair(doc, pat)
    assert anonymous.get('/api/state').status_code == 401
    assert anonymous.post('/api/auth/activate', json={'token':token,'password':PASSWORD,'consent':True}).status_code == 400
    assert anonymous.post('/api/auth/login', json={'login':patient['login'],'password':'wrong'}).status_code == 401
    login_response = anonymous.post('/api/auth/login', json={'login':patient['login'],'password':PASSWORD})
    assert login_response.status_code == 200
    assert 'HttpOnly' in login_response.headers['set-cookie']
    assert 'SameSite=strict' in login_response.headers['set-cookie']
    new_password = 'New-test-password-123!'
    r = pat.post('/api/auth/password', json={'current':PASSWORD,'password':new_password})
    assert r.status_code == 200
    assert anonymous.get('/api/state').status_code == 401
    assert pat.get('/api/state').status_code == 200
    assert anonymous.post('/api/auth/recover', json={'login':patient['login'],'code':activated['recoveryCode'],'password':PASSWORD}).status_code == 400
    assert anonymous.post('/api/auth/recover', json={'login':patient['login'],'code':r.json()['recoveryCode'],'password':PASSWORD}).status_code == 200
    assert pat.get('/api/state').status_code == 401
    anonymous.post('/api/auth/logout')
    assert anonymous.get('/api/state').status_code == 401
    with database.transaction() as db:
        hashes = [r[0] for r in db.execute('SELECT password FROM users')]
        assert all(h.startswith('$argon2id$') for h in hashes)
        assert db.execute('SELECT COUNT(*) FROM audit').fetchone()[0] >= 4


def test_ownership_private_notes_and_patient_role(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    register(other, 'other')
    assert snapshot(other)['patients'] == []
    profile = {'version':1,'name':'Обновлённое имя','birth':'1992-04-12','phone':'+7 000 000 00 00'}
    assert other.put(f"/api/patients/{p['id']}/profile",json=profile).status_code == 404
    assert doc.put(f"/api/patients/{p['id']}/profile",json=profile).status_code == 200
    assert snapshot(pat)['user']['name'] == 'Обновлённое имя'
    assert 'СЕКРЕТНАЯ ЗАМЕТКА' not in json.dumps(snapshot(pat), ensure_ascii=False)
    assert other.post(f"/api/patients/{p['id']}/invite").status_code == 404
    assert other.get('/api/messages', params={'patientId':p['id']}).status_code == 404
    assert other.post('/api/messages', json={'id':str(uuid4()),'patientId':p['id'],'text':'unauthorized'}).status_code == 404
    assert pat.post('/api/patients',json={'name':'Другой','birth':'2000-01-01','consent':True}).status_code == 403
    assert pat.put(f"/api/patients/{p['id']}/clinical",json={'version':1,'diagnosis':'forged'}).status_code == 403
    second = doc.post('/api/patients',json={'name':'Второй пациент','birth':'2000-01-01','consent':True}).json()
    assert pat.get('/api/messages',params={'patientId':second['id']}).status_code == 404
    assert pat.post('/api/messages',json={'id':str(uuid4()),'patientId':second['id'],'text':'forged'}).status_code == 404


def test_diary_plan_publication_marks_and_conflict(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc,pat)
    day = datetime.now(timezone.utc).date().isoformat()
    entry = {'date':day,'score':8,'sleep':7.5,'energy':6,'comment':'Реальная запись','tags':['Спокойнее']}
    assert pat.put('/api/diary',json=entry).status_code == 200
    assert snapshot(doc)['entries'][0]['comment'] == 'Реальная запись'
    assert pat.put('/api/diary',json={**entry,'score':9}).status_code == 200
    assert len(snapshot(doc)['entries']) == 1
    assert pat.put('/api/diary',json={**entry,'score':80}).status_code == 422
    v = doc.post('/api/visits',json={'patientId':p['id'],'scheduled':datetime.now(timezone.utc).isoformat()}).json()['id']
    prescription = {'name':'Тестовое назначение','dose':'По плану врача','times':['09:00'],'start':day,'end':None,'instructions':'Тест'}
    draft = {'version':1,'notes':'PRIVATE NOTE','observation':'PRIVATE OBSERVATION','plan':'Опубликованный план','diagnosis':'Наблюдение','prescriptions':[prescription]}
    assert doc.put(f'/api/visits/{v}',json=draft).status_code == 200
    exposed = json.dumps(snapshot(pat), ensure_ascii=False)
    assert 'PRIVATE NOTE' not in exposed and 'Опубликованный план' not in exposed
    assert doc.put(f'/api/visits/{v}',json={**draft,'confirm':True}).status_code == 409
    assert doc.put(f'/api/visits/{v}',json={**draft,'version':2,'confirm':True}).status_code == 200
    state = snapshot(pat)
    assert state['visits'][0]['plan'] == 'Опубликованный план'
    assert snapshot(doc)['patients'][0]['treatment'] == 'Опубликованный план'
    assert 'notes' not in state['visits'][0] and 'observation' not in state['visits'][0]
    prescription_id = state['prescriptions'][0]['id']
    assert pat.put(f'/api/prescriptions/{prescription_id}/mark',json={'date':day,'time':'09:00','status':'taken'}).status_code == 200
    assert snapshot(doc)['marks'][0]['status'] == 'taken'
    assert pat.put(f'/api/prescriptions/{prescription_id}/mark',json={'date':day,'time':'03:00','status':'taken'}).status_code == 422
    assert doc.put(f'/api/visits/{v}',json={**draft,'version':3}).status_code == 409
    assert doc.put(f"/api/patients/{p['id']}/clinical",json={'version':2,'note':'private','diagnosis':'обновлён'}).status_code == 200
    assert doc.put(f"/api/patients/{p['id']}/clinical",json={'version':2,'diagnosis':'устарел'}).status_code == 409


def test_message_delivery_idempotency_and_sos(clients):
    doc,pat,other = clients
    p,_,_ = create_pair(doc,pat)
    body = {'id':str(uuid4()),'patientId':p['id'],'text':'Вопрос врачу'}
    assert pat.post('/api/messages',json=body).status_code == 200
    assert pat.post('/api/messages',json=body).status_code == 200
    assert len(snapshot(doc)['messages']) == 1
    assert snapshot(pat)['messages'][0]['readAt'] is None
    assert doc.post('/api/messages/read',json={'ids':[body['id']]}).status_code == 200
    assert snapshot(pat)['messages'][0]['readAt'] is not None
    assert pat.post('/api/messages',json={**body,'text':'different'}).status_code == 409
    sos = pat.post('/api/sos').json()['id']
    assert pat.post('/api/sos').json()['id'] == sos
    assert snapshot(doc)['sosEvents'][0]['status'] == 'sent'
    assert snapshot(pat)['sosEvents'][0]['delivered'] is None
    assert pat.put(f'/api/sos/{sos}',json={'severity':8,'danger':'unsure','detail':'Нужна помощь'}).status_code == 200
    assert doc.post(f'/api/sos/{sos}/read').status_code == 200
    assert snapshot(pat)['sosEvents'][0]['status'] == 'delivered'
    assert doc.post('/api/messages',json={'id':str(uuid4()),'patientId':p['id'],'sosId':sos,'text':'Ответ врача'}).status_code == 200
    assert snapshot(pat)['sosEvents'][0]['status'] == 'answered'
    assert doc.post(f'/api/sos/{sos}/close').status_code == 200
    assert pat.post('/api/messages',json={**body,'id':str(uuid4()),'sosId':sos}).status_code == 409
    assert pat.post('/api/sos').json()['id'] != sos


def test_audio_permissions_csrf_validation_and_reminders(clients):
    doc,pat,other = clients
    p,_,_ = create_pair(doc,pat)
    register(other, 'foreign')
    wav = b'RIFF' + b'\x00'*4 + b'WAVE' + b'\x00'*40
    r = pat.post('/api/media',data={'patientId':p['id'],'purpose':'message','consent':'true'},files={'audio':('a.wav',wav,'audio/wav')})
    assert r.status_code == 200, r.text
    media_id = r.json()['id']
    assert doc.get(f'/api/media/{media_id}').status_code == 404
    assert pat.post('/api/messages',json={'id':str(uuid4()),'patientId':p['id'],'mediaId':media_id}).status_code == 200
    assert doc.get(f'/api/media/{media_id}').content == wav
    assert other.get(f'/api/media/{media_id}').status_code == 404
    assert doc.get(f'/api/media/{media_id}').headers['cache-control'] == 'no-store'
    assert pat.post('/api/media',data={'patientId':p['id'],'purpose':'message','consent':'true'},files={'audio':('evil.webm',b'<script>bad</script>','audio/webm')}).status_code == 415
    assert pat.post('/api/sos',headers={'Origin':'https://evil.example'}).status_code == 403
    assert pat.post('/api/sos',headers={'X-Ryadom':''}).status_code == 403
    assert pat.put('/api/settings',json={'diary':'00:00','timezone':'UTC','enabled':True}).status_code == 200
    service.reminder_tick()
    first = len(snapshot(pat)['notifications'])
    service.reminder_tick()
    assert len(snapshot(pat)['notifications']) == first
    assert any(n['title'] == 'Время отметить самочувствие' for n in snapshot(pat)['notifications'])
    with database.transaction() as db:
        backup = sqlite3.connect(database.DATA/'backup.sqlite3')
        db.backup(backup)
        assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert backup.execute('SELECT count(*) FROM users').fetchone()[0] == 3
        backup.close()
