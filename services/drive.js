'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const logger = require('../utils/logger');
const { cfg } = require('./config');
const site = require('./site');
const { escapeDriveQuery } = require('../utils/sanitize');

/**
 * Minimal Google Drive REST client (no heavy SDK).
 *  - Service-account JWT or OAuth2 refresh-token flow, cached & auto-refreshed.
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

/**
 * Google puts the useful part of a failure in `error.errors[0].reason`, not in
 * the HTTP status: a 403 can equally mean "you may not write here" or "the
 * account that would own this file has no storage quota". Those need different
 * fixes, so they get different codes.
 */
function mapApiError(status, bodyText, fallbackCode) {
  let code = fallbackCode;
  let reason = '';
  let message = bodyText ? String(bodyText).slice(0, 300) : `HTTP ${status}`;
  try {
    const j = JSON.parse(bodyText || '{}');
    if (j.error) {
      const e = j.error;
      const details = Array.isArray(e.errors) ? e.errors[0] : null;
      reason = (details && details.reason) || e.status || '';
      if (e.code === 404) code = 'FOLDER_NOT_FOUND';
      else if (e.code === 403) {
        // A service account owns whatever it creates, and a service account has
        // no Drive storage of its own — so writing into a personal "My Drive"
        // folder fails here even though the folder was shared correctly.
        code = /storageQuotaExceeded|quotaExceeded/i.test(reason)
          ? 'DRIVE_QUOTA'
          : 'DRIVE_PERMISSION';
      } else if (e.code === 401) code = 'DRIVE_AUTH';
      else if (e.code === 429) code = 'DRIVE_RATE_LIMIT';
      else code = 'DRIVE_ERROR';
      if (e.message) message = e.message;
    }
  } catch (e) { /* keep fallback */ }
  const err = new DriveError(code, message, {
    status,
    retryable: status >= 500 || status === 429 || status === 408,
  });
  err.reason = reason;
  return err;
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

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function serviceAccountAssertion(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: cfg.google.scope,
    aud: GOOGLE_TOKEN,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function refreshAccessToken(force = false) {
  if (!force && cachedToken && Date.now() < cachedExp - 60_000) return cachedToken;
  if (inflight) return inflight;
  inflight = (async () => {
    let tokenFields;
    if (cfg.google.serviceAccountJson) {
      let account;
      try { account = JSON.parse(cfg.google.serviceAccountJson); } catch (e) {
        throw new DriveError('DRIVE_AUTH', 'Invalid service account JSON', { status: 500 });
      }
      let assertion;
      try { assertion = serviceAccountAssertion(account); } catch (e) {
        throw new DriveError('DRIVE_AUTH', 'Invalid service account private key', { status: 500 });
      }
      tokenFields = {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      };
    } else {
      tokenFields = {
        client_id: cfg.google.clientId,
        client_secret: cfg.google.clientSecret,
        refresh_token: cfg.google.refreshToken,
        grant_type: 'refresh_token',
      };
    }
    const body = new URLSearchParams(tokenFields).toString();
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

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function getFolderMeta() {
  return apiJson('GET', `/drive/v3/files/${encodeURIComponent(cfg.google.folderId)}`, {
    query: '?fields=id,name,mimeType&supportsAllDrives=true',
  });
}

/* ── Media / category sub-folders ────────────────────────────── */

// Sub-folder ids are resolved lazily and cached by folder NAME. The legacy
// "Photos" / "Videos" names keep working as before; extra category folders
// (e.g. "Group Photos") join the map the first time they are needed.
const folderIdCache = new Map();   // folder name → Drive folder id
const folderInflight = new Map();  // folder name → in-flight resolution promise

// Legacy view over the two media folders: { photos, videos } or null.
let mediaFolders = null;
let ensureMediaInflight = null;

/** Resolve one sub-folder by name (create it when missing), cached. */
function ensureSubFolder(name) {
  if (!name) return Promise.resolve(null);
  if (folderIdCache.has(name)) return Promise.resolve(folderIdCache.get(name));
  if (folderInflight.has(name)) return folderInflight.get(name);
  const p = resolveChildFolder(name)
    .then((id) => {
      folderIdCache.set(name, id);
      return id;
    })
    .finally(() => {
      folderInflight.delete(name);
    });
  folderInflight.set(name, p);
  return p;
}

async function findChildFolder(name) {
  const q =
    `'${escapeDriveQuery(cfg.google.folderId)}' in parents and ` +
    `name = '${escapeDriveQuery(name)}' and ` +
    `mimeType = '${FOLDER_MIME}' and trashed = false`;
  const data = await apiJson('GET', '/drive/v3/files', {
    query: `?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id,name)&supportsAllDrives=true`,
  });
  const hit = Array.isArray(data.files) ? data.files[0] : null;
  return (hit && hit.id) || null;
}

async function createChildFolder(name) {
  const data = await apiJson('POST', '/drive/v3/files', {
    query: '?fields=id&supportsAllDrives=true',
    body: { name, mimeType: FOLDER_MIME, parents: [cfg.google.folderId] },
  });
  if (!data || !data.id) {
    throw new DriveError('DRIVE_ERROR', 'could not create sub-folder', { status: 500 });
  }
  return data.id;
}

async function resolveChildFolder(name) {
  const found = await findChildFolder(name);
  if (found) return found;
  return createChildFolder(name);
}

/**
 * Make sure the two legacy media sub-folders ("Photos" / "Videos") exist and
 * return their ids. Never throws: if Drive is unhappy we fall back to the root
 * folder so an upload is never blocked by folder housekeeping.
 */
async function ensureMediaFolders() {
  if (!cfg.google.separateMediaFolders) return null;
  if (mediaFolders) return mediaFolders;
  if (ensureMediaInflight) return ensureMediaInflight;
  ensureMediaInflight = (async () => {
    try {
      const photos = await ensureSubFolder(cfg.google.photosFolderName);
      const videos = await ensureSubFolder(cfg.google.videosFolderName);
      mediaFolders = { photos, videos };
      logger.info('drive: media sub-folders ready', { photos, videos });
      return mediaFolders;
    } catch (e) {
      logger.warn('drive: could not prepare media sub-folders, using the root folder', {
        code: e && e.code,
      });
      return null;
    } finally {
      ensureMediaInflight = null;
    }
  })();
  return ensureMediaInflight;
}

/**
 * Make sure a folder exists for every active upload category (single / group /
 * video) and return [{ id, category }]. Used by listings so the gallery sees
 * files in every category folder, and by the admin dashboard for folder links.
 */
async function ensureAllCategoryFolders() {
  if (!cfg.google.separateMediaFolders) return [];
  const out = [];
  for (const category of site.categories) {
    if (!category || !category.folder) continue;
    try {
      const id = await ensureSubFolder(category.folder);
      out.push({ id, category });
    } catch (e) {
      logger.warn('drive: could not prepare category folder', {
        name: category.folder,
        code: e && e.code,
      });
    }
  }
  return out;
}

/** Destination folder id for one upload, based on its MIME type. */
async function folderIdForMime(mimeType) {
  const folders = await ensureMediaFolders();
  if (!folders) return cfg.google.folderId;
  const m = String(mimeType || '').toLowerCase();
  if (m.startsWith('video/')) return folders.videos;
  if (m.startsWith('image/')) return folders.photos;
  return cfg.google.folderId;
}

/**
 * Destination folder for one upload. A visitor-chosen category wins; when it is
 * absent (or folder routing is disabled — flat mode) we fall back to the
 * MIME-based Photos / Videos routing.
 */
async function folderIdForCategory(category, mimeType) {
  if (category && category.folder && cfg.google.separateMediaFolders) {
    try {
      return await ensureSubFolder(category.folder);
    } catch (e) {
      logger.warn('drive: category folder lookup failed, using mime routing', {
        name: category.folder,
        code: e && e.code,
      });
    }
  }
  return folderIdForMime(mimeType);
}

/** Every folder a gallery/admin file is allowed to live in. */
function allowedParents() {
  const ids = new Set([cfg.google.folderId]);
  if (cfg.google.separateMediaFolders) {
    for (const id of folderIdCache.values()) {
      if (id) ids.add(id);
    }
  }
  return Array.from(ids).filter(Boolean);
}

/** Test/dev hook: forget the resolved sub-folder ids. */
function resetFolderCache() {
  folderIdCache.clear();
  folderInflight.clear();
  mediaFolders = null;
  ensureMediaInflight = null;
  settingsFileId = null;
}

/** Returns true if at least one non-trashed file with this exact name exists. */
async function nameExistsInFolder(name, parentId) {
  const parent = parentId || cfg.google.folderId;
  const q = `'${escapeDriveQuery(parent)}' in parents and name = '${escapeDriveQuery(name)}' and trashed = false`;
  const data = await apiJson('GET', '/drive/v3/files', {
    query: `?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id)&supportsAllDrives=true`,
  });
  return Array.isArray(data.files) && data.files.length > 0;
}

/* ── Resumable upload sessions ────────────────────────────────── */

async function createResumableSession({ name, mimeType, size, description, parentId, retry = true }) {
  const headers = await authHeaders();
  headers['x-upload-content-type'] = mimeType;
  headers['x-upload-content-length'] = String(size);
  headers['content-type'] = 'application/json; charset=UTF-8';

  const body = JSON.stringify({
    name,
    description,
    parents: [parentId || cfg.google.folderId],
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
  if (res.status === 401 && retry) {
    // Bounded: exactly one retry with a freshly minted token, never a loop.
    await refreshAccessToken(true);
    return createResumableSession({ name, mimeType, size, description, parentId, retry: false });
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
  // Files uploaded before sub-folders existed still live in the root folder,
  // so every listing spans the root AND all media/category sub-folders.
  await ensureMediaFolders().catch(() => null);
  await ensureAllCategoryFolders().catch(() => null);
  const parentsClause = allowedParents()
    .map((id) => `'${escapeDriveQuery(id)}' in parents`)
    .join(' or ');
  const baseQ =
    `(${parentsClause}) and trashed = false and mimeType != '${FOLDER_MIME}'${mimeFilter}`;

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
  // The settings file lives in the same folder but is not tour content.
  const visible = files.filter((f) => f.name !== SETTINGS_FILE);
  if (visible.length > cap) {
    truncated = true;
    visible.length = cap;
  }
  return { files: visible, truncated };
}

/** List the files sitting directly in one folder (no sub-folder contents). */
async function listFilesInFolder(folderId, { cap = 2000 } = {}) {
  const q =
    `'${escapeDriveQuery(folderId)}' in parents and trashed = false and ` +
    `mimeType != '${FOLDER_MIME}'`;
  const files = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      q,
      pageSize: '1000',
      fields: 'files(id,name,mimeType),nextPageToken',
      supportsAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await apiJson('GET', '/drive/v3/files', { query: `?${params.toString()}` });
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = data.nextPageToken || null;
    if (!pageToken || files.length >= cap) break;
  }
  return files.filter((f) => f.name !== SETTINGS_FILE).slice(0, cap);
}

/** Re-parent one file: a Drive move is an add + remove of parents. */
async function moveFile(fileId, { from, to }) {
  const params = new URLSearchParams({
    addParents: to,
    removeParents: from,
    fields: 'id,parents',
    supportsAllDrives: 'true',
  });
  return apiJson('PATCH', `/drive/v3/files/${encodeURIComponent(fileId)}`, {
    query: `?${params.toString()}`,
    body: {},
  });
}

/* ── Durable settings file (survives Railway redeploys) ───────── */

/**
 * Railway wipes the container disk on every redeploy, so admin-edited content
 * is kept in a small JSON file inside the tour's own Drive folder. It is hidden
 * from every listing above.
 */
const SETTINGS_FILE = '.tour-hub-settings.json';
let settingsFileId = null;

async function findSettingsFile() {
  if (settingsFileId) return settingsFileId;
  const q =
    `'${escapeDriveQuery(cfg.google.folderId)}' in parents and ` +
    `name = '${escapeDriveQuery(SETTINGS_FILE)}' and trashed = false`;
  const data = await apiJson('GET', '/drive/v3/files', {
    query: `?q=${encodeURIComponent(q)}&pageSize=1&fields=files(id)&supportsAllDrives=true`,
  });
  const hit = Array.isArray(data.files) ? data.files[0] : null;
  settingsFileId = (hit && hit.id) || null;
  return settingsFileId;
}

/** Read the saved settings object, or null when nothing has been saved yet. */
async function readSettingsFile() {
  const id = await findSettingsFile();
  if (!id) return null;
  const headers = await authHeaders();
  const url = `${ep('api')}/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new DriveError('NETWORK', 'could not read settings file', { retryable: true });
  }
  if (res.status === 404) {
    settingsFileId = null;
    return null;
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw mapApiError(res.status, text, 'DRIVE_ERROR');
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** Create or overwrite the settings file. Small JSON, single media upload. */
async function writeSettingsFile(obj, retry = true) {
  let id = await findSettingsFile();
  if (!id) {
    const created = await apiJson('POST', '/drive/v3/files', {
      query: '?fields=id&supportsAllDrives=true',
      body: { name: SETTINGS_FILE, parents: [cfg.google.folderId], mimeType: 'application/json' },
    });
    id = created && created.id;
    if (!id) throw new DriveError('DRIVE_ERROR', 'could not create settings file', { status: 500 });
    settingsFileId = id;
  }
  const headers = await authHeaders();
  headers['content-type'] = 'application/json';
  const url = `${ep('upload')}/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true`;
  let res;
  try {
    res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(obj, null, 2) });
  } catch (e) {
    throw new DriveError('NETWORK', 'could not save settings file', { retryable: true });
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 404) {
      // Someone deleted it — forget the id and recreate it once.
      settingsFileId = null;
      if (retry) return writeSettingsFile(obj, false);
    }
    throw mapApiError(res.status, text, 'DRIVE_ERROR');
  }
  return true;
}

async function getFileMeta(fileId) {
  return apiJson('GET', `/drive/v3/files/${encodeURIComponent(fileId)}`, {
    query: '?fields=id,name,mimeType,parents,size,thumbnailLink&supportsAllDrives=true',
  });
}

/**
 * Fetch a Drive-generated thumbnail as a Buffer.
 * Drive's `thumbnailLink` is NOT publicly readable for files in a private
 * folder, so the browser can never load it directly — the server fetches it
 * with the access token and serves the bytes itself.
 * Returns null when Drive has no usable thumbnail (some HEIC files, etc.).
 */
async function fetchThumbnail(thumbnailLink, size = 640) {
  if (!thumbnailLink) return null;
  const url = String(thumbnailLink).replace(/=s\d+(-c)?$/, `=s${size}`);
  const headers = await authHeaders();
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || 'image/jpeg';
  if (!type.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? { buffer: buf, contentType: type } : null;
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
    // Prepare the Photos / Videos sub-folders up front (best effort).
    const folders = await ensureMediaFolders().catch(() => null);
    return { ok: true, name: meta.name, code: 'OK', mediaFolders: !!folders };
  } catch (e) {
    logger.error('drive: folder access check failed', {
      code: e.code, reason: e.reason || '', msg: e.message,
    });
    return { ok: false, code: e.code, reason: e.reason || '', msg: e.message };
  }
}

/**
 * Ask Drive the question that actually matters: "can this account create a
 * file here?" A resumable session is opened for a tiny placeholder and then
 * aborted, so nothing is ever stored — but permission and storage-quota
 * failures surface with Google's own reason string.
 */
async function testWrite() {
  const parentId = await folderIdForMime('image/jpeg').catch(() => cfg.google.folderId);
  let sessionUri;
  try {
    sessionUri = await createResumableSession({
      name: `.tour-upload-hub-write-test-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      size: 3,
      description: '',
      parentId,
    });
  } catch (e) {
    logger.warn('drive: write test failed', { code: e.code, reason: e.reason || '' });
    return { ok: false, code: e.code, reason: e.reason || '', msg: e.message };
  }
  await abortSession(sessionUri);
  return { ok: true, code: 'OK', parentId };
}

module.exports = {
  DriveError,
  testWrite,
  apiJson,
  setEndpoints,
  parseRangeOffset,
  getFolderMeta,
  ensureMediaFolders,
  ensureAllCategoryFolders,
  folderIdForCategory,
  folderIdForMime,
  allowedParents,
  resetFolderCache,
  nameExistsInFolder,
  fetchThumbnail,
  createResumableSession,
  putChunk,
  probeSession,
  abortSession,
  listFolderFiles,
  listFilesInFolder,
  moveFile,
  readSettingsFile,
  writeSettingsFile,
  SETTINGS_FILE,
  getFileMeta,
  openContentStream,
  verifyAccess,
};
