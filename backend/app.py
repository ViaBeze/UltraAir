import asyncio
import contextlib
import hashlib
import json
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import FastAPI, Depends, HTTPException, Request, Response, UploadFile, File, Form
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from . import models as m
from . import push, garden, ai, medicines, references, pharmacies
from .db import DATA, init_db, get_db, transaction, dump, uid, now, audit, notify
from .auth import (PUBLIC_URL, SECURE, COOKIE, SIGNUP, ALLOWED_ORIGINS, HASHER,
                   current_user, doctor, patient, public_user, auth_limit,
                   limit, verify, digest, session, recovery_code, invite, set_password, DEVICE_COOKIE)


def patient_row(db, user, patient_id=None):
    if user['role'] == 'doctor':
        row = db.execute('SELECT * FROM patients WHERE id=? AND doctor_id=?', (patient_id, user['id'])).fetchone()
    else:
        row = db.execute('SELECT * FROM patients WHERE user_id=?', (user['id'],)).fetchone()
        if patient_id and row and patient_id != row['id']:
            row = None
    if not row:
        raise HTTPException(404, 'Карточка не найдена')
    return row


def visit_row(db, user, visit_id):
    row = db.execute('SELECT * FROM visits WHERE id=?', (visit_id,)).fetchone()
    if not row:
        raise HTTPException(404, 'Приём не найден')
    patient_row(db, user, row['patient_id'])
    return row


def sos_row(db, user, sos_id):
    row = db.execute('SELECT * FROM sos WHERE id=?', (sos_id,)).fetchone()
    if not row:
        raise HTTPException(404, 'Обращение не найдено')
    patient_row(db, user, row['patient_id'])
    return row


def media_check(db, user, patient_id, media_id, purpose, sos_id=None):
    if not media_id:
        return
    row = db.execute('SELECT * FROM media WHERE id=? AND author=? AND patient_id=? AND purpose=?',
                     (media_id, user['id'], patient_id, purpose)).fetchone()
    if not row:
        raise HTTPException(404, 'Запись не найдена')
    protected = db.execute('SELECT sos_id FROM media_sos WHERE media_id=?', (media_id,)).fetchone()
    if protected and protected['sos_id'] != sos_id:
        raise HTTPException(409, 'Эта запись относится к SOS-обращению и не может быть перенесена.')


def serialize_patient(db, row, is_doctor):
    profile = json.loads(row['profile'])
    clinical = json.loads(row['clinical']) if is_doctor else {}
    if not is_doctor:
        profile.pop('note', None)
    birth = date.fromisoformat(profile['birth'])
    today = date.today()
    age = today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))
    doc = db.execute('SELECT name FROM users WHERE id=?', (row['doctor_id'],)).fetchone()
    account = db.execute('SELECT login,password FROM users WHERE id=?', (row['user_id'],)).fetchone()
    return dict({**profile, **clinical}, id=row['id'], age=f'{age} лет', doctorName=doc['name'],
                login=account['login'], activated=bool(account['password']), version=row['version'],
                created=row['created'], updated=row['updated'], garden=garden.snapshot(db, row['id']))


def serialize_visit(row, is_doctor):
    data = json.loads(row['data'])
    if not is_doctor:
        data = {k: data[k] for k in ('title', 'diagnosis', 'plan', 'prescriptions', 'citations') if k in data} if row['confirmed'] else {'title': data.get('title', 'Приём')}
    return dict(id=row['id'], patientId=row['patient_id'], scheduled=row['scheduled'], status=row['status'],
                version=row['version'], confirmed=row['confirmed'], created=row['created'], updated=row['updated'], **data)


def serialize_message(row, user):
    return dict(id=row['id'], patientId=row['patient_id'], author=row['role'], authorName=row['name'],
                text=row['body'], sosId=row['sos_id'], mediaId=row['media_id'], created=row['created'], readAt=row['read_at'],
                canDeleteAudio=bool(row['media_id'] and row['author'] == user['id'] and not row['audio_sos_id']))


def purge_deleted_audio():
    # Retry failed filesystem removals after a crash or temporary disk error.
    # Database references and transcripts have already been removed atomically.
    with transaction() as db:
        for row in db.execute('SELECT media_id FROM pending_media_deletions').fetchall():
            try:
                (DATA / 'media' / row['media_id']).unlink(missing_ok=True)
            except OSError:
                continue
            db.execute('DELETE FROM pending_media_deletions WHERE media_id=?', (row['media_id'],))


