'use strict';

require('dotenv').config();

const logger = require('../utils/logger');
const { cfg, validate } = require('../services/config');
const state = require('../services/state');
const drive = require('../services/drive');
const { createApp } = require('./app');

/* ── Boot validation ──────────────────────────────────────────── */
try {
  validate();
} catch (e) {
  logger.error('boot aborted: ' + e.message);
  process.exit(1);
}

const app = createApp();

/* ── Listen ───────────────────────────────────────────────────── */
const server = app.listen(cfg.port, () => {
  logger.info(`tour-upload-hub listening on port ${cfg.port} (${cfg.nodeEnv})`);
  logger.info(`uploads enabled: ${state.settings.uploadsEnabled} | gallery: ${state.settings.galleryVisible}`);
});

// Long phone uploads must not be killed by Node's default 5-minute request timeout.
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 5 * 1000;

// Non-fatal boot check so the admin sees credential/folder problems immediately.
// Validates that GOOGLE_DRIVE_FOLDER_ID really points at a Drive folder.
drive.verifyAccess().then(async (r) => {
  state.setDriveHealth({
    ok: r.ok, code: r.code, name: r.name || '', msg: r.msg, reason: r.reason || '',
  });
  if (!r.ok) {
    logger.warn('startup Drive check failed — uploads will error until fixed', {
      code: r.code,
    });
    return;
  }
  // Admin-edited title/subtitle/folder names live in the Drive folder, so they
  // survive redeploys (Railway's own disk does not).
  await state.loadFromDrive();
});

function shutdown(signal) {
  logger.info(`received ${signal}, shutting down gracefully`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
