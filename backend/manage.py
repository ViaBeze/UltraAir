"""Server-only account recovery and consistent database/audio snapshots."""
import argparse
import sqlite3
import tarfile
from contextlib import closing
from datetime import datetime, timezone, timedelta
from pathlib import Path
from .db import DATA, init_db, transaction, now, uid, audit
from .auth import invite


def backup(destination):
    folder = Path(destination)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    database_copy = folder / (stamp + '.sqlite3')
    with transaction() as source:
        with closing(sqlite3.connect(database_copy)) as target:
            source.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
            media_ids = [r[0] for r in target.execute('SELECT id FROM media')]
    archive = folder / (stamp + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(database_copy, arcname='ryadom.sqlite3')
        if (DATA / 'vapid.pem').exists():
            tar.add(DATA / 'vapid.pem', arcname='vapid.pem')
        for media_id in media_ids:
            tar.add(DATA/'media'/media_id, arcname='media/'+media_id)
    archive.chmod(0o600)
    database_copy.unlink()
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    for old in folder.glob('*.tar.gz'):
        if datetime.fromtimestamp(old.stat().st_mtime, timezone.utc) < cutoff:
            old.unlink()
    print('Backup verified:', archive.name)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    create = sub.add_parser('invite-doctor')
    create.add_argument('--login', required=True)
    create.add_argument('--name', required=True)
    recover = sub.add_parser('reset-access')
    recover.add_argument('--login', required=True)
    save = sub.add_parser('backup')
    save.add_argument('--destination', default='/var/backups/ryadom')
    args = parser.parse_args()
    init_db()
    if args.action == 'backup':
        return backup(args.destination)
    with transaction() as db:
        if args.action == 'invite-doctor':
            user_id = uid()
            db.execute('INSERT INTO users(id,role,login,name,created) VALUES(?,?,?,?,?)', (user_id,'doctor',args.login.lower(),args.name,now()))
            audit(db,user_id,'doctor_invited_by_operator',user_id)
        else:
            row = db.execute('SELECT id FROM users WHERE login=?',(args.login.lower(),)).fetchone()
            if not row:
                raise SystemExit('Account not found')
            user_id = row['id']
            audit(db,user_id,'access_reset_by_operator',user_id)
        print(invite(db,user_id))


if __name__ == '__main__':
    main()