def reminder_tick():
    purge_deleted_audio()
    with transaction() as db:
        for p in db.execute('SELECT p.*,u.settings FROM patients p JOIN users u ON p.user_id=u.id WHERE u.password IS NOT NULL').fetchall():
            settings = m.Settings(**json.loads(p['settings']))
            if not settings.enabled:
                continue
            local = datetime.now(ZoneInfo(settings.timezone))
            day, clock = local.date().isoformat(), local.strftime('%H:%M')
            base = f"{p['id']}:{day}:"
            if clock >= settings.diary and not db.execute('SELECT 1 FROM entries WHERE patient_id=? AND day=?', (p['id'], day)).fetchone():
                notify(db, p['user_id'], 'Время отметить самочувствие', '/patient/diary', digest(base + 'diary'))
            for prescription in db.execute('SELECT * FROM prescriptions WHERE patient_id=? AND active=1', (p['id'],)).fetchall():
                value = json.loads(prescription['data'])
                if value['start'] > day or (value.get('end') and value['end'] < day):
                    continue
                for slot in value['times']:
                    if slot <= clock and not db.execute('SELECT 1 FROM medicine_marks WHERE prescription_id=? AND day=? AND slot=? AND status IN (\'taken\',\'skipped\')', (prescription['id'], day, slot)).fetchone():
                        notify(db, p['user_id'], f"Приём по плану · {slot}", '/patient/plan', digest(base + prescription['id'] + slot))
        snooze_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        for mark in db.execute("SELECT m.*,p.user_id FROM medicine_marks m JOIN patients p ON p.id=m.patient_id WHERE m.status='later' AND m.updated<=?", (snooze_cutoff,)).fetchall():
            preferences = m.Settings(**json.loads(db.execute('SELECT settings FROM users WHERE id=?', (mark['user_id'],)).fetchone()[0]))
            if preferences.enabled and mark['day'] == datetime.now(ZoneInfo(preferences.timezone)).date().isoformat():
                notify(db, mark['user_id'], 'Вы просили напомнить о приёме', '/patient/plan', digest('snooze:' + mark['id'] + mark['updated']))
        cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        db.execute('DELETE FROM notifications WHERE read_at IS NOT NULL AND created<?', (cutoff,))
        db.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
        db.execute('DELETE FROM invites WHERE expires<?', (time.time(),))


async def reminder_loop():
    while True:
        try:
            await asyncio.to_thread(reminder_tick)
        except Exception:
            # No clinical payloads or credentials in logs.
            import logging
            logging.getLogger('ryadom').exception('Reminder scheduler failed')
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app):
    init_db()
    push.init_keys()
    task = asyncio.create_task(reminder_loop())
    push_task = None if os.environ.get('RYADOM_TESTING') == '1' else asyncio.create_task(push.push_loop())
    yield
    task.cancel()
    if push_task:
        push_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await push_task
    with contextlib.suppress(asyncio.CancelledError):
        await task


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(push.router)
app.include_router(ai.router)
app.include_router(medicines.router)
app.include_router(references.router)
app.include_router(pharmacies.router)


@app.middleware('http')
async def guards(request, call_next):
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if request.headers.get('x-ryadom') != '1' or (origin and origin not in ALLOWED_ORIGINS) or request.headers.get('sec-fetch-site') == 'cross-site':
            return JSONResponse({'detail': 'Недопустимый источник запроса'}, status_code=403)
        length = request.headers.get('content-length', '0')
        maximum = 26 * 1024 * 1024 if request.url.path == '/api/media' else 256 * 1024
        if not length.isdigit() or int(length) > maximum:
            return JSONResponse({'detail': 'Файл слишком большой'}, status_code=413)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.exception_handler(RequestValidationError)
async def invalid_input(request, exc):
    # Pydantic's default error response can echo passwords and medical content.
    fields = ', '.join(dict.fromkeys(str(e['loc'][-1]) for e in exc.errors()))
    return JSONResponse({'detail': f'Проверьте поля: {fields}'}, status_code=422)


@app.get('/api/health')
def health(db=Depends(get_db, scope='function')):
    db.execute('SELECT 1').fetchone()
    return {'ok': True}


@app.get('/api/auth/config')
def auth_config():
    return {'doctorSignup': SIGNUP}


@app.post('/api/auth/register')
def register(data: m.Registration, request: Request, response: Response, db=Depends(get_db, scope='function')):
    if not SIGNUP:
        raise HTTPException(403, 'Регистрация врачей только по приглашению')
    auth_limit(request, data.login)
    if db.execute('SELECT 1 FROM users WHERE login=?', (data.login.lower(),)).fetchone():
        raise HTTPException(409, 'Этот логин уже занят')
    user_id = uid()
    try:
        db.execute('INSERT INTO users(id,role,login,name,password,created) VALUES(?,?,?,?,?,?)',
                   (user_id, 'doctor', data.login.lower(), data.name, HASHER.hash(data.password), now()))
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'Этот логин уже занят')
    audit(db, user_id, 'registered', user_id)
    code = recovery_code(db, user_id)
    session(db, response, user_id)
    return {'user': public_user(db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()), 'recoveryCode': code}


@app.post('/api/auth/login')
def login(data: m.Credentials, request: Request, response: Response, db=Depends(get_db, scope='function')):
    auth_limit(request, data.login)
    user = db.execute('SELECT * FROM users WHERE login=?', (data.login.lower(),)).fetchone()
    if not verify(user['password'] if user else None, data.password):
        raise HTTPException(401, 'Неверный логин или пароль')
    session(db, response, user['id'])
    audit(db, user['id'], 'login', user['id'])
    return {'user': public_user(user)}


