"""Confirmed audio removal, ownership, durable cleanup, and SOS retention."""
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier

import pytest

from backend.test_app import clients, create_pair, register, snapshot, database, service


def upload(client, patient_id, purpose='message', **fields):
    wav = b'RIFF' + b'\0' * 4 + b'WAVE' + b'\0' * 40
    result = client.post('/api/media', data={'patientId': patient_id, 'purpose': purpose, 'consent': 'true', **fields},
                         files={'audio': ('recording.wav', wav, 'audio/wav')})
    assert result.status_code == 200, result.text
    return result.json()['id']


def remove(client, media_id, **kwargs):
    return client.request('DELETE', f'/api/media/{media_id}', json={'confirm': True}, **kwargs)


def test_confirmation_ownership_csrf_and_transcript_removal(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    media = upload(pat, p['id'])
    message = {'id': database.uid(), 'patientId': p['id'], 'text': 'Сохранить этот текст', 'mediaId': media}
    assert pat.post('/api/messages', json=message).status_code == 200
    with database.transaction() as db:
        db.execute('INSERT INTO ai_transcripts VALUES(?,?,?,?,?)', (media, 'Расшифровка', 'test', snapshot(doc)['user']['id'], database.now()))
    assert remove(other, media).status_code == 401
    register(other, 'unrelated')
    assert remove(other, media).status_code == 404
    assert remove(doc, media).status_code == 403
    assert pat.request('DELETE', f'/api/media/{media}', json={}).status_code == 422
    assert pat.request('DELETE', f'/api/media/{media}', json={'confirm': False}).status_code == 422
    assert remove(pat, media, headers={'Origin': 'https://evil.example'}).status_code == 403
    assert snapshot(pat)['messages'][0]['canDeleteAudio'] is True
    assert snapshot(doc)['messages'][0]['canDeleteAudio'] is False
    assert pat.get(f'/api/media/{media}').status_code == 200
    assert remove(pat, media).status_code == 200
    for client in [doc, pat]:
        assert client.get(f'/api/media/{media}').status_code == 404
        saved = snapshot(client)['messages'][0]
        assert saved['text'] == message['text'] and saved['mediaId'] is None
        assert saved['canDeleteAudio'] is False
    assert doc.get(f'/api/media/{media}/transcription').status_code == 404
    assert not (database.DATA / 'media' / media).exists()
    with database.transaction() as db:
        assert not db.execute('SELECT * FROM ai_transcripts WHERE media_id=?', (media,)).fetchone()
        assert not db.execute('SELECT * FROM pending_media_deletions').fetchall()
        assert db.execute("SELECT 1 FROM audit WHERE action='audio_deleted' AND entity=?", (media,)).fetchone()


def test_diary_removal_preserves_answers_and_rewards(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    media = upload(pat, p['id'], 'diary')
    day = datetime.now(timezone.utc).date().isoformat()
    body = {'date': day, 'score': 8, 'sleep': 7, 'energy': 6, 'comment': 'Оставить заметку', 'tags': ['Спокойнее'], 'mediaId': media}
    assert pat.put('/api/diary', json=body).status_code == 200
    growth = snapshot(pat)['patients'][0]['garden']['growth']
    assert remove(pat, media).status_code == 200
    for client in [doc, pat]:
        entry = snapshot(client)['entries'][0]
        assert not entry.get('mediaId')
        assert {k: entry[k] for k in body if k != 'mediaId'} == {k: v for k, v in body.items() if k != 'mediaId'}
    assert snapshot(pat)['patients'][0]['garden']['growth'] == growth
    assert pat.put('/api/diary', json=body).status_code == 404  # stale tab cannot restore deleted audio


def test_visit_audio_removal_keeps_confirmed_clinical_record(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    visit = doc.post('/api/visits', json={'patientId': p['id'], 'scheduled': datetime.now(timezone.utc).isoformat()}).json()['id']
    media = upload(doc, p['id'], 'visit', visitId=visit)
    assert doc.put(f'/api/visits/{visit}', json={'version': 1, 'notes': 'Заметки врача', 'plan': 'План врача', 'confirm': True}).status_code == 200
    before = snapshot(doc)
    assert doc.get(f'/api/visits/{visit}/media').json()[0]['canDelete'] is True
    assert remove(doc, media).status_code == 200
    assert doc.get(f'/api/visits/{visit}/media').json() == []
    assert snapshot(doc)['visits'] == before['visits']
    assert snapshot(doc)['patients'] == before['patients']
    assert snapshot(pat)['visits'][0]['plan'] == 'План врача'


@pytest.mark.parametrize('protected_on_upload', [False, True])
def test_sos_audio_cannot_be_deleted_before_or_after_closing(clients, protected_on_upload):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    sos = pat.post('/api/sos').json()['id']
    media = upload(pat, p['id'], **({'sosId': sos} if protected_on_upload else {}))
    body = {'id': database.uid(), 'patientId': p['id'], 'mediaId': media}
    if protected_on_upload:
        assert remove(pat, media).status_code == 403
        assert pat.post('/api/messages', json=body).status_code == 409
    else:
        # An older browser can first send the same attachment in ordinary chat.
        assert pat.post('/api/messages', json=body).status_code == 200
    assert pat.post('/api/messages', json={**body, 'id': database.uid(), 'sosId': sos}).status_code == 200
    if not protected_on_upload:
        # Recreate the pre-feature database state; startup must protect old SOS audio too.
        with database.transaction() as db:
            db.execute('DELETE FROM media_sos WHERE media_id=?', (media,))
        database.init_db()
    assert all(not m['canDeleteAudio'] for m in snapshot(pat)['messages'])
    assert remove(pat, media).status_code == 403
    assert doc.post(f'/api/sos/{sos}/close').status_code == 200
    assert remove(pat, media).status_code == 403
    assert pat.get(f'/api/media/{media}').status_code == 200
    assert doc.get(f'/api/media/{media}').status_code == 200
    assert (database.DATA / 'media' / media).exists()


def test_active_transcription_protects_audio_and_failed_file_cleanup_is_retried(clients, monkeypatch):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    media = upload(pat, p['id'])
    with database.transaction() as db:
        db.execute('INSERT INTO ai_locks VALUES(?,?,?)', ('transcript:' + media, 'active', time.time() + 100))
    assert remove(pat, media).status_code == 409
    with database.transaction() as db:
        db.execute('UPDATE ai_locks SET expires=?', (time.time() - 1,))
    path = database.DATA / 'media' / media
    unlink = Path.unlink
    def fail_file_removal(self, *args, **kwargs):
        if self == path:
            raise OSError('Temporary filesystem failure')
        return unlink(self, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'unlink', fail_file_removal)
        assert remove(pat, media).status_code == 200
    assert pat.get(f'/api/media/{media}').status_code == 404
    assert path.exists()
    with database.transaction() as db:
        assert db.execute('SELECT 1 FROM pending_media_deletions WHERE media_id=?', (media,)).fetchone()
    service.purge_deleted_audio()
    assert not path.exists()


def test_sos_publication_and_deletion_cannot_both_win(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    media = upload(pat, p['id'])
    sos = pat.post('/api/sos').json()['id']
    barrier = Barrier(2)
    def send():
        barrier.wait()
        return pat.post('/api/messages', json={'id': database.uid(), 'patientId': p['id'], 'mediaId': media, 'sosId': sos}).status_code
    def delete():
        barrier.wait()
        return remove(pat, media).status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        sending = executor.submit(send)
        deleting = executor.submit(delete)
        assert (sending.result(), deleting.result()) in [(200, 403), (404, 200)]
