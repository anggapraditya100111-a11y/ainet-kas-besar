const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const cron = require('node-cron');

const {
  db,
  BACKUP_DIR,
  nowIso,
  localDate,
  getSetting,
  setSetting,
  audit,
  nextNumber,
  accountBalance,
  totalCashPosition,
  cleanupSessions,
  backupDatabase,
  listBackups
} = require('./db');
const {
  APP_PEPPER,
  newId,
  cleanText,
  hashPassword,
  verifyPassword,
  randomToken,
  hashToken,
  assertPassword
} = require('./security');
const pettyCash = require('./integration-client');

const PORT = Number(process.env.PORT || 8094);
const APP_VERSION = '1.0.0';
const COOKIE_NAME = 'kb_session';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_HOURS = () => Number(getSetting('SESSION_HOURS', 8)) || 8;

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function toAmount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  const number = Number(digits) * (raw.startsWith('-') ? -1 : 1);
  return Number.isSafeInteger(number) ? number : 0;
}

function validatedDate(value, label = 'Tanggal') {
  const date = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(`${label} tidak valid.`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new AppError(`${label} tidak valid.`);
  return date;
}

function assertOpenDate(value) {
  const date = validatedDate(value, 'Tanggal transaksi');
  if (date > localDate()) throw new AppError('Tanggal transaksi tidak boleh melebihi hari ini.');
  const period = db.prepare("SELECT * FROM accounting_periods WHERE status='OPEN' ORDER BY period_month DESC LIMIT 1").get();
  if (!period) throw new AppError('Tidak ada periode keuangan yang terbuka.', 409);
  if (!date.startsWith(`${period.period_month}-`)) throw new AppError(`Tanggal transaksi wajib berada pada periode terbuka ${period.period_month}.`, 409);
  return date;
}

function publicUser(row) {
  return {
    userId: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    active: Boolean(row.active),
    lastLogin: row.last_login || ''
  };
}

const ROLE_POWER = {
  VIEWER: 0,
  MANAGER: 1,
  APPROVER: 2,
  FINANCE: 3,
  SUPER_ADMIN: 4
};

function authMiddleware(req, _res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next(new AppError('Silakan login kembali.', 401));
  const tokenHash = hashToken('SESSION', token);
  const row = db.prepare(`SELECT s.*,u.id AS uid,u.name,u.username,u.role,u.active,u.last_login
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash);
  if (!row || row.revoked_at || !row.active || row.expires_at < nowIso()) return next(new AppError('Sesi berakhir. Silakan login kembali.', 401));
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(nowIso(), tokenHash);
  }
  req.auth = { user: { id: row.uid, name: row.name, username: row.username, role: row.role, last_login: row.last_login }, sessionHash: tokenHash };
  next();
}

function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.auth.user.role)) return next(new AppError('Anda tidak memiliki hak akses untuk tindakan ini.', 403));
    next();
  };
}

function canApprove(user) {
  return ['SUPER_ADMIN', 'APPROVER', 'MANAGER'].includes(user.role);
}

function canFinance(user) {
  return ['SUPER_ADMIN', 'FINANCE'].includes(user.role);
}

function assertBalance(accountId, amount) {
  const balance = accountBalance(accountId);
  if (balance < amount) throw new AppError(`Saldo akun tidak mencukupi. Saldo tersedia Rp ${balance.toLocaleString('id-ID')}.`, 409);
}

function accountView(row) {
  return {
    accountId: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    bankName: row.bank_name || '',
    accountNumber: row.account_number || '',
    accountHolder: row.account_holder || '',
    active: Boolean(row.active),
    notes: row.notes || '',
    balance: accountBalance(row.id)
  };
}

function insertTransaction({ date, fundAccountId, direction, categoryId = null, costCenterId = null, vendorId = null, amount, description, counterparty = '', referenceNo = '', status = 'APPROVED', sourceType = 'DIRECT', sourceId = null, createdBy, approvedBy = null }) {
  const id = newId('TRX');
  const no = nextNumber(direction === 'IN' ? 'IN' : 'OUT', date);
  const now = nowIso();
  db.prepare(`INSERT INTO transactions(
    id,transaction_no,transaction_date,fund_account_id,direction,category_id,cost_center_id,vendor_id,amount,description,counterparty,
    reference_no,status,cash_effect,source_type,source_id,created_by,created_at,approved_by,approved_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`)
    .run(id, no, date, fundAccountId, direction, categoryId, costCenterId, vendorId, amount, description, counterparty || null,
      referenceNo || null, status, sourceType, sourceId, createdBy, now, approvedBy, approvedBy ? now : null);
  return db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
}

function auditAction(entityType, entityId, action, actorId, note = '', stepNo = 1) {
  db.prepare(`INSERT INTO approval_actions(id,entity_type,entity_id,step_no,action,actor_id,note,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(newId('ACT'), entityType, entityId, stepNo, action, actorId, cleanText(note, 1000), nowIso());
}

function dashboardData() {
  const period = localDate().slice(0, 7);
  const bounds = [`${period}-01`, `${period}-31`];
  const cashIn = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE status='APPROVED' AND cash_effect=1 AND direction='IN' AND transaction_date BETWEEN ? AND ?`).get(...bounds).total || 0);
  const cashOut = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE status='APPROVED' AND cash_effect=1 AND direction='OUT' AND transaction_date BETWEEN ? AND ?`).get(...bounds).total || 0);
  const pendingPayments = Number(db.prepare("SELECT COUNT(*) AS total FROM payment_requests WHERE status IN ('SUBMITTED','VERIFIED','APPROVED')").get().total || 0);
  const pendingAmount = Number(db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE status IN ('SUBMITTED','VERIFIED','APPROVED')").get().total || 0);
  const syncFailed = Number(db.prepare("SELECT COUNT(*) AS total FROM cash_transfers WHERE status='SYNC_FAILED'").get().total || 0);
  const accounts = db.prepare('SELECT * FROM fund_accounts WHERE active=1 ORDER BY account_type,name COLLATE NOCASE').all().map(accountView);
  const recent = db.prepare(`SELECT t.*,f.name AS fund_account_name,c.name AS category_name,cc.name AS cost_center_name,v.name AS vendor_name,u.name AS created_by_name
    FROM transactions t
    JOIN fund_accounts f ON f.id=t.fund_account_id
    LEFT JOIN transaction_categories c ON c.id=t.category_id
    LEFT JOIN cost_centers cc ON cc.id=t.cost_center_id
    LEFT JOIN vendors v ON v.id=t.vendor_id
    JOIN users u ON u.id=t.created_by
    ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 12`).all();
  return { totalCash: totalCashPosition(), cashIn, cashOut, netCashFlow: cashIn - cashOut, pendingPayments, pendingAmount, syncFailed, accounts, recent };
}

const executeInternalTransfer = db.transaction((transfer, actorId) => {
  const exists = db.prepare("SELECT COUNT(*) AS total FROM transactions WHERE source_type='TRANSFER' AND source_id=?").get(transfer.id);
  if (Number(exists.total || 0) > 0) return;
  assertBalance(transfer.from_account_id, transfer.amount);
  const category = db.prepare("SELECT id FROM transaction_categories WHERE code='TRANSFER'").get();
  insertTransaction({
    date: transfer.transfer_date,
    fundAccountId: transfer.from_account_id,
    direction: 'OUT',
    categoryId: category?.id || null,
    amount: Number(transfer.amount),
    description: transfer.description,
    counterparty: 'Transfer Internal',
    referenceNo: transfer.transfer_no,
    sourceType: 'TRANSFER',
    sourceId: transfer.id,
    createdBy: actorId,
    approvedBy: actorId
  });
  insertTransaction({
    date: transfer.transfer_date,
    fundAccountId: transfer.to_account_id,
    direction: 'IN',
    categoryId: category?.id || null,
    amount: Number(transfer.amount),
    description: transfer.description,
    counterparty: 'Transfer Internal',
    referenceNo: transfer.transfer_no,
    sourceType: 'TRANSFER',
    sourceId: transfer.id,
    createdBy: actorId,
    approvedBy: actorId
  });
});

const executePettyCashDebit = db.transaction((transfer, actorId) => {
  const existing = db.prepare("SELECT * FROM transactions WHERE source_type='KAS_KECIL_FUNDING' AND source_id=? AND direction='OUT'").get(transfer.id);
  if (existing) return existing;
  assertBalance(transfer.from_account_id, transfer.amount);
  const category = db.prepare("SELECT id FROM transaction_categories WHERE code='TRANSFER'").get();
  return insertTransaction({
    date: transfer.transfer_date,
    fundAccountId: transfer.from_account_id,
    direction: 'OUT',
    categoryId: category?.id || null,
    amount: Number(transfer.amount),
    description: transfer.description,
    counterparty: 'Kas Kecil',
    referenceNo: transfer.transfer_no,
    sourceType: 'KAS_KECIL_FUNDING',
    sourceId: transfer.id,
    createdBy: actorId,
    approvedBy: actorId
  });
});

async function syncPettyCashTransfer(transferId, actorId) {
  let transfer = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(transferId);
  if (!transfer) throw new AppError('Transfer tidak ditemukan.', 404);
  if (transfer.destination_type !== 'KAS_KECIL') throw new AppError('Transfer ini bukan pendanaan Kas Kecil.');
  if (!['APPROVED', 'SYNC_PENDING', 'SYNC_FAILED'].includes(transfer.status)) throw new AppError('Status transfer tidak dapat disinkronkan.', 409);

  executePettyCashDebit(transfer, actorId);
  db.prepare("UPDATE cash_transfers SET status='SYNC_PENDING',sync_attempts=sync_attempts+1,sync_error=NULL WHERE id=?").run(transfer.id);
  transfer = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(transfer.id);
  try {
    const response = await pettyCash.sendFunding({
      integrationId: transfer.integration_id,
      transactionDate: transfer.transfer_date,
      amount: Number(transfer.amount),
      recipientUserId: transfer.recipient_user_id,
      description: transfer.description,
      counterparty: getSetting('COMPANY_NAME', 'Kas Besar'),
      referenceNo: transfer.transfer_no
    });
    db.prepare("UPDATE cash_transfers SET status='SYNCED',sync_response=?,sync_error=NULL WHERE id=?")
      .run(JSON.stringify(response).slice(0, 10000), transfer.id);
    audit(actorId, 'SYNC_SUCCESS', 'TRANSFER', transfer.id, '', response, 'Pendanaan Kas Kecil berhasil disinkronkan');
    return { ok: true, response };
  } catch (error) {
    db.prepare("UPDATE cash_transfers SET status='SYNC_FAILED',sync_error=?,sync_response=? WHERE id=?")
      .run(cleanText(error.message, 1000), JSON.stringify(error.remoteBody || {}).slice(0, 10000), transfer.id);
    audit(actorId, 'SYNC_FAILED', 'TRANSFER', transfer.id, '', { error: error.message }, 'Pendanaan Kas Kecil gagal disinkronkan');
    throw error;
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
  try {
    if (new URL(req.headers.origin).host !== req.headers.host) return next(new AppError('Origin permintaan tidak diizinkan.', 403));
  } catch {
    return next(new AppError('Origin permintaan tidak valid.', 403));
  }
  next();
});

const loginLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false });

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ainet-kas-besar', version: APP_VERSION }));

app.post('/api/auth/login', loginLimiter, (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user || !user.active || !verifyPassword(password, user.password_hash, user.password_salt)) throw new AppError('Username atau password salah.', 401);
    const rawToken = randomToken();
    const tokenHash = hashToken('SESSION', rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_HOURS() * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(tokenHash, user.id, now.toISOString(), expiresAt, now.toISOString());
    db.prepare('UPDATE users SET last_login=?,updated_at=? WHERE id=?').run(now.toISOString(), now.toISOString(), user.id);
    audit(user.id, 'LOGIN', 'USER', user.id, '', '', 'Login aplikasi Kas Besar');
    res.cookie(COOKIE_NAME, rawToken, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_HOURS() * 60 * 60 * 1000 });
    res.json({ user: publicUser({ ...user, last_login: now.toISOString() }), appVersion: APP_VERSION });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(nowIso(), req.auth.sessionHash);
  audit(req.auth.user.id, 'LOGOUT', 'USER', req.auth.user.id, '', '', 'Logout aplikasi Kas Besar');
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.auth.user, appVersion: APP_VERSION, appName: getSetting('APP_NAME', 'AINET Kas Besar'), companyName: getSetting('COMPANY_NAME', '') });
});