@app.post('/api/auth/activate')
def activate(data: m.Activation, request: Request, response: Response, db=Depends(get_db, scope='function')):
    auth_limit(request)
    row = db.execute('SELECT * FROM invites WHERE token=? AND expires>?', (digest(data.token), time.time())).fetchone()
    if not row:
        raise HTTPException(400, 'Ссылка недействительна или срок действия истёк. Запросите новую у врача.')
    # Consume the invite within the same write transaction as the password change.
    consumed = db.execute('DELETE FROM invites WHERE token=? AND expires>?', (digest(data.token), time.time())).rowcount
    if not consumed:
        raise HTTPException(400, 'Ссылка уже использована')
    code = set_password(db, response, row['user_id'], data.password)
    user = db.execute('SELECT * FROM users WHERE id=?', (row['user_id'],)).fetchone()
    return {'user': public_user(user), 'recoveryCode': code}


@app.post('/api/auth/recover')
def recover(data: m.Recovery, request: Request, response: Response, db=Depends(get_db, scope='function')):
    auth_limit(request, data.login)
    row = db.execute('SELECT * FROM users WHERE login=? AND recovery=?', (data.login.lower(), digest(data.code))).fetchone()
    if not row:
        raise HTTPException(400, 'Неверный логин или код восстановления')
    # CAS makes the recovery code single use even for concurrent requests.
    changed = db.execute('UPDATE users SET recovery=NULL WHERE id=? AND recovery=?', (row['id'], digest(data.code))).rowcount
    if not changed:
        raise HTTPException(400, 'Код уже использован')
    code = set_password(db, response, row['id'], data.password)
    return {'user': public_user(row), 'recoveryCode': code}


@app.post('/api/auth/password')
def change_password(data: m.PasswordChange, request: Request, response: Response, user=Depends(current_user), db=Depends(get_db, scope='function')):
    auth_limit(request, user['login'])
    if not verify(user['password'], data.current):
        raise HTTPException(400, 'Текущий пароль указан неверно')
    return {'recoveryCode': set_password(db, response, user['id'], data.password)}


@app.post('/api/auth/logout')
def logout(request: Request, response: Response, user=Depends(current_user), db=Depends(get_db, scope='function')):
    db.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies.get(COOKIE, '')),))
    db.execute('DELETE FROM push_subscriptions WHERE device=? AND user_id=?',
               (digest(request.cookies.get(DEVICE_COOKIE, '')), user['id']))
    response.delete_cookie(COOKIE, path='/', httponly=True, secure=SECURE, samesite='strict')
    return {'ok': True}


@app.get('/api/state')
def state(user=Depends(current_user), db=Depends(get_db, scope='function')):
    is_doctor = user['role'] == 'doctor'
    patients = db.execute('SELECT * FROM patients WHERE ' + ('doctor_id=?' if is_doctor else 'user_id=?') + ' ORDER BY created DESC', (user['id'],)).fetchall()
    # Every collection is scoped through the relationship, including IDs supplied by clients.
    scope = 'SELECT id FROM patients WHERE ' + ('doctor_id=?' if is_doctor else 'user_id=?')
    def scoped(table, tail=''):
        return db.execute(f'SELECT * FROM {table} WHERE patient_id IN ({scope}) {tail}', (user['id'],)).fetchall()
    entries = [dict(id=r['id'], patientId=r['patient_id'], **json.loads(r['data']), created=r['created'], updated=r['updated']) for r in scoped('entries', 'ORDER BY day DESC')]
    visits = [serialize_visit(r, is_doctor) for r in scoped('visits', 'ORDER BY scheduled DESC')]
    messages = db.execute(f'''SELECT m.*,u.role,u.name,ms.sos_id AS audio_sos_id FROM messages m JOIN users u ON u.id=m.author
                              LEFT JOIN media_sos ms ON ms.media_id=m.media_id
                              WHERE m.patient_id IN ({scope}) ORDER BY m.created DESC LIMIT 500''', (user['id'],)).fetchall()
    sos = [dict(id=r['id'], patientId=r['patient_id'], status=r['status'], **json.loads(r['data']), created=r['created'], delivered=r['delivered'], answered=r['answered'], closed=r['closed']) for r in scoped('sos', 'ORDER BY created DESC')]
    prescriptions = [dict(id=r['id'], patientId=r['patient_id'], visitId=r['visit_id'], active=bool(r['active']), **json.loads(r['data'])) for r in scoped('prescriptions')]
    marks = [dict(id=r['id'], prescriptionId=r['prescription_id'], patientId=r['patient_id'], date=r['day'], time=r['slot'], status=r['status'], note=r['note'], updated=r['updated']) for r in scoped('medicine_marks')]
    notifications = [dict(id=r['id'], title=r['title'], link=r['link'], created=r['created'], readAt=r['read_at']) for r in db.execute('SELECT * FROM notifications WHERE user_id=? ORDER BY created DESC LIMIT 100', (user['id'],))]
    return dict(user=public_user(user), patients=[serialize_patient(db, p, is_doctor) for p in patients],
                entries=entries, visits=visits, messages=[serialize_message(r, user) for r in reversed(messages)],
                sosEvents=sos, prescriptions=prescriptions, marks=marks, notifications=notifications,
                settings=m.Settings(**json.loads(user['settings'])).model_dump(),
                **({'ai': {'enabled': ai.enabled()}} if is_doctor else {}))


