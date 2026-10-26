"""Doctor-only transcription and source-grounded drafts. Never publishes clinical data."""
import asyncio
import hashlib
import json
import os
import time
from contextlib import contextmanager
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from . import db as database
from .auth import doctor, limit
from .db import audit, dump, get_db, now, transaction, uid
from .models import Model
from .clinical_support import INSTRUCTIONS, MEDICATION_REVIEW, PROMPT_VERSION, Proposal, parse_proposal, sources_for

router = APIRouter(prefix='/api')
MAX_SOURCE = 50000
EXTENSIONS = {'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
              'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3'}


class Consent(Model):
    consent: Literal[True]


class DraftRequest(Consent):
    version: int = Field(ge=1)
    patientVersion: int = Field(ge=1)
    source: Annotated[str, Field(min_length=10, max_length=MAX_SOURCE)]
    includeClinicalContext: bool = False
    reviewMedications: bool = False



def enabled():
    return bool(os.environ.get('OPENAI_API_KEY', '').strip())


def require_key():
    key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not key:
        raise HTTPException(503, 'ИИ не настроен. Администратору нужно подключить ключ OpenAI на сервере.')
    return key


async def openai_request(endpoint, **kwargs):
    key = require_key()
    proxy = os.environ.get('OPENAI_PROXY_URL', '').strip() or None
    try:
        # Fixed provider origin, no redirects, no retries of billable requests.
        async with asyncio.timeout(100):
            async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), follow_redirects=False,
                                         proxy=proxy) as client:
                response = await client.post('https://api.openai.com/v1/' + endpoint,
                                             headers={'Authorization': 'Bearer ' + key}, **kwargs)
    except (TimeoutError, httpx.TimeoutException):
        raise HTTPException(504, 'Обработка заняла слишком много времени. Исходные данные сохранены; попробуйте ещё раз.') from None
    except httpx.HTTPError:
        raise HTTPException(502, 'Нет связи с OpenAI. Попробуйте ещё раз позже.') from None
    if response.status_code == 403:
        try:
            region_blocked = response.json().get('error', {}).get('code') == 'unsupported_country_region_territory'
        except (ValueError, AttributeError):
            region_blocked = False
        if region_blocked:
            raise HTTPException(503, 'OpenAI не поддерживает регион этого сервера. Для обработки ИИ требуется размещение сервиса в поддерживаемом регионе. Исходные данные сохранены.')
    if response.status_code in (401, 403, 404):
        raise HTTPException(503, 'OpenAI недоступен: администратору нужно проверить ключ, доступ к модели и регион.')
    if response.status_code == 429:
        raise HTTPException(429, 'OpenAI отклонил запрос из-за лимита. Проверьте баланс API или повторите позже.')
    if response.status_code in (400, 413, 415, 422):
        raise HTTPException(422, 'OpenAI не смог обработать данные. Проверьте запись или текст и настройки модели.')
    if not response.is_success:
        raise HTTPException(502, 'Ошибка сервиса OpenAI. Попробуйте позже.')
    try:
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except ValueError:
        raise HTTPException(502, 'OpenAI вернул некорректный ответ. Изменения не применены.') from None


@contextmanager
def operation(user, key, entity, request_db):
    """Persist consent and a short lease without holding SQLite over the network."""
    require_key()
    limit('ai:' + user['id'], 60, 3600)
    token = uid()
    with transaction() as db:
        db.execute('DELETE FROM ai_locks WHERE expires<?', (time.time(),))
        if not db.execute('INSERT OR IGNORE INTO ai_locks VALUES(?,?,?)', (key, token, time.time() + 120)).rowcount:
            raise HTTPException(409, 'Эта запись уже обрабатывается. Подождите и повторите запрос.')
        audit(db, user['id'], 'ai_processing_with_consent', entity)
    try:
        yield
    finally:
        # Successful handlers commit explicitly. On failure release any write transaction
        # before the independent lease cleanup (including disk/constraint failures).
        request_db.rollback()
        with transaction() as db:
            db.execute('DELETE FROM ai_locks WHERE key=? AND token=?', (key, token))


def transcript_payload(row):
    return {'text': row['text'], 'created': row['created'], 'model': row['model']}


@router.get('/media/{media_id}/transcription')
def get_transcript(media_id: str, user=Depends(doctor), db=Depends(get_db, scope='function')):
    from .app import media_row
    media_row(db, user, media_id)
    row = db.execute('SELECT * FROM ai_transcripts WHERE media_id=?', (media_id,)).fetchone()
    return {'transcript': transcript_payload(row) if row else None}


