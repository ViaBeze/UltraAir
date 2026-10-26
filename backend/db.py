"""Private, transactional storage. No application data lives in the web root."""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

DATA = Path(os.environ.get('RYADOM_DATA', '.local-data')).resolve()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def uid():
    return str(uuid4())


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def connect():
    db = sqlite3.connect(DATA / 'ryadom.sqlite3', timeout=15, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=15000')
    return db


@contextmanager
def transaction():
    db = connect()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def get_db():
    with transaction() as db:
        yield db


def init_db():
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    (DATA / 'media').mkdir(mode=0o700, exist_ok=True)
    with transaction() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_version VALUES(1);
        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('doctor','patient')),
          login TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
          password TEXT, recovery TEXT, settings TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires REAL NOT NULL, seen REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
        CREATE TABLE IF NOT EXISTS patients(
          id TEXT PRIMARY KEY, doctor_id TEXT NOT NULL REFERENCES users(id),
          user_id TEXT NOT NULL UNIQUE REFERENCES users(id), profile TEXT NOT NULL,
          clinical TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
          created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS patients_doctor ON patients(doctor_id);
        CREATE TABLE IF NOT EXISTS invites(
          token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires REAL NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entries(
          id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
          day TEXT NOT NULL, data TEXT NOT NULL, author TEXT NOT NULL REFERENCES users(id),
          created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(patient_id,day));
        CREATE TABLE IF NOT EXISTS visits(
          id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
          scheduled TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
          data TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
          created TEXT NOT NULL, updated TEXT NOT NULL, confirmed TEXT);
        CREATE INDEX IF NOT EXISTS visits_patient ON visits(patient_id,scheduled);
        CREATE TABLE IF NOT EXISTS prescriptions(
          id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
          visit_id TEXT NOT NULL REFERENCES visits(id), data TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS medicine_marks(
          id TEXT PRIMARY KEY, prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
          patient_id TEXT NOT NULL REFERENCES patients(id), day TEXT NOT NULL,
          slot TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
          updated TEXT NOT NULL, UNIQUE(prescription_id,day,slot));
        CREATE TABLE IF NOT EXISTS sos(
          id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
          status TEXT NOT NULL DEFAULT 'sent', data TEXT NOT NULL DEFAULT '{}',
          created TEXT NOT NULL, delivered TEXT, answered TEXT, closed TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS sos_active ON sos(patient_id) WHERE closed IS NULL;
        CREATE TABLE IF NOT EXISTS media(
          id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
          author TEXT NOT NULL REFERENCES users(id), mime TEXT NOT NULL, bytes INTEGER NOT NULL,
          purpose TEXT NOT NULL, visit_id TEXT REFERENCES visits(id), created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(
          id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
          author TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
          sos_id TEXT REFERENCES sos(id), media_id TEXT REFERENCES media(id),
          created TEXT NOT NULL, read_at TEXT);
        CREATE INDEX IF NOT EXISTS messages_patient ON messages(patient_id,created);
        CREATE INDEX IF NOT EXISTS messages_media ON messages(media_id);
        CREATE TABLE IF NOT EXISTS media_sos(
          media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
          sos_id TEXT NOT NULL REFERENCES sos(id));
        INSERT OR IGNORE INTO media_sos
          SELECT media_id,sos_id FROM messages WHERE media_id IS NOT NULL AND sos_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS pending_media_deletions(
          media_id TEXT PRIMARY KEY, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notifications(
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          title TEXT NOT NULL, link TEXT NOT NULL, created TEXT NOT NULL, read_at TEXT);
        CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created);
        CREATE TABLE IF NOT EXISTS push_subscriptions(
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          device TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL,
          regular INTEGER NOT NULL DEFAULT 1, urgent INTEGER NOT NULL DEFAULT 1,
          created TEXT NOT NULL, updated TEXT NOT NULL, last_success TEXT);
        CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
        CREATE TABLE IF NOT EXISTS push_jobs(
          id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
          notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
          urgent INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
          due REAL NOT NULL, expires REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          last_code INTEGER, UNIQUE(subscription_id,notification_id));
        CREATE INDEX IF NOT EXISTS push_due ON push_jobs(status,due);
        CREATE TABLE IF NOT EXISTS audit(
          id TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES users(id),
          action TEXT NOT NULL, entity TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_transcripts(
          media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
          text TEXT NOT NULL, model TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(id), created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_visit_drafts(
          visit_id TEXT PRIMARY KEY REFERENCES visits(id) ON DELETE CASCADE,
          source TEXT NOT NULL, source_hash TEXT NOT NULL, data TEXT NOT NULL,
          visit_version INTEGER NOT NULL, patient_version INTEGER NOT NULL,
          model TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(id), created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_locks(key TEXT PRIMARY KEY, token TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS medicine_search_cache(key TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS patient_gardens(
          patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
          plant TEXT NOT NULL DEFAULT 'cornflower' CHECK(plant IN ('cornflower','cactus','daisy','monstera')),
          chosen INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS garden_rewards(
          patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
          source TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), created TEXT NOT NULL,
          PRIMARY KEY(patient_id,source));
        CREATE TABLE IF NOT EXISTS garden_waterings(
          patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount = 3), created TEXT NOT NULL,
          PRIMARY KEY(patient_id,request_id));
        ''')
        if not db.execute('SELECT 1 FROM schema_version WHERE version=2').fetchone():
            # Preserve credit for existing records; their edits cannot award a second time.
            db.execute('''INSERT OR IGNORE INTO garden_rewards
                          SELECT patient_id,'diary:' || day,3,created FROM entries''')
            db.execute('''INSERT OR IGNORE INTO garden_rewards
                          SELECT patient_id,'medicine:' || prescription_id || ':' || day || ':' || slot,1,updated
                          FROM medicine_marks WHERE status='taken' ''')
            db.execute('INSERT INTO schema_version VALUES(2)')
    os.chmod(DATA / 'ryadom.sqlite3', 0o600)


def audit(db, actor, action, entity):
    db.execute('INSERT INTO audit VALUES(?,?,?,?,?)', (uid(), actor, action, entity, now()))


def notify(db, user_id, title, link, notification_id=None, *, urgent=False, subscription_id=None):
    import time
    notification_id = notification_id or uid()
    inserted = db.execute('INSERT OR IGNORE INTO notifications VALUES(?,?,?,?,?,NULL)',
                          (notification_id, user_id, title, link, now())).rowcount
    if inserted:
        # Same transaction as the event: a restart cannot lose an accepted alert.
        for sub in db.execute('SELECT * FROM push_subscriptions WHERE user_id=?', (user_id,)):
            if subscription_id and sub['id'] != subscription_id:
                continue
            if not sub['urgent' if urgent else 'regular'] and not subscription_id:
                continue
            stamp = time.time()
            db.execute('INSERT INTO push_jobs(id,subscription_id,notification_id,urgent,due,expires) VALUES(?,?,?,?,?,?)',
                       (uid(), sub['id'], notification_id, int(urgent), stamp, stamp + (3600 if urgent else 86400)))
    return notification_id
