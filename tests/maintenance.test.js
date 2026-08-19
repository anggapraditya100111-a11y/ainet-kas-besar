const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-besar-maintenance-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.APP_PEPPER = 'maintenance-test-pepper';
process.env.INITIAL_ADMIN_PASSWORD = 'TestAdmin123';

const express = require('express');
const security = require('../src/security');
const dbmod = require('../src/db');
const registerMaintenanceRoutes = require('../src/maintenance-routes');

const app = express();
registerMaintenanceRoutes(app, express);
let server;
let base;
const serverReady = new Promise((resolve, reject) => {
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
  server.once('error', reject);
});

const admin = dbmod.db.prepare("SELECT * FROM users WHERE role='SUPER_ADMIN' LIMIT 1").get();
const rawToken = 'maintenance-test-session';
const tokenHash = security.hashToken('SESSION', rawToken);
const now = new Date();
dbmod.db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
  .run(tokenHash, admin.id, now.toISOString(), new Date(now.getTime() + 3600000).toISOString(), now.toISOString());

async function request(url, options = {}) {
  await serverReady;
  return fetch(`${base}${url}`, {
    ...options,
    headers: {
      Cookie: `kb_session=${rawToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
}

let fundId;
let categoryId;
let kbSequence;
let masterBefore;

test('seed operational data and preserve master baseline', () => {
  const ts = dbmod.nowIso();
  const date = dbmod.localDate();
  fundId = security.newId('FUND');
  dbmod.db.prepare(`INSERT INTO fund_accounts(id,code,name,account_type,active,created_by,created_at,updated_by,updated_at)
    VALUES(?,?,?,'BANK',1,?,?,?,?)`).run(fundId, 'TEST-BANK', 'Bank Test', admin.id, ts, admin.id, ts);

  categoryId = dbmod.db.prepare("SELECT id FROM transaction_categories WHERE code='OPERASIONAL'").get().id;
  const trxId = security.newId('TRX');
  dbmod.db.prepare(`INSERT INTO transactions(
    id,transaction_no,transaction_date,fund_account_id,direction,category_id,amount,description,status,cash_effect,source_type,created_by,created_at,approved_by,approved_at
  ) VALUES(?,?,?,?,?,?,?,?,'APPROVED',1,'DIRECT',?,?,?,?)`)
    .run(trxId, 'TEST-MAINT-IN-001', date, fundId, 'IN', categoryId, 1000000, 'Saldo test', admin.id, ts, admin.id, ts);

  const payId = security.newId('PAY');
  dbmod.db.prepare(`INSERT INTO payment_requests(
    id,request_no,request_date,requester_name,category_id,amount,purpose,status,created_by,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,'SUBMITTED',?,?,?)`)
    .run(payId, 'PAY-TEST-001', date, admin.name, categoryId, 125000, 'Permintaan test', admin.id, ts, ts);

  const transferId = security.newId('TRF');
  dbmod.db.prepare(`INSERT INTO cash_transfers(
    id,transfer_no,transfer_date,from_account_id,destination_type,amount,description,status,created_by,created_at
  ) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`)
    .run(transferId, 'TRF-TEST-001', date, fundId, 'KAS_KECIL', 100000, 'Transfer test', admin.id, ts);

  dbmod.db.prepare(`INSERT INTO approval_actions(id,entity_type,entity_id,step_no,action,actor_id,note,created_at)
    VALUES(?,?,?,1,'SUBMIT',?,?,?)`).run(security.newId('ACT'), 'TRANSFER', transferId, admin.id, 'test', ts);
  dbmod.audit(admin.id, 'TEST', 'TRANSACTION', trxId, '', '', 'Audit test');

  kbSequence = dbmod.nextNumber('KB', date);
  masterBefore = {
    funds: Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM fund_accounts').get().total),
    categories: Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM transaction_categories').get().total),
    vendors: Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM vendors').get().total),
    costCenters: Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM cost_centers').get().total),
    users: Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM users').get().total)
  };
  assert.ok(masterBefore.funds >= 1);
});

test('maintenance status reports operational and preserved data', async () => {
  const response = await request('/api/maintenance/status');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.counts.transactions, 1);
  assert.equal(data.counts.paymentRequests, 1);
  assert.equal(data.counts.transfers, 1);
  assert.ok(data.preserved.includes('Akun Dana'));
  assert.equal(data.confirmationText, 'HAPUS SEMUA TRANSAKSI');
});

test('database transfer exports a standalone SQLite file', async () => {
  const response = await request('/api/maintenance/database/export');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') || '', /attachment/i);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 1024);
  assert.equal(Buffer.from(bytes.slice(0, 16)).toString('utf8'), 'SQLite format 3\u0000');
});

test('wrong password cannot clear transactions', async () => {
  const response = await request('/api/maintenance/transactions/clear', {
    method: 'POST',
    body: JSON.stringify({ password: 'Wrong123', confirmation: 'HAPUS SEMUA TRANSAKSI' })
  });
  assert.equal(response.status, 400);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM transactions').get().total), 1);
});

test('clear removes operational data, creates backup and preserves masters/sequences', async () => {
  const response = await request('/api/maintenance/transactions/clear', {
    method: 'POST',
    body: JSON.stringify({ password: 'TestAdmin123', confirmation: 'HAPUS SEMUA TRANSAKSI' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.deleted.transactions, 1);
  assert.equal(result.deleted.paymentRequests, 1);
  assert.equal(result.deleted.transfers, 1);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM transactions').get().total), 0);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM payment_requests').get().total), 0);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM cash_transfers').get().total), 0);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM approval_actions').get().total), 0);

  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM fund_accounts').get().total), masterBefore.funds);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM transaction_categories').get().total), masterBefore.categories);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM vendors').get().total), masterBefore.vendors);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM cost_centers').get().total), masterBefore.costCenters);
  assert.equal(Number(dbmod.db.prepare('SELECT COUNT(*) AS total FROM users').get().total), masterBefore.users);

  const key = kbSequence.slice(0, kbSequence.lastIndexOf('-'));
  assert.ok(dbmod.db.prepare('SELECT * FROM sequences WHERE prefix=?').get(key));
  assert.equal(fs.existsSync(path.join(process.env.BACKUP_DIR, result.backupFile)), true);
  assert.equal(Number(dbmod.db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action='CLEAR_ALL_TRANSACTIONS'").get().total), 1);
});

test.after(async () => {
  await serverReady.catch(() => {});
  await new Promise(resolve => server.close(resolve));
  try { dbmod.db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
