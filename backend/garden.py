"""Server-owned garden progress, awarded in the same transaction as each record."""
from .db import now


def reward(db, patient_id, source, amount):
    added = db.execute('INSERT OR IGNORE INTO garden_rewards VALUES(?,?,?,?)',
                       (patient_id, source, amount, now())).rowcount
    return amount if added else 0


def snapshot(db, patient_id):
    garden = db.execute('SELECT * FROM patient_gardens WHERE patient_id=?', (patient_id,)).fetchone()
    earned = db.execute('SELECT COALESCE(SUM(amount),0) FROM garden_rewards WHERE patient_id=?', (patient_id,)).fetchone()[0]
    # Every earned drop goes straight into growth. Previous manual waterings
    # already spent these same rewards and must never be counted a second time.
    return dict(plant=garden['plant'] if garden else 'cornflower', chosen=bool(garden and garden['chosen']),
                growth=earned,
                # Keep already open older clients readable, with no spendable balance.
                drops=0, earned=earned, watered=earned,
                stage=3 if earned >= 30 else 2 if earned >= 15 else 1 if earned >= 6 else 0)
