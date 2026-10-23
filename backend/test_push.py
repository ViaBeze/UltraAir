"""Notification ownership, outbox durability, retries and actual Web Push encryption."""
import json
import secrets
import time
from unittest.mock import Mock

import http_ece
import pytest
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from backend import push
from backend import db as database
from backend.auth import DEVICE_COOKIE
from backend.test_app import clients, create_pair, register, snapshot, PASSWORD


def subscription(endpoint=None):
    key = ec.generate_private_key(ec.SECP256R1())
    auth = secrets.token_bytes(16)
    return {'endpoint': endpoint or 'https://fcm.googleapis.com/fcm/send/' + secrets.token_urlsafe(32),
            'keys': {'p256dh': push.b64(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
                     'auth': push.b64(auth)}}, key, auth


def rows():
    with database.transaction() as db:
        return [dict(r) for r in db.execute('SELECT * FROM push_jobs ORDER BY urgent DESC')]


def message(pat, patient):
    return pat.post('/api/messages', json={'id': database.uid(), 'patientId': patient['id'], 'text': 'ПРИВАТНЫЙ ТЕКСТ СООБЩЕНИЯ'})


def test_permissions_devices_and_endpoint_validation(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    assert other.get('/api/push').status_code == 401
    sub, _, _ = subscription()
    for endpoint in ['http://fcm.googleapis.com/push/1', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x',
                     'https://fcm.googleapis.com@localhost/x', 'https://fcm.googleapis.com:8443/x',
                     'https://fcm.googleapis.com/x#secret', 'https://evil.test/push']:
        assert doc.post('/api/push/subscription', json={**sub, 'endpoint': endpoint}).status_code == 422
    assert doc.post('/api/push/subscription', json={**sub, 'keys': {**sub['keys'], 'auth': 'bad'}}).status_code == 422
    assert doc.post('/api/push/subscription', json=sub).status_code == 200
    assert doc.cookies.get(DEVICE_COOKIE)
    first_key = doc.get('/api/push').json()['publicKey']
    push.init_keys()
    assert first_key == push.public_key()  # Restarts retain subscriptions' signing key.
    assert (database.DATA/'vapid.pem').stat().st_mode & 0o777 == 0o600
    register(other, 'other')
    assert other.post('/api/push/subscription', json=sub).status_code == 409
    assert other.delete('/api/push/subscription').status_code == 200
    assert doc.get('/api/push').json()['enabled'] is True
    assert pat.get('/api/push').json()['enabled'] is False
    assert message(pat, p).status_code == 200
    assert len(rows()) == 1
    assert doc.post('/api/auth/logout').status_code == 200
    assert rows() == []  # Logout revokes the device and its queued deliveries atomically.
    with database.transaction() as db:
        assert db.execute('SELECT count(*) FROM push_subscriptions').fetchone()[0] == 0


def test_sos_priority_preferences_and_no_historical_replay(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    message(pat, p)
    sub, _, _ = subscription()
    doc.post('/api/push/subscription', json=sub)
    assert rows() == []  # Enabling never replays old clinical events.
    doc.put('/api/push/preferences', json={'regular': False, 'urgent': True})
    message(pat, p)
    assert rows() == []
    sos = pat.post('/api/sos').json()
    pat.post('/api/sos')
    assert len(rows()) == 1 and rows()[0]['urgent'] == 1  # Repeat drag is idempotent.
    assert pat.post('/api/messages', json={'id': database.uid(), 'patientId': p['id'], 'sosId': sos['id'], 'text': 'SOS PRIVATE'}).status_code == 200
    assert len(rows()) == 2 and all(row['urgent'] for row in rows())
    doc.put('/api/push/preferences', json={'regular': True, 'urgent': False})
    assert all(row['status'] == 'cancelled' for row in rows())
    doc.post('/api/push/test')  # The explicit test works even with SOS disabled.
    assert len([row for row in rows() if row['status'] == 'pending']) == 1
    doc.post('/api/auth/password', json={'current': PASSWORD, 'password': PASSWORD + 'changed'})
    assert doc.get('/api/push').json()['enabled'] is False
    assert rows() == []


def test_encrypted_delivery_and_retry(clients, monkeypatch):
    monkeypatch.setenv('RYADOM_VAPID_SUBJECT', 'https://ryadomhelp.online')
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    sub, key, auth = subscription()
    doc.post('/api/push/subscription', json=sub)
    message(pat, p)
    seen = []

    def receive(self, url, **kwargs):
        assert url == sub['endpoint']
        encrypted = kwargs['data']
        assert b'PRIVATE' not in encrypted
        payload = json.loads(http_ece.decrypt(encrypted, private_key=key, auth_secret=auth, version='aes128gcm'))
        assert 'ПРИВАТНЫЙ' not in json.dumps(payload, ensure_ascii=False)
        assert 'Пациент Тест' not in json.dumps(payload, ensure_ascii=False)
        assert payload['link'] == '/doctor/messages?patient=' + p['id']
        assert kwargs['headers']['Urgency'] == 'normal'
        assert kwargs['headers']['Authorization'].lower().startswith('vapid ')
        assert int(kwargs['headers']['TTL']) > 0
        seen.append(payload)
        response = requests.Response(); response.status_code = 201; response._content = b''
        return response

    monkeypatch.setattr(push.NoRedirectSession, 'post', receive)
    push.push_tick()
    assert len(seen) == 1 and rows()[0]['status'] == 'sent'
    push.push_tick()
    assert len(seen) == 1
    doc.post('/api/push/test')
    response = requests.Response(); response.status_code = 503; response._content = b''; response.headers['Retry-After'] = '30'
    monkeypatch.setattr(push, 'webpush', Mock(side_effect=push.WebPushException('redacted', response=response)))
    push.push_tick()
    retry = next(row for row in rows() if row['status'] == 'pending')
    assert retry['attempts'] == 1 and retry['due'] >= time.time() + 28
    assert doc.get('/api/push').json()['lastTest']['status'] == 'pending'
    with database.transaction() as db:
        db.execute('UPDATE push_jobs SET due=? WHERE id=?', (time.time()-1, retry['id']))
    response.status_code = 410
    push.push_tick()
    assert doc.get('/api/push').json()['enabled'] is False
    assert rows() == []


def test_shared_browser_revokes_old_account_and_lease_recovery(clients, monkeypatch):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    sub, _, _ = subscription()
    doc.post('/api/push/subscription', json=sub)
    message(pat, p)
    with database.transaction() as db:
        db.execute("UPDATE push_jobs SET status='sending', due=?", (time.time()-1,))
    response = requests.Response(); response.status_code = 201
    sender = Mock(return_value=response)
    monkeypatch.setattr(push, 'webpush', sender)
    push.push_tick()  # A worker killed during dispatch leaves a recoverable lease.
    assert sender.call_count == 1 and rows()[0]['status'] == 'sent'
    register(other, 'stranger')
    assert doc.post('/api/auth/login', json={'login': 'doctor.stranger', 'password': PASSWORD}).status_code == 200
    assert doc.get('/api/push').json()['enabled'] is False
    assert rows() == []


def test_redirects_are_never_followed(monkeypatch):
    recorded = {}
    def request(self, method, url, **kwargs):
        recorded.update(kwargs)
    monkeypatch.setattr(requests.Session, 'request', request)
    with push.NoRedirectSession() as session:
        session.post('https://fcm.googleapis.com/push/123', data=b'encrypted', timeout=10)
        assert recorded['allow_redirects'] is False
        with pytest.raises(ValueError):
            session.post('https://127.0.0.1/private', data=b'encrypted')


def test_logout_keeps_other_phone_connected(clients):
    doc, pat, phone = clients
    p, _, _ = create_pair(doc, pat)
    assert phone.post('/api/auth/login', json={'login': 'doctor.one', 'password': PASSWORD}).status_code == 200
    doc.post('/api/push/subscription', json=subscription()[0])
    phone.post('/api/push/subscription', json=subscription()[0])
    pat.post('/api/sos')
    assert len(rows()) == 2
    doc.post('/api/auth/logout')
    assert len(rows()) == 1
    assert phone.get('/api/push').json()['enabled'] is True
