'use strict';

/**
 * Local mock of the Google Drive REST + resumable-upload API, used ONLY by the
 * automated tests. It emulates:
 *   - OAuth token endpoint
 *   - folder / file metadata, folder listing (name & media queries)
 *   - resumable session creation (returns a Location header)
 *   - chunk PUT semantics: 308 + Range until the last byte, then 201 + file
 *   - status probe (a zero-length PUT whose content-range ends with "/total")
 *     and session DELETE
 *   - content download (alt=media) with basic Range support
 *
 * Deterministic fault injection for recovery tests:
 *   mock.nextPutFault = 'http500' | 'http503' | 'network' | { type:'partial', bytes:N }
 * A fault is consumed by the NEXT chunk PUT.
 */

const http = require('http');
const crypto = require('crypto');

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || 'FOLDER_ID_123';

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(body);
}

function fileMeta(f) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    createdTime: f.createdTime,
    description: f.description || '',
    parents: f.parents,
    thumbnailLink: f.thumbnailLink || null,
    webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
  };
}

async function startDriveMock() {
  const files = [];            // completed uploads (Drive's source of truth)
  const sessions = new Map();  // sid -> { committed, total, name, mimeType, description, parents }
  const state = {
    putCount: 0,
    sessionCount: 0,
    nextPutFault: null,
    files: () => files.map(fileMeta),
    sessionsCount: () => sessions.size,
    reset() {
      files.length = 0;
      sessions.clear();
      state.putCount = 0;
      state.sessionCount = 0;
      state.nextPutFault = null;
    },
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    try {
      if (req.method === 'POST' && path === '/token') {
        return json(res, 200, { access_token: 'ya29.MOCK', expires_in: 3600 });
      }

      if (req.method === 'GET' && path === '/drive/v3/files') {
        const q = (u.searchParams.get('q') || '').replace(/\+/g, ' ');
        // name-equality queries (used for unique-name checks)
        const nameMatch = /name = '([^']*)'/.exec(q);
        let result = files;
        if (nameMatch) result = files.filter((f) => f.name === nameMatch[1]);
        // media listing used by the gallery
        const mediaOnly = /mimeType contains '(image|video)\//.test(q);
        if (mediaOnly) {
          result = files.filter((f) => /^(image|video)\//.test(f.mimeType));
        }
        const sorted = [...result].sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1));
        return json(res, 200, { files: sorted.slice(0, 1000).map(fileMeta), nextPageToken: null });
      }

      if (req.method === 'GET' && path.startsWith('/drive/v3/files/')) {
        const fileId = decodeURIComponent(path.slice('/drive/v3/files/'.length));
        const isFolder = fileId === FOLDER_ID;
        if (isFolder) {
          return json(res, 200, {
            id: FOLDER_ID,
            name: 'Mock Tour Folder',
            mimeType: 'application/vnd.google-apps.folder',
          });
        }
        const f = files.find((x) => x.id === fileId);
        if (!f) return json(res, 404, { error: { code: 404, message: 'file not found' } });
        if (u.searchParams.get('alt') === 'media') {
          const range = req.headers.range || null;
          if (!range) {
            res.writeHead(200, {
              'content-type': f.mimeType,
              'content-length': f.buffer.length,
              'accept-ranges': 'bytes',
            });
            return res.end(f.buffer);
          }
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          if (!m) {
            res.writeHead(416, { 'content-range': `bytes */${f.buffer.length}` });
            return res.end();
          }
          const start = parseInt(m[1], 10);
          const end = m[2] === '' ? f.buffer.length - 1 : Math.min(parseInt(m[2], 10), f.buffer.length - 1);
          if (start > end || start >= f.buffer.length) {
            res.writeHead(416, { 'content-range': `bytes */${f.buffer.length}` });
            return res.end();
          }
          res.writeHead(206, {
            'content-type': f.mimeType,
            'content-range': `bytes ${start}-${end}/${f.buffer.length}`,
            'accept-ranges': 'bytes',
            'content-length': end - start + 1,
          });
          return res.end(f.buffer.subarray(start, end + 1));
        }
        return json(res, 200, {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          parents: f.parents,
          description: f.description || '',
        });
      }

      if (req.method === 'POST' && path === '/drive/v3/files' && u.searchParams.get('uploadType') === 'resumable') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const sid = 'sid_' + crypto.randomBytes(8).toString('hex');
        sessions.set(sid, {
          committed: 0,
          total: Number(req.headers['x-upload-content-length']) || 0,
          name: body.name,
          mimeType: body.mimeType || req.headers['x-upload-content-type'] || 'application/octet-stream',
          description: body.description || '',
          parents: Array.isArray(body.parents) ? body.parents : [FOLDER_ID],
        });
        state.sessionCount += 1;
        const { port } = server.address();
        res.writeHead(200, { location: `http://127.0.0.1:${port}/_up/${sid}` });
        return res.end();
      }

      if (path.startsWith('/_up/')) {
        const sid = path.slice('/_up/'.length);
        const session = sessions.get(sid);
        const missing = !session;
        const cr = req.headers['content-range'] || '';
        const rangeMatch = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
        const probe = /bytes \*\/(\d+)/.exec(cr);

        if (missing) {
          await readBody(req).catch(() => {});
          return json(res, 404, { error: { code: 404, message: 'upload session not found' } });
        }

        if (req.method === 'DELETE') {
          await readBody(req).catch(() => {});
          sessions.delete(sid);
          return json(res, 200, {});
        }

        // ── Status probe (PUT with content-range: bytes */T) ──
        if (probe) {
          const total = Number(probe[1]);
          if (session.committed >= total) {
            // Unusual: Google returns the file when a session is already done.
            sessions.delete(sid);
            const f = files.find((x) => x.name === session.name && x.mimeType === session.mimeType && x.size === session.committed);
            return json(res, 201, f ? fileMeta(f) : { id: 'probe_done', name: session.name });
          }
          if (session.committed > 0) {
            return json(res, 308, {}, { range: `bytes=0-${session.committed - 1}` });
          }
          return json(res, 308, {});
        }

        if (!rangeMatch) {
          await readBody(req).catch(() => {});
          return json(res, 400, { error: { code: 400, message: 'invalid content-range' } });
        }

        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        const total = Number(rangeMatch[3]);
        const body = await readBody(req);
        state.putCount += 1;

        if (session.committed !== start && session.committed < total) {
          // Out-of-order write.
          return json(res, 400, { error: { code: 400, message: 'out of order' } });
        }

        const fault = state.nextPutFault;
        state.nextPutFault = null;
        const chunkLen = end - start + 1;

        if (!session.chunks) session.chunks = [];

        /** Drive accepted `acceptedCount` bytes of this chunk — persist them. */
        const accept = (acceptedCount) => {
          session.committed = Math.max(session.committed, start + acceptedCount);
          if (acceptedCount > 0) session.chunks.push(body.subarray(0, acceptedCount));
        };

        // All fault modes below leave the bytes durably "at Drive" — they only
        // change what the client observes (response lost / error / partial).
        if (fault === 'network') {
          accept(chunkLen);
          if (session.committed >= total) register();
          return req.socket.destroy();
        }
        if (fault === 'http500' || fault === 'http503') {
          accept(chunkLen);
          if (session.committed >= total) register();
          const status = fault === 'http500' ? 500 : 503;
          return json(res, status, { error: { code: status, message: 'simulated upstream error' } });
        }
        if (fault && fault.type === 'partial') {
          const keep = Math.max(0, Math.min(fault.bytes, chunkLen));
          accept(keep);
          if (session.committed >= total) {
            register();
            return json(res, 201, fileMeta(files[files.length - 1]));
          }
          if (session.committed > 0) {
            return json(res, 308, {}, { range: `bytes=0-${session.committed - 1}` });
          }
          return json(res, 308, {});
        }

        // Normal in-order chunk.
        accept(chunkLen);
        if (session.committed >= total) {
          register();
          return json(res, 201, fileMeta(files[files.length - 1]));
        }
        if (session.committed > 0) {
          return json(res, 308, {}, { range: `bytes=0-${session.committed - 1}` });
        }
        return json(res, 308, {});

        function register() {
          // Called after completion: persist the file exactly once.
          const existing = files.find((x) => x.sessionSid === sid);
          if (existing) return;
          const f = {
            sessionSid: sid,
            id: 'df_' + crypto.randomBytes(6).toString('hex'),
            name: session.name,
            mimeType: session.mimeType,
            size: session.committed,
            description: session.description || '',
            parents: session.parents,
            createdTime: new Date().toISOString(),
            buffer: Buffer.concat(session.chunks),
          };
          files.push(f);
          sessions.delete(sid);
        }
      }

      return json(res, 404, { error: { code: 404, message: 'no such route ' + req.method + ' ' + path } });
    } catch (e) {
      try { json(res, 500, { error: { code: 500, message: String(e && e.message) } }); } catch (e2) { /* ignore */ }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    state,
    close: () =>
      new Promise((resolve) => {
        try { server.closeAllConnections && server.closeAllConnections(); } catch (e) { /* ignore */ }
        server.close(() => resolve());
        setTimeout(resolve, 1500).unref();
      }),
  };
}

module.exports = { startDriveMock, FOLDER_ID };
