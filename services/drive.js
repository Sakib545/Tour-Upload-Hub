'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../utils/logger');
const { cfg } = require('./config');
const { escapeDriveQuery } = require('../utils/sanitize');

/**
 * Minimal Google Drive REST client (no heavy SDK).
 *  - OAuth2 refresh-token flow, token cached & auto-refreshed.
 *  - Resumable (chunked) uploads, so a multi-GB video never sits in memory:
 *    the client's request stream is piped straight into the Drive session.
 *  - Drive-confirmed byte offsets only: every 308 response's `Range` header is
 *    parsed; `probeSession()` asks Drive how many bytes it really holds.
 *  - Range-request support for safe video/image streaming back to the gallery.
 * Secrets never leave this process and are never logged.
 */

const GOOGLE_API = 'https://www.googleapis.com';
const GOOGLE_UPLOAD = 'https://www.googleapis.com/upload';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

class DriveError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.code = code;
    this.status = opts.status || 500;
    this.retryable = !!opts.retryable;
  }
}

// Test hook: point the client at a local mock server (http://…).
let endpoints = null; // { api, upload, token }
function setEndpoints(o) {
  endpoints = o
    ? { api: o.api, upload: o.upload, token: o.token || `${o.api}/token` }
    : null;
}
function ep(kind) {
  if (endpoints) return endpoints[kind];
  if (kind === 'api') return GOOGLE_API;
  if (kind === 'upload') return GOOGLE_UPLOAD;
  return GOOGLE_TOKEN;
}

function mapApiError(status, bodyText, fallbackCode) {
  let code = fallbackCode;
  let message = bodyText ? String(bodyText).slice(0, 300) : `HTTP ${status}`;
  try {
    const j = JSON.parse(bodyText || '{}');
    if (j.error) {
      const e = j.error;
      if (e.code === 404) code = 'FOLDER_NOT_FOUND';
      else if (e.code === 403) code = 'DRIVE_PERMISSION';
      else if (e.code === 401) code = 'DRIVE_AUTH';
      else if (e.code === 429) code = 'DRIVE_RATE_LIMIT';
      else code = 'DRIVE_ERROR';
      if (e.message) message = e.message;
    }
  } catch (e) { /* keep fallback */ }
  return new DriveError(code, message, {
    status,
    retryable: status >= 500 || status === 429 || status === 408,
  });
}

/** 404 on an *upload session* PUT/probe means the session itself is gone. */
function mapUploadError(status, bodyText) {
  if (status === 404) {
    return new DriveError('SESSION_GONE', 'resumable upload session no longer exists', { status: 404 });
  }
  return mapApiError(status, bodyText, 'DRIVE_ERROR');
}

/**
 * Parse Google's `Range` response header ("bytes=0-524287" = 524288 bytes
 * confirmed) into a byte count. Missing/empty header means 0 confirmed bytes.
 */
function parseRangeOffset(rangeHeader) {
  if (!rangeHeader) return 0;
  const m = /bytes=0-(\d+)/.exec(String(rangeHeader));
  if (!m) return 0;
  const end = parseInt(m[1], 10);
  if (!Number.isFinite(end)) return 0;
  return end + 1;
}

/* ── Token management ─────────────────────────────────────────── */

let cachedToken = null;
let cachedExp = 0;
let inflight = null;

