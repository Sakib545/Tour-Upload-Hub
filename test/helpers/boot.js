'use strict';

/**
 * Boot helper for tests. Each test FILE runs in its own process (node --test),
 * so `start()` may safely set process.env once before the app modules load.
 * Returns a running app + the mock Drive server.
 */

const { startDriveMock } = require('./drive-mock');

const DEFAULTS = {
  PORT: '0',
  NODE_ENV: 'test',
  GOOGLE_DRIVE_FOLDER_ID: 'FOLDER_ID_123',
  GOOGLE_CLIENT_ID: 'mock-client-id',
  GOOGLE_CLIENT_SECRET: 'mock-client-secret',
  GOOGLE_REFRESH_TOKEN: 'mock-refresh-token',
  ADMIN_PASSWORD: 'admin-pass-123',
  TOUR_UPLOAD_PIN: '',
  ENABLE_GALLERY: 'true',
  ENABLE_UPLOADS: 'true',
  GALLERY_VISIBLE: 'true',
  MAX_FILE_SIZE_MB: '1024',
  MAX_FILES_PER_UPLOAD: '50',
  UPLOAD_CHUNK_MB: '1',
  GALLERY_LIMIT: '300',
  MAX_ACTIVE_UPLOADS: '50',
  MAX_UPLOADS_PER_IP: '50',
  MAX_SESSION_CREATES_PER_MIN_PER_IP: '100',
  UPLOAD_SESSION_IDLE_MINUTES: '120',
  GALLERY_TOKEN_TTL_HOURS: '3',
};

async function start({ env = {} } = {}) {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = String(v);
  }

  // Modules must load AFTER the environment is final.
  const drive = require('../../services/drive');
  const { createApp } = require('../../server/app');

  const mock = await startDriveMock();
  drive.setEndpoints({ api: mock.base, upload: mock.base, token: `${mock.base}/token` });

  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  return {
    base: `http://127.0.0.1:${port}`,
    server,
    mock,
    uploads: require('../../services/uploads'),
    close: async () => {
      try { server.closeAllConnections && server.closeAllConnections(); } catch (e) { /* ignore */ }
      await new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1500).unref();
      });
      await mock.close();
    },
  };
}

/** Small helpers to build realistic file prefixes. */

const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_PREFIX = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypheic', 'latin1'),
]);
const MP4_PREFIX = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
]);
const EXE_PREFIX = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00');
const HTML_PREFIX = Buffer.from('<!DOCTYPE html><html><head></head><body>hi</body></html>');

function padTo(len, prefix) {
  const buf = Buffer.alloc(len);
  prefix.copy(buf);
  for (let i = prefix.length; i < len; i++) buf[i] = i % 256;
  return buf;
}

module.exports = { start, DEFAULTS, JPEG_PREFIX, PNG_PREFIX, HEIC_PREFIX, MP4_PREFIX, EXE_PREFIX, HTML_PREFIX, padTo };
