'use strict';

/**
 * Central environment configuration.
 * All secrets stay server-side — nothing here is ever sent to the browser.
 */

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}
function str(v, dflt) {
  const s = String(v ?? '').trim();
  return s || dflt;
}

const env = process.env;

const cfg = {
  nodeEnv: env.NODE_ENV || 'development',
  port: num(env.PORT, 3000, 1, 65535),
  publicSiteUrl: str(env.PUBLIC_SITE_URL, '').replace(/\/+$/, ''),

  google: {
    folderId: str(env.GOOGLE_DRIVE_FOLDER_ID, ''),
    serviceAccountJson: str(env.GOOGLE_SERVICE_ACCOUNT_JSON, ''),
    clientId: str(env.GOOGLE_CLIENT_ID, ''),
    clientSecret: str(env.GOOGLE_CLIENT_SECRET, ''),
    refreshToken: str(env.GOOGLE_REFRESH_TOKEN, ''),
    scope: str(env.GOOGLE_DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive'),
  },

  adminPassword: env.ADMIN_PASSWORD || '',
  tourPin: env.TOUR_UPLOAD_PIN || '',
  pinEnabled: Boolean(env.TOUR_UPLOAD_PIN && String(env.TOUR_UPLOAD_PIN).trim()),

  enableGallery: bool(env.ENABLE_GALLERY, true),
  defaultUploadsEnabled: bool(env.ENABLE_UPLOADS, true),
  defaultGalleryVisible: bool(env.GALLERY_VISIBLE, true),

  maxFileBytes: num(env.MAX_FILE_SIZE_MB, 2048, 1, 10240) * 1024 * 1024,
  maxFileSizeMB: num(env.MAX_FILE_SIZE_MB, 2048, 1, 10240),
  maxFilesPerUpload: num(env.MAX_FILES_PER_UPLOAD, 50, 1, 500),
  chunkBytes: num(env.UPLOAD_CHUNK_MB, 8, 1, 64) * 1024 * 1024,
  galleryLimit: num(env.GALLERY_LIMIT, 300, 1, 5000),

  // ── Abuse protection (uploads) ─────────────────────────────
  // Max in-flight upload sessions the whole server accepts at once.
  maxActiveUploads: num(env.MAX_ACTIVE_UPLOADS, 150, 1, 10000),
  // Max simultaneous in-flight sessions a single IP may hold.
  maxUploadsPerIp: num(env.MAX_UPLOADS_PER_IP, 40, 1, 1000),
  // Max new resumable-session creations per IP inside a 60 s window.
  maxSessionCreatesPerMinPerIp: num(env.MAX_SESSION_CREATES_PER_MIN_PER_IP, 60, 1, 10000),
  // How long an upload session may stay idle before it is aborted/evicted.
  uploadSessionIdleMinutes: num(env.UPLOAD_SESSION_IDLE_MINUTES, 120, 10, 1440),

  // Signed media URLs for PIN-protected gallery use a shorter lifetime than the
  // 12 h PIN proof, so a token pasted/shared elsewhere expires quickly.
  galleryTokenTtlHours: num(env.GALLERY_TOKEN_TTL_HOURS, 3, 1, 72),

  tour: {
    title: str(env.TOUR_TITLE, 'Tour Memories'),
    subtitle: str(env.TOUR_SUBTITLE, 'আমাদের Tour-এর সব ছবি ও ভিডিও এখানে Upload করুন'),
    date: str(env.TOUR_DATE, ''),
    location: str(env.TOUR_LOCATION, ''),
    privacyNote: str(env.TOUR_PRIVACY_NOTE, 'আপনার Upload করা ফাইল শুধু আমাদের Tour Drive-এ সংরক্ষিত হবে।'),
    coverUrl: str(env.TOUR_COVER_URL, ''),
  },
};

/** Throw with a human-readable boot error if required config is missing. */
function validate() {
  const missing = [];
  if (!cfg.google.folderId) missing.push('GOOGLE_DRIVE_FOLDER_ID');
  const hasServiceAccount = Boolean(cfg.google.serviceAccountJson);
  if (!hasServiceAccount) {
    if (!cfg.google.clientId) missing.push('GOOGLE_CLIENT_ID');
    if (!cfg.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
    if (!cfg.google.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');
  }
  if (!cfg.adminPassword) missing.push('ADMIN_PASSWORD');
  if (missing.length) {
    const err = new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in (see README).'
    );
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  if (hasServiceAccount) {
    let account;
    try { account = JSON.parse(cfg.google.serviceAccountJson); } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain the complete valid JSON key.');
    }
    if (!account.client_email || !account.private_key) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.');
    }
  }
  if (cfg.adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
  }
  if (cfg.pinEnabled && cfg.tourPin.length < 4) {
    throw new Error('TOUR_UPLOAD_PIN must be at least 4 characters long when configured.');
  }
  if (cfg.tourPin.length > 64) {
    throw new Error('TOUR_UPLOAD_PIN must be 64 characters or fewer.');
  }
}

/** Public (safe) configuration exposed to the frontend at /api/config. */
function publicConfig(state) {
  return {
    siteName: 'Tour Memories',
    tourTitle: cfg.tour.title,
    tourSubtitle: cfg.tour.subtitle,
    tourDate: cfg.tour.date,
    tourLocation: cfg.tour.location,
    coverUrl: cfg.tour.coverUrl,
    privacyNote: cfg.tour.privacyNote,
    galleryEnabled: cfg.enableGallery && state.galleryVisible,
    uploadsEnabled: state.uploadsEnabled,
    pinRequired: cfg.pinEnabled,
    maxFileSizeMB: cfg.maxFileSizeMB,
    maxFilesPerUpload: cfg.maxFilesPerUpload,
    chunkMB: cfg.chunkBytes / (1024 * 1024),
    maxFileBytes: cfg.maxFileBytes,
    maxFilesPerUploadBytesLabel: `${cfg.maxFileSizeMB} MB`,
  };
}

module.exports = { cfg, validate, publicConfig };
