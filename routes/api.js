'use strict';

const express = require('express');
const { PassThrough } = require('stream');
const logger = require('../utils/logger');
const { cfg, publicConfig } = require('../services/config');
const state = require('../services/state');
const site = require('../services/site');
const uploads = require('../services/uploads');
const reservations = require('../services/reservations');
const drive = require('../services/drive');
const sanitize = require('../utils/sanitize');
const sniff = require('../utils/sniff');
const { safeEqual } = require('../utils/tokens');
const {
  requireUploadAuth,
  requireGalleryAuth,
  pinToken,
  galleryToken,
} = require('../middleware/auth');
const { noStore } = require('../middleware/security');
const rl = require('../middleware/rateLimiters');

const router = express.Router();
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, status, code) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.status(status).json({ error: code });
}

function sendJson(res, status, obj) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.status(status).json(obj);
}

function driveFail(res, err) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  logger.error('drive error surfaced to client', {
    code: err.code,
    reason: (err && err.reason) || '',
    msg: err && err.message,
  });
  const table = {
    FOLDER_NOT_FOUND: [500, 'DRIVE_FOLDER_NOT_FOUND'],
    NOT_A_FOLDER: [500, 'DRIVE_FOLDER_NOT_FOUND'],
    DRIVE_PERMISSION: [500, 'DRIVE_PERMISSION'],
    DRIVE_QUOTA: [500, 'DRIVE_QUOTA'],
    DRIVE_AUTH: [500, 'DRIVE_AUTH'],
    DRIVE_RATE_LIMIT: [503, 'DRIVE_BUSY'],
    DRIVE_ERROR: [500, 'DRIVE_ERROR'],
    FILE_NOT_FOUND: [404, 'NOT_FOUND'],
    NETWORK: [502, 'DRIVE_NETWORK'],
  };
  const [status, code] = table[err.code] || [500, 'DRIVE_ERROR'];
  res.status(status).json({ error: code });
}

function safeDecode(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return String(value);
  }
}

/** Fully consume the incoming request body so the TCP connection stays clean. */
function drain(req) {
  if (!req || req.readableEnded || req.complete || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let total = 0;
    const onData = (d) => {
      total += d.length;
      if (total > 64 * 1024 * 1024) {
        cleanup();
        req.destroy();
        resolve();
      }
    };
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('close', onClose);
      req.removeListener('error', onError);
    };
    const onEnd = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); resolve(); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
    req.on('error', onError);
    req.resume();
  });
}

/* ── Public: health & config ──────────────────────────────────── */

router.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

router.get('/config', noStore, (req, res) => {
  res.json(publicConfig(state.settings, site));
});

/* ── Public: PIN gate ─────────────────────────────────────────── */

router.post('/verify-pin', noStore, rl.pinVerify, asyncH(async (req, res) => {
  if (!cfg.pinEnabled) return fail(res, 400, 'PIN_NOT_REQUIRED');
  const pin = (req.body && req.body.pin) || '';
  if (typeof pin !== 'string' || !pin) return fail(res, 400, 'BAD_REQUEST');
  if (!safeEqual(pin, cfg.tourPin)) {
    logger.warn('verify-pin: wrong pin attempt');
    return fail(res, 401, 'INVALID_PIN');
  }
  res.json({ token: pinToken() });
}));

/* ── Public: chunked upload ───────────────────────────────────── */

// Session-creation attempts per IP inside a 60 s window (new Drive resumable
// sessions are expensive; stop brute-force session spam).
const createAttempts = new Map(); // ip -> [timestamps]
function allowSessionCreate(ip) {
  const now = Date.now();
  const arr = (createAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= cfg.maxSessionCreatesPerMinPerIp) return false;
  arr.push(now);
  if (arr.length) createAttempts.set(ip, arr);
  return true;
}
// prevent unbounded growth of the tracker map
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of createAttempts) {
    const keep = arr.filter((t) => now - t < 60_000);
    if (!keep.length) createAttempts.delete(ip);
    else createAttempts.set(ip, keep);
  }
}, 60_000).unref();

