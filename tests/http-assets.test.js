const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('CasaOS HTTP runtime disables CSP upgrade-insecure-requests', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'start.js'), 'utf8');
  assert.match(source, /upgradeInsecureRequests:\s*null/);
});

test('frontend keeps local CSS and JavaScript assets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'styles.css')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'app.js')), true);
});

test('Docker starts the HTTP-compatible runtime entry', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /CMD \["node", "src\/start\.js"\]/);
});
