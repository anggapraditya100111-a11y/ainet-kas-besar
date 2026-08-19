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

// Register additive finance routes before server.js mounts its API fallback.
// This keeps the stable v1.0 core intact while allowing safe, backwards-
// compatible enhancements for account masters, profile and cash mutation.
const expressPath = require.resolve('express');
const realExpress = require(expressPath);
const registerAddonRoutes = require('./addon-routes');

function enhancedExpress(...args) {
  const app = realExpress(...args);
  registerAddonRoutes(app, realExpress);
  return app;
}

Object.assign(enhancedExpress, realExpress);
require.cache[expressPath].exports = enhancedExpress;

require('./server');
