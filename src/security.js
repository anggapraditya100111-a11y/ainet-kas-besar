const crypto = require('node:crypto');

const APP_PEPPER = String(process.env.APP_PEPPER || 'change-this-pepper-before-production');

function newId(prefix = 'ID') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function assertPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw Object.assign(new Error('Password minimal 8 karakter.'), { status: 400 });
  if (value.length > 128) throw Object.assign(new Error('Password terlalu panjang.'), { status: 400 });
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw Object.assign(new Error('Password wajib mengandung huruf dan angka.'), { status: 400 });
  }
  return value;
}

function hashPassword(password) {
  const value = assertPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(`${value}:${APP_PEPPER}`, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, expectedHash, salt) {
  if (!password || !expectedHash || !salt) return false;
  const candidate = crypto.scryptSync(`${String(password)}:${APP_PEPPER}`, String(salt), 64);
  const expected = Buffer.from(String(expectedHash), 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(scope, token) {
  return crypto.createHmac('sha256', APP_PEPPER).update(`${scope}:${String(token || '')}`).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

module.exports = {
  APP_PEPPER,
  newId,
  cleanText,
  assertPassword,
  hashPassword,
  verifyPassword,
  randomToken,
  hashToken,
  safeEqual
};
