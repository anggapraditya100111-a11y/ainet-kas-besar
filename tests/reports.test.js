const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-besar-reports-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.APP_PEPPER = 'report-test-pepper';
process.env.INITIAL_ADMIN_PASSWORD = 'TestAdmin123';

const security = require('../src/security');
const dbmod = require('../src/db');
const reports = require('../src/report-routes')._test;

const admin = dbmod.db.prepare("SELECT * FROM users WHERE role='SUPER_ADMIN' LIMIT 1").get();
const ts = dbmod.nowIso();
const today = dbmod.localDate();
const previous = new Date(`${today}T00:00:00Z`);
previous.setUTCDate(previous.getUTCDate() - 1);
const yesterday = previous.toISOString().slice(0, 10);
let txOrder = 0;

const fundId = security.newId('FUND');
const otherFundId = security.newId('FUND');
dbmod.db.prepare(`INSERT INTO fund_accounts(id,code,name,account_type,active,created_by,created_at,updated_by,updated_at)
  VALUES(?,?,?,'BANK',1,?,?,?,?)`).run(fundId, 'BCA-OPR', 'BCA Operasional', admin.id, ts, admin.id, ts);
dbmod.db.prepare(`INSERT INTO fund_accounts(id,code,name,account_type,active,created_by,created_at,updated_by,updated_at)
  VALUES(?,?,?,'CASH',1,?,?,?,?)`).run(otherFundId, 'KAS-TUNAI', 'Kas Tunai', admin.id, ts, admin.id, ts);

const incomeCategory = security.newId('CAT');
const expenseCategory = security.newId('CAT');
dbmod.db.prepare(`INSERT INTO transaction_categories(id,code,name,scope,active,created_at,updated_at)
  VALUES(?,?,?,'IN',1,?,?)`).run(incomeCategory, '4-100', 'Pendapatan Internet', ts, ts);
dbmod.db.prepare(`INSERT INTO transaction_categories(id,code,name,scope,active,created_at,updated_at)
  VALUES(?,?,?,'OUT',1,?,?)`).run(expenseCategory, '5-200', 'Biaya Listrik', ts, ts);

function insertTx({ no, date, fund, direction, category, amount, description, reference }) {
  txOrder += 1;
  const createdAt = new Date(new Date(ts).getTime() + txOrder * 1000).toISOString();
  dbmod.db.prepare(`INSERT INTO transactions(
    id,transaction_no,transaction_date,fund_account_id,direction,category_id,amount,description,reference_no,status,cash_effect,source_type,created_by,created_at,approved_by,approved_at
  ) VALUES(?,?,?,?,?,?,?,?,?,'APPROVED',1,'DIRECT',?,?,?,?)`)
    .run(security.newId('TRX'), no, date, fund, direction, category, amount, description, reference || null, admin.id, createdAt, admin.id, createdAt);
}

insertTx({ no: 'OPEN-001', date: yesterday, fund: fundId, direction: 'IN', category: incomeCategory, amount: 500000, description: 'Saldo sebelum periode' });
insertTx({ no: 'IN-001', date: today, fund: fundId, direction: 'IN', category: incomeCategory, amount: 1000000, description: 'Pembayaran pelanggan Alpha', reference: 'INV-ALPHA' });
insertTx({ no: 'OUT-001', date: today, fund: fundId, direction: 'OUT', category: expenseCategory, amount: 250000, description: 'Bayar listrik kantor', reference: 'PLN-001' });
insertTx({ no: 'IN-OTHER', date: today, fund: otherFundId, direction: 'IN', category: incomeCategory, amount: 75000, description: 'Dana kas tunai' });

test('Buku Kas Besar filter supports period, Akun Dana, Akun Transaksi, direction and keyword', () => {
  const byFund = reports.ledgerReport({ from: today, to: today, accountId: fundId });
  assert.equal(byFund.rows.length, 2);
  assert.equal(byFund.totalIn, 1000000);
  assert.equal(byFund.totalOut, 250000);
  assert.equal(byFund.net, 750000);

  const byIncome = reports.ledgerReport({ from: today, to: today, accountId: fundId, transactionAccountId: incomeCategory, direction: 'IN' });
  assert.equal(byIncome.rows.length, 1);
  assert.equal(byIncome.rows[0].transaction_no, 'IN-001');

  const byKeyword = reports.ledgerReport({ from: today, to: today, q: 'ALPHA' });
  assert.equal(byKeyword.rows.length, 1);
  assert.equal(byKeyword.rows[0].reference_no, 'INV-ALPHA');
});

test('Mutasi Kas calculates opening and running balance for selected Akun Dana', () => {
  const report = reports.cashMutationReport({ from: today, to: today, accountId: fundId });
  assert.equal(report.openingBalance, 500000);
  assert.equal(report.totalIn, 1000000);
  assert.equal(report.totalOut, 250000);
  assert.equal(report.closingBalance, 1250000);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].running_balance, 1500000);
  assert.equal(report.rows[1].running_balance, 1250000);
});

test('Excel exports produce valid XLSX buffers', async () => {
  const ledger = reports.ledgerReport({ from: today, to: today, accountId: fundId });
  const mutation = reports.cashMutationReport({ from: today, to: today, accountId: fundId });
  const ledgerBuffer = await reports.ledgerExcel(ledger);
  const mutationBuffer = await reports.mutationExcel(mutation);
  assert.equal(ledgerBuffer.subarray(0, 2).toString('binary'), 'PK');
  assert.equal(mutationBuffer.subarray(0, 2).toString('binary'), 'PK');
  assert.ok(ledgerBuffer.length > 5000);
  assert.ok(mutationBuffer.length > 5000);
});

test('PDF exports produce valid PDF buffers', async () => {
  const ledger = reports.ledgerReport({ from: today, to: today, accountId: fundId });
  const mutation = reports.cashMutationReport({ from: today, to: today, accountId: fundId });
  const ledgerBuffer = await reports.ledgerPdf(ledger);
  const mutationBuffer = await reports.mutationPdf(mutation);
  assert.equal(ledgerBuffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(mutationBuffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(ledgerBuffer.length > 1000);
  assert.ok(mutationBuffer.length > 1000);
});

test('frontend loads report filter/export extension', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'reports.js'), 'utf8');
  assert.match(index, /reports\.js/);
  assert.match(ui, /Filter Buku Kas Besar/);
  assert.match(ui, /Download PDF/);
  assert.match(ui, /Download Excel/);
});

test.after(() => {
  try { dbmod.db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