/**
 * Probe Google and answer with Drive's confirmed byte count. Used after a
 * failed/uncertain chunk PUT, where the correct answers are:
 *   done            — Drive already has the whole file (200/201 probe)
 *   200 received    — resume from this confirmed offset
 *   503 uncertain   — Drive reachable but holds no new bytes; retry the chunk
 */
async function reconcileWithDrive(res, entry, id) {
  let rec;
  try {
    rec = await drive.probeSession(entry.sessionUri, entry.total);
  } catch (perr) {
    if (perr.code === 'SESSION_GONE') {
      uploads.remove(id);
      sendJson(res, 422, { error: 'UNKNOWN_UPLOAD' });
      return;
    }
    if (perr.code === 'NETWORK') {
      // Drive is unreachable right now — keep the session, ask for a retry.
      sendJson(res, 503, { error: 'CHUNK_UNCERTAIN', retryable: true });
      return;
    }
    uploads.remove(id);
    driveFail(res, perr);
    return;
  }
  if (rec.done) {
    const fileId = rec.file && rec.file.id;
    uploads.complete(id, { fileId, name: entry.name, total: entry.total });
    sendJson(res, 200, {
      done: true,
      file: { id: fileId, name: entry.name, size: entry.total },
    });
    return;
  }
  const before = entry.offset;
  const confirmed = Math.min(entry.total, Math.max(before, rec.received || 0));
  uploads.advance(id, confirmed);
  if (confirmed === before) {
    // Drive holds no new bytes beyond what we already recorded.
    sendJson(res, 503, { error: 'CHUNK_UNCERTAIN', retryable: true });
    return;
  }
  if (confirmed === entry.total) {
    // Google reports the file is complete but no 201 reached us — Drive is the
    // source of truth, treat it as done and retire the session (otherwise it
    // lingers against the capacity caps until idle eviction aborts it).
    uploads.complete(id, { fileId: null, name: entry.name, total: entry.total });
    sendJson(res, 200, { done: true, file: { id: null, name: entry.name, size: entry.total } });
    return;
  }
  // Everything up to `confirmed` is at Drive; the client resumes from there.
  sendJson(res, 200, { received: confirmed });
}

/**
 * Reconcile when the client's chunk is NOT in order with our recorded offset
 * (a gap — lost response — or a partial overlap). Unlike reconcileWithDrive,
 * a confirmed "client is genuinely ahead of Drive" state means OUT_OF_ORDER:
 * the session is aborted and the client restarts the file (bounded).
 * Returns { proceed: true } when the chunk may be sent now, else undefined.
 */
async function reconcileGap(res, entry, id, { offset, contentLength }) {
  let rec;
  try {
    rec = await drive.probeSession(entry.sessionUri, entry.total);
  } catch (perr) {
    if (perr.code === 'SESSION_GONE') {
      uploads.remove(id);
      sendJson(res, 422, { error: 'UNKNOWN_UPLOAD' });
      return;
    }
    if (perr.code === 'NETWORK') {
      sendJson(res, 503, { error: 'CHUNK_UNCERTAIN', retryable: true });
      return;
    }
    uploads.remove(id);
    driveFail(res, perr);
    return;
  }
  if (rec.done) {
    const fileId = rec.file && rec.file.id;
    uploads.complete(id, { fileId, name: entry.name, total: entry.total });
    sendJson(res, 200, {
      done: true,
      file: { id: fileId, name: entry.name, size: entry.total },
    });
    return;
  }
  const confirmed = Math.min(entry.total, Math.max(entry.offset, rec.received || 0));
  uploads.advance(id, confirmed);

  if (offset + contentLength <= confirmed) {
    // Everything the client is re-sending is already durably at Drive.
    sendJson(res, 200, { received: confirmed });
    return;
  }
  if (offset > confirmed) {
    // Client is ahead of Google even after probing — genuinely out of order.
    uploads.remove(id); // abort the partial Drive session
    sendJson(res, 409, { error: 'OUT_OF_ORDER' });
    return;
  }
  if (confirmed > offset) {
    // Part of this chunk is already at Drive — resume from the confirmed byte.
    sendJson(res, 200, { received: confirmed });
    return;
  }
  // confirmed === offset: nothing of this chunk is at Drive yet and we are now
  // in order — the caller may stream the chunk straight through.
  return { proceed: true };
}