@app.post('/api/patients')
def create_patient(data: m.PatientCreate, user=Depends(doctor), db=Depends(get_db, scope='function')):
    limit('patients:' + user['id'], 50, 3600)
    patient_id, user_id = uid(), uid()
    login = 'p.' + uid().replace('-', '')[:12]
    db.execute('INSERT INTO users(id,role,login,name,created) VALUES(?,?,?,?,?)', (user_id, 'patient', login, data.name, now()))
    profile = data.model_dump(mode='json', exclude={'consent'})
    db.execute('INSERT INTO patients(id,doctor_id,user_id,profile,created,updated) VALUES(?,?,?,?,?,?)',
               (patient_id, user['id'], user_id, dump(profile), now(), now()))
    audit(db, user['id'], 'patient_created_with_consent', patient_id)
    return {'id': patient_id, 'login': login, 'inviteUrl': invite(db, user_id)}


@app.post('/api/patients/{patient_id}/invite')
def patient_invite(patient_id: str, user=Depends(doctor), db=Depends(get_db, scope='function')):
    row = patient_row(db, user, patient_id)
    audit(db, user['id'], 'patient_invitation_created', patient_id)
    return {'inviteUrl': invite(db, row['user_id'])}


@app.put('/api/patients/{patient_id}/profile')
def patient_profile(patient_id: str, data: m.ProfileUpdate, user=Depends(doctor), db=Depends(get_db, scope='function')):
    p = patient_row(db, user, patient_id)
    profile = {**json.loads(p['profile']), **data.model_dump(mode='json', exclude={'version'})}
    changed = db.execute('UPDATE patients SET profile=?,version=version+1,updated=? WHERE id=? AND version=?',
                         (dump(profile), now(), patient_id, data.version)).rowcount
    if not changed:
        raise HTTPException(409, 'Карточка изменилась. Обновите страницу перед сохранением.')
    db.execute('UPDATE users SET name=? WHERE id=?', (data.name, p['user_id']))
    audit(db, user['id'], 'patient_profile_updated', patient_id)
    return {'ok': True}


@app.put('/api/patients/{patient_id}/clinical')
def clinical(patient_id: str, data: m.Clinical, user=Depends(doctor), db=Depends(get_db, scope='function')):
    p = patient_row(db, user, patient_id)
    values = {**json.loads(p['clinical']), **data.model_dump(exclude={'version'}, exclude_unset=True)}
    changed = db.execute('UPDATE patients SET clinical=?,version=version+1,updated=? WHERE id=? AND version=?',
                         (dump(values), now(), patient_id, data.version)).rowcount
    if not changed:
        raise HTTPException(409, 'Карточка изменилась в другой вкладке. Обновите страницу и повторите изменение.')
    audit(db, user['id'], 'clinical_updated', patient_id)
    return {'ok': True}


@app.put('/api/patients/{patient_id}/prescriptions')
def edit_prescriptions(patient_id: str, data: m.PrescriptionsUpdate, user=Depends(doctor), db=Depends(get_db, scope='function')):
    p = patient_row(db, user, patient_id)
    active = {row['id']: row for row in db.execute('SELECT * FROM prescriptions WHERE patient_id=? AND active=1', (patient_id,))}
    ids = [item.id for item in data.prescriptions if item.id]
    if len(ids) != len(set(ids)) or any(key not in active for key in ids):
        raise HTTPException(409, 'Назначения изменились. Обновите карточку перед сохранением.')
    changed = db.execute('UPDATE patients SET version=version+1,updated=? WHERE id=? AND version=?',
                         (now(), patient_id, data.version)).rowcount
    if not changed:
        raise HTTPException(409, 'Карточка изменилась. Обновите страницу, сохранив свой текст.')
    retained = set()
    for item in data.prescriptions:
        value = item.model_dump(mode='json', exclude={'id'})
        if item.id and m.Prescription.model_validate_json(active[item.id]['data']).model_dump(mode='json') == value:
            retained.add(item.id)
            continue
        db.execute('INSERT INTO prescriptions VALUES(?,?,NULL,?,1,?)', (uid(), patient_id, dump(value), now()))
    for key in active.keys() - retained:
        db.execute('UPDATE prescriptions SET active=0 WHERE id=?', (key,))
    audit(db, user['id'], 'prescriptions_updated_from_card', patient_id)
    notify(db, p['user_id'], 'Врач обновил назначения в карточке', '/patient/plan')
    return {'ok': True}


@app.put('/api/diary')
def diary(data: m.Diary, user=Depends(patient), db=Depends(get_db, scope='function')):
    p = patient_row(db, user)
    local_day = datetime.now(ZoneInfo(m.Settings(**json.loads(user['settings'])).timezone)).date()
    if data.date > local_day:
        raise HTTPException(422, 'Нельзя добавить запись в будущем')
    db.execute('BEGIN IMMEDIATE')
    media_check(db, user, p['id'], data.mediaId, 'diary')
    value = data.model_dump(mode='json')
    if 'alcohol' not in data.model_fields_set:
        # Older open tabs do not know these fields; do not erase an existing answer.
        previous = db.execute('SELECT data FROM entries WHERE patient_id=? AND day=?', (p['id'], data.date.isoformat())).fetchone()
        if previous:
            value.update({k: v for k, v in json.loads(previous['data']).items() if k.startswith('alcohol')})
    db.execute('''INSERT INTO entries VALUES(?,?,?,?,?,?,?) ON CONFLICT(patient_id,day)
                  DO UPDATE SET data=excluded.data,updated=excluded.updated''',
               (uid(), p['id'], data.date.isoformat(), dump(value), user['id'], now(), now()))
    earned = garden.reward(db, p['id'], f'diary:{data.date}', 3) if data.date >= local_day - timedelta(days=7) else 0
    notify(db, p['doctor_id'], 'Новая запись дневника', f"/doctor/patients/{p['id']}?tab=diary", digest(f"diary:{p['id']}:{data.date}"))
    audit(db, user['id'], 'diary_saved', p['id'])
    return {'ok': True, 'earnedDrops': earned}


