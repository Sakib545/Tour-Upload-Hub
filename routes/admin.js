'use strict';

const express = require('express');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { cfg } = require('../services/config');
const state = require('../services/state');
const drive = require('../services/drive');
const sanitize = require('../utils/sanitize');
const { safeEqual } = require('../utils/tokens');
const { requireAdmin, adminToken } = require('../middleware/auth');
const { noStore } = require('../middleware/security');
const rl = require('../middleware/rateLimiters');

const router = express.Router();
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Admin + authentication responses must never be cached.
router.use(noStore);

function fail(res, status, code) {
  if (res.headersSent || res.writableEnded) return;
  res.status(status).json({ error: code });
}

let folderNameCache = { name: '', at: 0 };

async function folderName() {
  if (folderNameCache.name && Date.now() - folderNameCache.at < 5 * 60 * 1000) {
    return folderNameCache.name;
  }
  const meta = await drive.getFolderMeta();
  folderNameCache = { name: meta.name || '', at: Date.now() };
  return folderNameCache.name;
}

/* ── Login ────────────────────────────────────────────────────── */

router.post('/admin/login', rl.adminLogin, (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (typeof pw !== 'string' || !safeEqual(pw, cfg.adminPassword)) {
    logger.warn('admin: failed login attempt');
    return fail(res, 401, 'ADMIN_UNAUTHORIZED');
  }
  res.json({ token: adminToken() });
});

/* ── Overview (stats + recent uploads + settings) ────────────── */

router.get('/admin/overview', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const { files } = await drive.listFolderFiles({
    cap: 30000,
    kinds: 'all',
    fields:
      'files(id,name,mimeType,size,createdTime,description,webViewLink),nextPageToken',
  });

  let totalSize = 0;
  for (const f of files) totalSize += Number(f.size) || 0;

  const recent = files.slice(0, 50).map((f) => {
    const meta = sanitize.parseDescription(f.description);
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType || '',
      size: Number(f.size) || 0,
      createdTime: f.createdTime || null,
      uploader: meta.uploader,
      driveUrl: f.webViewLink || null,
    };
  });

  let folder = '';
  try { folder = await folderName(); } catch (e) { logger.warn('admin: folder name lookup failed', { code: e.code }); }

  res.json({
    stats: { totalFiles: files.length, totalSize, folderName: folder },
    recent,
    settings: state.settings,
    drive: state.driveHealth,
  });
}));

/* ── Live settings toggles ────────────────────────────────────── */

router.put('/admin/settings', rl.adminApi, requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.uploadsEnabled === 'boolean') patch.uploadsEnabled = body.uploadsEnabled;
  if (typeof body.galleryVisible === 'boolean') patch.galleryVisible = body.galleryVisible;
  const next = state.update(patch);
  logger.info('admin: settings updated', { uploadsEnabled: next.uploadsEnabled, galleryVisible: next.galleryVisible });
  res.json({ settings: next });
});

/* ── QR code for sharing ──────────────────────────────────────── */

router.get('/admin/qr', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const publicUrl =
    cfg.publicSiteUrl || `${req.protocol}://${req.get('host')}`;
  const dataUrl = await QRCode.toDataURL(publicUrl, {
    width: 640,
    margin: 2,
    color: { dark: '#0b253b', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
  res.json({ publicUrl, dataUrl, scanText: 'Scan করে Tour-এর ছবি Upload করুন' });
}));

module.exports = router;