async function refreshAccessToken(force = false) {
  if (!force && cachedToken && Date.now() < cachedExp - 60_000) return cachedToken;
  if (inflight) return inflight;
  inflight = (async () => {
    const body = new URLSearchParams({
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      refresh_token: cfg.google.refreshToken,
      grant_type: 'refresh_token',
    }).toString();
    let res;
    try {
      res = await fetch(ep('token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (e) {
      throw new DriveError('NETWORK', 'cannot reach Google token endpoint', { retryable: true });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      logger.error('drive: token refresh failed', { status: res.status });
      throw new DriveError('DRIVE_AUTH', 'Google token refresh failed (check credentials)', {
        status: 500,
      });
    }
    let j;
    try { j = JSON.parse(text); } catch (e) { j = {}; }
    if (!j.access_token) {
      throw new DriveError('DRIVE_AUTH', 'Google returned no access token', { status: 500 });
    }
    cachedToken = j.access_token;
    cachedExp = Date.now() + (j.expires_in || 3600) * 1000;
    return cachedToken;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function authHeaders() {
  const token = await refreshAccessToken();
  return { authorization: `Bearer ${token}` };
}

/** JSON request with a single automatic retry after token refresh on 401. */
async function apiJson(method, path, { body, query = '', retry = true } = {}) {
  const headers = await authHeaders();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const url = `${ep('api')}${path}${query}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new DriveError('NETWORK', 'Google Drive network error', { retryable: true });
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401 && retry) {
    await refreshAccessToken(true);
    return apiJson(method, path, { body, query, retry: false });
  }
  if (!res.ok) {
    throw mapApiError(res.status, text, 'DRIVE_ERROR');
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return {}; }
}

/* ── Low-level streaming request (http or https, chosen by URL) ─ */

function streamRequest(urlStr, method, headers) {
  const u = new URL(urlStr);
  const mod = u.protocol === 'http:' ? http : https;
  return mod.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers,
    },
    (res) => res
  );
}

/* ── Folder helpers ───────────────────────────────────────────── */

async function getFolderMeta() {
  return apiJson('GET', `/drive/v3/files/${encodeURIComponent(cfg.google.folderId)}`, {
    query: '?fields=id,name,mimeType&supportsAllDrives=true',
  });
}

/** Returns true if at least one non-trashed file with this exact name exists in the folder. */
async function nameExistsInFolder(name) {
  const q = `'${escapeDriveQuery(cfg.google.folderId)}' in parents and name = '${escapeDriveQuery(name)}' and trashed = false`;
  const data = await apiJson('GET', '/drive/v3/files', {
    query: `?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id)&supportsAllDrives=true`,
  });
  return Array.isArray(data.files) && data.files.length > 0;
}

/* ── Resumable upload sessions ────────────────────────────────── */

async function createResumableSession({ name, mimeType, size, description }) {
  const headers = await authHeaders();
  headers['x-upload-content-type'] = mimeType;
  headers['x-upload-content-length'] = String(size);
  headers['content-type'] = 'application/json; charset=UTF-8';

  const body = JSON.stringify({
    name,
    description,
    parents: [cfg.google.folderId],
  });

  const url = `${ep('upload')}/drive/v3/files?uploadType=resumable&supportsAllDrives=true`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body });
  } catch (e) {
    throw new DriveError('NETWORK', 'cannot reach Google Drive upload endpoint', {
      retryable: true,
    });
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401) {
    await refreshAccessToken(true);
    return createResumableSession({ name, mimeType, size, description });
  }
  if (!res.ok) {
    throw mapApiError(res.status, text, 'DRIVE_ERROR');
  }
  const location = res.headers.get('location');
  if (!location) {
    throw new DriveError('DRIVE_ERROR', 'Google returned no upload session URL', { status: 500 });
  }
  return location;
}

/**
 * Stream one chunk into the resumable session.
 * resolve → { done:true, file } | { done:false, received } where `received` is
 *           parsed from Google's Range header (0 when absent).
 * reject  → DriveError; SESSION_GONE when the session 404s.
 */
function putChunk({ sessionUri, offset, length, total, contentType, stream }) {
  return new Promise((resolve, reject) => {
    const end = offset + length - 1;
    const headers = {
      'content-length': String(length),
      'content-range': `bytes ${offset}-${end}/${total}`,
    };
    if (contentType) headers['content-type'] = contentType;

    let req;
    try {
      req = streamRequest(sessionUri, 'PUT', headers);
    } catch (e) {
      reject(new DriveError('NETWORK', 'bad upload session uri', { retryable: true }));
      return;
    }

    let bodyText = '';
    let settled = false;

    req.on('response', (res) => {
      res.on('data', (d) => { bodyText += d; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (res.statusCode === 200 || res.statusCode === 201) {
          let file = {};
          try { file = JSON.parse(bodyText || '{}'); } catch (e) { /* ignore */ }
          resolve({ done: true, file });
        } else if (res.statusCode === 308) {
          resolve({ done: false, received: parseRangeOffset(res.headers.range) });
        } else {
          const err = mapUploadError(res.statusCode, bodyText);
          err.retryable = res.statusCode >= 500 || res.statusCode === 429;
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new DriveError('NETWORK', 'upload stream to Drive failed', { retryable: true }));
    });

    // If the client disconnects mid-chunk we must not leave the PUT hanging.
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      req.destroy(err);
      reject(new DriveError('NETWORK', 'client stream error', { retryable: true }));
    });
    req.on('close', () => {
      if (!settled && req.destroyed) {
        settled = true;
        reject(new DriveError('NETWORK', 'upload connection closed', { retryable: true }));
      }
    });

    stream.pipe(req);
  });
}

/** Abort (DELETE) an incomplete resumable session. Best-effort, never throws. */
function abortSession(sessionUri) {
  if (!sessionUri) return Promise.resolve();
  return new Promise((resolve) => {
    let req;
    try {
      req = streamRequest(sessionUri, 'DELETE', {});
    } catch (e) {
      resolve();
      return;
    }
    req.on('response', () => resolve());
    req.on('error', () => resolve());
    req.end();
  });
}

/**
 * Ask Drive how many bytes it really holds for a session.
 * resolve → { received } (308) | { done:true, file } (200/201)
 * reject  → DriveError; SESSION_GONE when the session 404s.
 */
function probeSession(sessionUri, total) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = streamRequest(sessionUri, 'PUT', {
        'content-length': '0',
        'content-range': `bytes */${total}`,
      });
    } catch (e) {
      reject(new DriveError('NETWORK', 'bad session uri', { retryable: true }));
      return;
    }
    let bodyText = '';
    let settled = false;
    req.on('response', (res) => {
      res.on('data', (d) => { bodyText += d; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (res.statusCode === 308) {
          resolve({ received: parseRangeOffset(res.headers.range) });
        } else if (res.statusCode === 200 || res.statusCode === 201) {
          let file = {};
          try { file = JSON.parse(bodyText || '{}'); } catch (e) { /* ignore */ }
          resolve({ done: true, file });
        } else {
          reject(mapUploadError(res.statusCode, bodyText));
        }
      });
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        reject(new DriveError('NETWORK', 'probe failed', { retryable: true }));
      }
    });
    req.end();
  });
}

/* ── Listing & metadata ───────────────────────────────────────── */

/**
 * Paginate over folder contents.
 * kinds: 'all' | 'media' (images+videos)
 * returns { files, truncated }
 */
async function listFolderFiles({ cap = 5000, kinds = 'all', fields = '' } = {}) {
  const wanted =
    fields ||
    'files(id,name,mimeType,size,createdTime,description,thumbnailLink,webViewLink),nextPageToken';
  let mimeFilter = '';
  if (kinds === 'media') {
    mimeFilter = " and (mimeType contains 'image/' or mimeType contains 'video/')";
  }
  const baseQ = `'${escapeDriveQuery(cfg.google.folderId)}' in parents and trashed = false${mimeFilter}`;

  const files = [];
  let pageToken = null;
  let truncated = false;

  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      q: baseQ,
      pageSize: '1000',
      orderBy: 'createdTime desc',
      fields: wanted,
      supportsAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await apiJson('GET', '/drive/v3/files', { query: `?${params.toString()}` });
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = data.nextPageToken || null;
    if (!pageToken || files.length >= cap) {
      if (pageToken && files.length >= cap) truncated = true;
      break;
    }
  }
  return { files, truncated };
}

async function getFileMeta(fileId) {
  return apiJson('GET', `/drive/v3/files/${encodeURIComponent(fileId)}`, {
    query: '?fields=id,name,mimeType,parents,size&supportsAllDrives=true',
  });
}

/**
 * Open a range-requestable stream to a Drive file's content.
 * Returns { status, headers, stream, req } where stream is the raw http(s)
 * IncomingMessage. Retries once with a freshly refreshed token on 401.
 */
function openContentStreamOnce(fileId, rangeHeader) {
  return new Promise((resolve, reject) => {
    (async () => {
      const headers = await authHeaders();
      if (rangeHeader) headers.range = rangeHeader;
      const url = `${ep('api')}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const req = streamRequest(url, 'GET', headers);
      req.on('response', (res) => {
        if (res.statusCode === 401) {
          res.resume();
          reject(new DriveError('DRIVE_AUTH', 'auth expired', { status: 500 }));
          return;
        }
        if (res.statusCode === 404) {
          res.resume();
          reject(new DriveError('FILE_NOT_FOUND', 'file not found', { status: 404 }));
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, stream: res, req });
      });
      req.on('error', (e) =>
        reject(new DriveError('NETWORK', 'media stream error', { retryable: true }))
      );
      req.end();
    })().catch(reject);
  });
}

