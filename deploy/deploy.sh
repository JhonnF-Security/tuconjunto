#!/usr/bin/env bash
# Despliegue inicial de TuConjunto en un VPS Ubuntu 22.04/24.04 recién creado.
# Uso: sudo ./deploy.sh tudominio.com
set -euo pipefail

DOMINIO="${1:-}"
if [[ -z "$DOMINIO" ]]; then echo "Uso: sudo $0 <dominio>"; exit 1; fi
APP_DIR="/opt/tuconjunto"

echo "== 1. Paquetes base =="
apt-get update -qq
apt-get install -y nginx curl git sqlite3 rsync

echo "== 2. Node.js 20 LTS =="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential python3

echo "== 3. Copiar proyecto a $APP_DIR =="
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude 'data/tuconjunto.db*' --exclude backups \
  --exclude tls --exclude .env \
  "$(cd "$(dirname "$0")/.." && pwd)/" "$APP_DIR/"
cd "$APP_DIR/server"
mkdir -p data backups
npm ci --omit=dev || npm install --omit=dev

echo "== 4. Usuario de servicio y permisos =="
id -u tuconjunto &>/dev/null || useradd -r -s /usr/sbin/nologin tuconjunto
chown -R tuconjunto:tuconjunto "$APP_DIR"

echo "== 5. .env de produccion =="
[[ -f .env ]] || cp .env.example .env
# Detrás de nginx (TLS): confía en 1 salto de proxy -> cookies Secure + HSTS + IPs reales.
sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" .env
grep -q '^TRUST_PROXY' .env || echo "TRUST_PROXY=1" >> .env
# La API solo escucha local; el público entra por nginx 80/443.
sed -i "s|^HOST=.*|HOST=127.0.0.1|" .env
grep -q '^HOST' .env || echo "HOST=127.0.0.1" >> .env
chown tuconjunto:tuconjunto .env && chmod 600 .env

echo "== 6. Firewall (SSH/Web) =="
if command -v ufw >/dev/null; then
  ufw allow 22/tcp || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
  yes | ufw enable || true
fi

echo "== 7. Servicio systemd =="
cp "$APP_DIR/deploy/tuconjunto.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tuconjunto
# Health con reintentos (evita cortes por arranque lento bajo set -e).
SALUD=0
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:8081/api/health >/dev/null; then SALUD=1; break; fi
  sleep 2
done
if [[ "$SALUD" == "1" ]]; then
  echo "   app OK en 127.0.0.1:8081"
else
  echo "!! La app no respondio a /api/health. Revisa: journalctl -u tuconjunto -n 50" >&2
  exit 1
fi

echo "== 8. Nginx (vhost HTTP) + TLS (Let's Encrypt) =="
# El vhost inicial es solo puerto 80: nginx -t pasa sin certificados y certbot
# inyecta el bloque SSL y la redireccion a HTTPS (--redirect).
cp "$APP_DIR/deploy/nginx-tuconjunto.conf" /etc/nginx/sites-available/tuconjunto
sed -i "s/tudominio.com/$DOMINIO/g" /etc/nginx/sites-available/tuconjunto
ln -sf /etc/nginx/sites-available/tuconjunto /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
apt-get install -y certbot python3-certbot-nginx
if certbot --nginx -d "$DOMINIO" --redirect --non-interactive --agree-tos -m "admin@$DOMINIO"; then
  echo "   TLS activo para $DOMINIO"
else
  echo "!! Certbot fallo: verifica el registro DNS A de $DOMINIO antes de reintentar:" >&2
  echo "!! sudo certbot --nginx -d $DOMINIO --redirect" >&2
fi

echo "== 9. Backups diarios 3 AM (usuario tuconjunto) =="
chmod +x scripts/backup.sh
CRON_LINE="0 3 * * * cd $APP_DIR/server && ./scripts/backup.sh >> backups/backup.log 2>&1"
( crontab -u tuconjunto -l 2>/dev/null | grep -Fv "$CRON_LINE"; echo "$CRON_LINE" ) | crontab -u tuconjunto -

cat <<EOF

==========================================================
  TuConjunto desplegado:  https://$DOMINIO
  Salud:                  https://$DOMINIO/api/health

  Siguiente paso OBLIGATORIO — crea tu administrador real:
      cd $APP_DIR/server
      sudo -u tuconjunto npm run create-admin -- \\
        --documento TU_DOCUMENTO --nombre "Tu Nombre"

  NO uses datos demo en produccion:
    - npm run seed BORRA la base completa e instala demo
      (clave demo1234). Solo para pruebas locales.
==========================================================
EOF
