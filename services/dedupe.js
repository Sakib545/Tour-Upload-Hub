'use strict';

const logger = require('../utils/logger');
const drive = require('./drive');
const sanitize = require('../utils/sanitize');

/**
 * Duplicate detection by content signature.
 *
 * The client computes a small signature of every file it is about to send
 * (SHA-256 over the first 256 KB, the last 256 KB and the byte size) and asks
 * `/api/upload/precheck` whether that signature is already in the tour folder.
 * A match means the very same file was uploaded before — by this phone or by
 * somebody else — so the bytes are never sent a second time.
 *
 * Where the index lives:
 *  - The signature is written into the Drive file's own `description` (the
 *    same JSON that already carries the uploader name and category), so the
 *    index is rebuildable from Drive alone. A Railway redeploy wipes the
 *    container disk, not the tour folder — duplicates stay detected.
 *  - In memory we keep only `sig -> { fileId, name }`, rebuilt lazily from one
 *    Drive listing and refreshed on a TTL. Nothing else is cached.
 *
 * What it deliberately does NOT do: it never blocks an upload on a Drive
 * failure. If the index cannot be built, the upload proceeds as before — a
 * duplicate file is a small annoyance, a lost photo is not.
 */

const SIG_RE = /^[a-f0-9]{16,64}$/;
const REFRESH_MS = 10 * 60 * 1000;   // how stale the index may get
const MAX_ENTRIES = 50000;           // hard memory ceiling

// sig -> { fileId, name, at }
const index = new Map();
let builtAt = 0;
let building = null;

function validSig(sig) {
  return typeof sig === 'string' && SIG_RE.test(sig);
}

/** Normalise whatever a client sent into a usable signature (or ''). */
function cleanSig(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return validSig(s) ? s : '';
}

function put(sig, fileId, name) {
  if (!validSig(sig)) return;
  if (index.size >= MAX_ENTRIES && !index.has(sig)) {
    index.delete(index.keys().next().value); // drop the oldest insert
  }
  index.set(sig, { fileId: fileId || null, name: name || '', at: Date.now() });
}

/** Record a freshly stored file so the next upload of it is caught at once. */
function remember(sig, { fileId, name } = {}) {
  put(cleanSig(sig), fileId, name);
}

/** Drop everything pointing at a file the admin deleted or moved out. */
function forgetFile(fileId) {
  if (!fileId) return;
  for (const [sig, v] of index) {
    if (v.fileId === fileId) index.delete(sig);
  }
}

/** Rebuild the whole map from one Drive listing of the tour folders. */
async function build() {
  const { files } = await drive.listFolderFiles({
    kinds: 'media',
    fields: 'files(id,name,description),nextPageToken',
  });
  index.clear();
  for (const f of files || []) {
    const meta = sanitize.parseDescription(f.description);
    if (meta && validSig(meta.sig)) put(meta.sig, f.id, f.name || '');
  }
  builtAt = Date.now();
  logger.info('dedupe: signature index built', { files: (files || []).length, signatures: index.size });
  return index.size;
}

/** Build the index if it was never built, or has gone stale. Never throws. */
async function ensureIndex() {
  if (builtAt && Date.now() - builtAt < REFRESH_MS) return;
  if (building) return building;
  building = build()
    .catch((e) => {
      // A failed rebuild must not retry on every single request.
      builtAt = Date.now();
      logger.warn('dedupe: index build failed', { code: e && e.code, msg: e && e.message });
    })
    .finally(() => { building = null; });
  return building;
}

/**
 * Look one signature up.
 * @returns {Promise<{fileId:string|null,name:string}|null>}
 */
async function lookup(sig) {
  const s = cleanSig(sig);
  if (!s) return null;
  const hit = index.get(s);
  if (hit) return { fileId: hit.fileId, name: hit.name };
  await ensureIndex();
  const late = index.get(s);
  return late ? { fileId: late.fileId, name: late.name } : null;
}

/** Look several signatures up in one go (the /precheck endpoint). */
async function lookupMany(sigs) {
  const clean = [];
  for (const raw of Array.isArray(sigs) ? sigs : []) {
    const s = cleanSig(raw);
    if (s && !clean.includes(s)) clean.push(s);
  }
  if (!clean.length) return {};
  // One build attempt for the whole batch, not one per signature.
  if (clean.some((s) => !index.has(s))) await ensureIndex();
  const known = {};
  for (const s of clean) {
    const hit = index.get(s);
    if (hit) known[s] = { fileId: hit.fileId, name: hit.name };
  }
  return known;
}

/** Test/admin hook: forget everything and force the next lookup to rebuild. */
function reset() {
  index.clear();
  builtAt = 0;
}

module.exports = {
  validSig,
  cleanSig,
  remember,
  forgetFile,
  lookup,
  lookupMany,
  ensureIndex,
  reset,
  size: () => index.size,
};
