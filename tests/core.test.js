const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-besar-test-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.APP_PEPPER = 'test-pepper-that-is-not-production';
process.env.INITIAL_ADMIN_PASSWORD = 'TestAdmin123';

const security = require('../src/security');
const dbmod = require('../src/db');

test('password hash and verify works', () => {
  const data = security.hashPassword('Password123');
  assert.equal(security.verifyPassword('Password123', data.hash, data.salt), true);
  assert.equal(security.verifyPassword('Wrong123', data.hash, data.salt), false);
});

test('database seeds admin and master data', () => {
  const admin = dbmod.db.prepare("SELECT * FROM users WHERE role='SUPER_ADMIN'").get();
  assert.ok(admin);
  assert.equal(admin.username, 'admin');
  assert.ok(dbmod.db.prepare('SELECT COUNT(*) AS total FROM transaction_categories').get().total >= 5);
  assert.ok(dbmod.db.prepare('SELECT COUNT(*) AS total FROM cost_centers').get().total >= 8);
});

test('numbering is sequential per prefix and period', () => {
  const one = dbmod.nextNumber('PAY', '2026-08-17');
  const two = dbmod.nextNumber('PAY', '2026-08-17');
  assert.match(one, /^PAY-202608-\d{5}$/);
  assert.equal(Number(two.slice(-5)), Number(one.slice(-5)) + 1);
});

test('backup creates sqlite file', () => {
  const file = dbmod.backupDatabase('test');
  assert.equal(fs.existsSync(file), true);
  assert.ok(fs.statSync(file).size > 0);
});

test.after(() => {
  try { dbmod.db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