async function openContentStream(fileId, rangeHeader) {
  try {
    return await openContentStreamOnce(fileId, rangeHeader);
  } catch (e) {
    if (e && e.code === 'DRIVE_AUTH') {
      await refreshAccessToken(true);
      return openContentStreamOnce(fileId, rangeHeader);
    }
    throw e;
  }
}

/**
 * Boot check (non-fatal): verifies credentials work AND that the configured
 * destination is really a folder. Surfaces { ok:false, code } otherwise.
 */
async function verifyAccess() {
  try {
    const meta = await getFolderMeta();
    if (meta.mimeType && meta.mimeType !== 'application/vnd.google-apps.folder') {
      logger.error('drive: configured destination is not a Google Drive folder', {
        code: 'NOT_A_FOLDER',
      });
      return { ok: false, code: 'NOT_A_FOLDER', msg: 'GOOGLE_DRIVE_FOLDER_ID is not a folder' };
    }
    logger.info('drive: folder access OK', { folder: meta.name });
    return { ok: true, name: meta.name, code: 'OK' };
  } catch (e) {
    logger.error('drive: folder access check failed', { code: e.code, msg: e.message });
    return { ok: false, code: e.code, msg: e.message };
  }
}

module.exports = {
  DriveError,
  apiJson,
  setEndpoints,
  parseRangeOffset,
  getFolderMeta,
  nameExistsInFolder,
  createResumableSession,
  putChunk,
  probeSession,
  abortSession,
  listFolderFiles,
  getFileMeta,
  openContentStream,
  verifyAccess,
};
