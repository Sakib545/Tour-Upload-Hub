'use strict';

const { cfg } = require('../services/config');
const state = require('../services/state');
const { signToken, verifyToken, hoursFromNow } = require('../utils/tokens');

const PIN_TTL_HOURS = 12;
const ADMIN_TTL_HOURS = 12;

function pinToken() {
  return signToken({ purpose: 'pin', exp: hoursFromNow(PIN_TTL_HOURS) }, cfg.tourPin, 'pin');
}

function verifyPinToken(token) {
  if (!cfg.pinEnabled) return { ok: true };
  const payload = verifyToken(token, cfg.tourPin, 'pin');
  if (!payload || payload.purpose !== 'pin') return { ok: false };
  return { ok: true };
}

function adminToken() {
  return signToken({ purpose: 'admin', exp: hoursFromNow(ADMIN_TTL_HOURS) }, cfg.adminPassword, 'admin');
}

function verifyAdminToken(token) {
  const payload = verifyToken(token, cfg.adminPassword, 'admin');
  if (!payload || payload.purpose !== 'admin') return { ok: false };
  return { ok: true };
}

/**
 * Short-lived signed media token for the PIN-protected gallery. Minted by the
 * server when a gallery listing is served; embedded in <img>/<video> URLs as a
 * query parameter because media elements cannot send custom headers.
 */
function galleryToken() {
  return signToken(
    { purpose: 'gal', exp: hoursFromNow(cfg.galleryTokenTtlHours) },
    cfg.tourPin,
    'gal'
  );
}

/** Accept a fresh gallery token OR a still-valid participant PIN proof. */
function verifyGalleryProof(token) {
  if (!token || typeof token !== 'string') return { ok: false };
  const gal = verifyToken(token, cfg.tourPin, 'gal');
  if (gal && gal.purpose === 'gal') return { ok: true };
  const pin = verifyToken(token, cfg.tourPin, 'pin');
  if (pin && pin.purpose === 'pin') return { ok: true };
  return { ok: false };
}

/**
 * Gate for upload endpoints.
 *  - Rejects when uploads are disabled by the admin.
 *  - When a TOUR_UPLOAD_PIN is configured, requires a valid X-Upload-Token
 *    header (obtained from POST /api/verify-pin).
 */
function requireUploadAuth(req, res, next) {
  const s = state.settings;
  if (!s.uploadsEnabled) {
    return res.status(403).json({ error: 'UPLOADS_DISABLED' });
  }
  if (cfg.pinEnabled) {
    const token = req.get('x-upload-token') || '';
    const v = verifyPinToken(token);
    if (!v.ok) {
      return res.status(401).json({ error: 'PIN_REQUIRED' });
    }
  }
  next();
}

/**
 * Gate for gallery routes. Order matters:
 *  1. Admin "hide gallery" blocks everything immediately (even valid tokens).
 *  2. Without a configured PIN the gallery stays public.
 *  3. With a PIN, gallery list + every media URL require a signed token
 *     (X-Gallery-Token / X-Upload-Token header, or `?gt=` query param).
 */
function requireGalleryAuth(req, res, next) {
  const s = state.settings;
  if (!cfg.enableGallery || !s.galleryVisible) {
    return res.status(404).json({ error: 'GALLERY_DISABLED' });
  }
  if (!cfg.pinEnabled) return next();

  const bearer = (req.get('authorization') || '').startsWith('Bearer ')
    ? req.get('authorization').slice(7)
    : '';
  const token =
    req.get('x-gallery-token') ||
    req.get('x-upload-token') ||
    (req.query && req.query.gt) ||
    bearer ||
    '';
  const v = verifyGalleryProof(token);
  if (!v.ok) {
    return res.status(401).json({ error: 'GALLERY_PIN_REQUIRED' });
  }
  next();
}

/** Admin endpoints: Bearer token in Authorization header. */
function requireAdmin(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const v = verifyAdminToken(token);
  if (!v.ok) {
    return res.status(401).json({ error: 'ADMIN_UNAUTHORIZED' });
  }
  next();
}

module.exports = {
  requireUploadAuth,
  requireAdmin,
  requireGalleryAuth,
  pinToken,
  adminToken,
  galleryToken,
  verifyPinToken,
  verifyAdminToken,
  verifyGalleryProof,
};
