'use strict';

const logger = require('../utils/logger');
const { cfg } = require('./config');

/**
 * Registry of in-flight chunked upload sessions.
 *
 * Each entry maps one client upload id to the metadata of its Google Drive
 * resumable session. File bytes are NEVER stored here — only tiny metadata.
 *
 * Recovery rules enforced by this module:
 *  - `advance()` stores ONLY byte offsets confirmed by Google (Range headers),
 *    never `offset + contentLength` guesses.
 *  - Idle/abandoned sessions are aborted (Drive session deleted, filename
 *    reservation released) on a timer.
 *  - Finished uploads leave a short-lived tombstone so a lost final response
 *    (client re-sends the last chunk after the entry is gone) is answered with
 *    the Drive file id instead of failing or duplicating.
 */

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;

// id -> { offset, total, name, mimeType, uploader, ip, createdAt, lastActiveAt, cancel }
const sessions = new Map();
// id -> { fileId, name, total, at }  (recently completed uploads)
const tombstones = new Map();

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Register a new upload session.
 * meta: { total, name, mimeType, uploader, ip, sessionUri }
 * cancel:  async best-effort cleanup (abort the Drive session + release the
 *          filename reservation). Invoked on failure / cancellation / idle
 *          eviction — i.e. whenever the upload did NOT finish.
 * release: releases ONLY the filename reservation, leaving the Drive session
 *          alone. Invoked by complete(), because the file is already stored:
 *          aborting its session there would be wrong.
 */
function create(id, meta, cancel, release) {
  if (!validId(id)) {
    const err = new Error('invalid upload id');
    err.code = 'INVALID_UPLOAD_ID';
    throw err;
  }
  if (sessions.has(id)) {
    // Stale session with the same id — abort it and start fresh.
    const stale = sessions.get(id);
    sessions.delete(id);
    if (stale && typeof stale.cancel === 'function') {
      try { stale.cancel(); } catch (e) { /* ignore */ }
    }
  }
  sessions.set(id, {
    offset: 0,
    total: meta.total,
    name: meta.name,
    mimeType: meta.mimeType,
    uploader: meta.uploader || '',
    ip: meta.ip || '',
    sessionUri: meta.sessionUri || '',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    cancel: typeof cancel === 'function' ? cancel : null,
    release: typeof release === 'function' ? release : null,
  });
  return sessions.get(id);
}

function get(id) {
  return validId(id) ? sessions.get(id) || null : null;
}

/**
 * Set the confirmed byte offset (as reported by Google) and refresh the idle
 * clock. Never pass an unconfirmed guess here.
 */
function advance(id, confirmedOffset) {
  const s = sessions.get(id);
  if (!s) return null;
  s.offset = Math.max(0, Math.min(confirmedOffset, s.total));
  s.lastActiveAt = Date.now();
  return s;
}

function touch(id) {
  const s = sessions.get(id);
  if (s) s.lastActiveAt = Date.now();
}

function remove(id) {
  const s = sessions.get(id);
  if (s) {
    sessions.delete(id);
    if (typeof s.cancel === 'function') {
      try { s.cancel(); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * A file is durably in Drive. Remove the live entry WITHOUT aborting the Drive
 * session, release the filename reservation, and leave a tombstone so a
 * re-sent final chunk (lost response) is answered from the recorded file id.
 */
function complete(id, { fileId, name, total } = {}) {
  const s = sessions.get(id);
  const finalName = name || (s && s.name) || '';
  const finalTotal = total || (s && s.total) || 0;
  // Release the display-name reservation only — the bytes are already at
  // Drive, so the session must NOT be deleted here.
  if (s && typeof s.release === 'function') {
    try { s.release(); } catch (e) { /* ignore */ }
  }
  sessions.delete(id);
  if (fileId) {
    tombstones.set(id, { fileId, name: finalName, total: finalTotal, at: Date.now() });
  }
}

/** Look up a recently completed upload (lost-final-response recovery). */
function tombstoneDone(id) {
  const t = tombstones.get(id);
  if (!t) return null;
  if (Date.now() - t.at > TOMBSTONE_TTL_MS) {
    tombstones.delete(id);
    return null;
  }
  return { fileId: t.fileId, name: t.name, total: t.total };
}

/* ── Capacity / abuse accounting ─────────────────────────────── */

function activeCount() {
  return sessions.size;
}

function countByIp(ip) {
  if (!ip) return 0;
  let n = 0;
  for (const s of sessions.values()) {
    if (s.ip === ip) n += 1;
  }
  return n;
}

/** True when a new session is allowed under the configured global/IP caps. */
function capacityOk(ip) {
  if (sessions.size >= cfg.maxActiveUploads) return { ok: false, code: 'UPLOAD_CAPACITY', status: 503 };
  if (countByIp(ip) >= cfg.maxUploadsPerIp) return { ok: false, code: 'TOO_MANY_UPLOADS', status: 429 };
  return { ok: true };
}

/* ── Idle cleanup ────────────────────────────────────────────── */

function evictIdle(now = Date.now()) {
  const idleMs = cfg.uploadSessionIdleMinutes * 60 * 1000;
  for (const [id, s] of sessions) {
    if (now - s.lastActiveAt > idleMs) {
      logger.warn('uploads: evicting idle upload session', { id, name: s.name });
      remove(id); // aborts the Drive session and releases the reservation
    }
  }
  for (const [id, t] of tombstones) {
    if (now - t.at > TOMBSTONE_TTL_MS) tombstones.delete(id);
  }
}

let timer = null;
function startCleanup() {
  if (timer) return;
  timer = setInterval(evictIdle, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  validId,
  create,
  get,
  touch,
  advance,
  remove,
  complete,
  tombstoneDone,
  activeCount,
  countByIp,
  capacityOk,
  evictIdle,
  startCleanup,
};
