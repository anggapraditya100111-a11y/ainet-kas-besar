'use strict';

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

const expressPath = require.resolve('express');
const realExpress = require(expressPath);
const registerAddonRoutes = require('./addon-routes');
const registerMaintenanceRoutes = require('./maintenance-routes');
const registerReportRoutes = require('./report-routes');

function enhancedExpress(...args) {
  const app = realExpress(...args);
  registerMaintenanceRoutes(app, realExpress);
  registerAddonRoutes(app, realExpress);
  registerReportRoutes(app, realExpress);
  return app;
}

Object.assign(enhancedExpress, realExpress);
require.cache[expressPath].exports = enhancedExpress;

require('./server');