app.get('/api/dashboard', authMiddleware, (_req, res) => res.json(dashboardData()));

app.get('/api/fund-accounts', authMiddleware, (_req, res) => {
  res.json({ accounts: db.prepare('SELECT * FROM fund_accounts ORDER BY active DESC,account_type,name COLLATE NOCASE').all().map(accountView) });
});

app.post('/api/fund-accounts', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const code = cleanText(req.body.code, 40).toUpperCase();
    const name = cleanText(req.body.name, 150);
    const accountType = cleanText(req.body.accountType, 10).toUpperCase();
    if (!code || !name || !['BANK', 'CASH'].includes(accountType)) throw new AppError('Kode, nama, dan jenis akun wajib valid.');
    const id = newId('FUND');
    const now = nowIso();
    db.prepare(`INSERT INTO fund_accounts(id,code,name,account_type,bank_name,account_number,account_holder,active,notes,created_by,created_at,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?)`)
      .run(id, code, name, accountType, cleanText(req.body.bankName, 100) || null, cleanText(req.body.accountNumber, 80) || null,
        cleanText(req.body.accountHolder, 150) || null, cleanText(req.body.notes, 500) || null, req.auth.user.id, now, req.auth.user.id, now);
    const opening = toAmount(req.body.openingBalance);
    if (opening > 0) {
      insertTransaction({ date: localDate(), fundAccountId: id, direction: 'IN', amount: opening, description: 'Saldo awal akun', counterparty: 'Saldo Awal', sourceType: 'OPENING_BALANCE', sourceId: id, createdBy: req.auth.user.id, approvedBy: req.auth.user.id });
    }
    const row = db.prepare('SELECT * FROM fund_accounts WHERE id=?').get(id);
    audit(req.auth.user.id, 'CREATE', 'FUND_ACCOUNT', id, '', accountView(row), 'Membuat akun kas/bank');
    res.status(201).json({ account: accountView(row) });
  } catch (error) { next(error); }
});

