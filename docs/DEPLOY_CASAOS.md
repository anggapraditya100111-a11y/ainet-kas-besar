# Deployment AINET Kas Besar di CasaOS

## Port dan integrasi
- AINET Kas Besar: 8094
- AINET Kas Kecil: 8090
- Service integrasi Kas Kecil: 8095 internal Docker only
- Docker network bersama: `ainet-finance`

## Urutan deployment
1. Update Kas Kecil ke `main` terbaru agar service `ainet-kas-kecil-integration` tersedia.
2. Pastikan `KAS_BESAR_INTEGRATION_KEY` ada di `.env` Kas Kecil.
3. Jalankan `docker compose up -d --build --force-recreate` pada instalasi Kas Kecil.
4. Install Kas Besar dengan `install.sh`.
5. Pastikan Kas Besar dan service integrasi Kas Kecil bergabung ke network `ainet-finance`.

## Verifikasi Kas Kecil
```bash
cd /DATA/AppData/kas-kecil/app
git fetch origin main
git reset --hard origin/main
chmod +x install.sh update.sh
./update.sh

docker compose ps
docker network inspect ainet-finance
```

Harus terlihat service utama Kas Kecil dan service `ainet-kas-kecil-integration` aktif.

## Install Kas Besar
```bash
curl -fsSL https://raw.githubusercontent.com/anggapraditya100111-a11y/ainet-kas-besar/main/install.sh -o /tmp/install-ainet-kas-besar.sh
chmod +x /tmp/install-ainet-kas-besar.sh
bash /tmp/install-ainet-kas-besar.sh
```

Installer menggunakan `/opt/ainet-kas-besar` secara default dan port 8094. Jika instalasi Kas Kecil ditemukan, installer mencoba memakai integration key yang sama secara otomatis.

## Verifikasi Kas Besar
```bash
cd /opt/ainet-kas-besar
docker compose ps
curl -fsS http://127.0.0.1:8094/api/health
```

## Uji koneksi internal
```bash
docker exec ainet-kas-besar node -e "fetch('http://ainet-kas-kecil-integration:8095/health').then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exit(1)})"
```

Jika koneksi benar, service integrasi menjawab JSON dengan `ok: true`.

## Catatan keamanan
Port 8095 tidak perlu dan tidak boleh dipublish ke internet. Komunikasi antar aplikasi dilakukan melalui Docker network `ainet-finance` dan autentikasi `X-Integration-Key`.