/** Recover from a failed/uncertain chunk PUT and answer the client. */
async function handleChunkFailure(res, { entry, id, err }) {
  if (err.code === 'SESSION_GONE') {
    // Session genuinely invalid — clean up; client restarts the file (bounded).
    uploads.remove(id);
    sendJson(res, 422, { error: 'UNKNOWN_UPLOAD' });
    return;
  }
  if (
    err.code === 'DRIVE_AUTH' ||
    err.code === 'DRIVE_PERMISSION' ||
    err.code === 'FOLDER_NOT_FOUND' ||
    err.code === 'NOT_A_FOLDER' ||
    err.code === 'FILE_NOT_FOUND'
  ) {
    uploads.remove(id);
    driveFail(res, err);
    return;
  }
  // Transient / state-unknown: ask Drive how many bytes it really has.
  await reconcileWithDrive(res, entry, id);
}

/**
 * Send one in-order chunk to the Drive session and answer with the
 * Google-confirmed offset (never offset+contentLength guesses).
 * - `clientReq`: the browser request (drained on failure so the connection
 *   stays clean).
 * - `stream`: what is piped to Drive — the request itself for continuation
 *   chunks, or the PassThrough tee for a first chunk.
 * - `ownedStream`: true for the tee — it must be destroyed on failure so its
 *   buffer cannot linger.
 */
async function sendChunkToDrive({ clientReq, stream, res, entry, id, offset, contentLength, ownedStream = false }) {
  let out;
  try {
    out = await drive.putChunk({
      sessionUri: entry.sessionUri,
      offset,
      length: contentLength,
      total: entry.total,
      contentType: entry.mimeType,
      stream,
    });
  } catch (e) {
    // The request may still be streaming — swallow the rest before answering.
    await drain(clientReq).catch(() => {});
    if (ownedStream && stream && typeof stream.destroy === 'function') {
      try { stream.destroy(); } catch (e2) { /* ignore */ }
    }
    await handleChunkFailure(res, { entry, id, err: e });
    return;
  }
  if (out.done) {
    const fileId = out.file && out.file.id;
    uploads.complete(id, { fileId, name: entry.name, total: entry.total });
    sendJson(res, 200, {
      done: true,
      file: { id: fileId, name: entry.name, size: entry.total },
    });
    return;
  }
  // 308 — only bytes Google's Range header confirmed may advance our offset.
  const received = Math.min(
    entry.total,
    Math.max(entry.offset, Number.isFinite(out.received) ? out.received : 0)
  );
  uploads.advance(id, received);
  sendJson(res, 200, { received });
}

/**
 * Tee the incoming first chunk: every byte is fed into `bodyStream` (which will
 * be piped to Drive) while a small prefix is captured for magic-byte sniffing.
 * The request is paused as soon as the prefix is available so validation and
 * Drive-session creation never race ahead of the network — and no byte is ever
 * dropped (a whole small file can arrive inside a single data event).
 * Bounded memory: at most one configured chunk (≤ UPLOAD_CHUNK_MB) is held.
 */