@app.put('/api/garden/plant')
def choose_plant(data: m.PlantChoice, user=Depends(patient), db=Depends(get_db, scope='function')):
    p = patient_row(db, user)
    db.execute('''INSERT INTO patient_gardens VALUES(?,?,1,?) ON CONFLICT(patient_id)
                  DO UPDATE SET plant=excluded.plant,chosen=1,updated=excluded.updated''',
               (p['id'], data.plant, now()))
    return {'ok': True, 'garden': garden.snapshot(db, p['id'])}


@app.post('/api/garden/water')
def manual_watering_removed(user=Depends(patient)):
    # Older tabs may still contain this button. They cannot alter growth.
    raise HTTPException(410, 'Растение поливается автоматически после отметки приёма лекарства или заполнения дневника. Обновите страницу.')


@app.post('/api/visits')
def create_visit(data: m.VisitCreate, user=Depends(doctor), db=Depends(get_db, scope='function')):
    p = patient_row(db, user, data.patientId)
    visit_id = uid()
    scheduled = data.scheduled.astimezone(timezone.utc).isoformat()
    prescriptions = [json.loads(row['data']) for row in db.execute('SELECT data FROM prescriptions WHERE patient_id=? AND active=1', (p['id'],))]
    db.execute('INSERT INTO visits(id,patient_id,scheduled,data,created,updated) VALUES(?,?,?,?,?,?)',
               (visit_id, p['id'], scheduled, dump({'title': data.title, 'prescriptions': prescriptions, 'patientVersion': p['version']}), now(), now()))
    notify(db, p['user_id'], 'Врач запланировал приём', '/patient/plan')
    audit(db, user['id'], 'visit_created', visit_id)
    return {'id': visit_id}


@app.put('/api/visits/{visit_id}')
def edit_visit(visit_id: str, data: m.VisitEdit, user=Depends(doctor), db=Depends(get_db, scope='function')):
    v = visit_row(db, user, visit_id)
    if v['confirmed'] or v['status'] == 'cancelled':
        raise HTTPException(409, 'Завершённый приём нельзя изменить. Создайте новый приём для уточнений.')
    if data.confirm and not data.plan.strip():
        raise HTTPException(422, 'Заполните план перед подтверждением')
    if data.confirm and data.cancel:
        raise HTTPException(422, 'Выберите одно действие')
    # Only a prescription snapshot or an explicitly reviewed card version can
    # protect the plan. A clinicalDraft version covers different medical fields.
    patient_version_at_open = (data.patientVersion if data.patientVersion is not None else
                               json.loads(v['data']).get('patientVersion'))
    if data.confirm:
        if patient_version_at_open is None:
            raise HTTPException(409, 'В старом черновике нет версии назначений. Откройте приём и загрузите актуальные назначения из карточки.')
        p = patient_row(db, user, v['patient_id'])
        if p['version'] != patient_version_at_open:
            raise HTTPException(409, 'Карточка изменилась после открытия приёма. Загрузите и проверьте актуальные назначения.')
    if data.confirm and data.clinicalDraft:
        p = patient_row(db, user, v['patient_id'])
        if p['version'] != data.clinicalDraft.version:
            raise HTTPException(409, 'Медкарта изменилась. Повторно проверьте изменения карточки перед подтверждением.')
    status = 'confirmed' if data.confirm else 'cancelled' if data.cancel else 'draft'
    saved = data.model_dump(mode='json', exclude={'version', 'confirm', 'cancel'})
    saved['patientVersion'] = patient_version_at_open
    changed = db.execute('UPDATE visits SET data=?,status=?,version=version+1,updated=?,confirmed=? WHERE id=? AND version=?',
                         (dump(saved), status, now(), now() if data.confirm else None, visit_id, data.version)).rowcount
    if not changed:
        raise HTTPException(409, 'Приём изменился в другой вкладке. Обновите страницу, сохранив свой текст.')
    if data.confirm:
        # Confirmation publishes a complete replacement plan. Historical prescriptions remain immutable.
        db.execute('UPDATE prescriptions SET active=0 WHERE patient_id=?', (v['patient_id'],))
        for value in data.prescriptions:
            db.execute('INSERT INTO prescriptions VALUES(?,?,?,?,1,?)', (uid(), v['patient_id'], visit_id, dump(value.model_dump(mode='json')), now()))
        p = patient_row(db, user, v['patient_id'])
        clinical = json.loads(p['clinical'])
        if data.clinicalDraft:
            clinical.update(data.clinicalDraft.model_dump(exclude={'version'}, exclude_none=True))
        clinical['diagnosis'] = data.diagnosis or clinical.get('diagnosis', '')
        clinical['treatment'] = data.plan
        citations = clinical.get('citations', [])
        for citation in data.citations:
            value = citation.model_dump()
            if value not in citations:
                citations.append(value)
        if len(citations) > 20:
            raise HTTPException(422, 'В карточке слишком много цитат. Удалите неактуальные ссылки перед подтверждением.')
        clinical['citations'] = citations
        patient_version = patient_version_at_open
        changed = db.execute('UPDATE patients SET clinical=?,version=version+1,updated=? WHERE id=? AND version=?',
                             (dump(clinical), now(), p['id'], patient_version)).rowcount
        if not changed:
            raise HTTPException(409, 'Медкарта изменилась. Проверьте её перед подтверждением.')
        if data.clinicalDraft:
            audit(db, user['id'], 'clinical_draft_confirmed', p['id'])
        notify(db, p['user_id'], 'Врач подтвердил новый план', '/patient/plan')
    elif data.cancel:
        p = patient_row(db, user, v['patient_id'])
        notify(db, p['user_id'], 'Приём отменён', '/patient/plan')
    audit(db, user['id'], 'visit_' + status, visit_id)
    return {'ok': True}


