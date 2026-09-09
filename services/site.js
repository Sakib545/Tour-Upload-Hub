'use strict';

/**
 * Persistent site content + upload-category store.
 *
 * The organizer edits the tour page texts (title / subtitle / date / location /
 * privacy note / cover URL) and the upload categories (public labels + Google
 * Drive folder names) from the /admin dashboard. Everything is persisted to
 * ./data/site.json on top of the TOUR_* env defaults, so a fresh deployment
 * starts from the env values and the admin can change them live — no redeploy.
 *
 * Category ids are stable keys. The default layout matches the tour flow:
 *   single — one-persons / ordinary photos  → "Photos"       (env PHOTOS_FOLDER_NAME)
 *   group  — group photos                   → "Group Photos"
 *   video  — videos                         → "Videos"       (env VIDEOS_FOLDER_NAME)
 * Each category routes uploads into its own Drive sub-folder and gives the
 * public gallery its filter chips. Only the label and folder name are editable;
 * ids and media type are fixed so existing files keep their meaning.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { cfg } = require('./config');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SITE_FILE = path.join(DATA_DIR, 'site.json');

// In tests the file must never influence state (hermetic runs).
let persisted = process.env.NODE_ENV !== 'test';

/** Trim, collapse whitespace and cap length (single-line text helper). */
function clean(value, max) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Drive folder names: no control chars or path-breaking symbols.
const FOLDER_RE = /^[^/\\<>:"|?*\u0000-\u001f]{1,80}$/;

const CATEGORY_IDS = ['single', 'group', 'video'];

function defaultCategories() {
  return [
    {
      id: 'single',
      label: 'একক ছবি',
      folder: cfg.google.photosFolderName || 'Photos',
      media: 'photo',
    },
    {
      id: 'group',
      label: 'গ্রুপ ছবি',
      folder: 'Group Photos',
      media: 'photo',
    },
    {
      id: 'video',
      label: 'ভিডিও',
      folder: cfg.google.videosFolderName || 'Videos',
      media: 'video',
    },
  ];
}

let state = {
  content: {
    title: cfg.tour.title,
    subtitle: cfg.tour.subtitle,
    date: cfg.tour.date,
    location: cfg.tour.location,
    privacyNote: cfg.tour.privacyNote,
    coverUrl: cfg.tour.coverUrl,
  },
  categories: defaultCategories(),
};

function ensureFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    persisted = false;
    logger.warn('site: cannot create data dir, site content will be memory-only', {
      err: e.message,
    });
  }
}

function sanitizeContent(src) {
  const out = {};
  if (typeof src !== 'object' || src === null) return null;

  const title = clean(src.title, 120);
  if (title) out.title = title;
  const subtitle = clean(src.subtitle, 300);
  if (subtitle) out.subtitle = subtitle;

  if ('date' in src) out.date = clean(src.date, 60);
  if ('location' in src) out.location = clean(src.location, 120);

  const privacyNote = clean(src.privacyNote, 300);
  if (privacyNote) out.privacyNote = privacyNote;

  if ('coverUrl' in src) {
    const coverUrl = clean(src.coverUrl, 500);
    // Only http(s) images (or empty) are accepted as a page cover.
    if (!coverUrl || /^https?:\/\//i.test(coverUrl)) out.coverUrl = coverUrl;
  }
  return out;
}

function sanitizeCategory(raw, base) {
  const id = String((raw && raw.id) || '').trim();
  if (!CATEGORY_IDS.includes(id)) return null;
  const label = clean((raw && raw.label) || '', 80) || base.label;
  const folderRaw = clean((raw && raw.folder) || '', 80);
  const folder = folderRaw && FOLDER_RE.test(folderRaw) ? folderRaw : base.folder;
  return { id, label, folder, media: base.media };
}

function merge(raw) {
  if (typeof raw !== 'object' || raw === null) return;

  if (raw.content) {
    const next = sanitizeContent(raw.content);
    if (next) state.content = { ...state.content, ...next };
  }

  if (Array.isArray(raw.categories) && raw.categories.length) {
    const defaults = defaultCategories();
    const next = defaults
      .map((d) => {
        const found = raw.categories.find((c) => c && String(c.id) === d.id);
        return found ? sanitizeCategory(found, d) : d;
      })
      .filter(Boolean);
    if (next.length) state.categories = next;
  }
}

function load() {
  ensureFile();
  if (!persisted) return;
  try {
    if (fs.existsSync(SITE_FILE)) {
      merge(JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')));
    }
  } catch (e) {
    logger.warn('site: could not read site file, using defaults', { err: e.message });
  }
}

function save() {
  if (!persisted) return;
  try {
    fs.writeFileSync(SITE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.warn('site: could not persist site content', { err: e.message });
  }
}

function snapshot() {
  return {
    content: { ...state.content },
    categories: state.categories.map((c) => ({ ...c })),
  };
}

/** Update content / categories with sanitization. Never throws. */
function update({ content, categories } = {}) {
  if (content && typeof content === 'object') {
    const next = sanitizeContent(content);
    if (next) state.content = { ...state.content, ...next };
  }
  if (Array.isArray(categories)) {
    const defaults = defaultCategories();
    const next = defaults
      .map((d) => {
        const found = categories.find((c) => c && String(c.id) === d.id);
        return found ? sanitizeCategory(found, d) : d;
      })
      .filter(Boolean);
    if (next.length) state.categories = next;
  }
  save();
  return snapshot();
}

function categoryById(id) {
  return state.categories.find((c) => c.id === id) || null;
}

load();

module.exports = {
  update,
  categoryById,
  // Full view (labels + Drive folder names) — admin only.
  adminView: snapshot,
  get content() {
    return { ...state.content };
  },
  get categories() {
    return state.categories.map((c) => ({ ...c }));
  },
};
