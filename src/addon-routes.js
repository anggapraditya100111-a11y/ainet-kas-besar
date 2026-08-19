'use strict';

const helmet = require('helmet');
const {
  db,
  nowIso,
  localDate,
  getSetting,
  audit
} = require('./db');
const {
  newId,
  cleanText,
  hashToken,
  hashPassword,
  verifyPassword,
  assertPassword
} = require('./security');

const APP_VERSION = '1.1.0';
const COOKIE_NAME = 'kb_session';
const ACCOUNT_CLASSES = new Set(['PENDAPATAN', 'BEBAN', 'TRANSFER', 'LAINNYA']);
const ACCOUNT_SCOPES = new Set(['IN', 'OUT', 'BOTH']);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureEnhancementSchema() {
  ensureColumn('transaction_categories', 'account_class', "TEXT NOT NULL DEFAULT 'LAINNYA'");
  ensureColumn('transaction_categories', 'notes', 'TEXT');

  db.prepare("UPDATE transaction_categories SET account_class='PENDAPATAN' WHERE code='PENDAPATAN-LAIN' AND account_class='LAINNYA'").run();
  db.prepare("UPDATE transaction_categories SET account_class='BEBAN' WHERE code IN ('OPERASIONAL','VENDOR','PAJAK') AND account_class='LAINNYA'").run();
  db.prepare("UPDATE transaction_categories SET account_class='TRANSFER' WHERE code='TRANSFER' AND account_class='LAINNYA'").run();
}

function parseCookies(req) {
  const result = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); }
    catch { result[key] = value; }
  }
  return result;
}

