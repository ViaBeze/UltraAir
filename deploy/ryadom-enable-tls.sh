#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f /etc/letsencrypt/live/ryadomhelp.online/fullchain.pem ]]; then
    # Query the domain's authoritative servers to avoid an old parking IP cached by a resolver.
    if ! python3 - <<'PY'
import socket, struct, sys, concurrent.futures

def skip(data, pos):
    while data[pos]:
        if data[pos] & 192 == 192:
            return pos + 2
        pos += data[pos] + 1
    return pos + 1

def query(args):
    server, host, kind = args
    question = b''.join(bytes([len(p)]) + p.encode() for p in host.split('.')) + b'\0' + struct.pack('!HH', kind, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as conn:
        conn.settimeout(5)
        conn.sendto(struct.pack('!HHHHHH', 24193, 0, 1, 0, 0, 0) + question, (socket.gethostbyname(server), 53))
        data, _ = conn.recvfrom(4096)
    _, flags, questions, answers, _, _ = struct.unpack('!HHHHHH', data[:12])
    if not flags & 1024 or flags & 15:
        return False
    pos, found = 12, set()
    for _ in range(questions):
        pos = skip(data, pos) + 4
    for _ in range(answers):
        pos = skip(data, pos)
        typ, cls, ttl, length = struct.unpack('!HHIH', data[pos:pos+10])
        pos += 10
        if typ == kind:
            found.add(socket.inet_ntop(socket.AF_INET if kind == 1 else socket.AF_INET6, data[pos:pos+length]))
        pos += length
    return found == ({'194.58.114.49'} if kind == 1 else set())

try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        checks = list(pool.map(query, [(s,h,k) for s in ('ns1.reg.ru','ns2.reg.ru') for h in ('ryadomhelp.online','www.ryadomhelp.online') for k in (1,28)]))
    sys.exit(0 if all(checks) else 1)
except (OSError, ValueError, IndexError, struct.error):
    sys.exit(1)
PY
    then
        echo 'Waiting for authoritative A records @ and www: 194.58.114.49 (and no AAAA records)'
        exit 0
    fi
    # Back off after an ACME failure to avoid repeated certificate requests during DNS propagation.
    if [[ -f /opt/ryadom/last-acme-attempt ]] && [[ $(( $(date +%s) - $(stat -c %Y /opt/ryadom/last-acme-attempt) )) -lt 1800 ]]; then
        echo 'Waiting before retrying certificate issuance'
        exit 0
    fi
    touch /opt/ryadom/last-acme-attempt
    certbot certonly --webroot -w /var/www/ryadom/acme \
        --cert-name ryadomhelp.online --domain ryadomhelp.online \
        --domain www.ryadomhelp.online --non-interactive --agree-tos \
        --register-unsafely-without-email --quiet
fi

if ! cmp -s /opt/ryadom/ryadom-https.conf /etc/nginx/sites-available/ryadom; then
    cp /etc/nginx/sites-available/ryadom /etc/nginx/sites-available/ryadom.before-https
    cp /opt/ryadom/ryadom-https.conf /etc/nginx/sites-available/ryadom
    if nginx -t; then
        systemctl reload nginx
    else
        cp /etc/nginx/sites-available/ryadom.before-https /etc/nginx/sites-available/ryadom
        exit 1
    fi
fi
echo 'HTTPS configured for ryadomhelp.online and www.ryadomhelp.online'