function sniffPrep(req, sniffLen) {
  const bodyStream = new PassThrough();
  const bufs = [];
  let have = 0;
  let done = false;
  let heldForSniff = false;  // paused while we validate and open the session
  let heldForDrain = false;  // paused because Drive is slower than the client
  let resolveReady = null;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const cleanup = () => {
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', onError);
  };
  const onData = (d) => {
    if (done) return;
    let wantsMore = true;
    if (!bodyStream.destroyed) wantsMore = bodyStream.write(d);
    if (have < sniffLen) {
      const need = sniffLen - have;
      bufs.push(d.subarray(0, Math.min(need, d.length)));
      have += Math.min(need, d.length);
      if (have >= sniffLen) {
        heldForSniff = true;
        req.pause(); // hold the remainder while we validate + open the session
        if (resolveReady) { const r = resolveReady; resolveReady = null; r(); }
      }
    }
    // Respect backpressure: without this the tee would buffer a whole chunk in
    // memory whenever the phone uploads faster than we can push to Drive.
    if (!wantsMore && !heldForDrain) {
      heldForDrain = true;
      req.pause();
      bodyStream.once('drain', () => {
        heldForDrain = false;
        if (!done && !heldForSniff) req.resume();
      });
    }
  };
  const onEnd = () => {
    done = true;
    cleanup();
    if (!bodyStream.destroyed) bodyStream.end();
    if (resolveReady) { const r = resolveReady; resolveReady = null; r(); }
  };
  const onError = () => {
    done = true;
    cleanup();
    if (!bodyStream.destroyed) bodyStream.destroy();
    if (resolveReady) { const r = resolveReady; resolveReady = null; r(); }
  };

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);

  return {
    ready,
    prefix: () => Buffer.concat(bufs, have),
    bodyStream,
    resume() {
      heldForSniff = false;
      if (!heldForDrain) req.resume();
    },
    /** Cancel the upload: stop consuming and free the tee buffer. */
    abort() {
      if (done) return;
      done = true;
      heldForSniff = false;
      heldForDrain = false;
      cleanup();
      req.pause();
      if (!bodyStream.destroyed) bodyStream.destroy();
    },
  };
}

/** First chunk of a brand-new upload id: full validation before any Drive call. */
async function beginNewFile(req, res, { id, total, contentLength, ip }) {
  const rawName = safeDecode(req.get('x-file-name') || '');
  const mime = String(req.get('x-mime') || '').slice(0, 200);
  const uploader = safeDecode(req.get('x-uploader') || '').slice(0, 60);

  // A normal first chunk is exactly min(chunkBytes, total). Anything smaller for
  // a multi-chunk file is "unusually tiny" and never warrants a Drive session.
  const expected = Math.min(cfg.chunkBytes, total);
  if (contentLength !== expected) {
    await drain(req);
    return fail(res, 400, 'BAD_REQUEST');
  }

  const v = sanitize.validateFile({ name: rawName, mime, size: total, maxBytes: cfg.maxFileBytes });
  if (!v.ok) {
    const status = v.code === 'FILE_TOO_LARGE' ? 413 : v.code === 'EMPTY_FILE' ? 400 : 415;
    await drain(req);
    return fail(res, status, v.code);
  }

  // Abuse caps BEFORE any Drive session or buffering.
  const cap = uploads.capacityOk(ip);
  if (!cap.ok) {
    await drain(req);
    return fail(res, cap.status, cap.code);
  }
  if (!allowSessionCreate(ip)) {
    await drain(req);
    return fail(res, 429, 'RATE_LIMITED');
  }

  // Magic-byte sniff: only inspect a small prefix, never the whole chunk.
  const sniffLen = Math.min(contentLength, sniff.PROBE_BYTES);
  const prep = sniffPrep(req, sniffLen);
  await prep.ready;
  const sniffRes = sniff.sniffPrefix(v.ext, prep.prefix());
  if (!sniffRes.ok) {
    prep.abort();
    await drain(req);
    return fail(res, 415, sniffRes.code);
  }

  // The visitor picks a category (single / group / video) in the UI; it decides
  // which Drive sub-folder the file lands in. A category is only honoured when
  // it matches the file type (photo categories for images, video for videos).
  const rawCategory = String(req.get('x-category') || '').trim().slice(0, 24);
  let category = null;
  if (/^[A-Za-z0-9_-]{1,24}$/.test(rawCategory)) {
    const candidate = site.categoryById(rawCategory);
    const m = String(v.mimeType || '').toLowerCase();
    // A category accepts a file when its media kind matches — 'any' takes both,
    // which is what custom categories (a place, a day, a drone set) usually are.
    if (
      candidate &&
      (candidate.media === 'any' ||
        (candidate.media === 'photo' && m.startsWith('image/')) ||
        (candidate.media === 'video' && m.startsWith('video/')))
    ) {
      category = candidate;
    }
  }

  // Category folders (or the legacy Photos / Videos split when no valid
  // category was sent) — never block an upload over folder housekeeping.
  let parentId;
  try {
    parentId = await drive.folderIdForCategory(category, v.mimeType);
  } catch (e) {
    parentId = null; // fall back to the root folder — never block an upload
  }

  // Unique display name — in-process reservation + Drive existence check,
  // scoped to the folder the file will actually land in.
  let reservation;
  try {
    reservation = await reservations.acquire(v.fileName, (n) =>
      drive.nameExistsInFolder(n, parentId)
    );
  } catch (e) {
    prep.abort();
    await drain(req);
    return driveFail(res, e);
  }

  const description = sanitize.encodeDescription({
    uploader,
    originalName: v.fileName,
    category: category ? category.id : '',
  });

  let sessionUri;
  try {
    sessionUri = await drive.createResumableSession({
      name: reservation.name,
      mimeType: v.mimeType,
      size: total,
      description,
      parentId,
    });
  } catch (e) {
    reservation.release();
    prep.abort();
    await drain(req);
    logger.error('drive: resumable session create failed', {
      code: e.code, reason: e.reason || '', msg: e.message,
    });
    return driveFail(res, e);
  }

  uploads.create(
    id,
    {
      total,
      name: reservation.name,
      mimeType: v.mimeType,
      uploader,
      ip,
      sessionUri,
    },
    // cancel: best-effort abort of the Drive session + release the filename.
    async () => {
      try { await drive.abortSession(sessionUri); } catch (e) { /* ignore */ }
      reservation.release();
    },
    // release: file is safely at Drive — only free the reserved display name.
    () => reservation.release()
  );

  logger.info('upload: session started', { id, name: reservation.name, size: total, uploader });

  const entry = uploads.get(id);
  // Stream the tee (prefix + already-buffered bytes + remainder) into Drive.
  prep.resume();
  await sendChunkToDrive({
    clientReq: req,
    stream: prep.bodyStream,
    res,
    entry,
    id,
    offset: 0,
    contentLength,
    ownedStream: true,
  });
}

