const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { newId, hashPassword } = require('./security');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'kas-besar.sqlite');
const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.transaction = function transaction(handler) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = handler(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (ignored) {}
      throw error;
    }
  };
};

function nowIso() {
  return new Date().toISOString();
}

function localDate(date = new Date()) {
  const timezone = String(getSetting('TIMEZONE', process.env.TIMEZONE || 'Asia/Jakarta'));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function localPeriodMonth(date = new Date()) {
  return localDate(date).slice(0, 7);
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','FINANCE','MANAGER','APPROVER','VIEWER')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      last_login TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS fund_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('BANK','CASH')),
      bank_name TEXT,
      account_number TEXT,
      account_holder TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transaction_categories (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('IN','OUT','BOTH')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      bank_name TEXT,
      account_number TEXT,
      account_holder TEXT,
      npwp TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id TEXT PRIMARY KEY,
      period_month TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
      opened_at TEXT NOT NULL,
      opened_by TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      close_note TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      transaction_no TEXT NOT NULL UNIQUE,
      transaction_date TEXT NOT NULL,
      fund_account_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')),
      category_id TEXT,
      cost_center_id TEXT,
      vendor_id TEXT,
      amount INTEGER NOT NULL CHECK(amount > 0),
      description TEXT NOT NULL,
      counterparty TEXT,
      reference_no TEXT,
      status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','REVERSED')),
      cash_effect INTEGER NOT NULL DEFAULT 1 CHECK(cash_effect IN (0,1)),
      source_type TEXT NOT NULL DEFAULT 'DIRECT',
      source_id TEXT,
      attachment_path TEXT,
      attachment_name TEXT,
      attachment_mime TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      reversed_from_id TEXT,
      FOREIGN KEY(fund_account_id) REFERENCES fund_accounts(id),
      FOREIGN KEY(category_id) REFERENCES transaction_categories(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id),
      FOREIGN KEY(vendor_id) REFERENCES vendors(id),
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id),
      FOREIGN KEY(reversed_from_id) REFERENCES transactions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(fund_account_id, transaction_date DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_source ON transactions(source_type, source_id, direction)
      WHERE source_id IS NOT NULL AND source_id <> '';

    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      request_no TEXT NOT NULL UNIQUE,
      request_date TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      requester_user_id TEXT,
      division TEXT,
      cost_center_id TEXT,
      vendor_id TEXT,
      category_id TEXT,
      amount INTEGER NOT NULL CHECK(amount > 0),
      purpose TEXT NOT NULL,
      due_date TEXT,
      reference_no TEXT,
      attachment_path TEXT,
      attachment_name TEXT,
      attachment_mime TEXT,
      status TEXT NOT NULL CHECK(status IN ('SUBMITTED','VERIFIED','APPROVED','REJECTED','PAID','CANCELLED')),
      finance_note TEXT,
      rejection_reason TEXT,
      payment_transaction_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(requester_user_id) REFERENCES users(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id),
      FOREIGN KEY(vendor_id) REFERENCES vendors(id),
      FOREIGN KEY(category_id) REFERENCES transaction_categories(id),
      FOREIGN KEY(payment_transaction_id) REFERENCES transactions(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status, request_date DESC);

    CREATE TABLE IF NOT EXISTS approval_actions (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('PAYMENT_REQUEST','TRANSFER','TRANSACTION')),
      entity_id TEXT NOT NULL,
      step_no INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL CHECK(action IN ('SUBMIT','VERIFY','APPROVE','REJECT','PAY','CANCEL')),
      actor_id TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_approval_entity ON approval_actions(entity_type, entity_id, created_at);

    CREATE TABLE IF NOT EXISTS cash_transfers (
      id TEXT PRIMARY KEY,
      transfer_no TEXT NOT NULL UNIQUE,
      transfer_date TEXT NOT NULL,
      from_account_id TEXT NOT NULL,
      to_account_id TEXT,
      destination_type TEXT NOT NULL CHECK(destination_type IN ('INTERNAL','KAS_KECIL')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','SYNC_PENDING','SYNCED','SYNC_FAILED','REVERSED')),
      recipient_user_id TEXT,
      integration_id TEXT UNIQUE,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      sync_response TEXT,
      sync_error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      FOREIGN KEY(from_account_id) REFERENCES fund_accounts(id),
      FOREIGN KEY(to_account_id) REFERENCES fund_accounts(id),
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_status ON cash_transfers(status, transfer_date DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      value_type TEXT NOT NULL DEFAULT 'TEXT',
      description TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      old_value TEXT,
      new_value TEXT,
      description TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);

    CREATE TABLE IF NOT EXISTS sequences (
      prefix TEXT PRIMARY KEY,
      last_date TEXT NOT NULL,
      last_sequence INTEGER NOT NULL
    );
  `);

  seedAdmin();
  seedSettings();
  seedMasterData();
  ensureAccountingPeriod();
  cleanupSessions();
}

function seedAdmin() {
  const count = Number(db.prepare('SELECT COUNT(*) AS total FROM users').get().total || 0);
  if (count) return;
  const name = String(process.env.INITIAL_ADMIN_NAME || 'Administrator').trim();
  const username = String(process.env.INITIAL_ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || 'Admin12345');
  const credentials = hashPassword(password);
  const now = nowIso();
  db.prepare(`INSERT INTO users(id,name,username,password_hash,password_salt,role,active,created_at,updated_at)
    VALUES(?,?,?,?,?,'SUPER_ADMIN',1,?,?)`)
    .run(newId('USR'), name, username, credentials.hash, credentials.salt, now, now);
}

function seedSettings() {
  const rows = [
    ['APP_NAME', process.env.DEFAULT_APP_NAME || 'AINET Kas Besar', 'TEXT', 'Nama aplikasi'],
    ['COMPANY_NAME', process.env.DEFAULT_COMPANY_NAME || 'PT Axindo Infinitas Network', 'TEXT', 'Nama perusahaan'],
    ['TIMEZONE', process.env.TIMEZONE || 'Asia/Jakarta', 'TEXT', 'Zona waktu'],
    ['SESSION_HOURS', '8', 'NUMBER', 'Durasi sesi login'],
    ['THEME_COLOR', '#174ea6', 'TEXT', 'Warna utama aplikasi'],
    ['MAX_UPLOAD_MB', '10', 'NUMBER', 'Batas upload bukti'],
    ['PAYMENT_AUTO_APPROVE_LIMIT', '0', 'NUMBER', 'Batas auto approval; 0 berarti selalu approval']
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO settings(key,value,value_type,description,updated_at) VALUES(?,?,?,?,?)');
  const now = nowIso();
  const run = db.transaction(() => rows.forEach(row => insert.run(...row, now)));
  run();
}

function seedMasterData() {
  const now = nowIso();
  const categories = [
    ['PENDAPATAN-LAIN', 'Pendapatan Lain-lain', 'IN'],
    ['OPERASIONAL', 'Biaya Operasional', 'OUT'],
    ['VENDOR', 'Pembayaran Vendor', 'OUT'],
    ['PAJAK', 'Pajak dan Kewajiban', 'OUT'],
    ['TRANSFER', 'Transfer Antar Kas/Bank', 'BOTH']
  ];
  const insertCategory = db.prepare(`INSERT OR IGNORE INTO transaction_categories(id,code,name,scope,active,created_at,updated_at)
    VALUES(?,?,?,?,1,?,?)`);
  const seedCategories = db.transaction(() => categories.forEach(([code, name, scope]) =>
    insertCategory.run(newId('CAT'), code, name, scope, now, now)));
  seedCategories();

  const costCenters = [
    ['UMUM', 'Umum'], ['TEKNIS', 'Teknis'], ['NOC', 'NOC'], ['SALES', 'Sales'],
    ['HRGA', 'HRGA'], ['FINANCE', 'Finance'], ['PID', 'PID'], ['DIREKSI', 'Direksi']
  ];
  const insertCC = db.prepare(`INSERT OR IGNORE INTO cost_centers(id,code,name,active,created_at,updated_at) VALUES(?,?,?,1,?,?)`);
  const seedCC = db.transaction(() => costCenters.forEach(([code, name]) => insertCC.run(newId('CC'), code, name, now, now)));
  seedCC();
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value,value_type FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  if (row.value_type === 'NUMBER') return Number(row.value || 0);
  if (row.value_type === 'BOOLEAN') return ['1', 'true', 'TRUE'].includes(String(row.value));
  return row.value === null || row.value === '' ? fallback : row.value;
}

function setSetting(key, value, userId = 'SYSTEM') {
  const result = db.prepare('UPDATE settings SET value=?,updated_by=?,updated_at=? WHERE key=?')
    .run(String(value), userId, nowIso(), key);
  if (!result.changes) throw Object.assign(new Error('Pengaturan tidak ditemukan.'), { status: 404 });
}

function audit(userId, action, entityType, entityId = '', oldValue = '', newValue = '', description = '') {
  const encode = value => {
    if (value === '' || value === null || value === undefined) return '';
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 12000);
  };
  db.prepare(`INSERT INTO audit_logs(id,timestamp,user_id,action,entity_type,entity_id,old_value,new_value,description)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(newId('LOG'), nowIso(), userId || 'SYSTEM', action, entityType, entityId || '', encode(oldValue), encode(newValue), description);
}

function ensureAccountingPeriod(actorId = 'SYSTEM') {
  const existingOpen = db.prepare("SELECT * FROM accounting_periods WHERE status='OPEN' ORDER BY period_month DESC LIMIT 1").get();
  if (existingOpen) return existingOpen;
  const month = localPeriodMonth();
  let row = db.prepare('SELECT * FROM accounting_periods WHERE period_month=?').get(month);
  if (row) {
    db.prepare("UPDATE accounting_periods SET status='OPEN',opened_at=?,opened_by=? WHERE id=?").run(nowIso(), actorId, row.id);
    return db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(row.id);
  }
  const id = newId('PER');
  db.prepare("INSERT INTO accounting_periods(id,period_month,status,opened_at,opened_by) VALUES(?,?,'OPEN',?,?)")
    .run(id, month, nowIso(), actorId);
  return db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(id);
}

function nextNumber(prefix, date = localDate()) {
  const period = String(date).slice(0, 7).replace('-', '');
  const key = `${prefix}-${period}`;
  const current = db.prepare('SELECT last_sequence FROM sequences WHERE prefix=?').get(key);
  const next = Number(current?.last_sequence || 0) + 1;
  db.prepare(`INSERT INTO sequences(prefix,last_date,last_sequence) VALUES(?,?,?)
    ON CONFLICT(prefix) DO UPDATE SET last_date=excluded.last_date,last_sequence=excluded.last_sequence`)
    .run(key, date, next);
  return `${prefix}-${period}-${String(next).padStart(5, '0')}`;
}

function accountBalance(accountId) {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance
    FROM transactions
    WHERE fund_account_id=? AND status='APPROVED' AND cash_effect=1`).get(accountId);
  return Number(row?.balance || 0);
}

function totalCashPosition() {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance
    FROM transactions WHERE status='APPROVED' AND cash_effect=1`).get();
  return Number(row?.balance || 0);
}

function cleanupSessions() {
  const now = nowIso();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at<? OR (revoked_at IS NOT NULL AND revoked_at<?)').run(now, cutoff);
}

function listBackups() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => /^kas-besar-.*\.sqlite$/.test(name))
    .map(name => {
      const filePath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(filePath);
      return { fileName: name, size: stat.size, createdAt: stat.mtime.toISOString(), filePath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function backupDatabase(kind = 'manual') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUP_DIR, `kas-besar-${kind}-${stamp}.sqlite`);
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  audit('SYSTEM', 'BACKUP', 'DATABASE', path.basename(target), '', { kind }, 'Backup database Kas Besar');
  const auto = listBackups().filter(item => item.fileName.includes('-auto-'));
  for (const old of auto.slice(30)) fs.unlinkSync(old.filePath);
  return target;
}

initDatabase();

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  BACKUP_DIR,
  nowIso,
  localDate,
  localPeriodMonth,
  getSetting,
  setSetting,
  audit,
  ensureAccountingPeriod,
  nextNumber,
  accountBalance,
  totalCashPosition,
  cleanupSessions,
  backupDatabase,
  listBackups
};
