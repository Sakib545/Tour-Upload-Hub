'use strict';

const express = require('express');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { cfg } = require('../services/config');
const state = require('../services/state');
const site = require('../services/site');
const drive = require('../services/drive');
const persist = require('../services/persist');
const faces = require('../services/faces');
const faceSorter = require('../services/face-sorter');
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

/** Display label of the category a stored file belongs to (by tag or MIME). */
function categoryLabelFor(taggedCategory, mimeType) {
  const m = String(mimeType || '').toLowerCase();
  const tagged = taggedCategory
    ? site.categoryById(String(taggedCategory).slice(0, 24))
    : null;
  if (
    tagged &&
    ((m.startsWith('image/') && tagged.media === 'photo') ||
      (m.startsWith('video/') && tagged.media === 'video'))
  ) {
    return tagged.label;
  }
  if (m.startsWith('video/')) {
    const v = site.categories.find((c) => c.media === 'video');
    return v ? v.label : '';
  }
  if (m.startsWith('image/')) {
    const p = site.categories.find((c) => c.media === 'photo');
    return p ? p.label : '';
  }
  return '';
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
  let photoCount = 0;
  let videoCount = 0;
  for (const f of files) {
    totalSize += Number(f.size) || 0;
    const mime = String(f.mimeType || '');
    if (mime.startsWith('image/')) photoCount += 1;
    else if (mime.startsWith('video/')) videoCount += 1;
  }

  const recent = files.slice(0, 50).map((f) => {
    const meta = sanitize.parseDescription(f.description);
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType || '',
      size: Number(f.size) || 0,
      createdTime: f.createdTime || null,
      uploader: meta.uploader,
      categoryLabel: categoryLabelFor(meta.category, f.mimeType),
      driveUrl: f.webViewLink || null,
    };
  });

  let folder = '';
  try { folder = await folderName(); } catch (e) { logger.warn('admin: folder name lookup failed', { code: e.code }); }

  // Direct links so the admin can open (and bulk-download) each category folder.
  let folderLinks = null;
  try {
    const ensured = await drive.ensureAllCategoryFolders();
    if (ensured && ensured.length) {
      folderLinks = ensured.map(({ id, category }) => ({
        label: category.label || category.folder,
        folder: category.folder,
        url: `https://drive.google.com/drive/folders/${id}`,
      }));
    }
  } catch (e) { /* sub-folders are optional */ }

  res.json({
    stats: {
      totalFiles: files.length,
      totalSize,
      folderName: folder,
      photoCount,
      videoCount,
    },
    folderLinks,
    rootFolderUrl: `https://drive.google.com/drive/folders/${cfg.google.folderId}`,
    recent,
    settings: state.settings,
    site: site.adminView(),
    drive: state.driveHealth,
  });
}));

/* ── Live settings toggles ────────────────────────────────────── */

router.put('/admin/settings', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const key of ['uploadsEnabled', 'galleryVisible', 'galleryPublic']) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }
  // How the beach crew is drawn: cartoon figures, real portraits, or neither.
  if (['cartoon', 'photo', 'off'].includes(body.heroCrew)) patch.heroCrew = body.heroCrew;
  const next = state.update(patch);
  logger.info('admin: settings updated', {
    uploadsEnabled: next.uploadsEnabled,
    galleryVisible: next.galleryVisible,
    galleryPublic: next.galleryPublic,
  });
  // The durable copy lives in Drive; report honestly if it did not get there.
  const persisted = await persist.saveAll();
  res.json({ settings: next, persisted });
}));

/* ── Site content & upload categories (title, subtitle, folders…) ─ */

router.put('/admin/site', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const before = site.categories.map((c) => c.folder).join('\u0001');
  const next = site.update({
    content: body.content,
    categories: body.categories,
  });
  const after = next.categories.map((c) => c.folder).join('\u0001');
  // Folder renames must be re-resolved on Drive (new folders, new ids).
  if (before !== after) drive.resetFolderCache();
  logger.info('admin: site content updated', {
    title: next.content.title,
    categories: next.categories.map((c) => `${c.id}:${c.folder}`).join(', '),
  });
  const persisted = await persist.saveAll();
  res.json({ site: next, persisted });
}));

/* ── People & face sorting ───────────────────────────────────── */

