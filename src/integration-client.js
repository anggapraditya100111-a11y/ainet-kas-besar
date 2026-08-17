const { cleanText } = require('./security');

function config() {
  return {
    baseUrl: String(process.env.KAS_KECIL_INTEGRATION_URL || '').trim().replace(/\/$/, ''),
    key: String(process.env.KAS_BESAR_INTEGRATION_KEY || '').trim()
  };
}

function configured() {
  const cfg = config();
  return Boolean(cfg.baseUrl && cfg.key);
}

async function request(path, options = {}) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.key) {
    const error = new Error('Integrasi Kas Kecil belum dikonfigurasi.');
    error.status = 503;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${cfg.baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Integration-Key': cfg.key,
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const error = new Error(cleanText(body.error || `Kas Kecil merespons HTTP ${response.status}`, 500));
      error.status = response.status >= 400 && response.status < 500 ? 409 : 502;
      error.remoteStatus = response.status;
      error.remoteBody = body;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Koneksi ke Kas Kecil timeout.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function health() {
  const cfg = config();
  if (!cfg.baseUrl) return { ok: false, configured: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${cfg.baseUrl}/health`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok && Boolean(body.ok), configured: configured(), remote: body };
  } catch (error) {
    return { ok: false, configured: configured(), error: error.name === 'AbortError' ? 'timeout' : cleanText(error.message, 300) };
  } finally {
    clearTimeout(timeout);
  }
}

async function listPettyCashUsers() {
  return request('/api/integration/v1/users', { method: 'GET' });
}

async function sendFunding(payload) {
  return request('/api/integration/v1/funding', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function getFunding(integrationId) {
  const safe = encodeURIComponent(String(integrationId || ''));
  return request(`/api/integration/v1/funding/${safe}`, { method: 'GET' });
}

module.exports = { configured, health, listPettyCashUsers, sendFunding, getFunding };
