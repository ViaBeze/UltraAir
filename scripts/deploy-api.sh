#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
RYADOM_HOST="${RYADOM_HOST:-root@194.58.114.49}"
RYADOM_KEY="${RYADOM_KEY:-$HOME/.ssh/reg_ai_server_ed25519}"
RYADOM_RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
RYADOM_DEST="/opt/ryadom/api/releases/$RYADOM_RELEASE"
SSH=(ssh -i "$RYADOM_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$RYADOM_HOST")
"${SSH[@]}" "install -d -m 755 '$RYADOM_DEST' /opt/ryadom"
tar --exclude='__pycache__' --exclude='test_*' -cf - backend | "${SSH[@]}" "tar --no-same-owner -xf - -C '$RYADOM_DEST'"
tar -C deploy -cf - . | "${SSH[@]}" 'tar --no-same-owner -xf - -C /opt/ryadom'
"${SSH[@]}" 'chmod 755 /opt/ryadom/ryadom-enable-tls.sh /opt/ryadom/ryadom-reload.sh'
"${SSH[@]}" 'id ryadom >/dev/null 2>&1 || useradd --system --home /var/lib/ryadom --shell /usr/sbin/nologin ryadom
install -d -o ryadom -g ryadom -m 700 /var/lib/ryadom /var/backups/ryadom
install -d -m 700 /etc/ryadom
if ! test -f /etc/ryadom/api.env; then
    umask 077
    cat > /etc/ryadom/api.env <<EOF
RYADOM_DATA=/var/lib/ryadom
RYADOM_PUBLIC_URL=https://ryadomhelp.online
RYADOM_ORIGINS=https://ryadomhelp.online
RYADOM_DOCTOR_SIGNUP=1
EOF
fi
umask 022
test -d /opt/ryadom/api/venv || python3 -m venv /opt/ryadom/api/venv'
"${SSH[@]}" "/opt/ryadom/api/venv/bin/pip install -r '$RYADOM_DEST/backend/requirements.lock' --quiet"
"${SSH[@]}" 'chmod -R a+rX /opt/ryadom/api/venv'
"${SSH[@]}" 'if systemctl is-active --quiet ryadom-api; then systemctl start ryadom-backup.service; fi
if test -L /opt/ryadom/api/current; then ln -sfn "$(readlink /opt/ryadom/api/current)" /opt/ryadom/api/previous; fi'
"${SSH[@]}" "ln -sfn '$RYADOM_DEST' /opt/ryadom/api/current.next
mv -Tf /opt/ryadom/api/current.next /opt/ryadom/api/current"
"${SSH[@]}" 'cp /opt/ryadom/ryadom-api.service /opt/ryadom/ryadom-backup.service /opt/ryadom/ryadom-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable ryadom-api.service
systemctl restart ryadom-api.service
systemctl enable --now ryadom-backup.timer
for attempt in 1 2 3 4 5; do
    if curl -fsS http://127.0.0.1:8000/api/health; then exit 0; fi
    sleep 1
done
if test -L /opt/ryadom/api/previous; then
    ln -sfn "$(readlink /opt/ryadom/api/previous)" /opt/ryadom/api/current
    systemctl restart ryadom-api.service
fi
exit 1'
echo "API deployed: $RYADOM_RELEASE"
