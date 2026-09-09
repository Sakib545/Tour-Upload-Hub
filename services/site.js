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

// Folder names reserved for the app itself — a category/person folder must
// never shadow the durable settings file kept in the same Drive folder (see
// services/drive.js SETTINGS_FILE).
const RESERVED_FOLDERS = new Set(['.tour-hub-settings.json']);

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
  // Enrolled faces: [{ id, name, folder, descriptors: number[128][] }]
  people: [],
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
  const folder =
    folderRaw && FOLDER_RE.test(folderRaw) && !RESERVED_FOLDERS.has(folderRaw)
      ? folderRaw
      : base.folder;
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

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    if (out.length >= MAX_CATEGORIES) break;
    const id = String(raw.id || '').trim();
    const base = byId.get(id);
    if (base) {
      const next = sanitizeCategory(raw, base);
      // Folder taken by another category — keep what this one had.
      if (!push(next)) push({ ...next, folder: base.folder });
      byId.delete(id);
      continue;
    }
    // A brand-new custom category.
    const label = clean(raw.label || '', 80);
    const folder = clean(raw.folder || '', 80);
    if (!label || !folder || !FOLDER_RE.test(folder) || RESERVED_FOLDERS.has(folder)) continue;
    const newId = newCategoryId(takenIds);
    if (!newId) continue;
    takenIds.add(newId);
    const media = MEDIA_KINDS.includes(String(raw.media || '')) ? String(raw.media) : 'any';
    push({ id: newId, label, folder, media, builtin: false });
  }

  // Any built-in the payload left out is restored, so routing never breaks.
  for (const [, leftover] of byId) {
    if (!leftover.builtin) continue;
    if (!push(leftover)) push({ ...leftover, folder: `${leftover.folder} (${leftover.id})` });
  }
  // Guarantee pass: a built-in that WAS in the payload can still have been
  // pushed out above (its folder renamed into another category's name and the
  // base-folder fallback collided too). Built-ins are the routing fallback, so
  // they must always survive — re-add any that are missing under a unique name.
  for (const id of CATEGORY_IDS) {
    if (out.some((c) => c.id === id)) continue;
    const base = current.find((c) => c.id === id);
    if (!base) continue;
    const cat = { ...base };
    if (push(cat)) continue;
    if (push({ ...cat, folder: `${base.folder} (${base.id})` })) continue;
    for (let i = 2; i <= 50; i++) {
      if (push({ ...cat, folder: `${base.folder} (${i})` })) break;
    }
  }
  return out.length ? out : current;
}

function merge(raw) {
  if (typeof raw !== 'object' || raw === null) return;

  if (raw.content) {
    const next = sanitizeContent(raw.content);
    if (next) state.content = { ...state.content, ...next };
  }

  if (Array.isArray(raw.people)) restorePeople(raw.people);

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

/** Accept a saved people list (local cache or the Drive settings file). */
function restorePeople(raw) {
  if (!Array.isArray(raw)) return;
  state.people = raw
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    .slice(0, 40)
    .map((p, i) => ({
      id: p.id,
      name: clean(p.name, 60),
      folder: clean(p.folder || p.name, 60),
      descriptors: Array.isArray(p.descriptors)
        ? p.descriptors
            .filter((d) => Array.isArray(d) && d.length === 128 && d.every((n) => Number.isFinite(n)))
            .slice(-6)
        : [],
      avatar: sanitizeAvatar(p.avatar, defaultAvatar(i)),
      face: typeof p.face === 'string' && p.face.length < 90000 ? p.face : '',
    }));
}

function snapshot() {
  return {
    content: { ...state.content },
    categories: state.categories.map((c) => ({ ...c })),
    // Descriptors are big and useless to a human, so the admin view reports
    // only how many reference photos each person has.
    people: state.people.map((p, i) => ({
      id: p.id,
      name: p.name,
      folder: p.folder,
      samples: (p.descriptors || []).length,
      avatar: p.avatar || defaultAvatar(i),
      hasFace: !!p.face,
    })),
  };
}

/** The full people records, descriptors included — for the sorter. */
function peopleWithDescriptors() {
  return state.people.map((p) => ({ ...p, descriptors: (p.descriptors || []).map((d) => d.slice()) }));
}

/* Flat colours that sit well in the beach scene. */
const SKIN_TONES = ['#efbd93', '#d1996a', '#9a6440', '#7a4a2c', '#f7d7bd'];
const HAIR_TONES = ['#2b1d17', '#1c130f', '#c98b3c', '#5b3b21', '#6b6b6b'];
const SHIRT_TONES = ['#17948f', '#d9483b', '#6b4bd6', '#f2ece1', '#f59e0b', '#0ea5e9', '#ec4899'];
const SHORTS_TONES = ['#2b3a52', '#3b3f2c', '#243b46', '#4a3f6b'];
const HEX_RE = /^#[0-9a-f]{6}$/i;

function defaultAvatar(index) {
  return {
    skin: SKIN_TONES[index % SKIN_TONES.length],
    hair: HAIR_TONES[index % HAIR_TONES.length],
    shirt: SHIRT_TONES[index % SHIRT_TONES.length],
    shorts: SHORTS_TONES[index % SHORTS_TONES.length],
  };
}

function sanitizeAvatar(raw, base) {
  const out = { ...base };
  for (const key of ['skin', 'hair', 'shirt', 'shorts']) {
    const v = String((raw && raw[key]) || '').trim();
    if (HEX_RE.test(v)) out[key] = v.toLowerCase();
  }
  return out;
}

const PERSON_ID_RE = /^p_[a-z0-9]{6}$/;
const MAX_PEOPLE = 40;
const MAX_SAMPLES = 6;

function newPersonId(taken) {
  for (let i = 0; i < 50; i++) {
    const id = 'p_' + Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '0');
    if (PERSON_ID_RE.test(id) && !taken.has(id)) return id;
  }
  return null;
}

