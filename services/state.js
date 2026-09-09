'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { cfg } = require('./config');
const drive = require('./drive');

/**
 * Runtime settings store.
 *
 * Holds three things the admin can change without a redeploy:
 *   flags   — uploads on/off, gallery visible, gallery readable without PIN
 *   site    — the page content (title, subtitle, date, place, notes, cover)
 *   folders — the Drive sub-folder names for single photos / group photos / videos
 *
 * Persistence is two-layered. `data/state.json` is a local cache (Railway's
 * disk is ephemeral, so it disappears on redeploy) and the real durable copy
 * is a small JSON file inside the tour's own Google Drive folder. That way an
 * edited title survives redeploys without any database.
 */

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// In tests neither layer may influence state (hermetic runs).
const isTest = process.env.NODE_ENV === 'test';
let persisted = !isTest;

function defaults() {
  return {
    flags: {
      uploadsEnabled: cfg.defaultUploadsEnabled,
      galleryVisible: cfg.defaultGalleryVisible,
      galleryPublic: cfg.defaultGalleryPublic,
    },
    site: {
      title: cfg.tour.title,
      subtitle: cfg.tour.subtitle,
      date: cfg.tour.date,
      location: cfg.tour.location,
      privacyNote: cfg.tour.privacyNote,
      coverUrl: cfg.tour.coverUrl,
    },
    folders: {
      photos: cfg.google.photosFolderName,
      group: cfg.google.groupFolderName,
      videos: cfg.google.videosFolderName,
    },
    // Every sub-folder id we have ever used, so renaming a folder never hides
    // the files already inside the old one.
    seenFolderIds: [],
  };
}

let state = defaults();
let driveLoaded = false;

// Result of the startup Google Drive folder check: { ok, code, name, msg }.
let driveHealth = { ok: false, code: 'UNCHECKED', name: '' };

/* ── Field cleaning ──────────────────────────────────────────── */

const LIMITS = {
  title: 80,
  subtitle: 200,
  date: 60,
  location: 60,
  privacyNote: 300,
  coverUrl: 500,
};

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/** Only http(s) images may be pointed at from the hero. */
function cleanUrl(value) {
  const v = cleanText(value, LIMITS.coverUrl);
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : '';
}

/** Drive folder names: no slashes, quotes or path tricks. */
function cleanFolderName(value, fallback) {
  const v = cleanText(value, 60).replace(/[\\/'"]/g, '').trim();
  return v || fallback;
}

/* ── Local cache ─────────────────────────────────────────────── */

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    persisted = false;
    logger.warn('state: cannot create data dir, settings will be memory-only', { err: e.message });
  }
}

function merge(raw) {
  if (!raw || typeof raw !== 'object') return;
  const flags = raw.flags || raw; // tolerate the old flat shape
  for (const key of ['uploadsEnabled', 'galleryVisible', 'galleryPublic']) {
    if (typeof flags[key] === 'boolean') state.flags[key] = flags[key];
  }
  if (raw.site && typeof raw.site === 'object') {
    for (const [key, max] of Object.entries(LIMITS)) {
      if (typeof raw.site[key] === 'string') {
        state.site[key] = key === 'coverUrl' ? cleanUrl(raw.site[key]) : cleanText(raw.site[key], max);
      }
    }
  }
  if (raw.folders && typeof raw.folders === 'object') {
    for (const key of ['photos', 'group', 'videos']) {
      if (typeof raw.folders[key] === 'string') {
        state.folders[key] = cleanFolderName(raw.folders[key], state.folders[key]);
      }
    }
  }
  if (Array.isArray(raw.seenFolderIds)) {
    state.seenFolderIds = Array.from(new Set(raw.seenFolderIds.filter((x) => typeof x === 'string')));
  }
}

function loadLocal() {
  ensureDir();
  if (!persisted) return;
  try {
    if (fs.existsSync(STATE_FILE)) merge(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    logger.warn('state: could not read local state file, using defaults', { err: e.message });
  }
}

function saveLocal() {
  if (!persisted) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('state: could not cache settings locally', { err: e.message });
  }
}

/* ── Durable copy in Drive ───────────────────────────────────── */

/** Pull admin-saved settings out of Drive. Best effort, never throws. */
async function loadFromDrive() {
  if (isTest) return false;
  try {
    const raw = await drive.readSettingsFile();
    if (raw) {
      merge(raw);
      saveLocal();
      logger.info('state: settings restored from Drive');
    }
    driveLoaded = true;
    return true;
  } catch (e) {
    logger.warn('state: could not read settings from Drive', { code: e && e.code });
    return false;
  }
}

/** Push the current settings to Drive. Resolves to true when stored. */
async function saveToDrive() {
  if (isTest) return false;
  try {
    await drive.writeSettingsFile(state);
    driveLoaded = true;
    return true;
  } catch (e) {
    logger.warn('state: could not save settings to Drive', { code: e && e.code });
    return false;
  }
}

/* ── Public API ──────────────────────────────────────────────── */

/**
 * Apply a patch. Returns the new state; `update` is synchronous, and the
 * caller decides whether to await the durable Drive write.
 */
function update(patch = {}) {
  const flags = patch.flags || patch;
  for (const key of ['uploadsEnabled', 'galleryVisible', 'galleryPublic']) {
    if (typeof flags[key] === 'boolean') state.flags[key] = flags[key];
  }
  if (patch.site && typeof patch.site === 'object') {
    for (const [key, max] of Object.entries(LIMITS)) {
      if (typeof patch.site[key] === 'string') {
        state.site[key] = key === 'coverUrl' ? cleanUrl(patch.site[key]) : cleanText(patch.site[key], max);
      }
    }
  }
  let foldersChanged = false;
  if (patch.folders && typeof patch.folders === 'object') {
    for (const key of ['photos', 'group', 'videos']) {
      if (typeof patch.folders[key] === 'string') {
        const next = cleanFolderName(patch.folders[key], state.folders[key]);
        if (next !== state.folders[key]) {
          state.folders[key] = next;
          foldersChanged = true;
        }
      }
    }
  }
  if (foldersChanged) {
    // Ids for the old names stay in seenFolderIds, so their files remain
    // listed; the new names are resolved (and created) on the next upload.
    drive.resetFolderCache();
  }
  saveLocal();
  return snapshot();
}

function rememberFolderIds(ids) {
  let added = false;
  for (const id of ids || []) {
    if (id && !state.seenFolderIds.includes(id)) {
      state.seenFolderIds.push(id);
      added = true;
    }
  }
  if (added) {
    if (state.seenFolderIds.length > 40) state.seenFolderIds = state.seenFolderIds.slice(-40);
    saveLocal();
  }
}

function snapshot() {
  return {
    flags: { ...state.flags },
    site: { ...state.site },
    folders: { ...state.folders },
  };
}

function setDriveHealth(h) {
  driveHealth = h || { ok: false, code: 'UNCHECKED', name: '' };
  return driveHealth;
}

loadLocal();

// Folder names are admin-editable, so the Drive client reads them from here.
drive.configureFolders({
  names: () => state.folders,
  seen: () => state.seenFolderIds,
  remember: rememberFolderIds,
});

module.exports = {
  /** Feature flags — kept as `settings` for the existing call sites. */
  get settings() {
    return { ...state.flags };
  },
  get site() {
    return { ...state.site };
  },
  get folders() {
    return { ...state.folders };
  },
  get driveSynced() {
    return driveLoaded;
  },
  snapshot,
  update,
  loadFromDrive,
  saveToDrive,
  rememberFolderIds,
  get driveHealth() {
    return { ...driveHealth };
  },
  setDriveHealth,
};