@router.post('/media/{media_id}/transcription')
async def transcribe(media_id: str, data: Consent, user=Depends(doctor), db=Depends(get_db, scope='function')):
    from .app import media_row
    media = media_row(db, user, media_id)
    cached = db.execute('SELECT * FROM ai_transcripts WHERE media_id=?', (media_id,)).fetchone()
    if cached:
        return transcript_payload(cached)
    path = database.DATA / 'media' / media['id']
    if not path.is_file():
        raise HTTPException(404, 'Запись не найдена')
    if media['mime'] not in EXTENSIONS:
        raise HTTPException(415, 'Этот формат записи не поддерживает расшифровку')
    if not 0 < path.stat().st_size <= 25 * 1024**2:
        raise HTTPException(413, 'Максимальный размер записи — 25 МБ')
    model = os.environ.get('OPENAI_TRANSCRIBE_MODEL', 'gpt-transcribe')
    with operation(user, 'transcript:' + media_id, media_id, db):
        # A deletion may have completed before the transcription lease was acquired.
        media_row(db, user, media_id)
        with path.open('rb') as audio:
            result = await openai_request('audio/transcriptions',
                                         data={'model': model},
                                         files={'file': ('recording.' + EXTENSIONS[media['mime']], audio, media['mime'])})
        text = result.get('text')
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(422, 'Не удалось распознать речь. Прослушайте запись или внесите текст вручную.')
        if len(text) > MAX_SOURCE:
            raise HTTPException(422, 'Расшифровка слишком длинная. Разделите запись на несколько частей.')
        media_row(db, user, media_id)
        created = now()
        db.execute('INSERT OR IGNORE INTO ai_transcripts VALUES(?,?,?,?,?)', (media_id, text.strip(), model, user['id'], created))
        audit(db, user['id'], 'audio_transcribed', media_id)
        db.commit()
    return transcript_payload(db.execute('SELECT * FROM ai_transcripts WHERE media_id=?', (media_id,)).fetchone())


def draft_payload(row):
    suggestion = json.loads(row['data'])
    return {'source': row['source'], 'suggestion': suggestion,
            'needsRefresh': suggestion.get('promptVersion') != PROMPT_VERSION,
            'version': row['visit_version'], 'patientVersion': row['patient_version'],
            'model': row['model'], 'created': row['created']}


@router.get('/visits/{visit_id}/ai-draft')
def get_draft(visit_id: str, user=Depends(doctor), db=Depends(get_db, scope='function')):
    from .app import visit_row
    visit_row(db, user, visit_id)
    row = db.execute('SELECT * FROM ai_visit_drafts WHERE visit_id=?', (visit_id,)).fetchone()
    return {'draft': draft_payload(row) if row else None}


def check_versions(db, user, visit_id, data):
    from .app import visit_row, patient_row
    visit = visit_row(db, user, visit_id)
    patient = patient_row(db, user, visit['patient_id'])
    if visit['confirmed'] or visit['status'] == 'cancelled':
        raise HTTPException(409, 'Приём завершён. Создайте новый приём для уточнений.')
    if visit['version'] != data.version or patient['version'] != data.patientVersion:
        raise HTTPException(409, 'Приём или медкарта изменились. Обновите страницу, сохранив свой текст.')
    return visit, patient


@router.post('/visits/{visit_id}/ai-draft')
async def generate_draft(visit_id: str, data: DraftRequest, user=Depends(doctor), db=Depends(get_db, scope='function')):
    visit, patient = check_versions(db, user, visit_id, data)
    prescriptions = db.execute('SELECT data FROM prescriptions WHERE patient_id=? AND active=1', (visit['patient_id'],)).fetchall() if data.includeClinicalContext else []
    sources = sources_for(data.source, patient if data.includeClinicalContext else None, prescriptions)
    model = os.environ.get('OPENAI_DRAFT_MODEL', 'gpt-5.4-mini')
    source_hash = hashlib.sha256(dump({'sources': sources, 'prompt': PROMPT_VERSION, 'reviewMedications': data.reviewMedications}).encode()).hexdigest()
    cached = db.execute('SELECT * FROM ai_visit_drafts WHERE visit_id=?', (visit_id,)).fetchone()
    # A separate, explicit medication review must not replay a previous empty answer.
    if not data.reviewMedications and cached and cached['source_hash'] == source_hash and cached['visit_version'] == data.version and cached['patient_version'] == data.patientVersion and cached['model'] == model:
        return draft_payload(cached)
    with operation(user, 'draft:' + visit_id, visit_id, db):
        result = await openai_request('responses', json={
            'model': model, 'store': False, 'max_output_tokens': 12000,
            'reasoning': {'effort': 'low'},
            'instructions': INSTRUCTIONS + (MEDICATION_REVIEW if data.reviewMedications else ''),
            # Only explicitly selected clinical context; no names, contacts or unrelated notes.
            'input': [{'role': 'user', 'content': dump({'sources': [{'id': key, 'text': value} for key, value in sources.items()]})}],
            'text': {'format': {'type': 'json_schema', 'name': 'visit_draft', 'strict': True,
                                'schema': Proposal.model_json_schema()}},
        })
        suggestion = parse_proposal(result, sources, data.includeClinicalContext)
        check_versions(db, user, visit_id, data)
        db.execute('''INSERT INTO ai_visit_drafts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(visit_id)
                      DO UPDATE SET source=excluded.source,source_hash=excluded.source_hash,data=excluded.data,
                      visit_version=excluded.visit_version,patient_version=excluded.patient_version,
                      model=excluded.model,actor=excluded.actor,created=excluded.created''',
                   (visit_id, data.source, source_hash, dump(suggestion), data.version,
                    data.patientVersion, model, user['id'], now()))
        audit(db, user['id'], 'ai_visit_draft_created', visit_id)
        db.commit()
    return draft_payload(db.execute('SELECT * FROM ai_visit_drafts WHERE visit_id=?', (visit_id,)).fetchone())
