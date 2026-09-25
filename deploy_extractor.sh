#!/bin/bash
# Разворачивает kino-extractor на VPS: служба systemd + nginx-локация /kino/.
set -e
APP=/opt/kino-extractor
mkdir -p "$APP" /var/lib/kino-extractor
cp /tmp/kino_extractor.py "$APP/kino_extractor.py"
chmod 755 "$APP/kino_extractor.py"
python3 -c "import ast,sys; ast.parse(open('$APP/kino_extractor.py',encoding='utf-8').read())" && echo "синтаксис python: ok"

if [ ! -f /etc/kino-extractor.json ]; then
  TOKEN=$(openssl rand -hex 16)
  python3 - "$TOKEN" <<'PY'
import json, sys
json.dump({"token": sys.argv[1], "port": 8791}, open("/etc/kino-extractor.json", "w"))
PY
  chmod 600 /etc/kino-extractor.json
fi
TOKEN=$(python3 -c "import json;print(json.load(open('/etc/kino-extractor.json'))['token'])")

cat > /etc/systemd/system/kino-extractor.service <<'UNIT'
[Unit]
Description=kino-extractor (HDrezka для Lampa)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/kino-extractor/kino_extractor.py --config /etc/kino-extractor.json
Restart=always
RestartSec=3
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

python3 - <<'PY'
import re
path = "/etc/nginx/sites-enabled/default"
src = open(path, encoding="utf-8").read()
block = """\tlocation /kino/ {
\t\tproxy_pass http://127.0.0.1:8791/kino/;
\t\tproxy_set_header X-Real-IP $remote_addr;
\t\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
\t\tproxy_http_version 1.1;
\t\tproxy_read_timeout 120s;
\t\tadd_header Access-Control-Allow-Origin * always;
\t}
"""
if "location /kino/" not in src:
    index = src.find("\tlocation / {")
    if index == -1:
        index = src.find("location / {")
    src = src[:index] + block + src[index:]
    open(path, "w", encoding="utf-8").write(src)
    print("nginx: локация /kino/ добавлена")
else:
    print("nginx: локация /kino/ уже есть")
PY

systemctl daemon-reload
systemctl enable kino-extractor >/dev/null 2>&1 || true
systemctl restart kino-extractor
nginx -t && systemctl reload nginx
sleep 2
systemctl is-active kino-extractor
echo "--- проверка изнутри ---"
curl -s -m 30 "http://127.0.0.1:8791/kino/$TOKEN/health"; echo
echo "--- проверка через nginx ---"
curl -s -m 30 "http://127.0.0.1/kino/$TOKEN/health"; echo
echo "TOKEN=$TOKEN"
