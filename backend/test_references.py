import json
import httpx

from backend import references
from backend.test_ai import clients, provider, create_pair, register


def response(url='https://www.rlsnet.ru/drugs/test', quote='Точная цитата из инструкции.'):
    return {'status': 'completed', 'output': [
        {'type': 'web_search_call', 'action': {'sources': [{'url': url}]}},
        {'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps({'items': [
            {'title': 'Инструкция', 'section': 'Раздел', 'url': url, 'quote': quote}]})}]},
    ]}


def test_search_validates_exact_quote_and_does_not_send_patient_context(clients, provider, monkeypatch):
    doc, pat, anon = clients
    create_pair(doc, pat)
    body = {'source': 'РЛС', 'query': 'Препарат взаимодействия'}
    assert pat.post('/api/references/search', json=body).status_code == 403
    assert anon.post('/api/references/search', json=body).status_code == 401
    assert doc.post('/api/references/search', json={**body, 'patientId': 'private'}).status_code == 422
    async def page(url, source):
        return 'Раздел. Точная цитата из инструкции. Следующий абзац.'
    monkeypatch.setattr(references, 'page_text', page)
    provider['result'] = response()
    result = doc.post('/api/references/search', json=body)
    assert result.status_code == 200, result.text
    assert result.json()['items'][0]['quoteVerified']
    request = json.loads(provider['calls'][0].content)
    assert json.loads(request['input']) == body
    assert 'Пациент Тест' not in provider['calls'][0].content.decode()
    assert doc.post('/api/references/search', json=body).json() == result.json()
    assert len(provider['calls']) == 1
    provider['result'] = response(quote='Несуществующее утверждение.')
    result = doc.post('/api/references/search', json={**body, 'query': 'Другой запрос'}).json()
    assert result['items'][0]['quote'] == '' and not result['items'][0]['quoteVerified']


def test_unprovenanced_and_wrong_domain_links_are_not_returned(clients, provider, monkeypatch):
    doc, _, _ = clients
    register(doc)
    async def never_fetch(*args):
        raise AssertionError('Must not fetch untrusted links')
    monkeypatch.setattr(references, 'page_text', never_fetch)
    provider['result'] = response('https://evil.example/drugs/test')
    assert doc.post('/api/references/search', json={'source': 'РЛС', 'query': 'Препарат'}).json()['items'] == []
    provider['result'] = response()
    provider['result']['output'][0]['action']['sources'] = []
    assert doc.post('/api/references/search', json={'source': 'РЛС', 'query': 'Другой препарат'}).json()['items'] == []


def test_fetch_rechecks_redirects_and_strips_scripts(monkeypatch):
    import asyncio
    requests = []
    real_client = httpx.AsyncClient
    def handler(request):
        requests.append(request)
        if request.url.path == '/redirect':
            return httpx.Response(302, headers={'location': 'http://127.0.0.1/private'})
        return httpx.Response(200, headers={'content-type': 'text/html; charset=utf-8'}, text='<p>Точная <b>цитата</b>.</p><script>Не цитата</script>')
    monkeypatch.setattr(references.httpx, 'AsyncClient', lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handler)))
    assert asyncio.run(references.page_text('https://www.rlsnet.ru/redirect', 'РЛС')) == ''
    assert len(requests) == 1
    assert asyncio.run(references.page_text('https://www.rlsnet.ru/drugs/test', 'РЛС')) == 'Точная цитата.'
