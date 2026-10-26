import json

from backend.test_ai import clients, provider, create_pair, register


def search_response():
    url = 'https://www.vidal.ru/drugs/aviandr'
    value = {'items': [{'name': 'АВИАНДР', 'inn': 'Маритупирдин', 'form': 'Таблетки',
                        'strength': '20 мг', 'manufacturer': None, 'url': url}]}
    return {'status': 'completed', 'output': [
        {'type': 'web_search_call', 'action': {'sources': [{'type': 'url', 'url': url}]}},
        {'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(value)}]},
    ]}


def test_reference_search_permissions_provenance_and_cache(clients, provider):
    doc, pat, anon = clients
    create_pair(doc, pat)
    body = {'query': 'Авиандр', 'source': 'Видаль'}
    assert anon.post('/api/medicines/search', json=body).status_code == 401
    assert pat.post('/api/medicines/search', json=body).status_code == 403
    assert doc.post('/api/medicines/search', json={**body, 'source': 'https://evil.example'}).status_code == 422
    assert doc.post('/api/medicines/search', json={**body, 'patientId': 'private'}).status_code == 422
    assert not provider['calls']
    provider['result'] = search_response()
    result = doc.post('/api/medicines/search', json=body)
    assert result.status_code == 200, result.text
    assert result.json()['items'][0]['name'] == 'АВИАНДР'
    assert result.json()['mode'] == 'public_search'
    request = json.loads(provider['calls'][0].content)
    assert request['tools'][0]['filters']['allowed_domains'] == ['vidal.ru']
    assert request['tool_choice'] == 'required'
    assert json.loads(request['input']) == {'reference': 'Видаль', 'drugQuery': 'Авиандр'}
    assert 'Пациент Тест' not in provider['calls'][0].content.decode()
    assert doc.post('/api/medicines/search', json=body).json() == result.json()
    assert len(provider['calls']) == 1


def test_invented_or_wrong_domain_links_never_become_catalog_entries(clients, provider):
    doc, _, _ = clients
    register(doc)
    provider['result'] = search_response()
    provider['result']['output'][0]['action']['sources'] = []
    result = doc.post('/api/medicines/search', json={'source': 'Видаль', 'query': 'Авиандр'})
    assert result.status_code == 200 and result.json()['items'] == []
    provider['result'] = search_response()
    result = doc.post('/api/medicines/search', json={'source': 'РЛС', 'query': 'Авиандр'})
    assert result.status_code == 200 and result.json()['items'] == []
