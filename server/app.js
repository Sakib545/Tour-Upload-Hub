'use strict';

const path = require('path');
const express = require('express');
const logger = require('../utils/logger');
const { securityHeaders } = require('../middleware/security');
const uploads = require('../services/uploads');
const reservations = require('../services/reservations');
const apiRouter = require('../routes/api');
const adminRouter = require('../routes/admin');

/**
 * Builds the Express app without listening, so automated tests can boot it on
 * an ephemeral port. `server/server.js` is the production entry point and is
 * responsible for config validation, listening and startup checks.
 */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS and forwards requests; trust one proxy hop so
  // rate-limiters see real client IPs.
  app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));

  // Face sorting listens for finished uploads; installing the handler here
  // keeps services/faces free of any route knowledge.
  require('../services/face-sorter').install();

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      etag: true,
      maxAge: process.env.NODE_ENV === 'production' ? '10m' : 0,
      setHeaders(res, filePath) {
        // HTML shells must never be served stale after a redeploy — only the
        // fingerprint-free assets (css/js) get the short cache window.
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // Short pretty URLs
  const sendPage = (file) => (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, file));
  };
  app.get(['/admin', '/admin/'], sendPage('admin.html'));
  app.get(['/gallery', '/gallery/'], sendPage('gallery.html'));
  app.get(['/game', '/game/'], sendPage('game.html'));

  app.use('/api', apiRouter);
  app.use('/api', adminRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  /* ── Errors (never leak stack traces / credentials / session URLs) ── */
  const DRIVE_ERROR_MAP = {
    FOLDER_NOT_FOUND: [500, 'DRIVE_FOLDER_NOT_FOUND'],
    NOT_A_FOLDER: [500, 'DRIVE_FOLDER_NOT_FOUND'],
    DRIVE_PERMISSION: [500, 'DRIVE_PERMISSION'],
    DRIVE_QUOTA: [500, 'DRIVE_QUOTA'],
    DRIVE_AUTH: [500, 'DRIVE_AUTH'],
    DRIVE_RATE_LIMIT: [503, 'DRIVE_BUSY'],
    DRIVE_ERROR: [500, 'DRIVE_ERROR'],
    FILE_NOT_FOUND: [404, 'NOT_FOUND'],
    NETWORK: [502, 'DRIVE_NETWORK'],
  };
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'BAD_JSON' });
    }
    if (err && DRIVE_ERROR_MAP[err.code]) {
      const [status, code] = DRIVE_ERROR_MAP[err.code];
      logger.warn('drive error', { code: err.code, url: req.originalUrl });
      if (!res.headersSent) return res.status(status).json({ error: code });
    }
    logger.error('unhandled error', { message: err && err.message, url: req.originalUrl });
    if (res.headersSent) return;
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  uploads.startCleanup();
  reservations.startSweeper();

  return app;
}

module.exports = { createApp };
