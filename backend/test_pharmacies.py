import json
from datetime import datetime, timezone, timedelta

import httpx
import pytest

from backend import pharmacies
from backend.test_app import clients, create_pair, register


@pytest.fixture
def maps(monkeypatch):
    monkeypatch.delenv('RYADOM_PHARMACY_FEED', raising=False)
    monkeypatch.delenv('RYADOM_GEOCODER_URL', raising=False)
    monkeypatch.delenv('RYADOM_OVERPASS_URL', raising=False)
    monkeypatch.delenv('RYADOM_OVERPASS_FALLBACK_URL', raising=False)
    fake = {'calls': [], 'status': 200, 'statuses': {}, 'remark': ''}
    real_client = httpx.AsyncClient
    def handler(request):
        fake['calls'].append(request)
        assert request.url.host in ('overpass-api.de', 'maps.mail.ru')
        return httpx.Response(fake['statuses'].get(request.url.host, fake['status']), json={'remark': fake['remark'], 'elements': [
            {'id': 123, 'type': 'node', 'lat': 55.756, 'lon': 37.618,
             'tags': {'name': 'Аптека на карте', 'addr:street': 'Тестовая', 'addr:housenumber': '1'}},
        ]})
    monkeypatch.setattr(pharmacies.httpx, 'AsyncClient', lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handler)))
    return fake


QUERY = {'lat': 55.7558, 'lon': 37.6173, 'radius': 3000, 'query': 'Авиандр'}


def test_nearby_pharmacies_have_unknown_stock_and_no_patient_data(clients, maps):
    doc, pat, anon = clients
    create_pair(doc, pat)
    assert anon.post('/api/pharmacies/search', json=QUERY).status_code == 401
    assert pat.post('/api/pharmacies/search', json={**QUERY, 'patientId': 'private'}).status_code == 422
    assert pat.post('/api/pharmacies/search', json={**QUERY, 'radius': 99999}).status_code == 422
    result = pat.post('/api/pharmacies/search', json=QUERY)
    assert result.status_code == 200, result.text
    item = result.json()['items'][0]
    assert item['price'] is None and item['availability'] == 'unknown'
    assert not result.json()['inventoryConnected']
    assert doc.post('/api/pharmacies/search', json=QUERY).json() == result.json()
    assert len(maps['calls']) == 1
    assert b'patientId' not in maps['calls'][0].content and b'query=' not in maps['calls'][0].content
    assert pat.get('/api/pharmacies/config').json() == {'addressSearch': False}
    assert pat.post('/api/pharmacies/location', json={'query': 'Москва'}).status_code == 503


def test_feed_prices_and_stale_stock_and_map_outage(clients, maps, tmp_path, monkeypatch):
    doc, _, _ = clients
    register(doc)
    offer = {'id': 'one', 'name': 'Тестовая аптека', 'address': 'Тестовая улица, 1',
             'lat': 55.756, 'lon': 37.618, 'medicine': 'Авиандр', 'form': 'Упаковка для теста',
             'price': '112.34', 'packageSize': 30, 'available': True,
             'url': 'https://pharmacy.example/offer', 'updatedAt': datetime.now(timezone.utc).isoformat(), 'source': 'Тестовая выгрузка'}
    path = tmp_path / 'offers.json'
    path.write_text(json.dumps({'offers': [offer, {**offer, 'id': 'old', 'updatedAt': (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()},
                                          {**offer, 'id': 'empty', 'available': False}, {**offer, 'id': 'far', 'lat': 59.9},
                                          {**offer, 'id': 'other', 'medicine': 'Другой препарат'}]}))
    monkeypatch.setenv('RYADOM_PHARMACY_FEED', str(path))
    maps['status'] = 503
    result = doc.post('/api/pharmacies/search', json=QUERY).json()
    assert result['inventoryConnected'] and result['warning']
    items = {item['id']: item for item in result['items']}
    assert set(items) == {'offer:one', 'offer:old', 'offer:empty'}
    assert items['offer:one']['price'] == 112.34 and items['offer:one']['availability'] == 'available'
    assert items['offer:old']['price'] is None and items['offer:old']['availability'] == 'unknown'
    assert items['offer:empty']['price'] is None and items['offer:empty']['availability'] == 'unavailable'
    path.write_text(json.dumps({'offers': [{**offer, 'price': '-1'}]}))
    invalid = doc.post('/api/pharmacies/search', json=QUERY).json()
    assert not invalid['inventoryConnected'] and invalid['items'] == []


def test_map_uses_configured_fallback_and_never_caches_partial_results(clients, maps, monkeypatch):
    doc, _, _ = clients
    register(doc)
    monkeypatch.setenv('RYADOM_OVERPASS_FALLBACK_URL', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter')
    maps['statuses']['overpass-api.de'] = 503
    result = doc.post('/api/pharmacies/search', json=QUERY).json()
    assert result['items'] and not result['warning']
    assert [request.url.host for request in maps['calls']] == ['overpass-api.de', 'maps.mail.ru']
    maps['remark'] = 'runtime error: Query timed out'
    changed_area = {**QUERY, 'lat': 55.76}
    partial = doc.post('/api/pharmacies/search', json=changed_area).json()
    assert partial['items'] == [] and partial['warning']
    maps['remark'] = ''
    assert doc.post('/api/pharmacies/search', json=changed_area).json()['items']