app.patch('/api/fund-accounts/:id', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const old = db.prepare('SELECT * FROM fund_accounts WHERE id=?').get(req.params.id);
    if (!old) throw new AppError('Akun kas/bank tidak ditemukan.', 404);
    const name = cleanText(req.body.name ?? old.name, 150);
    const active = req.body.active === undefined ? Number(old.active) : (req.body.active ? 1 : 0);
    db.prepare(`UPDATE fund_accounts SET name=?,bank_name=?,account_number=?,account_holder=?,active=?,notes=?,updated_by=?,updated_at=? WHERE id=?`)
      .run(name, cleanText(req.body.bankName ?? old.bank_name, 100) || null, cleanText(req.body.accountNumber ?? old.account_number, 80) || null,
        cleanText(req.body.accountHolder ?? old.account_holder, 150) || null, active, cleanText(req.body.notes ?? old.notes, 500) || null,
        req.auth.user.id, nowIso(), old.id);
    const row = db.prepare('SELECT * FROM fund_accounts WHERE id=?').get(old.id);
    audit(req.auth.user.id, 'UPDATE', 'FUND_ACCOUNT', old.id, accountView(old), accountView(row), 'Mengubah akun kas/bank');
    res.json({ account: accountView(row) });
  } catch (error) { next(error); }
});