router.post('/upload/chunk', rl.uploadChunks, requireUploadAuth, asyncH(async (req, res) => {
  const id = String(req.get('x-upload-id') || '');
  const offset = Number(req.get('x-offset'));
  const total = Number(req.get('x-total'));
  const contentLength = Number(req.headers['content-length']);
  const ip = req.ip || '';

  if (!uploads.validId(id)) return fail(res, 400, 'BAD_REQUEST');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(total) || total <= 0) {
    return fail(res, 400, 'BAD_REQUEST');
  }
  if (total > cfg.maxFileBytes) return fail(res, 413, 'FILE_TOO_LARGE');
  if (!Number.isFinite(contentLength) || contentLength <= 0) return fail(res, 411, 'LENGTH_REQUIRED');
  if (contentLength > cfg.chunkBytes) return fail(res, 400, 'BAD_REQUEST');
  if (offset + contentLength > total) return fail(res, 400, 'BAD_REQUEST');

  let entry = uploads.get(id);

  // Unknown id: either the first chunk (start) or a session we lost.
  if (!entry) {
    if (offset !== 0) {
      // Server restart / session eviction mid-file: if the file actually
      // completed (lost final response), answer done from the tombstone.
      const tomb = uploads.tombstoneDone(id);
      if (tomb && offset + contentLength >= tomb.total) {
        await drain(req);
        return sendJson(res, 200, { done: true, file: { id: tomb.fileId, name: tomb.name, size: tomb.total } });
      }
      return fail(res, 422, 'UNKNOWN_UPLOAD'); // client restarts the file (bounded)
    }
    return beginNewFile(req, res, { id, total, contentLength, ip });
  }

  // Duplicate resend of already-acknowledged bytes (lost response): answer from
  // our confirmed offset without touching Drive again.
  if (offset < entry.offset && offset + contentLength <= entry.offset) {
    await drain(req);
    return sendJson(res, 200, { received: entry.offset });
  }

  // Out-of-order or partial-overlap: reconcile with Google before deciding.
  if (offset !== entry.offset) {
    const r = await reconcileGap(res, entry, id, { offset, contentLength });
    if (!r || !r.proceed) return; // a response was already sent / session removed
    // Entry is now in order at offset === entry.offset — stream the chunk.
    await sendChunkToDrive({ clientReq: req, stream: req, res, entry, id, offset, contentLength });
    return;
  }

  await sendChunkToDrive({ clientReq: req, stream: req, res, entry, id, offset, contentLength });
}));

