"""Garden transactions and private diary fields, using isolated temporary databases."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from .test_app import clients, create_pair, register, snapshot, service, database, HEADERS


def local_day():
    return datetime.now(ZoneInfo('Europe/Moscow')).date()


def entry(**changes):
    return dict(date=local_day().isoformat(), score=6, sleep=7, energy=5, **changes)


def garden(client):
    return snapshot(client)['patients'][0]['garden']


def prescribe(doc, pat, patient_id, times=None):
    visit = doc.post('/api/visits', json={'patientId': patient_id, 'scheduled': datetime.now(ZoneInfo('UTC')).isoformat()}).json()['id']
    result = doc.put(f'/api/visits/{visit}', json={'version': 1, 'confirm': True, 'plan': 'Тестовый план', 'prescriptions': [
        {'name': 'Тестовое назначение', 'dose': 'По плану', 'times': times or ['09:00','20:00'], 'start': (local_day() - timedelta(days=7)).isoformat()}
    ]})
    assert result.status_code == 200, result.text
    return snapshot(pat)['prescriptions'][0]['id']


def test_diary_alcohol_rewards_privacy_and_corrections(clients):
    doc, pat, other = clients
    create_pair(doc, pat)
    register(other, 'other')
    payload = entry(alcohol='yes', alcoholDrink='Вино', alcoholVolume=150, alcoholStrength=12,
                    alcoholTime='20:30', alcoholNote='За ужином')
    first = pat.put('/api/diary', json=payload)
    assert first.status_code == 200 and first.json()['earnedDrops'] == 3
    assert snapshot(doc)['entries'][0]['alcoholVolume'] == 150
    assert snapshot(pat)['entries'][0]['alcoholNote'] == 'За ужином'
    assert snapshot(other)['entries'] == [] and snapshot(other)['patients'] == []
    assert pat.put('/api/diary', json=payload).json()['earnedDrops'] == 0
    # An old browser tab must not erase new fields it does not yet know.
    assert pat.put('/api/diary', json=entry()).status_code == 200
    assert snapshot(doc)['entries'][0]['alcohol'] == 'yes'
    for answer in ['no', 'private', None]:
        assert pat.put('/api/diary', json={**payload, 'alcohol': answer}).json()['earnedDrops'] == 0
        saved = snapshot(pat)['entries'][0]
        assert saved['alcohol'] == answer
        assert saved['alcoholDrink'] == '' and saved['alcoholNote'] == ''
        assert saved['alcoholVolume'] is None and saved['alcoholStrength'] is None and saved['alcoholTime'] is None
    assert garden(pat)['growth'] == 3
    assert doc.put('/api/garden/plant', json={'plant': 'cactus'}).status_code == 403
    assert doc.post('/api/garden/water', json={'id': str(uuid4())}).status_code == 403
    assert pat.put('/api/garden/plant', json={'plant': 'unknown'}).status_code == 422
    assert pat.put('/api/garden/plant', json={'plant': 'cactus', 'drops': 999}).status_code == 422
    for bad in [{'alcohol': 'unknown'}, {'alcoholStrength': 101}, {'alcoholVolume': -1}, {'alcoholTime': '25:00'}]:
        assert pat.put('/api/diary', json={**payload, **bad}).status_code == 422
    assert garden(pat)['growth'] == 3


def test_medication_rewards_only_once_for_an_authorized_slot(clients):
    doc, pat, other = clients
    p, _, _ = create_pair(doc, pat)
    prescription = prescribe(doc, pat, p['id'])
    path = f'/api/prescriptions/{prescription}/mark'
    payload = {'date': local_day().isoformat(), 'time': '09:00'}
    for status, expected in [('later',0),('skipped',0),('taken',1),('taken',0),('later',0),('skipped',0),('taken',0)]:
        response = pat.put(path, json={**payload, 'status': status})
        assert response.status_code == 200 and response.json()['earnedDrops'] == expected
    assert pat.put(path, json={**payload, 'status': 'taken', 'time': '20:00'}).json()['earnedDrops'] == 1
    assert pat.put(path, json={**payload, 'status': 'taken', 'time': '07:00'}).status_code == 422
    assert other.put(path, json={**payload, 'status': 'taken'}).status_code == 401
    assert garden(pat)['growth'] == 2
    assert pat.post('/api/garden/water', json={'id': str(uuid4())}).status_code == 410
    assert garden(pat)['growth'] == 2 and garden(pat)['drops'] == 0


def test_automatic_growth_stages_choice_and_restart(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    prescription = prescribe(doc, pat, p['id'], ['09:00','10:00','11:00','12:00','13:00','14:00'])
    for ago in range(8):
        payload = {**entry(), 'date': (local_day() - timedelta(days=ago)).isoformat()}
        assert pat.put('/api/diary', json=payload).json()['earnedDrops'] == 3
        assert pat.put('/api/diary', json=payload).json()['earnedDrops'] == 0
        growth = (ago + 1) * 3
        assert garden(pat)['growth'] == growth
        assert garden(pat)['stage'] == (2 if growth >= 15 else 1 if growth >= 6 else 0)
    for hour in range(9,15):
        assert pat.put(f'/api/prescriptions/{prescription}/mark', json={'date': local_day().isoformat(), 'time': f'{hour:02}:00', 'status': 'taken'}).json()['earnedDrops'] == 1
    assert garden(pat)['growth'] == 30 and garden(pat)['stage'] == 3
    for kind in ['cactus','daisy','monstera','cornflower']:
        assert pat.put('/api/garden/plant', json={'plant': kind}).status_code == 200
        assert garden(doc) == garden(pat)
        assert garden(doc)['plant'] == kind and garden(doc)['growth'] == 30
    database.init_db()
    assert garden(pat)['stage'] == 3 and garden(pat)['growth'] == 30
    before = garden(pat)
    assert pat.post('/api/garden/water', json={'id': str(uuid4())}).status_code == 410
    assert garden(pat) == before
    with database.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM garden_waterings').fetchone()[0] == 0


def test_parallel_diary_requests_grow_the_plant_only_once(clients):
    doc, pat, _ = clients
    create_pair(doc, pat)
    barrier = Barrier(2)
    def save(_):
        client = TestClient(service.app, headers=HEADERS, cookies=pat.cookies)
        try:
            barrier.wait(timeout=10)
            response = client.put('/api/diary', json=entry())
            assert response.status_code == 200
            return response.json()['earnedDrops']
        finally:
            client.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, [0,1]))
    assert sorted(responses) == [0,3]
    assert garden(pat)['growth'] == 3 and garden(pat)['drops'] == 0


def test_previous_drops_grow_automatically_without_double_counting_waterings(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    for ago in range(5):
        assert pat.put('/api/diary', json={**entry(), 'date': (local_day() - timedelta(days=ago)).isoformat()}).status_code == 200
    assert pat.put('/api/garden/plant', json={'plant': 'cactus'}).status_code == 200
    # Simulate the previously deployed version: 6 spent, 9 still in the balance.
    with database.transaction() as db:
        for _ in range(2):
            db.execute('INSERT INTO garden_waterings VALUES(?,?,3,?)', (p['id'], str(uuid4()), database.now()))
    database.init_db()
    current = garden(pat)
    assert current['growth'] == 15 and current['stage'] == 2 and current['plant'] == 'cactus'
    assert current['drops'] == 0 and current['watered'] == 15
    for _ in range(2):
        assert pat.post('/api/garden/water', json={'id': str(uuid4())}).status_code == 410
    assert garden(pat) == current
    with database.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM garden_waterings').fetchone()[0] == 2


def test_legacy_records_are_credited_once_without_inventing_alcohol(clients):
    doc, pat, _ = clients
    p, _, _ = create_pair(doc, pat)
    prescription = prescribe(doc, pat, p['id'])
    pat.put('/api/diary', json=entry())
    pat.put(f'/api/prescriptions/{prescription}/mark', json={'date': local_day().isoformat(), 'time': '09:00', 'status': 'taken'})
    pat.put(f'/api/prescriptions/{prescription}/mark', json={'date': local_day().isoformat(), 'time': '20:00', 'status': 'later'})
    with database.transaction() as db:
        db.execute('DELETE FROM garden_rewards')
        db.execute('DELETE FROM schema_version WHERE version=2')
        db.execute('UPDATE entries SET data=?', (database.dump(entry()),))
    database.init_db()
    database.init_db()
    assert garden(pat)['growth'] == 4
    assert snapshot(doc)['entries'][0].get('alcohol') is None
    assert pat.put('/api/diary', json=entry(alcohol='private')).json()['earnedDrops'] == 0
    assert garden(pat)['growth'] == 4


def test_no_reward_for_arbitrary_old_dates_or_future_entries(clients):
    doc, pat, _ = clients
    create_pair(doc, pat)
    assert pat.put('/api/diary', json={**entry(), 'date': (local_day() + timedelta(days=1)).isoformat()}).status_code == 422
    assert pat.put('/api/diary', json={**entry(), 'date': '2000-01-01'}).json()['earnedDrops'] == 0
    assert garden(pat)['growth'] == 0