router.get('/admin/faces', rl.adminApi, requireAdmin, (req, res) => {
  res.json({ people: site.people, status: faces.status(), heroCrew: state.settings.heroCrew });
});

router.post('/admin/people', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const person = site.addPerson((req.body || {}).name);
  if (!person) return res.status(400).json({ error: 'BAD_NAME' });
  await persist.saveAll();
  logger.info('admin: person added', { id: person.id, name: person.name });
  res.json({ person, people: site.people });
}));

router.patch('/admin/people/:id', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const body = req.body || {};
  const updated = site.updatePerson(req.params.id, { name: body.name, avatar: body.avatar });
  if (!updated) return res.status(404).json({ error: 'NOT_FOUND' });
  await persist.saveAll();
  res.json({ people: site.people });
}));

router.delete('/admin/people/:id', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  // Removing a person leaves their Drive folder and photos untouched.
  if (!site.removePerson(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  await persist.saveAll();
  res.json({ people: site.people });
}));

/**
 * Enrolment: one photo of one person, sent as raw image bytes. We keep only
 * the 128-number descriptor — the photo itself is never stored.
 */
router.post(
  '/admin/people/:id/enroll',
  rl.adminApi,
  requireAdmin,
  express.raw({ type: 'image/*', limit: '12mb' }),
  asyncH(async (req, res) => {
    const person = site.personById(req.params.id);
    if (!person) return res.status(404).json({ error: 'NOT_FOUND' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'NO_IMAGE' });
    }
    if (!(await faces.init())) {
      return res.status(503).json({ error: 'FACES_UNAVAILABLE', detail: faces.status().lastError });
    }
    const result = await faceSorter.describeReference(req.body);
    if (!result.ok) return res.status(400).json({ error: result.code });
    site.addDescriptor(person.id, result.descriptor);
    // The portrait is a by-product: a small square crop for the beach figure,
    // and the skin tone read off it, so the cartoon body matches the face.
    if (result.face) site.setPortrait(person.id, result.face);
    if (result.skin) site.updatePerson(person.id, { avatar: { skin: result.skin } });
    await persist.saveAll();
    logger.info('admin: face enrolled', { id: person.id, name: person.name });
    res.json({ people: site.people });
  })
);

router.post('/admin/faces/rescan', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  if (!cfg.faces.enabled) return res.status(400).json({ error: 'FACES_DISABLED' });
  const out = await faceSorter.rescanAll();
  res.json({ ...out, status: faces.status() });
}));

/* ── Drive diagnostics ────────────────────────────────────────── */

router.post('/admin/drive-test', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const access = await drive.verifyAccess();
  state.setDriveHealth(access);
  if (!access.ok) return res.json({ stage: 'read', ...access });
  const write = await drive.testWrite();
  return res.json({ stage: write.ok ? 'ok' : 'write', ...write, folderName: access.name });
}));

/* ── Tidy up files uploaded before the category folders existed ── */

router.post('/admin/organise', rl.adminApi, requireAdmin, asyncH(async (req, res) => {
  const folders = await drive.ensureAllCategoryFolders();
  if (!folders || !folders.length) {
    return res.status(400).json({ error: 'FOLDERS_DISABLED' });
  }
  // Group photos cannot be told apart automatically, so every loose image goes
  // to the first photo category; the admin can re-sort those in Drive.
  const photoTarget = folders.find((f) => f.category.media === 'photo');
  const videoTarget = folders.find((f) => f.category.media === 'video');

  const loose = await drive.listFilesInFolder(cfg.google.folderId);
  const result = { photos: 0, videos: 0, skipped: 0, failed: 0, total: loose.length };

  for (const file of loose) {
    const mime = String(file.mimeType || '');
    const target = mime.startsWith('video/') ? videoTarget
      : mime.startsWith('image/') ? photoTarget
        : null;
    if (!target) {
      result.skipped += 1;
      continue;
    }
    try {
      await drive.moveFile(file.id, { from: cfg.google.folderId, to: target.id });
      if (target === videoTarget) result.videos += 1;
      else result.photos += 1;
    } catch (e) {
      result.failed += 1;
      logger.warn('admin: could not move file into its folder', { id: file.id, code: e.code });
    }
  }
  logger.info('admin: organised existing files', result);
  res.json(result);
}));

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
