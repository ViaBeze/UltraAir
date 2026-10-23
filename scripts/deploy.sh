#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Build locally with `npm run build` before running this script.
test -f dist/index.html
RYADOM_HOST="${RYADOM_HOST:-root@194.58.114.49}"
RYADOM_KEY="${RYADOM_KEY:-$HOME/.ssh/reg_ai_server_ed25519}"
RYADOM_RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
RYADOM_DEST="/var/www/ryadom/releases/$RYADOM_RELEASE"
SSH=(ssh -i "$RYADOM_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$RYADOM_HOST")

"${SSH[@]}" "install -d -m 755 '$RYADOM_DEST' /var/www/ryadom/acme /opt/ryadom"
tar -C dist -cf - . | "${SSH[@]}" "tar --no-same-owner -xf - -C '$RYADOM_DEST'"
tar -C deploy -cf - . | "${SSH[@]}" 'tar --no-same-owner -xf - -C /opt/ryadom'
"${SSH[@]}" "find '$RYADOM_DEST' -type d -exec chmod 755 {} + && find '$RYADOM_DEST' -type f -exec chmod 644 {} +"
"${SSH[@]}" 'if test -L /var/www/ryadom/current; then ln -sfn "$(readlink /var/www/ryadom/current)" /var/www/ryadom/previous; fi'
"${SSH[@]}" "ln -sfn '$RYADOM_DEST' /var/www/ryadom/current.next
mv -Tf /var/www/ryadom/current.next /var/www/ryadom/current"
"${SSH[@]}" 'cp /opt/ryadom/ryadom-api.conf /etc/nginx/snippets/ryadom-api.conf
cp /opt/ryadom/ryadom-static.conf /etc/nginx/snippets/ryadom-static.conf
if ! test -f /etc/nginx/sites-available/ryadom; then cp /opt/ryadom/ryadom-http.conf /etc/nginx/sites-available/ryadom; fi
ln -sfn /etc/nginx/sites-available/ryadom /etc/nginx/sites-enabled/ryadom
nginx -t
systemctl reload nginx
chmod 755 /opt/ryadom/ryadom-enable-tls.sh
cp /opt/ryadom/ryadom-tls.service /opt/ryadom/ryadom-tls.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ryadom-tls.timer
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 755 /opt/ryadom/ryadom-reload.sh /etc/letsencrypt/renewal-hooks/deploy/ryadom-reload
systemctl start ryadom-tls.service'
echo "Deployed release $RYADOM_RELEASE to https://ryadomhelp.online"