@app.put('/api/prescriptions/{prescription_id}/mark')
def mark(prescription_id: str, data: m.Mark, user=Depends(patient), db=Depends(get_db, scope='function')):
    p = patient_row(db, user)
    row = db.execute('SELECT * FROM prescriptions WHERE id=? AND patient_id=?', (prescription_id, p['id'])).fetchone()
    if not row or not row['active']:
        raise HTTPException(404, 'Действующее назначение не найдено')
    value = json.loads(row['data'])
    today = datetime.now(ZoneInfo(m.Settings(**json.loads(user['settings'])).timezone)).date()
    if data.date > today or data.date < today - timedelta(days=7) or data.date.isoformat() < value['start'] or (value.get('end') and data.date.isoformat() > value['end']) or data.time not in value['times']:
        raise HTTPException(422, 'Проверьте дату и время приёма')
    db.execute('''INSERT INTO medicine_marks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(prescription_id,day,slot)
                  DO UPDATE SET status=excluded.status,note=excluded.note,updated=excluded.updated''',
               (uid(), prescription_id, p['id'], data.date.isoformat(), data.time, data.status, data.note, now()))
    audit(db, user['id'], 'medicine_' + data.status, prescription_id)
    earned = garden.reward(db, p['id'], f'medicine:{prescription_id}:{data.date}:{data.time}', 1) if data.status == 'taken' else 0
    return {'ok': True, 'earnedDrops': earned}


@app.post('/api/messages')
def send_message(data: m.MessageCreate, user=Depends(current_user), db=Depends(get_db, scope='function')):
    p = patient_row(db, user, data.patientId)
    limit('message:' + user['id'], 90, 60)
    db.execute('BEGIN IMMEDIATE')
    if data.sosId:
        s = sos_row(db, user, data.sosId)
        if s['patient_id'] != p['id'] or s['closed']:
            raise HTTPException(409, 'SOS-обращение закрыто или недоступно')
    media_check(db, user, p['id'], data.mediaId, 'message', data.sosId)
    existing = db.execute('SELECT * FROM messages WHERE id=?', (data.id,)).fetchone()
    if existing:
        if existing['author'] == user['id'] and existing['patient_id'] == p['id'] and existing['body'] == data.text and existing['sos_id'] == data.sosId and existing['media_id'] == data.mediaId:
            return {'id': existing['id']}
        raise HTTPException(409, 'Идентификатор сообщения уже использован')
    db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,NULL)', (data.id, p['id'], user['id'], data.text, data.sosId, data.mediaId, now()))
    if data.sosId and data.mediaId:
        db.execute('INSERT OR IGNORE INTO media_sos VALUES(?,?)', (data.mediaId, data.sosId))
    recipient = p['doctor_id'] if user['role'] == 'patient' else p['user_id']
    link = f"/doctor/messages?patient={p['id']}" if user['role'] == 'patient' else '/patient/messages'
    if data.sosId:
        link = f"/doctor/sos?id={data.sosId}" if user['role'] == 'patient' else '/patient/sos'
        if user['role'] == 'doctor':
            db.execute("UPDATE sos SET status='answered',answered=COALESCE(answered,?),delivered=COALESCE(delivered,?) WHERE id=?", (now(), now(), data.sosId))
    notify(db, recipient, 'Новое сообщение в SOS' if data.sosId else 'Новое сообщение', link, urgent=bool(data.sosId))
    return {'id': data.id}


@app.get('/api/messages')
def message_history(patientId: str, before: str = '', sosId: str = '', user=Depends(current_user), db=Depends(get_db, scope='function')):
    patient_row(db, user, patientId)
    rows = db.execute('''SELECT m.*,u.role,u.name,ms.sos_id AS audio_sos_id FROM messages m JOIN users u ON u.id=m.author
                         LEFT JOIN media_sos ms ON ms.media_id=m.media_id
                         WHERE m.patient_id=? AND COALESCE(m.sos_id,'')=? AND (?='' OR m.created<?)
                         ORDER BY m.created DESC LIMIT 100''', (patientId, sosId, before, before)).fetchall()
    return [serialize_message(r, user) for r in reversed(rows)]


