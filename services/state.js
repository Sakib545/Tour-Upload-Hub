'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { cfg } = require('./config');

/**
 * Small runtime settings store (uploads enabled / gallery visible).
 * Persisted to ./data/state.json as a convenience. NOTE: Railway's filesystem
 * is ephemeral and resets on redeploy — the durable defaults are the
 * ENABLE_UPLOADS / GALLERY_VISIBLE env vars. This file simply lets the admin
 * flip them temporarily without redeploying.
 */

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// In tests the file must never influence state (hermetic runs).
let persisted = process.env.NODE_ENV !== 'test';
let state = {
  uploadsEnabled: cfg.defaultUploadsEnabled,
  galleryVisible: cfg.defaultGalleryVisible,
  // Lets everyone view and download the gallery while uploading still
  // requires the PIN.
  galleryPublic: cfg.defaultGalleryPublic,
  // 'cartoon' — figures drawn in each person's colours
  // 'photo'   — their enrolled portrait on the cartoon body
  // 'off'     — the scene's own anonymous figures
  heroCrew: 'cartoon',
};

// Result of the startup Google Drive folder check: { ok, code, name, msg }.
let driveHealth = { ok: false, code: 'UNCHECKED', name: '' };

function ensureFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    persisted = false;
    logger.warn('state: cannot create data dir, settings will be memory-only', { err: e.message });
  }
}

function load() {
  ensureFile();
  if (!persisted) return;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const key of ['uploadsEnabled', 'galleryVisible', 'galleryPublic']) {
        if (typeof raw[key] === 'boolean') state[key] = raw[key];
      }
      if (['cartoon', 'photo', 'off'].includes(raw.heroCrew)) state.heroCrew = raw.heroCrew;
    }
  } catch (e) {
    logger.warn('state: could not read state file, using defaults', { err: e.message });
  }
}

function save() {
  if (!persisted) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('state: could not persist settings', { err: e.message });
  }
}

function update(patch) {
  for (const key of ['uploadsEnabled', 'galleryVisible', 'galleryPublic']) {
    if (typeof patch[key] === 'boolean') state[key] = patch[key];
  }
  if (['cartoon', 'photo', 'off'].includes(patch.heroCrew)) state.heroCrew = patch.heroCrew;
  save();
  return { ...state };
}

function setDriveHealth(h) {
  driveHealth = h || { ok: false, code: 'UNCHECKED', name: '' };
  return driveHealth;
}

load();

module.exports = {
  get settings() {
    return { ...state };
  },
  update,
  get driveHealth() {
    return { ...driveHealth };
  },
  setDriveHealth,
};