function authMiddleware(req, _res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return next(Object.assign(new Error('Silakan login kembali.'), { status: 401 }));
  const sessionHash = hashToken('SESSION', token);
  const row = db.prepare(`SELECT s.*,u.id AS uid,u.name,u.username,u.role,u.active,u.last_login
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sessionHash);
  if (!row || row.revoked_at || !row.active || row.expires_at < nowIso()) {
    return next(Object.assign(new Error('Sesi berakhir. Silakan login kembali.'), { status: 401 }));
  }
  req.addonAuth = {
    sessionHash,
    user: {
      id: row.uid,
      name: row.name,
      username: row.username,
      role: row.role,
      active: Boolean(row.active),
      lastLogin: row.last_login || ''
    }
  };
  next();
}

function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.addonAuth.user.role)) {
      return next(Object.assign(new Error('Anda tidak memiliki hak akses untuk tindakan ini.'), { status: 403 }));
    }
    next();
  };
}

function validDate(value, label = 'Tanggal') {
  const date = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error(`${label} tidak valid.`), { status: 400 });
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error(`${label} tidak valid.`), { status: 400 });
  }
  return date;
}

function categoryUsage(id) {
  const transactions = Number(db.prepare('SELECT COUNT(*) AS total FROM transactions WHERE category_id=?').get(id).total || 0);
  const paymentRequests = Number(db.prepare('SELECT COUNT(*) AS total FROM payment_requests WHERE category_id=?').get(id).total || 0);
  return { transactions, paymentRequests, total: transactions + paymentRequests };
}

function transactionAccountView(row) {
  const usage = categoryUsage(row.id);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scope: row.scope,
    accountClass: row.account_class || 'LAINNYA',
    active: Boolean(row.active),
    notes: row.notes || '',
    usage,
    canDelete: usage.total === 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function registerAddonRoutes(app, express) {
  if (app.locals.kasBesarEnhancementsRegistered) return;
  app.locals.kasBesarEnhancementsRegistered = true;
  ensureEnhancementSchema();

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'ainet-kas-besar', version: APP_VERSION }));

  const router = express.Router();
  router.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null
      }
    }
  }));
  router.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return next(Object.assign(new Error('Origin permintaan tidak diizinkan.'), { status: 403 }));
      }
    } catch {
      return next(Object.assign(new Error('Origin permintaan tidak valid.'), { status: 403 }));
    }
    next();
  });

  const json = express.json({ limit: '1mb' });

  router.get('/auth/me', authMiddleware, (req, res) => {
    res.json({
      user: req.addonAuth.user,
      appVersion: APP_VERSION,
      appName: getSetting('APP_NAME', 'AINET Kas Besar'),
      companyName: getSetting('COMPANY_NAME', '')
    });
  });

  router.get('/profile', authMiddleware, (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.addonAuth.user.id);
    res.json({ user: publicUser(row) });
  });

  router.post('/profile/password', json, authMiddleware, route((req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.addonAuth.user.id);
    if (!row) throw Object.assign(new Error('Pengguna tidak ditemukan.'), { status: 404 });

    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (!verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
      throw Object.assign(new Error('Password lama tidak sesuai.'), { status: 400 });
    }
    assertPassword(newPassword);
    if (verifyPassword(newPassword, row.password_hash, row.password_salt)) {
      throw Object.assign(new Error('Password baru harus berbeda dari password lama.'), { status: 400 });
    }

    const credentials = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?')
      .run(credentials.hash, credentials.salt, nowIso(), row.id);
    db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND token_hash<>? AND revoked_at IS NULL')
      .run(nowIso(), row.id, req.addonAuth.sessionHash);
    audit(row.id, 'PASSWORD_CHANGE', 'USER', row.id, '', '', 'Pengguna mengganti password akun sendiri');
    res.json({ ok: true });
  }));

  router.get('/master-data', authMiddleware, (_req, res) => {
    res.json({
      categories: db.prepare('SELECT * FROM transaction_categories ORDER BY active DESC,code COLLATE NOCASE').all(),
      costCenters: db.prepare('SELECT * FROM cost_centers ORDER BY active DESC,name COLLATE NOCASE').all(),
      vendors: db.prepare('SELECT * FROM vendors ORDER BY active DESC,name COLLATE NOCASE').all()
    });
  });

  router.get('/transaction-accounts', authMiddleware, (_req, res) => {
    const accounts = db.prepare('SELECT * FROM transaction_categories ORDER BY active DESC,code COLLATE NOCASE').all().map(transactionAccountView);
    res.json({ accounts });
  });

  router.post('/transaction-accounts', json, authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), route((req, res) => {
    const code = cleanText(req.body.code, 40).toUpperCase();
    const name = cleanText(req.body.name, 160);
    const scope = cleanText(req.body.scope || 'BOTH', 10).toUpperCase();
    const accountClass = cleanText(req.body.accountClass || 'LAINNYA', 20).toUpperCase();
    const notes = cleanText(req.body.notes, 500);
    if (!code || !name) throw Object.assign(new Error('Kode dan nama Akun Transaksi wajib diisi.'), { status: 400 });
    if (!ACCOUNT_SCOPES.has(scope)) throw Object.assign(new Error('Arah Akun Transaksi tidak valid.'), { status: 400 });
    if (!ACCOUNT_CLASSES.has(accountClass)) throw Object.assign(new Error('Klasifikasi Akun Transaksi tidak valid.'), { status: 400 });

    const id = newId('CAT');
    const now = nowIso();
    try {
      db.prepare(`INSERT INTO transaction_categories(id,code,name,scope,account_class,active,notes,created_at,updated_at)
        VALUES(?,?,?,?,?,1,?,?,?)`).run(id, code, name, scope, accountClass, notes || null, now, now);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('Kode Akun Transaksi sudah digunakan.'), { status: 409 });
      throw error;
    }
    const row = db.prepare('SELECT * FROM transaction_categories WHERE id=?').get(id);
    audit(req.addonAuth.user.id, 'CREATE', 'TRANSACTION_ACCOUNT', id, '', transactionAccountView(row), 'Membuat Akun Transaksi');
    res.status(201).json({ account: transactionAccountView(row) });
  }));

  router.patch('/transaction-accounts/:id', json, authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), route((req, res) => {
    const old = db.prepare('SELECT * FROM transaction_categories WHERE id=?').get(req.params.id);
    if (!old) throw Object.assign(new Error('Akun Transaksi tidak ditemukan.'), { status: 404 });

    const code = cleanText(req.body.code ?? old.code, 40).toUpperCase();
    const name = cleanText(req.body.name ?? old.name, 160);
    const scope = cleanText(req.body.scope ?? old.scope, 10).toUpperCase();
    const accountClass = cleanText(req.body.accountClass ?? old.account_class ?? 'LAINNYA', 20).toUpperCase();
    const notes = cleanText(req.body.notes ?? old.notes ?? '', 500);
    const active = req.body.active === undefined ? Number(old.active) : (req.body.active ? 1 : 0);
    if (!code || !name) throw Object.assign(new Error('Kode dan nama Akun Transaksi wajib diisi.'), { status: 400 });
    if (!ACCOUNT_SCOPES.has(scope)) throw Object.assign(new Error('Arah Akun Transaksi tidak valid.'), { status: 400 });
    if (!ACCOUNT_CLASSES.has(accountClass)) throw Object.assign(new Error('Klasifikasi Akun Transaksi tidak valid.'), { status: 400 });

    try {
      db.prepare(`UPDATE transaction_categories SET code=?,name=?,scope=?,account_class=?,active=?,notes=?,updated_at=? WHERE id=?`)
        .run(code, name, scope, accountClass, active, notes || null, nowIso(), old.id);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('Kode Akun Transaksi sudah digunakan.'), { status: 409 });
      throw error;
    }
    const row = db.prepare('SELECT * FROM transaction_categories WHERE id=?').get(old.id);
    audit(req.addonAuth.user.id, 'UPDATE', 'TRANSACTION_ACCOUNT', old.id, transactionAccountView(old), transactionAccountView(row), 'Mengubah Akun Transaksi');
    res.json({ account: transactionAccountView(row) });
  }));

  router.delete('/transaction-accounts/:id', authMiddleware, requireRoles('SUPER_ADMIN', 'FINANCE'), route((req, res) => {
    const row = db.prepare('SELECT * FROM transaction_categories WHERE id=?').get(req.params.id);
    if (!row) throw Object.assign(new Error('Akun Transaksi tidak ditemukan.'), { status: 404 });
    const usage = categoryUsage(row.id);
    if (usage.total > 0) {
      throw Object.assign(new Error('Akun Transaksi sudah digunakan dan tidak dapat dihapus. Nonaktifkan akun bila sudah tidak digunakan.'), { status: 409 });
    }
    db.prepare('DELETE FROM transaction_categories WHERE id=?').run(row.id);
    audit(req.addonAuth.user.id, 'DELETE', 'TRANSACTION_ACCOUNT', row.id, transactionAccountView(row), '', 'Menghapus Akun Transaksi yang belum pernah digunakan');
    res.json({ ok: true });
  }));

  router.get('/cash-mutations', authMiddleware, route((req, res) => {
    const month = localDate().slice(0, 7);
    const from = req.query.from ? validDate(req.query.from, 'Tanggal awal') : `${month}-01`;
    const to = req.query.to ? validDate(req.query.to, 'Tanggal akhir') : localDate();
    if (from > to) throw Object.assign(new Error('Tanggal awal tidak boleh melebihi tanggal akhir.'), { status: 400 });

    const accountId = cleanText(req.query.accountId, 100);
    if (accountId) {
      const account = db.prepare('SELECT id FROM fund_accounts WHERE id=?').get(accountId);
      if (!account) throw Object.assign(new Error('Akun Dana tidak ditemukan.'), { status: 404 });
    }

    const accountClause = accountId ? ' AND t.fund_account_id=?' : '';
    const openingParams = accountId ? [from, accountId] : [from];
    const opening = Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.direction='IN' THEN t.amount ELSE -t.amount END),0) AS total
      FROM transactions t WHERE t.status='APPROVED' AND t.cash_effect=1 AND t.transaction_date<?${accountClause}`)
      .get(...openingParams).total || 0);

    const rangeParams = accountId ? [from, to, accountId] : [from, to];
    const rows = db.prepare(`SELECT t.*,f.code AS fund_account_code,f.name AS fund_account_name,c.code AS transaction_account_code,c.name AS transaction_account_name
      FROM transactions t
      JOIN fund_accounts f ON f.id=t.fund_account_id
      LEFT JOIN transaction_categories c ON c.id=t.category_id
      WHERE t.status='APPROVED' AND t.cash_effect=1 AND t.transaction_date BETWEEN ? AND ?${accountClause}
      ORDER BY t.transaction_date ASC,t.created_at ASC,t.id ASC`).all(...rangeParams);

    let runningBalance = opening;
    let totalIn = 0;
    let totalOut = 0;
    const entries = rows.map(row => {
      const amount = Number(row.amount || 0);
      if (row.direction === 'IN') { totalIn += amount; runningBalance += amount; }
      else { totalOut += amount; runningBalance -= amount; }
      return {
        transactionId: row.id,
        transactionNo: row.transaction_no,
        transactionDate: row.transaction_date,
        fundAccountId: row.fund_account_id,
        fundAccountCode: row.fund_account_code,
        fundAccountName: row.fund_account_name,
        transactionAccountCode: row.transaction_account_code || '',
        transactionAccountName: row.transaction_account_name || '',
        direction: row.direction,
        amount,
        description: row.description,
        counterparty: row.counterparty || '',
        referenceNo: row.reference_no || '',
        sourceType: row.source_type,
        runningBalance
      };
    });

    res.json({
      from,
      to,
      accountId: accountId || '',
      openingBalance: opening,
      totalIn,
      totalOut,
      closingBalance: runningBalance,
      entries
    });
  }));

  app.use('/api', router);
}

module.exports = registerAddonRoutes;