@app.post('/api/messages/read')
def read_messages(data: m.ReadMessages, user=Depends(current_user), db=Depends(get_db, scope='function')):
    scope = 'SELECT id FROM patients WHERE ' + ('doctor_id=?' if user['role'] == 'doctor' else 'user_id=?')
    if data.ids:
        args = ','.join('?' for _ in data.ids)
        db.execute(f'UPDATE messages SET read_at=? WHERE id IN ({args}) AND author!=? AND patient_id IN ({scope}) AND read_at IS NULL',
                   (now(), *data.ids, user['id'], user['id']))
    return {'ok': True}


@app.post('/api/sos')
def start_sos(user=Depends(patient), db=Depends(get_db, scope='function')):
    p = patient_row(db, user)
    sos_id = uid()
    db.execute('INSERT OR IGNORE INTO sos(id,patient_id,data,created) VALUES(?,?,?,?)',
               (sos_id, p['id'], dump({'severity': 5, 'danger': '', 'detail': '', 'medication': ''}), now()))
    s = db.execute('SELECT * FROM sos WHERE patient_id=? AND closed IS NULL', (p['id'],)).fetchone()
    notify(db, p['doctor_id'], 'Новое SOS-обращение', f"/doctor/sos?id={s['id']}", 'sos:' + s['id'], urgent=True)
    audit(db, user['id'], 'sos_sent', s['id'])
    return {'id': s['id']}


@app.put('/api/sos/{sos_id}')
def edit_sos(sos_id: str, data: m.SosEdit, user=Depends(patient), db=Depends(get_db, scope='function')):
    s = sos_row(db, user, sos_id)
    if s['closed']:
        raise HTTPException(409, 'Обращение закрыто. При необходимости создайте новое.')
    db.execute('UPDATE sos SET data=? WHERE id=?', (dump(data.model_dump()), sos_id))
    return {'ok': True}


@app.post('/api/sos/{sos_id}/read')
def read_sos(sos_id: str, user=Depends(doctor), db=Depends(get_db, scope='function')):
    sos_row(db, user, sos_id)
    db.execute("UPDATE sos SET delivered=COALESCE(delivered,?),status=CASE WHEN status='sent' THEN 'delivered' ELSE status END WHERE id=?", (now(), sos_id))
    return {'ok': True}


@app.post('/api/sos/{sos_id}/close')
def close_sos(sos_id: str, user=Depends(doctor), db=Depends(get_db, scope='function')):
    s = sos_row(db, user, sos_id)
    db.execute("UPDATE sos SET status='closed',closed=COALESCE(closed,?) WHERE id=?", (now(), sos_id))
    p = patient_row(db, user, s['patient_id'])
    notify(db, p['user_id'], 'Врач завершил SOS-обращение', '/patient/sos')
    audit(db, user['id'], 'sos_closed', sos_id)
    return {'ok': True}


@app.put('/api/settings')
def settings(data: m.Settings, user=Depends(current_user), db=Depends(get_db, scope='function')):
    db.execute('UPDATE users SET settings=? WHERE id=?', (dump(data.model_dump()), user['id']))
    return {'ok': True}


@app.post('/api/notifications/{notification_id}/read')
def read_notification(notification_id: str, user=Depends(current_user), db=Depends(get_db, scope='function')):
    db.execute('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?', (now(), notification_id, user['id']))
    return {'ok': True}