app.get('/api/master-data', authMiddleware, (_req, res) => {
  res.json({
    categories: db.prepare('SELECT * FROM transaction_categories ORDER BY active DESC,name COLLATE NOCASE').all(),
    costCenters: db.prepare('SELECT * FROM cost_centers ORDER BY active DESC,name COLLATE NOCASE').all(),
    vendors: db.prepare('SELECT * FROM vendors ORDER BY active DESC,name COLLATE NOCASE').all()
  });
});

app.post('/api/cost-centers', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const code = cleanText(req.body.code, 40).toUpperCase();
    const name = cleanText(req.body.name, 150);
    if (!code || !name) throw new AppError('Kode dan nama cost center wajib diisi.');
    const id = newId('CC');
    const now = nowIso();
    db.prepare('INSERT INTO cost_centers(id,code,name,active,notes,created_at,updated_at) VALUES(?,?,?,1,?,?,?)')
      .run(id, code, name, cleanText(req.body.notes, 500) || null, now, now);
    audit(req.auth.user.id, 'CREATE', 'COST_CENTER', id, '', { code, name }, 'Membuat cost center');
    res.status(201).json({ costCenter: db.prepare('SELECT * FROM cost_centers WHERE id=?').get(id) });
  } catch (error) { next(error); }
});

