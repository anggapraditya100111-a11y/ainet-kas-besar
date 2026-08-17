'use strict';

// CasaOS/LAN deployments commonly access the app over plain HTTP.
// Helmet enables CSP `upgrade-insecure-requests` by default, which can make
// browsers rewrite local /styles.css and /app.js requests to HTTPS even when
// no TLS listener exists. Patch Helmet's CSP options before loading server.js
// so local static assets remain available over the same HTTP origin.
const helmetPath = require.resolve('helmet');
const realHelmet = require(helmetPath);

function httpCompatibleHelmet(options = {}) {
  if (options.contentSecurityPolicy !== false) {
    const csp = options.contentSecurityPolicy && typeof options.contentSecurityPolicy === 'object'
      ? options.contentSecurityPolicy
      : {};
    options = {
      ...options,
      contentSecurityPolicy: {
        ...csp,
        directives: {
          ...(csp.directives || {}),
          upgradeInsecureRequests: null
        }
      }
    };
  }
  return realHelmet(options);
}

Object.assign(httpCompatibleHelmet, realHelmet);
require.cache[helmetPath].exports = httpCompatibleHelmet;

require('./server');
