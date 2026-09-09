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

// The three built-in categories can be renamed but never deleted: they are the
// fallback routing for uploads that arrive without a category.
const CATEGORY_IDS = ['single', 'group', 'video'];
const MEDIA_KINDS = ['photo', 'video', 'any'];
const MAX_CATEGORIES = 12;
const CUSTOM_ID_RE = /^c_[a-z0-9]{6}$/;

function defaultCategories() {
  return [
    {
      id: 'single',
      label: 'একক ছবি',
      folder: cfg.google.photosFolderName || 'Photos',
      media: 'photo',
      builtin: true,
    },
    {
      id: 'group',
      label: 'গ্রুপ ছবি',
      folder: 'Group Photos',
      media: 'photo',
      builtin: true,
    },
    {
      id: 'video',
      label: 'ভিডিও',
      folder: cfg.google.videosFolderName || 'Videos',
      media: 'video',
      builtin: true,
    },
  ];
}

function newCategoryId(taken) {
  for (let i = 0; i < 50; i++) {
    const id = 'c_' + Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '0');
    if (CUSTOM_ID_RE.test(id) && !taken.has(id)) return id;
  }
  return null;
}

/**
 * A tour moment as an ISO instant, or '' when the organiser has not set one.
 * The admin's browser converts its local datetime-local value with
 * toISOString(), so the countdown is correct for every visitor's clock.
 */
function cleanInstant(value) {
  const raw = clean(value, 40);
  if (!raw) return '';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return '';
  const year = new Date(t).getUTCFullYear();
  if (year < 2000 || year > 2100) return '';
  return new Date(t).toISOString();
}

let state = {
  content: {
    title: cfg.tour.title,
    subtitle: cfg.tour.subtitle,
    date: cfg.tour.date,
    location: cfg.tour.location,
    privacyNote: cfg.tour.privacyNote,
    coverUrl: cfg.tour.coverUrl,
    // Drives the public countdown. Both optional.
    startAt: '',
    endAt: '',
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

  for (const key of ['startAt', 'endAt']) {
    if (key in src) out[key] = cleanInstant(src[key]);
  }

  if ('coverUrl' in src) {
    const coverUrl = clean(src.coverUrl, 500);
    // Only http(s) images (or empty) are accepted as a page cover.
    if (!coverUrl || /^https?:\/\//i.test(coverUrl)) out.coverUrl = coverUrl;
  }
  return out;
}

/**
 * Clean one incoming category against the version we already hold (`base`).
 * A built-in keeps its id and media kind; only its label and folder change.
 */
function sanitizeCategory(raw, base) {
  const label = clean((raw && raw.label) || '', 80) || base.label;
  const folderRaw = clean((raw && raw.folder) || '', 80);
  const folder = folderRaw && FOLDER_RE.test(folderRaw) ? folderRaw : base.folder;
  let media = base.media;
  if (!base.builtin) {
    const wanted = String((raw && raw.media) || '').trim();
    if (MEDIA_KINDS.includes(wanted)) media = wanted;
  }
  return { id: base.id, label, folder, media, builtin: !!base.builtin };
}

/**
 * Rebuild the category list from an admin payload.
 *
 * Built-ins always survive (they are the fallback routing). Custom categories
 * are kept when the payload still lists their id, created when it carries a new
 * entry, and dropped otherwise — files already in a dropped folder stay in
 * Drive and keep showing in the gallery via allowedParents().
 *
 * Two categories must never share a Drive folder, or a file's category becomes
 * ambiguous, so a colliding folder name falls back to the previous value (or
 * the whole new category is refused).
 */
function rebuildCategories(incoming, current) {
  const byId = new Map(current.map((c) => [c.id, c]));
  const usedFolders = new Set();
  const out = [];
  const takenIds = new Set(current.map((c) => c.id));

  const push = (cat) => {
    const key = cat.folder.toLowerCase();
    if (usedFolders.has(key)) return false;
    usedFolders.add(key);
    out.push(cat);
    return true;
  };

  /**
   * Place a category no matter what: the wanted folder, then the folder it had
   * before, then a disambiguated name. A category must never silently vanish —
   * a dropped built-in takes the upload routing and its gallery chip with it.
   */
  const placeCategory = (cat, previousFolder) => {
    if (push(cat)) return true;
    if (previousFolder && push({ ...cat, folder: previousFolder })) return true;
    const stem = previousFolder || cat.folder;
    for (let i = 2; i <= 20; i++) {
      const alt = `${stem} (${i})`;
      if (alt.length <= 80 && push({ ...cat, folder: alt })) return true;
    }
    return push({ ...cat, folder: `${stem.slice(0, 60)} (${cat.id})` });
  };

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    if (out.length >= MAX_CATEGORIES) break;
    const id = String(raw.id || '').trim();
    const base = byId.get(id);
    if (base) {
      const next = sanitizeCategory(raw, base);
      // Folder taken by another category — keep what this one had, and if that
      // is taken too fall back to a disambiguated name rather than dropping it.
      placeCategory(next, base.folder);
      byId.delete(id);
      continue;
    }
    // A brand-new custom category.
    const label = clean(raw.label || '', 80);
    const folder = clean(raw.folder || '', 80);
    if (!label || !folder || !FOLDER_RE.test(folder)) continue;
    const newId = newCategoryId(takenIds);
    if (!newId) continue;
    takenIds.add(newId);
    const media = MEDIA_KINDS.includes(String(raw.media || '')) ? String(raw.media) : 'any';
    push({ id: newId, label, folder, media, builtin: false });
  }

  // Any built-in the payload left out is restored, so routing never breaks.
  for (const [, leftover] of byId) {
    if (!leftover.builtin) continue;
    placeCategory(leftover, null);
  }
  return out.length ? out : current;
}

function merge(raw) {
  if (typeof raw !== 'object' || raw === null) return;

  if (raw.content) {
    const next = sanitizeContent(raw.content);
    if (next) state.content = { ...state.content, ...next };
  }

  if (Array.isArray(raw.categories) && raw.categories.length) {
    // Saved payloads may carry custom categories, so start from the defaults
    // and let anything stored (built-in or custom) come through.
    const defaults = defaultCategories();
    const known = defaults.slice();
    for (const c of raw.categories) {
      const id = String((c && c.id) || '');
      if (CUSTOM_ID_RE.test(id) && !known.some((k) => k.id === id)) {
        known.push({
          id,
          label: clean(c.label || '', 80) || id,
          folder: clean(c.folder || '', 80) || id,
          media: MEDIA_KINDS.includes(String(c.media || '')) ? String(c.media) : 'any',
          builtin: false,
        });
      }
    }
    const next = rebuildCategories(raw.categories, known);
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
    state.categories = rebuildCategories(categories, state.categories);
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
