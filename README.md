# AINET Kas Besar

Aplikasi treasury dan cash management internal AINET. Kas Besar mengelola posisi kas/bank perusahaan, penerimaan, pengeluaran, permintaan pembayaran, transfer dana, vendor, cost center, approval, audit, serta pendanaan Kas Kecil.

## Prinsip arsitektur

- Kas Besar dan Kas Kecil memakai database terpisah.
- Pendanaan Kas Besar → Kas Kecil adalah perpindahan posisi kas, bukan biaya perusahaan.
- Sinkronisasi memakai `integrationId` unik dan bersifat idempotent.
- Transaksi keuangan tidak dihapus; koreksi dilakukan dengan reversal/jejak audit.
- Secret dan password hanya melalui environment variable, tidak disimpan di repository.

## Stack

- Node.js 22+
- Express 5
- SQLite (`node:sqlite`)
- Docker / CasaOS

## Menjalankan

```bash
cp .env.example .env
# ubah password admin, APP_PEPPER, dan integration key
npm install
npm start
```

Default port: `8094`.

## Integrasi Kas Kecil

Kas Besar memanggil service integrasi Kas Kecil melalui:

- `GET /api/integration/v1/users`
- `POST /api/integration/v1/funding`
- `GET /api/integration/v1/funding/:integrationId`

Header autentikasi: `X-Integration-Key`.

## Status v1.0.0

Fondasi awal mencakup dashboard, akun kas/bank, master vendor & cost center, transaksi penerimaan/pengeluaran, permintaan pembayaran, approval, transfer/pendanaan Kas Kecil, audit log, serta backup database.