/* ── Public: cancel an upload ─────────────────────────────────── */

router.post('/upload/cancel', rl.light, requireUploadAuth, asyncH(async (req, res) => {
  const id = String((req.body && req.body.uploadId) || '');
  if (!uploads.validId(id)) return fail(res, 400, 'BAD_REQUEST');
  const entry = uploads.get(id);
  if (entry) {
    logger.info('upload: cancelled by client', { id, name: entry.name });
    uploads.remove(id); // best-effort aborts the Drive session + releases the name
  }
  res.json({ ok: true });
}));

/* ── Gallery (PIN-protected when TOUR_UPLOAD_PIN is configured) ── */

// Files verified to live in one of our folders (prevents probing other Drive
// files). Small metadata only, pruned so the map cannot grow without bound.
const VERIFY_TTL_MS = 5 * 60 * 1000;
const VERIFY_MAX = 5000;
const verifiedCache = new Map(); // id -> { at, name, mimeType, thumbnailLink }

function pruneVerified() {
  const now = Date.now();
  for (const [id, v] of verifiedCache) {
    if (now - v.at > VERIFY_TTL_MS) verifiedCache.delete(id);
  }
  while (verifiedCache.size > VERIFY_MAX) {
    verifiedCache.delete(verifiedCache.keys().next().value);
  }
}
setInterval(pruneVerified, VERIFY_TTL_MS).unref();

function cachedMeta(id) {
  const v = verifiedCache.get(id);
  if (!v) return null;
  if (Date.now() - v.at > VERIFY_TTL_MS) {
    verifiedCache.delete(id);
    return null;
  }
  return v;
}

/**
 * Resolve a file id to its metadata, refusing anything that does not live in
 * our destination folder (or its Photos / Videos sub-folders).
 * Returns null when the file is unknown or out of scope.
 */