app.post('/api/vendors', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const code = cleanText(req.body.code || nextNumber('VND', localDate()), 50).toUpperCase();
    const name = cleanText(req.body.name, 180);
    if (!name) throw new AppError('Nama vendor wajib diisi.');
    const id = newId('VND');
    const now = nowIso();
    db.prepare(`INSERT INTO vendors(id,code,name,contact_name,phone,email,bank_name,account_number,account_holder,npwp,active,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
      .run(id, code, name, cleanText(req.body.contactName, 150) || null, cleanText(req.body.phone, 50) || null,
        cleanText(req.body.email, 150) || null, cleanText(req.body.bankName, 100) || null, cleanText(req.body.accountNumber, 80) || null,
        cleanText(req.body.accountHolder, 150) || null, cleanText(req.body.npwp, 50) || null, cleanText(req.body.notes, 500) || null, now, now);
    audit(req.auth.user.id, 'CREATE', 'VENDOR', id, '', { code, name }, 'Membuat vendor');
    res.status(201).json({ vendor: db.prepare('SELECT * FROM vendors WHERE id=?').get(id) });
  } catch (error) { next(error); }
});

app.get('/api/transactions', authMiddleware, (req, res) => {
  const where = [];
  const params = [];
  if (req.query.from) { where.push('t.transaction_date>=?'); params.push(validatedDate(req.query.from, 'Tanggal awal')); }
  if (req.query.to) { where.push('t.transaction_date<=?'); params.push(validatedDate(req.query.to, 'Tanggal akhir')); }
  if (req.query.accountId) { where.push('t.fund_account_id=?'); params.push(String(req.query.accountId)); }
  if (req.query.direction && ['IN', 'OUT'].includes(String(req.query.direction))) { where.push('t.direction=?'); params.push(String(req.query.direction)); }
  const sql = `SELECT t.*,f.name AS fund_account_name,f.code AS fund_account_code,c.name AS category_name,cc.name AS cost_center_name,v.name AS vendor_name,u.name AS created_by_name
    FROM transactions t JOIN fund_accounts f ON f.id=t.fund_account_id
    LEFT JOIN transaction_categories c ON c.id=t.category_id LEFT JOIN cost_centers cc ON cc.id=t.cost_center_id
    LEFT JOIN vendors v ON v.id=t.vendor_id JOIN users u ON u.id=t.created_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 1000`;
  res.json({ transactions: db.prepare(sql).all(...params) });
});

app.post('/api/transactions', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const date = assertOpenDate(req.body.transactionDate || localDate());
    const direction = cleanText(req.body.direction, 3).toUpperCase();
    if (!['IN', 'OUT'].includes(direction)) throw new AppError('Jenis transaksi wajib IN atau OUT.');
    const amount = toAmount(req.body.amount);
    if (amount <= 0) throw new AppError('Nominal wajib lebih dari 0.');
    const fund = db.prepare('SELECT * FROM fund_accounts WHERE id=? AND active=1').get(cleanText(req.body.fundAccountId, 100));
    if (!fund) throw new AppError('Akun kas/bank tidak ditemukan.', 404);
    if (direction === 'OUT') assertBalance(fund.id, amount);
    const description = cleanText(req.body.description, 500);
    if (!description) throw new AppError('Keterangan transaksi wajib diisi.');
    const row = insertTransaction({
      date, fundAccountId: fund.id, direction, categoryId: cleanText(req.body.categoryId, 100) || null,
      costCenterId: cleanText(req.body.costCenterId, 100) || null, vendorId: cleanText(req.body.vendorId, 100) || null,
      amount, description, counterparty: cleanText(req.body.counterparty, 200), referenceNo: cleanText(req.body.referenceNo, 100),
      createdBy: req.auth.user.id, approvedBy: req.auth.user.id
    });
    audit(req.auth.user.id, 'CREATE', 'TRANSACTION', row.id, '', row, 'Mencatat transaksi langsung');
    res.status(201).json({ transaction: row });
  } catch (error) { next(error); }
});

app.get('/api/payment-requests', authMiddleware, (_req, res) => {
  const rows = db.prepare(`SELECT p.*,v.name AS vendor_name,cc.name AS cost_center_name,c.name AS category_name,u.name AS created_by_name
    FROM payment_requests p LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN cost_centers cc ON cc.id=p.cost_center_id
    LEFT JOIN transaction_categories c ON c.id=p.category_id JOIN users u ON u.id=p.created_by
    ORDER BY p.request_date DESC,p.created_at DESC LIMIT 1000`).all();
  res.json({ requests: rows });
});

app.post('/api/payment-requests', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE', 'MANAGER', 'APPROVER'), (req, res, next) => {
  try {
    const requestDate = validatedDate(req.body.requestDate || localDate(), 'Tanggal pengajuan');
    const amount = toAmount(req.body.amount);
    const purpose = cleanText(req.body.purpose, 1000);
    if (amount <= 0 || !purpose) throw new AppError('Nominal dan keperluan wajib diisi.');
    const id = newId('PAY');
    const no = nextNumber('PAY', requestDate);
    const now = nowIso();
    db.prepare(`INSERT INTO payment_requests(
      id,request_no,request_date,requester_name,requester_user_id,division,cost_center_id,vendor_id,category_id,amount,purpose,due_date,reference_no,status,created_by,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?,?,?)`)
      .run(id, no, requestDate, cleanText(req.body.requesterName || req.auth.user.name, 180), req.auth.user.id,
        cleanText(req.body.division, 100) || null, cleanText(req.body.costCenterId, 100) || null, cleanText(req.body.vendorId, 100) || null,
        cleanText(req.body.categoryId, 100) || null, amount, purpose, req.body.dueDate ? validatedDate(req.body.dueDate, 'Jatuh tempo') : null,
        cleanText(req.body.referenceNo, 100) || null, req.auth.user.id, now, now);
    auditAction('PAYMENT_REQUEST', id, 'SUBMIT', req.auth.user.id, req.body.note || '');
    audit(req.auth.user.id, 'SUBMIT', 'PAYMENT_REQUEST', id, '', { requestNo: no, amount, purpose }, 'Mengajukan pembayaran');
    res.status(201).json({ request: db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id) });
  } catch (error) { next(error); }
});

app.post('/api/payment-requests/:id/verify', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Permintaan pembayaran tidak ditemukan.', 404);
    if (row.status !== 'SUBMITTED') throw new AppError('Hanya pengajuan berstatus SUBMITTED yang dapat diverifikasi.', 409);
    db.prepare("UPDATE payment_requests SET status='VERIFIED',finance_note=?,updated_at=? WHERE id=?")
      .run(cleanText(req.body.note, 1000) || null, nowIso(), row.id);
    auditAction('PAYMENT_REQUEST', row.id, 'VERIFY', req.auth.user.id, req.body.note || '');
    audit(req.auth.user.id, 'VERIFY', 'PAYMENT_REQUEST', row.id, row.status, 'VERIFIED', 'Finance memverifikasi permintaan pembayaran');
    res.json({ request: db.prepare('SELECT * FROM payment_requests WHERE id=?').get(row.id) });
  } catch (error) { next(error); }
});

app.post('/api/payment-requests/:id/approve', authMiddleware, (req, res, next) => {
  try {
    if (!canApprove(req.auth.user)) throw new AppError('Anda tidak memiliki hak approval.', 403);
    const row = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Permintaan pembayaran tidak ditemukan.', 404);
    if (row.status !== 'VERIFIED') throw new AppError('Pengajuan wajib diverifikasi Finance sebelum approval.', 409);
    db.prepare("UPDATE payment_requests SET status='APPROVED',updated_at=? WHERE id=?").run(nowIso(), row.id);
    auditAction('PAYMENT_REQUEST', row.id, 'APPROVE', req.auth.user.id, req.body.note || '');
    audit(req.auth.user.id, 'APPROVE', 'PAYMENT_REQUEST', row.id, row.status, 'APPROVED', 'Permintaan pembayaran disetujui');
    res.json({ request: db.prepare('SELECT * FROM payment_requests WHERE id=?').get(row.id) });
  } catch (error) { next(error); }
});

app.post('/api/payment-requests/:id/reject', authMiddleware, (req, res, next) => {
  try {
    if (!canApprove(req.auth.user) && !canFinance(req.auth.user)) throw new AppError('Anda tidak memiliki hak menolak pengajuan.', 403);
    const row = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Permintaan pembayaran tidak ditemukan.', 404);
    if (!['SUBMITTED', 'VERIFIED'].includes(row.status)) throw new AppError('Status pengajuan tidak dapat ditolak.', 409);
    const reason = cleanText(req.body.reason, 1000);
    if (!reason) throw new AppError('Alasan penolakan wajib diisi.');
    db.prepare("UPDATE payment_requests SET status='REJECTED',rejection_reason=?,updated_at=? WHERE id=?").run(reason, nowIso(), row.id);
    auditAction('PAYMENT_REQUEST', row.id, 'REJECT', req.auth.user.id, reason);
    audit(req.auth.user.id, 'REJECT', 'PAYMENT_REQUEST', row.id, row.status, 'REJECTED', reason);
    res.json({ request: db.prepare('SELECT * FROM payment_requests WHERE id=?').get(row.id) });
  } catch (error) { next(error); }
});

app.post('/api/payment-requests/:id/pay', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Permintaan pembayaran tidak ditemukan.', 404);
    if (row.status !== 'APPROVED') throw new AppError('Pengajuan belum berstatus APPROVED.', 409);
    if (row.payment_transaction_id) throw new AppError('Pengajuan ini sudah dibayar.', 409);
    const fund = db.prepare('SELECT * FROM fund_accounts WHERE id=? AND active=1').get(cleanText(req.body.fundAccountId, 100));
    if (!fund) throw new AppError('Akun pembayaran tidak ditemukan.', 404);
    assertBalance(fund.id, Number(row.amount));
    const date = assertOpenDate(req.body.paymentDate || localDate());
    const trx = insertTransaction({
      date, fundAccountId: fund.id, direction: 'OUT', categoryId: row.category_id, costCenterId: row.cost_center_id,
      vendorId: row.vendor_id, amount: Number(row.amount), description: row.purpose,
      counterparty: row.vendor_id ? (db.prepare('SELECT name FROM vendors WHERE id=?').get(row.vendor_id)?.name || '') : row.requester_name,
      referenceNo: cleanText(req.body.referenceNo || row.reference_no || row.request_no, 100), sourceType: 'PAYMENT_REQUEST', sourceId: row.id,
      createdBy: req.auth.user.id, approvedBy: req.auth.user.id
    });
    db.prepare("UPDATE payment_requests SET status='PAID',payment_transaction_id=?,updated_at=? WHERE id=?").run(trx.id, nowIso(), row.id);
    auditAction('PAYMENT_REQUEST', row.id, 'PAY', req.auth.user.id, req.body.note || '');
    audit(req.auth.user.id, 'PAY', 'PAYMENT_REQUEST', row.id, 'APPROVED', { status: 'PAID', transactionId: trx.id }, 'Finance membayar permintaan pembayaran');
    res.json({ request: db.prepare('SELECT * FROM payment_requests WHERE id=?').get(row.id), transaction: trx });
  } catch (error) { next(error); }
});

app.get('/api/transfers', authMiddleware, (_req, res) => {
  const rows = db.prepare(`SELECT t.*,fa.name AS from_account_name,ta.name AS to_account_name,u.name AS created_by_name,ap.name AS approved_by_name
    FROM cash_transfers t JOIN fund_accounts fa ON fa.id=t.from_account_id LEFT JOIN fund_accounts ta ON ta.id=t.to_account_id
    JOIN users u ON u.id=t.created_by LEFT JOIN users ap ON ap.id=t.approved_by
    ORDER BY t.transfer_date DESC,t.created_at DESC LIMIT 1000`).all();
  res.json({ transfers: rows });
});

app.post('/api/transfers', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (req, res, next) => {
  try {
    const date = assertOpenDate(req.body.transferDate || localDate());
    const from = db.prepare('SELECT * FROM fund_accounts WHERE id=? AND active=1').get(cleanText(req.body.fromAccountId, 100));
    if (!from) throw new AppError('Akun sumber tidak ditemukan.', 404);
    const destinationType = cleanText(req.body.destinationType, 20).toUpperCase();
    if (!['INTERNAL', 'KAS_KECIL'].includes(destinationType)) throw new AppError('Tujuan transfer tidak valid.');
    const amount = toAmount(req.body.amount);
    if (amount <= 0) throw new AppError('Nominal transfer wajib lebih dari 0.');
    assertBalance(from.id, amount);
    let toAccountId = null;
    let recipientUserId = null;
    let integrationId = null;
    if (destinationType === 'INTERNAL') {
      const to = db.prepare('SELECT * FROM fund_accounts WHERE id=? AND active=1').get(cleanText(req.body.toAccountId, 100));
      if (!to || to.id === from.id) throw new AppError('Akun tujuan transfer internal tidak valid.');
      toAccountId = to.id;
    } else {
      recipientUserId = cleanText(req.body.recipientUserId, 100);
      if (!recipientUserId) throw new AppError('Penerima Kas Kecil wajib dipilih.');
      integrationId = nextNumber('KB', date);
    }
    const id = newId('TRF');
    const no = nextNumber('TRF', date);
    const description = cleanText(req.body.description, 500);
    if (!description) throw new AppError('Keterangan transfer wajib diisi.');
    db.prepare(`INSERT INTO cash_transfers(
      id,transfer_no,transfer_date,from_account_id,to_account_id,destination_type,amount,description,status,recipient_user_id,integration_id,created_by,created_at
    ) VALUES(?,?,?,?,?,?,?,?, 'PENDING',?,?,?,?)`)
      .run(id, no, date, from.id, toAccountId, destinationType, amount, description, recipientUserId, integrationId, req.auth.user.id, nowIso());
    auditAction('TRANSFER', id, 'SUBMIT', req.auth.user.id, '');
    audit(req.auth.user.id, 'SUBMIT', 'TRANSFER', id, '', { transferNo: no, amount, destinationType, integrationId }, 'Mengajukan transfer dana');
    res.status(201).json({ transfer: db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(id) });
  } catch (error) { next(error); }
});

app.post('/api/transfers/:id/approve', authMiddleware, (req, res, next) => {
  try {
    if (!canApprove(req.auth.user)) throw new AppError('Anda tidak memiliki hak approval.', 403);
    const row = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Transfer tidak ditemukan.', 404);
    if (row.status !== 'PENDING') throw new AppError('Hanya transfer PENDING yang dapat disetujui.', 409);
    db.prepare("UPDATE cash_transfers SET status='APPROVED',approved_by=?,approved_at=? WHERE id=?").run(req.auth.user.id, nowIso(), row.id);
    auditAction('TRANSFER', row.id, 'APPROVE', req.auth.user.id, req.body.note || '');
    audit(req.auth.user.id, 'APPROVE', 'TRANSFER', row.id, 'PENDING', 'APPROVED', 'Transfer dana disetujui; menunggu eksekusi Finance');
    res.json({ transfer: db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(row.id) });
  } catch (error) { next(error); }
});

app.post('/api/transfers/:id/reject', authMiddleware, (req, res, next) => {
  try {
    if (!canApprove(req.auth.user)) throw new AppError('Anda tidak memiliki hak approval.', 403);
    const row = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Transfer tidak ditemukan.', 404);
    if (row.status !== 'PENDING') throw new AppError('Hanya transfer PENDING yang dapat ditolak.', 409);
    db.prepare("UPDATE cash_transfers SET status='REJECTED' WHERE id=?").run(row.id);
    auditAction('TRANSFER', row.id, 'REJECT', req.auth.user.id, req.body.reason || '');
    audit(req.auth.user.id, 'REJECT', 'TRANSFER', row.id, 'PENDING', 'REJECTED', cleanText(req.body.reason, 1000));
    res.json({ transfer: db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(row.id) });
  } catch (error) { next(error); }
});

app.post('/api/transfers/:id/execute', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(req.params.id);
  if (!row) throw new AppError('Transfer tidak ditemukan.', 404);
  if (row.status !== 'APPROVED') throw new AppError('Transfer wajib disetujui sebelum dieksekusi.', 409);
  if (row.destination_type === 'INTERNAL') {
    executeInternalTransfer(row, req.auth.user.id);
    db.prepare("UPDATE cash_transfers SET status='SYNCED' WHERE id=?").run(row.id);
    auditAction('TRANSFER', row.id, 'PAY', req.auth.user.id, req.body.note || '');
    audit(req.auth.user.id, 'EXECUTE', 'TRANSFER', row.id, 'APPROVED', 'SYNCED', 'Transfer antar kas/bank dieksekusi');
    return res.json({ transfer: db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(row.id) });
  }
  const sync = await syncPettyCashTransfer(row.id, req.auth.user.id);
  return res.json({ transfer: db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(row.id), sync });
}));

app.post('/api/transfers/:id/retry-sync', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(req.params.id);
  if (!row) throw new AppError('Transfer tidak ditemukan.', 404);
  if (row.status !== 'SYNC_FAILED') throw new AppError('Retry hanya tersedia untuk transfer SYNC_FAILED.', 409);
  const sync = await syncPettyCashTransfer(row.id, req.auth.user.id);
  res.json({ transfer: db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(row.id), sync });
}));

app.get('/api/integration/status', authMiddleware, asyncRoute(async (_req, res) => res.json(await pettyCash.health())));
app.get('/api/integration/petty-cash-users', authMiddleware, asyncRoute(async (_req, res) => res.json(await pettyCash.listPettyCashUsers())));

app.get('/api/audit-logs', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), (_req, res) => {
  res.json({ logs: db.prepare(`SELECT a.*,u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.timestamp DESC LIMIT 1000`).all() });
});

app.get('/api/settings', authMiddleware, requireRoles('SUPER_ADMIN'), (_req, res) => {
  res.json({ settings: db.prepare('SELECT key,value,value_type,description,updated_at FROM settings ORDER BY key').all() });
});

app.patch('/api/settings/:key', authMiddleware, requireRoles('SUPER_ADMIN'), (req, res, next) => {
  try {
    setSetting(req.params.key, req.body.value ?? '', req.auth.user.id);
    audit(req.auth.user.id, 'UPDATE', 'SETTING', req.params.key, '', { value: String(req.body.value ?? '') }, 'Mengubah pengaturan aplikasi');
    res.json({ ok: true, value: getSetting(req.params.key, '') });
  } catch (error) { next(error); }
});

app.get('/api/users', authMiddleware, requireRoles('SUPER_ADMIN'), (_req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY active DESC,name COLLATE NOCASE').all().map(publicUser) });
});

app.post('/api/users', authMiddleware, requireRoles('SUPER_ADMIN'), (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 180);
    const username = cleanUsername(req.body.username);
    const role = cleanText(req.body.role, 20).toUpperCase();
    if (!name || !username || !Object.hasOwn(ROLE_POWER, role)) throw new AppError('Data pengguna tidak valid.');
    const credentials = hashPassword(String(req.body.password || ''));
    const id = newId('USR');
    const now = nowIso();
    db.prepare('INSERT INTO users(id,name,username,password_hash,password_salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)')
      .run(id, name, username, credentials.hash, credentials.salt, role, now, now);
    audit(req.auth.user.id, 'CREATE', 'USER', id, '', { name, username, role }, 'Membuat pengguna');
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  } catch (error) { next(error); }
});

app.post('/api/users/:id/password', authMiddleware, requireRoles('SUPER_ADMIN'), (req, res, next) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!user) throw new AppError('Pengguna tidak ditemukan.', 404);
    const credentials = hashPassword(String(req.body.password || ''));
    db.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(credentials.hash, credentials.salt, nowIso(), user.id);
    db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(nowIso(), user.id);
    audit(req.auth.user.id, 'PASSWORD_RESET', 'USER', user.id, '', '', 'Reset password pengguna');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/backups', authMiddleware, requireRoles('SUPER_ADMIN'), (_req, res) => {
  res.json({ backups: listBackups().map(({ filePath, mtime, ...item }) => item) });
});

app.post('/api/backups', authMiddleware, requireRoles('SUPER_ADMIN'), (_req, res, next) => {
  try {
    const file = backupDatabase('manual');
    res.status(201).json({ ok: true, fileName: path.basename(file) });
  } catch (error) { next(error); }
});

app.get('/api/backups/:fileName/download', authMiddleware, requireRoles('SUPER_ADMIN'), (req, res, next) => {
  try {
    const fileName = path.basename(String(req.params.fileName || ''));
    const filePath = path.join(BACKUP_DIR, fileName);
    if (!/^kas-besar-.*\.sqlite$/.test(fileName) || !fs.existsSync(filePath)) throw new AppError('Backup tidak ditemukan.', 404);
    res.download(filePath, fileName);
  } catch (error) { next(error); }
});

app.use(express.static(PUBLIC_DIR, { etag: true, cacheControl: false, setHeaders: (res, filePath) => {
  res.setHeader('Cache-Control', path.basename(filePath) === 'index.html' ? 'no-store' : 'no-cache, must-revalidate');
} }));
app.use('/api', (_req, _res, next) => next(new AppError('Endpoint tidak ditemukan.', 404)));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((error, _req, res, _next) => {
  const status = Number(error.status || (String(error.message || '').includes('UNIQUE constraint') ? 409 : 500));
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Terjadi kesalahan pada server.' : error.message });
});

cron.schedule('30 2 * * *', () => {
  try { cleanupSessions(); backupDatabase('auto'); }
  catch (error) { console.error('Backup otomatis gagal:', error); }
}, { timezone: String(getSetting('TIMEZONE', 'Asia/Jakarta')) });

app.listen(PORT, '0.0.0.0', () => {
  if (APP_PEPPER === 'change-this-pepper-before-production') console.warn('PERINGATAN: APP_PEPPER belum diubah.');
  console.log(`AINET Kas Besar v${APP_VERSION} berjalan di port ${PORT}`);
});

module.exports = { app, dashboardData, syncPettyCashTransfer };
