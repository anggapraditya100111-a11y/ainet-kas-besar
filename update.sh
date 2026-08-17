#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ainet-kas-besar}"
cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "Folder $APP_DIR bukan repository Git." >&2
  exit 1
fi

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -f data/kas-besar.sqlite ]; then
  echo "Membuat backup sebelum update..."
  docker compose stop kas-besar >/dev/null 2>&1 || true
  cp -a data/kas-besar.sqlite "backups/kas-besar-before-update-$STAMP.sqlite"
  [ -f data/kas-besar.sqlite-wal ] && cp -a data/kas-besar.sqlite-wal "backups/kas-besar-before-update-$STAMP.sqlite-wal" || true
  [ -f data/kas-besar.sqlite-shm ] && cp -a data/kas-besar.sqlite-shm "backups/kas-besar-before-update-$STAMP.sqlite-shm" || true
fi

git fetch origin main
git reset --hard origin/main
chmod +x install.sh update.sh 2>/dev/null || true

docker compose up -d --build

echo "Update selesai."
docker compose ps