@app.post('/api/media')
def upload(patientId: str = Form(...), purpose: str = Form(...), visitId: str = Form(''), sosId: str = Form(''), consent: bool = Form(...),
           audio: UploadFile = File(...), user=Depends(current_user), db=Depends(get_db, scope='function')):
    patient_row(db, user, patientId)
    if not consent:
        raise HTTPException(422, 'Необходимо согласие на передачу аудиозаписи')
    limit('upload:' + user['id'], 30, 3600)
    if purpose not in ('message', 'diary', 'visit') or (purpose == 'diary' and user['role'] != 'patient'):
        raise HTTPException(422, 'Неверное назначение записи')
    if purpose == 'visit':
        if user['role'] != 'doctor':
            raise HTTPException(403, 'Запись приёма доступна врачу')
        v = visit_row(db, user, visitId)
        if v['patient_id'] != patientId or v['confirmed'] or v['status'] == 'cancelled':
            raise HTTPException(409, 'Нельзя добавить запись к этому приёму')
    elif visitId:
        raise HTTPException(422, 'Неверное назначение записи')
    if sosId:
        s = sos_row(db, user, sosId)
        if purpose != 'message' or s['patient_id'] != patientId or s['closed']:
            raise HTTPException(409, 'SOS-обращение закрыто или недоступно')
    mime = (audio.content_type or '').split(';')[0]
    mime = {'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'video/mp4': 'audio/mp4', 'video/webm': 'audio/webm', 'audio/mp3': 'audio/mpeg'}.get(mime, mime)
    if mime not in ('audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/mpeg'):
        raise HTTPException(415, 'Поддерживаются аудиозаписи WebM, Ogg, MP3, M4A / MP4 и WAV')
    # Validate the signature and bound both single-file and per-user storage use.
    head = audio.file.read(32)
    valid = ((mime == 'audio/webm' and head.startswith(b'\x1a\x45\xdf\xa3')) or
             (mime == 'audio/ogg' and head.startswith(b'OggS')) or
             (mime == 'audio/mp4' and head[4:8] == b'ftyp') or
             (mime == 'audio/mpeg' and (head.startswith(b'ID3') or (len(head) >= 2 and head[0] == 0xff and head[1] & 0xe0 == 0xe0))) or
             (mime in ('audio/wav', 'audio/x-wav') and head.startswith(b'RIFF') and head[8:12] == b'WAVE'))
    if not valid:
        raise HTTPException(415, 'Файл не похож на поддерживаемую аудиозапись')
    used = db.execute('SELECT COALESCE(SUM(bytes),0) FROM media WHERE author=?', (user['id'],)).fetchone()[0]
    if used > 2 * 1024**3:
        raise HTTPException(413, 'Достигнут лимит аудиозаписей аккаунта. Обратитесь к администратору.')
    media_id = uid()
    path = DATA / 'media' / media_id
    size = len(head)
    try:
        with path.open('xb') as out:
            os.chmod(path, 0o600)
            out.write(head)
            while chunk := audio.file.read(65536):
                size += len(chunk)
                if size > 25 * 1024**2:
                    raise HTTPException(413, 'Максимальный размер записи — 25 МБ')
                out.write(chunk)
        db.execute('INSERT INTO media VALUES(?,?,?,?,?,?,?,?)', (media_id, patientId, user['id'], mime, size, purpose, visitId or None, now()))
        if sosId:
            db.execute('INSERT INTO media_sos VALUES(?,?)', (media_id, sosId))
        audit(db, user['id'], 'audio_uploaded_with_consent', media_id)
        db.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {'id': media_id}


@app.get('/api/visits/{visit_id}/media')
def visit_media(visit_id: str, user=Depends(doctor), db=Depends(get_db, scope='function')):
    visit_row(db, user, visit_id)
    return [dict(id=r['id'], created=r['created'], canDelete=r['author'] == user['id'])
            for r in db.execute('SELECT id,created,author FROM media WHERE visit_id=? ORDER BY created', (visit_id,))]


@app.delete('/api/media/{media_id}')
def delete_audio(media_id: str, data: m.MediaDelete, user=Depends(current_user), db=Depends(get_db, scope='function')):
    # Serialize deletion with attachment publication and transcription leases.
    db.execute('BEGIN IMMEDIATE')
    row = media_row(db, user, media_id)
    if row['author'] != user['id']:
        raise HTTPException(403, 'Можно удалить только свою голосовую запись.')
    if db.execute('SELECT 1 FROM media_sos WHERE media_id=?', (media_id,)).fetchone():
        raise HTTPException(403, 'Голосовые записи SOS нельзя удалять.')
    if db.execute('SELECT 1 FROM ai_locks WHERE key=? AND expires>?', ('transcript:' + media_id, time.time())).fetchone():
        raise HTTPException(409, 'Дождитесь окончания расшифровки, затем повторите удаление.')
    db.execute('UPDATE messages SET media_id=NULL WHERE media_id=?', (media_id,))
    db.execute("UPDATE entries SET data=json_remove(data,'$.mediaId'),updated=? WHERE json_extract(data,'$.mediaId')=?", (now(), media_id))
    db.execute('DELETE FROM media WHERE id=?', (media_id,))
    db.execute('INSERT INTO pending_media_deletions VALUES(?,?)', (media_id, now()))
    audit(db, user['id'], 'audio_deleted', media_id)
    db.commit()
    purge_deleted_audio()
    return {'ok': True}


@app.get('/api/media/{media_id}')
def download(media_id: str, user=Depends(current_user), db=Depends(get_db, scope='function')):
    row = media_row(db, user, media_id)
    path = DATA / 'media' / row['id']
    if not path.is_file():
        raise HTTPException(404, 'Запись не найдена')
    return FileResponse(path, media_type=row['mime'], headers={'Cache-Control': 'private, no-store'})


def media_row(db, user, media_id):
    row = db.execute('SELECT * FROM media WHERE id=?', (media_id,)).fetchone()
    if not row:
        raise HTTPException(404, 'Запись не найдена')
    patient_row(db, user, row['patient_id'])
    if row['purpose'] == 'visit' and user['role'] != 'doctor':
        raise HTTPException(403, 'Запись доступна врачу')
    if row['author'] != user['id'] and row['purpose'] == 'message' and not db.execute('SELECT 1 FROM messages WHERE media_id=?', (media_id,)).fetchone():
        raise HTTPException(404, 'Запись ещё не отправлена')
    if row['author'] != user['id'] and row['purpose'] == 'diary' and not db.execute("SELECT 1 FROM entries WHERE json_extract(data,'$.mediaId')=?", (media_id,)).fetchone():
        raise HTTPException(404, 'Запись ещё не сохранена')
    return row
