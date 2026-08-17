#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ainet-kas-besar}"
REPO_URL="${REPO_URL:-https://github.com/anggapraditya100111-a11y/ainet-kas-besar.git}"
PORT="${PORT:-8094}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker belum terpasang." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin belum tersedia." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Git belum terpasang." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL belum terpasang." >&2
  exit 1
fi

mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
mkdir -p data backups uploads

docker network inspect ainet-finance >/dev/null 2>&1 || docker network create ainet-finance >/dev/null

find_kas_kecil_key() {
  local candidate key
  for candidate in "/DATA/AppData/kas-kecil/app/.env" "/opt/ainet-kas-kecil/.env"; do
    if [ -f "$candidate" ]; then
      key="$(sed -n 's/^KAS_BESAR_INTEGRATION_KEY=//p' "$candidate" | tail -n 1 | tr -d '\r')"
      if [ -n "$key" ]; then
        printf '%s' "$key"
        return 0
      fi
    fi
  done
  return 1
}

if [ ! -f .env ]; then
  ADMIN_PASSWORD="$(openssl rand -hex 8)"
  APP_PEPPER="$(openssl rand -hex 32)"
  if INTEGRATION_KEY="$(find_kas_kecil_key)"; then
    KEY_SOURCE="diambil otomatis dari instalasi Kas Kecil"
  else
    INTEGRATION_KEY="$(openssl rand -hex 32)"
    KEY_SOURCE="dibuat baru; salin ke Kas Kecil bila belum sama"
  fi
  cat > .env <<EOF
PORT=$PORT
TIMEZONE=Asia/Jakarta
INITIAL_ADMIN_NAME=Administrator
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=$ADMIN_PASSWORD
APP_PEPPER=$APP_PEPPER
KAS_KECIL_INTEGRATION_URL=http://ainet-kas-kecil-integration:8095
KAS_BESAR_INTEGRATION_KEY=$INTEGRATION_KEY
DEFAULT_APP_NAME=AINET Kas Besar
DEFAULT_COMPANY_NAME=PT Axindo Infinitas Network
TRUST_PROXY=false
EOF
  chmod 600 .env
  echo
  echo "=== SIMPAN DATA BERIKUT ==="
  echo "Username awal      : admin"
  echo "Password awal      : $ADMIN_PASSWORD"
  echo "Integration key    : $INTEGRATION_KEY"
  echo "Key source         : $KEY_SOURCE"
  echo "==========================="
fi

docker compose up -d --build

echo
echo "AINET Kas Besar aktif di port $PORT"
echo "Buka: http://IP-SERVER:$PORT"
echo "Docker network: ainet-finance"
docker compose ps