async function verifiedMeta(id) {
  const hit = cachedMeta(id);
  if (hit) return hit;
  let meta;
  try {
    meta = await drive.getFileMeta(id);
  } catch (e) {
    return null;
  }
  const parents = Array.isArray(meta.parents) ? meta.parents : [];
  const allowed = drive.allowedParents();
  if (!parents.some((pid) => allowed.includes(pid))) return null;
  const entry = {
    at: Date.now(),
    name: meta.name || 'file',
    mimeType: meta.mimeType || '',
    thumbnailLink: meta.thumbnailLink || '',
  };
  verifiedCache.set(id, entry);
  if (verifiedCache.size > VERIFY_MAX) pruneVerified();
  return entry;
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** RFC 5987 Content-Disposition so Bengali file names survive the download. */
function attachmentHeader(name) {
  const safe = String(name || 'file').replace(/[\r\n"\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Resolve the category a gallery item belongs to. Uploads carry their category
 * id in the Drive description; legacy files (or mismatched tags) fall back by
 * MIME type — videos → the video category, images → the first photo category.
 */
function categoryForFile(taggedCategory, mimeType) {
  const cats = site.categories;
  if (!cats.length) return null;
  const m = String(mimeType || '').toLowerCase();
  const tagged = taggedCategory
    ? site.categoryById(String(taggedCategory).slice(0, 24))
    : null;
  if (tagged) {
    if (tagged.media === 'any') return tagged;
    if (m.startsWith('image/') && tagged.media === 'photo') return tagged;
    if (m.startsWith('video/') && tagged.media === 'video') return tagged;
  }
  if (m.startsWith('video/')) return cats.find((c) => c.media === 'video') || null;
  if (m.startsWith('image/')) return cats.find((c) => c.media === 'photo') || null;
  return null;
}

router.get('/gallery', rl.light, noStore, requireGalleryAuth, asyncH(async (req, res) => {
  const { files, truncated } = await drive.listFolderFiles({
    cap: cfg.galleryLimit,
    kinds: 'media',
  });
  // Mint one short-lived signed token per listing when the gallery is PIN-gated;
  // <img>/<video> cannot send headers, so media URLs carry it as ?gt=…
  const gated = cfg.pinEnabled && !state.settings.galleryPublic;
  const gt = gated ? galleryToken() : null;
  const q = gt ? `?gt=${encodeURIComponent(gt)}` : '';
  const items = files.map((f) => {
    const meta = sanitize.parseDescription(f.description);
    const isImage = String(f.mimeType || '').startsWith('image/');
    const isVideo = String(f.mimeType || '').startsWith('video/');
    const cat = categoryForFile(meta.category, f.mimeType);
    const base = `/api/gallery/file/${f.id}`;
    return {
      id: f.id,
      name: f.name,
      isImage,
      isVideo,
      mimeType: f.mimeType || '',
      size: Number(f.size) || 0,
      createdTime: f.createdTime || null,
      category: cat ? cat.id : null,
      categoryLabel: cat ? cat.label : null,
      uploader: meta.uploader,
      // Thumbnails are proxied: Drive's own thumbnailLink is not readable by a
      // visitor's browser for files in a private folder.
      thumb: f.thumbnailLink ? `${base}/thumb${q}` : null,
      src: `${base}/content${q}`,
      download: `${base}/content${q}${q ? '&' : '?'}download=1`,
    };
  });
  res.json({ items, truncated });
}));

/* Small, cacheable preview image — keeps the grid light on mobile data. */
router.get('/gallery/file/:id/thumb', rl.media, requireGalleryAuth, asyncH(async (req, res) => {
  const id = req.params.id;
  if (!FILE_ID_RE.test(id)) return fail(res, 404, 'NOT_FOUND');

  const meta = await verifiedMeta(id);
  if (!meta) return fail(res, 404, 'NOT_FOUND');

  const size = Math.min(1600, Math.max(160, Number(req.query.s) || 640));
  let thumb = null;
  try {
    thumb = await drive.fetchThumbnail(meta.thumbnailLink, size);
  } catch (e) {
    thumb = null;
  }
  if (!thumb) {
    // Drive could not render one (some HEIC files, fresh uploads) — the client
    // falls back to its own placeholder.
    return fail(res, 404, 'NO_THUMBNAIL');
  }
  res.setHeader('Content-Type', thumb.contentType);
  res.setHeader('Content-Length', String(thumb.buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(thumb.buffer);
}));

router.get('/gallery/file/:id/content', rl.media, requireGalleryAuth, asyncH(async (req, res) => {
  const id = req.params.id;
  if (!FILE_ID_RE.test(id)) return fail(res, 404, 'NOT_FOUND');

  const meta = await verifiedMeta(id);
  if (!meta) return fail(res, 404, 'NOT_FOUND');

  const range = req.headers.range || null;
  let open;
  try {
    open = await drive.openContentStream(id, range);
  } catch (e) {
    if (e.code === 'FILE_NOT_FOUND') return fail(res, 404, 'NOT_FOUND');
    return driveFail(res, e);
  }

  // Private, short-lived cache: safe re-fetch after admin hides the gallery.
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (req.query.download) {
    res.setHeader('Content-Disposition', attachmentHeader(meta.name));
  }
  res.status(open.status);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
  for (const h of passthrough) {
    const v = open.headers[h];
    if (v !== undefined) res.setHeader(h, v);
  }
  open.stream.pipe(res);
  req.on('close', () => {
    if (!res.writableEnded) {
      try { open.req.destroy(); } catch (e) { /* ignore */ }
    }
  });
}));

module.exports = router;
