import hashlib
import os
import secrets
import sqlite3
import time
from fastapi import Depends, HTTPException, Request, Response
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from .db import get_db, transaction, audit, now, uid

PUBLIC_URL = os.environ.get('RYADOM_PUBLIC_URL', 'http://127.0.0.1:4173').rstrip('/')
SECURE = PUBLIC_URL.startswith('https://')
COOKIE = '__Host-ryadom_session' if SECURE else 'ryadom_session'
DEVICE_COOKIE = '__Host-ryadom_device' if SECURE else 'ryadom_device'
SIGNUP = os.environ.get('RYADOM_DOCTOR_SIGNUP', '1') == '1'
ALLOWED_ORIGINS = set(os.environ.get('RYADOM_ORIGINS', PUBLIC_URL).split(','))
HASHER = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
DUMMY_HASH = HASHER.hash(secrets.token_urlsafe(32))
SESSION_SECONDS = 7 * 86400


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def verify(hashed, password):
    try:
        return HASHER.verify(hashed or DUMMY_HASH, password) and bool(hashed)
    except (VerificationError, InvalidHashError):
        return False


def limit(key, maximum=10, window=900):
    if os.environ.get('RYADOM_TESTING') == '1':
        return
    current = time.time()
    # A separate transaction persists failed attempts even if the request rolls back.
    with transaction() as db:
        db.execute('DELETE FROM rate_limits WHERE expires < ?', (current,))
        db.execute('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
                   (digest(key), current + window))
        count = db.execute('SELECT count FROM rate_limits WHERE key=?', (digest(key),)).fetchone()[0]
    if count > maximum:
        raise HTTPException(429, 'Слишком много попыток. Попробуйте позже.', headers={'Retry-After': str(window)})


def auth_limit(request, login=''):
    limit('auth-ip:' + (request.client.host if request.client else 'unknown'), 30)
    if login:
        limit('auth-login:' + login.lower(), 12)


def session(db, response, user_id):
    token = secrets.token_urlsafe(48)
    current = time.time()
    db.execute('DELETE FROM sessions WHERE expires < ? OR seen < ?', (current, current - 43200))
    db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest(token), user_id, current + SESSION_SECONDS, current))
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True, secure=SECURE,
                        samesite='strict', path='/')


def current_user(request: Request, db=Depends(get_db, scope='function')):
    token = request.cookies.get(COOKIE, '')
    row = db.execute('''SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                        WHERE s.token=? AND s.expires>? AND s.seen>?''',
                     (digest(token), time.time(), time.time() - 43200)).fetchone()
    if row is None:
        raise HTTPException(401, 'Войдите в аккаунт')
    # Updating at most once per minute avoids turning polling into writes.
    db.execute('UPDATE sessions SET seen=? WHERE token=? AND seen<?',
               (time.time(), digest(token), time.time() - 60))
    # Switching accounts on a shared browser must revoke its former push recipient.
    device = request.cookies.get(DEVICE_COOKIE)
    if device:
        db.execute('DELETE FROM push_subscriptions WHERE device=? AND user_id<>?', (digest(device), row['id']))
    db.commit()
    return row


def doctor(user=Depends(current_user)):
    if user['role'] != 'doctor':
        raise HTTPException(403, 'Действие доступно врачу')
    return user


def patient(user=Depends(current_user)):
    if user['role'] != 'patient':
        raise HTTPException(403, 'Действие доступно пациенту')
    return user


def public_user(user):
    return {k: user[k] for k in ('id', 'role', 'login', 'name')}


def recovery_code(db, user_id):
    code = secrets.token_urlsafe(24)
    db.execute('UPDATE users SET recovery=? WHERE id=?', (digest(code), user_id))
    return code


def invite(db, user_id):
    token = secrets.token_urlsafe(32)
    db.execute('DELETE FROM invites WHERE user_id=?', (user_id,))
    db.execute('INSERT INTO invites VALUES(?,?,?,?)', (digest(token), user_id, time.time() + 72 * 3600, now()))
    # Fragment keeps invitation secrets out of web server access logs and referrers.
    return f'{PUBLIC_URL}/activate#{token}'


def set_password(db, response, user_id, password):
    db.execute('UPDATE users SET password=? WHERE id=?', (HASHER.hash(password), user_id))
    db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
    db.execute('DELETE FROM invites WHERE user_id=?', (user_id,))
    audit(db, user_id, 'password_changed', user_id)
    db.execute('DELETE FROM push_subscriptions WHERE user_id=?', (user_id,))
    code = recovery_code(db, user_id)
    session(db, response, user_id)
    return code
