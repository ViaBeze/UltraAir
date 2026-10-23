"""Encrypted Web Push with a durable outbox; no clinical content in push payloads."""
import asyncio
import base64
import fcntl
import json
import logging
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pywebpush import webpush, WebPushException

from . import db as storage
from .auth import current_user, DEVICE_COOKIE, SECURE, PUBLIC_URL, digest, limit
from .db import get_db, transaction, dump, now, uid, notify

router = APIRouter(prefix='/api/push')


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def unb64(value):
    return base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)


def validate_endpoint(value):
    """Only established browser push services, never arbitrary URLs or redirects."""
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    allowed = (host == 'fcm.googleapis.com' or host == 'updates.push.services.mozilla.com'
               or host.endswith('.push.services.mozilla.com') or host.endswith('.push.apple.com'))
    if (not allowed or parsed.scheme != 'https' or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.fragment or not parsed.path
            or any(c.isspace() for c in value) or '\\' in value):
        raise ValueError('Unsupported push endpoint')
    return value


def init_keys():
    # Lock and exclusive creation prevent accidental rotation across restarts/workers.
    path = storage.DATA / 'vapid.pem'
    with open(storage.DATA / 'vapid.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not path.exists():
            key = ec.generate_private_key(ec.SECP256R1())
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
                file.write(key.private_bytes(serialization.Encoding.PEM,
                           serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
                file.flush()
                os.fsync(file.fileno())
        path.chmod(0o600)
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
            raise RuntimeError('Invalid VAPID key')


def public_key():
    key = serialization.load_pem_private_key((storage.DATA / 'vapid.pem').read_bytes(), password=None)
    return b64(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


class PushKeys(BaseModel):
    model_config = ConfigDict(extra='forbid')
    p256dh: str = Field(min_length=80, max_length=100)
    auth: str = Field(min_length=20, max_length=30)

    @field_validator('p256dh')
    @classmethod
    def point(cls, value):
        point = unb64(value)
        if len(point) != 65:
            raise ValueError('Invalid public key')
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
        return value

    @field_validator('auth')
    @classmethod
    def secret(cls, value):
        if len(unb64(value)) != 16:
            raise ValueError('Invalid auth secret')
        return value


class Subscription(BaseModel):
    model_config = ConfigDict(extra='forbid')
    endpoint: str = Field(max_length=4096)
    keys: PushKeys
    expirationTime: float | None = None

    @field_validator('endpoint')
    @classmethod
    def endpoint_valid(cls, value):
        return validate_endpoint(value)


class Preferences(BaseModel):
    model_config = ConfigDict(extra='forbid')
    regular: bool
    urgent: bool


def device_hash(request):
    return digest(request.cookies.get(DEVICE_COOKIE, ''))


def subscription_for(db, request, user):
    return db.execute('SELECT * FROM push_subscriptions WHERE device=? AND user_id=?',
                      (device_hash(request), user['id'])).fetchone()


@router.get('')
def config(request: Request, user=Depends(current_user), db=Depends(get_db, scope='function')):
    sub = subscription_for(db, request, user)
    last_test = None
    if sub:
        row = db.execute('''SELECT j.status, j.last_code FROM push_jobs j JOIN notifications n ON n.id=j.notification_id
                            WHERE j.subscription_id=? AND n.title='Проверка уведомлений'
                            ORDER BY n.created DESC LIMIT 1''', (sub['id'],)).fetchone()
        last_test = dict(row) if row else None
    return {'publicKey': public_key(), 'enabled': bool(sub), 'regular': bool(sub['regular']) if sub else True,
            'urgent': bool(sub['urgent']) if sub else True, 'lastTest': last_test}


@router.post('/subscription')
def subscribe(data: Subscription, request: Request, response: Response,
              user=Depends(current_user), db=Depends(get_db, scope='function')):
    limit('push-subscribe:' + user['id'], 30, 3600)
    device = request.cookies.get(DEVICE_COOKIE) or secrets.token_urlsafe(32)
    hashed = digest(device)
    existing = db.execute('SELECT * FROM push_subscriptions WHERE endpoint=?', (data.endpoint,)).fetchone()
    if existing and (existing['device'] != hashed or existing['user_id'] != user['id']):
        raise HTTPException(409, 'Переподключите уведомления в этом браузере')
    current = subscription_for(db, request, user)
    if current and (current['endpoint'] != data.endpoint or current['keys'] != dump(data.keys.model_dump())):
        db.execute('DELETE FROM push_subscriptions WHERE id=?', (current['id'],))
        current = None
    if not current:
        if db.execute('SELECT count(*) FROM push_subscriptions WHERE user_id=?', (user['id'],)).fetchone()[0] >= 20:
            raise HTTPException(409, 'Достигнут лимит устройств. Отключите уведомления на неиспользуемом устройстве.')
        db.execute('INSERT INTO push_subscriptions(id,user_id,device,endpoint,keys,created,updated) VALUES(?,?,?,?,?,?,?)',
                   (uid(), user['id'], hashed, data.endpoint, dump(data.keys.model_dump()), now(), now()))
    response.set_cookie(DEVICE_COOKIE, device, max_age=365 * 86400, secure=SECURE,
                        httponly=True, samesite='strict', path='/')
    return {'ok': True}


@router.delete('/subscription')
def unsubscribe(request: Request, user=Depends(current_user), db=Depends(get_db, scope='function')):
    db.execute('DELETE FROM push_subscriptions WHERE device=? AND user_id=?', (device_hash(request), user['id']))
    return {'ok': True}


@router.put('/preferences')
def preferences(data: Preferences, request: Request, user=Depends(current_user), db=Depends(get_db, scope='function')):
    sub = subscription_for(db, request, user)
    if not sub:
        raise HTTPException(409, 'Сначала включите уведомления на этом устройстве')
    db.execute('UPDATE push_subscriptions SET regular=?,urgent=?,updated=? WHERE id=?',
               (int(data.regular), int(data.urgent), now(), sub['id']))
    db.execute("UPDATE push_jobs SET status='cancelled' WHERE subscription_id=? AND status IN ('pending','sending') AND ((urgent=0 AND ?=0) OR (urgent=1 AND ?=0))",
               (sub['id'], int(data.regular), int(data.urgent)))
    return {'ok': True}


@router.post('/test')
def test(request: Request, user=Depends(current_user), db=Depends(get_db, scope='function')):
    limit('push-test:' + user['id'], 6, 300)
    sub = subscription_for(db, request, user)
    if not sub:
        raise HTTPException(409, 'Сначала включите уведомления на этом устройстве')
    link = '/doctor/settings' if user['role'] == 'doctor' else '/patient/profile'
    notify(db, user['id'], 'Проверка уведомлений', link, urgent=True, subscription_id=sub['id'])
    return {'ok': True}


class NoRedirectSession(requests.Session):
    def request(self, method, url, **kwargs):
        validate_endpoint(url)
        kwargs['allow_redirects'] = False
        return super().request(method, url, **kwargs)


def send_job(job_id):
    with transaction() as db:
        job = db.execute('''SELECT j.*, s.endpoint, s.keys, s.user_id, n.title, n.link, n.read_at
                            FROM push_jobs j JOIN push_subscriptions s ON s.id=j.subscription_id
                            JOIN notifications n ON n.id=j.notification_id AND n.user_id=s.user_id
                            WHERE j.id=? AND j.status='sending' ''', (job_id,)).fetchone()
        if not job:
            return
        if job['expires'] <= time.time() or job['read_at']:
            db.execute("UPDATE push_jobs SET status='cancelled' WHERE id=?", (job_id,))
            return
    urgent = bool(job['urgent'])
    is_test = job['title'] == 'Проверка уведомлений'
    payload = {'id': job['notification_id'], 'title': 'Рядом · ' + job['title'],
               'body': 'Уведомления на этом устройстве работают.' if is_test else
                       'Откройте Рядом, чтобы ответить на срочное обращение.' if urgent else 'Откройте Рядом, чтобы посмотреть.',
               'link': job['link'], 'urgent': urgent, 'tag': 'ryadom-' + job['notification_id']}
    code = 0
    retry_after = 0
    try:
        with NoRedirectSession() as client:
            response = webpush(subscription_info={'endpoint': job['endpoint'], 'keys': json.loads(job['keys'])},
                               data=dump(payload), vapid_private_key=str(storage.DATA / 'vapid.pem'),
                               vapid_claims={'sub': os.environ.get('RYADOM_VAPID_SUBJECT', PUBLIC_URL if SECURE else 'https://ryadomhelp.online')},
                               ttl=max(1, int(job['expires'] - time.time())), timeout=10,
                               headers={'Urgency': 'high' if urgent else 'normal'}, requests_session=client)
            code = response.status_code
    except WebPushException as exc:
        code = exc.response.status_code if exc.response is not None else 0
        if exc.response is not None:
            value = exc.response.headers.get('Retry-After', '')
            retry_after = min(int(value), 3600) if value.isdigit() else 0
    except (requests.RequestException, ValueError):
        # Provider errors can contain private endpoint tokens; never log exception text.
        pass
    except Exception:
        logging.getLogger('ryadom').error('Push delivery failed; details withheld')
    with transaction() as db:
        if code in (404, 410):
            db.execute('DELETE FROM push_subscriptions WHERE id=?', (job['subscription_id'],))
        elif 200 <= code < 300:
            db.execute("UPDATE push_jobs SET status='sent',last_code=? WHERE id=?", (code, job_id))
            db.execute('UPDATE push_subscriptions SET last_success=? WHERE id=?', (now(), job['subscription_id']))
        else:
            retryable = code in (0, 408, 425, 429) or code >= 500
            delay = max(retry_after, min(900, 5 * 2 ** min(job['attempts'], 8)))
            status = 'pending' if retryable and time.time() + delay < job['expires'] else 'failed'
            db.execute("UPDATE push_jobs SET status=?,last_code=?,due=? WHERE id=? AND status='sending'",
                       (status, code, time.time() + delay, job_id))


def push_tick():
    stamp = time.time()
    with transaction() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute("UPDATE push_jobs SET status='expired' WHERE status IN ('pending','sending') AND expires<=?", (stamp,))
        db.execute('DELETE FROM push_jobs WHERE expires<?', (stamp - 7 * 86400,))
        jobs = db.execute("SELECT id FROM push_jobs WHERE status IN ('pending','sending') AND due<=? AND expires>? ORDER BY urgent DESC,due LIMIT 4", (stamp, stamp)).fetchall()
        for job in jobs:
            db.execute("UPDATE push_jobs SET status='sending',due=?,attempts=attempts+1 WHERE id=?", (stamp + 90, job['id']))
    if jobs:
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(send_job, [job['id'] for job in jobs]))


async def push_loop():
    while True:
        try:
            await asyncio.to_thread(push_tick)
        except Exception:
            logging.getLogger('ryadom').error('Push queue temporarily unavailable')
        await asyncio.sleep(1)
