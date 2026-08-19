'use strict';

const path = require('node:path');
const {
  db,
  nowIso,
  getSetting,
  backupDatabase,
  audit
} = require('./db');
const {
  hashToken,
  verifyPassword
} = require('./security');

const APP_VERSION = '1.2.0';
const COOKIE_NAME = 'kb_session';
const CONFIRM_TEXT = 'HAPUS SEMUA TRANSAKSI';

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
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
  const row = db.prepare(`SELECT s.*,u.id AS uid,u.name,u.username,u.role,u.active,u.last_login,u.password_hash,u.password_salt
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sessionHash);
  if (!row || row.revoked_at || !row.active || row.expires_at < nowIso()) {
    return next(Object.assign(new Error('Sesi berakhir. Silakan login kembali.'), { status: 401 }));
  }
  req.maintenanceAuth = {
    sessionHash,
    user: {
      id: row.uid,
      name: row.name,
      username: row.username,
      role: row.role,
      active: Boolean(row.active),
      lastLogin: row.last_login || '',
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt
    }
  };
  next();
}

function requireSuperAdmin(req, _res, next) {
  if (req.maintenanceAuth.user.role !== 'SUPER_ADMIN') {
    return next(Object.assign(new Error('Hanya Super Admin yang dapat mengakses pemeliharaan data.'), { status: 403 }));
  }
  next();
}

function dataCounts() {
  const count = table => Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total || 0);
  return {
    transactions: count('transactions'),
    paymentRequests: count('payment_requests'),
    transfers: count('cash_transfers'),
    approvalActions: count('approval_actions'),
    auditLogs: count('audit_logs'),
    fundAccounts: count('fund_accounts'),
    transactionAccounts: count('transaction_categories'),
    vendors: count('vendors'),
    costCenters: count('cost_centers'),
    users: count('users')
  };
}

const clearTransactionData = db.transaction(() => {
  db.prepare('DELETE FROM approval_actions').run();
  db.prepare('DELETE FROM payment_requests').run();
  db.prepare('DELETE FROM cash_transfers').run();
  db.prepare('UPDATE transactions SET reversed_from_id=NULL WHERE reversed_from_id IS NOT NULL').run();
  db.prepare('DELETE FROM transactions').run();
  db.prepare('DELETE FROM audit_logs').run();
});

function registerMaintenanceRoutes(app, express) {
  if (app.locals.kasBesarMaintenanceRegistered) return;
  app.locals.kasBesarMaintenanceRegistered = true;

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'ainet-kas-besar', version: APP_VERSION }));

  const router = express.Router();
  const json = express.json({ limit: '128kb' });

  router.get('/auth/me', authMiddleware, (req, res) => {
    const { passwordHash, passwordSalt, ...user } = req.maintenanceAuth.user;
    res.json({
      user,
      appVersion: APP_VERSION,
      appName: getSetting('APP_NAME', 'AINET Kas Besar'),
      companyName: getSetting('COMPANY_NAME', '')
    });
  });

  router.get('/maintenance/status', authMiddleware, requireSuperAdmin, (_req, res) => {
    res.json({
      counts: dataCounts(),
      confirmationText: CONFIRM_TEXT,
      preserved: ['Akun Dana', 'Akun Transaksi', 'Vendor', 'Cost Center', 'Pengguna', 'Pengaturan', 'Periode Keuangan', 'Sequence/Nomor Dokumen']
    });
  });

  router.get('/maintenance/database/export', authMiddleware, requireSuperAdmin, (req, res, next) => {
    try {
      const file = backupDatabase('transfer');
      const name = `ainet-kas-besar-transfer-${new Date().toISOString().slice(0, 10)}.sqlite`;
      audit(req.maintenanceAuth.user.id, 'DATABASE_EXPORT', 'DATABASE', path.basename(file), '', '', 'Transfer/ekspor database Kas Besar');
      res.download(file, name);
    } catch (error) { next(error); }
  });

  router.post('/maintenance/transactions/clear', json, authMiddleware, requireSuperAdmin, (req, res, next) => {
    try {
      const password = String(req.body.password || '');
      const confirmation = String(req.body.confirmation || '').trim();
      const user = req.maintenanceAuth.user;

      if (!verifyPassword(password, user.passwordHash, user.passwordSalt)) {
        throw Object.assign(new Error('Password Super Admin tidak sesuai.'), { status: 400 });
      }
      if (confirmation !== CONFIRM_TEXT) {
        throw Object.assign(new Error(`Ketik tepat: ${CONFIRM_TEXT}`), { status: 400 });
      }

      const before = dataCounts();
      const backupFile = backupDatabase('before-clear-transactions');
      clearTransactionData();
      audit(user.id, 'CLEAR_ALL_TRANSACTIONS', 'DATABASE', '', before, dataCounts(), `Seluruh data transaksi dihapus. Backup otomatis: ${path.basename(backupFile)}`);

      res.json({
        ok: true,
        backupFile: path.basename(backupFile),
        deleted: {
          transactions: before.transactions,
          paymentRequests: before.paymentRequests,
          transfers: before.transfers,
          approvalActions: before.approvalActions,
          auditLogs: before.auditLogs
        },
        remaining: dataCounts()
      });
    } catch (error) { next(error); }
  });

  router.use((error, _req, res, _next) => {
    const status = Number(error.status || 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Terjadi kesalahan pada pemeliharaan data.' : error.message });
  });

  app.use('/api', router);
}

module.exports = registerMaintenanceRoutes;
module.exports._test = { dataCounts, clearTransactionData, CONFIRM_TEXT };