/** Add a person. Returns the record, or null when the name/folder is unusable. */
function addPerson(rawName) {
  const name = clean(rawName || '', 60);
  if (!name || state.people.length >= MAX_PEOPLE) return null;
  // The folder is the name, cleaned to something Drive is happy with.
  const folder = name.replace(/[\\/'"]/g, '').trim() || null;
  if (!folder || !FOLDER_RE.test(folder) || RESERVED_FOLDERS.has(folder)) return null;
  const taken = new Set(state.people.map((p) => p.id));
  if (state.people.some((p) => p.folder.toLowerCase() === folder.toLowerCase())) return null;
  const id = newPersonId(taken);
  if (!id) return null;
  const person = {
    id,
    name,
    folder,
    descriptors: [],
    avatar: defaultAvatar(state.people.length),
    face: '', // base64 JPEG portrait, filled in at enrolment
  };
  state.people.push(person);
  save();
  return { id, name, folder, samples: 0 };
}

function removePerson(id) {
  const before = state.people.length;
  state.people = state.people.filter((p) => p.id !== id);
  if (state.people.length === before) return false;
  save();
  return true;
}

/** Store one more reference descriptor for a person. */
function addDescriptor(id, descriptor) {
  const person = state.people.find((p) => p.id === id);
  if (!person || !Array.isArray(descriptor) || descriptor.length !== 128) return false;
  // Four decimals is well inside the noise floor and keeps the settings file
  // small enough to live in Drive.
  const rounded = descriptor.map((v) => Math.round(v * 1e4) / 1e4);
  person.descriptors = (person.descriptors || []).concat([rounded]).slice(-MAX_SAMPLES);
  save();
  return true;
}

function personById(id) {
  return state.people.find((p) => p.id === id) || null;
}

/** Change a person's name and/or their cartoon colours. */
function updatePerson(id, patch = {}) {
  const person = state.people.find((p) => p.id === id);
  if (!person) return null;
  if (typeof patch.name === 'string') {
    const name = clean(patch.name, 60);
    if (name) person.name = name;
  }
  if (patch.avatar && typeof patch.avatar === 'object') {
    person.avatar = sanitizeAvatar(patch.avatar, person.avatar || defaultAvatar(0));
  }
  save();
  return { id: person.id, name: person.name, folder: person.folder };
}

/** Store the small portrait taken from an enrolment photo. */
function setPortrait(id, jpegBuffer) {
  const person = state.people.find((p) => p.id === id);
  if (!person || !Buffer.isBuffer(jpegBuffer) || !jpegBuffer.length) return false;
  // Kept inline in the settings file so it survives a redeploy like everything
  // else; a 160px JPEG is a few kilobytes.
  if (jpegBuffer.length > 60 * 1024) return false;
  person.face = jpegBuffer.toString('base64');
  save();
  return true;
}

function portrait(id) {
  const person = state.people.find((p) => p.id === id);
  if (!person || !person.face) return null;
  return Buffer.from(person.face, 'base64');
}

/** What the public pages need to draw the beach crew. */
function crew() {
  return state.people.map((p, i) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar || defaultAvatar(i),
    hasFace: !!p.face,
  }));
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
  addPerson,
  removePerson,
  updatePerson,
  setPortrait,
  portrait,
  crew,
  addDescriptor,
  personById,
  peopleWithDescriptors,
  restorePeople,
  get people() {
    return snapshot().people;
  },
  // Full view (labels + Drive folder names) — admin only.
  adminView: snapshot,
  get content() {
    return { ...state.content };
  },
  get categories() {
    return state.categories.map((c) => ({ ...c }));
  },
};
