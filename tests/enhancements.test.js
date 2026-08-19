const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-besar-enhancements-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.APP_PEPPER = 'enhancement-test-pepper';
process.env.INITIAL_ADMIN_PASSWORD = 'TestAdmin123';

const express = require('express');
const security = require('../src/security');
const dbmod = require('../src/db');
const registerAddonRoutes = require('../src/addon-routes');

const app = express();
registerAddonRoutes(app, express);
const server = app.listen(0, '127.0.0.1');
let base = '';

const admin = dbmod.db.prepare("SELECT * FROM users WHERE role='SUPER_ADMIN' LIMIT 1").get();
const rawToken = 'enhancement-test-session-token';
const tokenHash = security.hashToken('SESSION', rawToken);
const now = new Date();
dbmod.db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
  .run(tokenHash, admin.id, now.toISOString(), new Date(now.getTime() + 3600000).toISOString(), now.toISOString());

function request(url, options = {}) {
  return fetch(`${base}${url}`, {
    ...options,
    headers: {
      Cookie: `kb_session=${rawToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
}

let transactionAccountId;
let fundAccountId;

test.before(async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

test('transaction account CRUD creates accounting-style account', async () => {
  const create = await request('/api/transaction-accounts', {
    method: 'POST',
    body: JSON.stringify({
      code: '4-100',
      name: 'Pendapatan Internet',
      accountClass: 'PENDAPATAN',
      scope: 'IN',
      notes: 'Pendapatan layanan internet'
    })
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  transactionAccountId = created.account.id;
  assert.equal(created.account.code, '4-100');
  assert.equal(created.account.accountClass, 'PENDAPATAN');
  assert.equal(created.account.canDelete, true);

  const update = await request(`/api/transaction-accounts/${transactionAccountId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Pendapatan Internet Bulanan', active: true })
  });
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.account.name, 'Pendapatan Internet Bulanan');

  const list = await request('/api/transaction-accounts');
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.ok(listed.accounts.some(item => item.id === transactionAccountId));
});

test('cash mutation returns opening, in, out, closing and running balance', async () => {
  const ts = dbmod.nowIso();
  fundAccountId = security.newId('FUND');
  dbmod.db.prepare(`INSERT INTO fund_accounts(id,code,name,account_type,active,created_by,created_at,updated_by,updated_at)
    VALUES(?,?,?,'BANK',1,?,?,?,?)`)
    .run(fundAccountId, 'BCA-OPR', 'BCA Operasional', admin.id, ts, admin.id, ts);

  const date = dbmod.localDate();
  dbmod.db.prepare(`INSERT INTO transactions(
    id,transaction_no,transaction_date,fund_account_id,direction,category_id,amount,description,status,cash_effect,source_type,created_by,created_at,approved_by,approved_at
  ) VALUES(?,?,?,?,?,?,?,?,'APPROVED',1,'DIRECT',?,?,?,?)`)
    .run(security.newId('TRX'), 'TEST-IN-001', date, fundAccountId, 'IN', transactionAccountId, 500000,
      'Penerimaan test', admin.id, ts, admin.id, ts);

  const expenseCategory = dbmod.db.prepare("SELECT id FROM transaction_categories WHERE code='OPERASIONAL'").get();
  dbmod.db.prepare(`INSERT INTO transactions(
    id,transaction_no,transaction_date,fund_account_id,direction,category_id,amount,description,status,cash_effect,source_type,created_by,created_at,approved_by,approved_at
  ) VALUES(?,?,?,?,?,?,?,?,'APPROVED',1,'DIRECT',?,?,?,?)`)
    .run(security.newId('TRX'), 'TEST-OUT-001', date, fundAccountId, 'OUT', expenseCategory.id, 125000,
      'Pengeluaran test', admin.id, ts, admin.id, ts);

  const response = await request(`/api/cash-mutations?accountId=${encodeURIComponent(fundAccountId)}&from=${date}&to=${date}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.openingBalance, 0);
  assert.equal(data.totalIn, 500000);
  assert.equal(data.totalOut, 125000);
  assert.equal(data.closingBalance, 375000);
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries.at(-1).runningBalance, 375000);
});

test('used transaction account cannot be deleted and can be deactivated', async () => {
  const remove = await request(`/api/transaction-accounts/${transactionAccountId}`, { method: 'DELETE' });
  assert.equal(remove.status, 409);

  const deactivate = await request(`/api/transaction-accounts/${transactionAccountId}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false })
  });
  assert.equal(deactivate.status, 200);
  const body = await deactivate.json();
  assert.equal(body.account.active, false);
  assert.ok(body.account.usage.total >= 1);
});

test('profile password change verifies old password and keeps current session', async () => {
  const profile = await request('/api/profile');
  assert.equal(profile.status, 200);
  const profileBody = await profile.json();
  assert.equal(profileBody.user.username, 'admin');

  const wrong = await request('/api/profile/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'Wrong123', newPassword: 'NewAdmin456' })
  });
  assert.equal(wrong.status, 400);

  const change = await request('/api/profile/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'TestAdmin123', newPassword: 'NewAdmin456' })
  });
  assert.equal(change.status, 200);

  const refreshed = dbmod.db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
  assert.equal(security.verifyPassword('NewAdmin456', refreshed.password_hash, refreshed.password_salt), true);
  const session = dbmod.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(tokenHash);
  assert.equal(session.revoked_at, null);
});

test.after(() => {
  server.close();
  try { dbmod.db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
