'use strict';

/**
 * UploadEngine — chunked, resumable client uploader.
 *
 * Design:
 *  - Files are split into chunks and POSTed one at a time with
 *    X-Upload-Id / X-Offset so the server can stream each chunk straight into
 *    a Google Drive resumable session (no whole file is ever in memory).
 *  - The server always answers with the byte offset **Google confirmed**
 *    (from the resumable Range header), never a guess. The client continues
 *    from that confirmed offset — so a chunk Google partially accepted is
 *    resumed, not re-sent from zero.
 *  - Transient chunk failures (network, stall, 503 "uncertain") are retried
 *    with exponential backoff. Only when the server session is really gone
 *    (UNKNOWN_UPLOAD / OUT_OF_ORDER) — or after bounded local retries — is the
 *    whole file restarted with a fresh upload id.
 *  - All retry/restart attempts are bounded; a file is never marked complete
 *    unless the server confirms Google returned a file id.
 *  - Object URLs (thumbnails) are revoked only after success/removal/clear —
 *    NOT when a file starts or fails — so previews stay visible while pending
 *    or uploading.
 *  - Two files run in parallel by default; one file never blocks the batch.
 */

(function (global) {
  const ALLOWED = {
    jpg: 1, jpeg: 1, png: 1, webp: 1, gif: 1, heic: 1, heif: 1, bmp: 1,
    mp4: 1, mov: 1, m4v: 1, '3gp': 1, '3g2': 1,
  };

  const MAX_FILE_ATTEMPTS = 3;   // full-file restarts after session loss
  const MAX_CHUNK_TRIES = 3;     // per-chunk retries for transient failures
  const MAX_ZERO_PROGRESS = 2;   // identical-ack answers before escalation

  // Self-contained: never rely on helpers from other scripts (common.js).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const newId = () =>
    (global.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12));

  function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /** Server-style preflight check (mirrors utils/sanitize.js rules). */
  function validateFile(file, cfg) {
    const ext = extOf(file.name);
    if (!ALLOWED[ext]) return { ok: false, code: 'INVALID_TYPE' };
    if (file.size <= 0) return { ok: false, code: 'EMPTY_FILE' };
    if (file.size > cfg.maxFileBytes) return { ok: false, code: 'FILE_TOO_LARGE' };
    return { ok: true };
  }

  function createUploadEngine({ cfg, getToken, getUploader, onChange, onProgress }) {
    const state = {
      entries: [],   // {id,name,size,type,status,pct,sent,errorCode,attempts,url,uploadId,file}
      running: false,
      finished: false,
    };

    function notify() { if (typeof onChange === 'function') onChange(state); }

    function entry(id) { return state.entries.find((e) => e.id === id); }

    /** Bounded "restart the whole file with a fresh session" error. */
    function restartError() {
      const err = new Error('SESSION_LOST');
      err.code = 'SESSION_LOST';
      err.status = 503;
      err.retryable = true;
      return err;
    }

    /** Errors that mean "stop this file, tell the user" (no auto restart). */
    function isFileFatal(err) {
      return [
        'PIN_REQUIRED', 'INVALID_PIN', 'UPLOADS_DISABLED', 'FILE_TOO_LARGE',
        'INVALID_TYPE', 'INVALID_NAME', 'EMPTY_FILE', 'INVALID_FILE_CONTENT',
        'BAD_REQUEST', 'LENGTH_REQUIRED', 'NO_FILES', 'DRIVE_FOLDER_NOT_FOUND',
        'DRIVE_PERMISSION', 'DRIVE_AUTH', 'NOT_FOUND', 'RATE_LIMITED',
        'TOO_MANY_UPLOADS', 'UPLOAD_CAPACITY',
      ].includes(err.code);
    }

    /** Errors that mean the server session is gone — restart the file. */
    function isRestartTrigger(err) {
      return err && (
        err.code === 'UNKNOWN_UPLOAD' ||
        err.code === 'OUT_OF_ORDER' ||
        err.code === 'SESSION_LOST'
      );
    }

    function addFiles(fileList) {
      const added = [];
      const rejected = [];
      const current = state.entries.length;
      const room = Math.max(0, cfg.maxFilesPerUpload - current);

      for (const file of Array.from(fileList || [])) {
        if (room > 0 && added.length >= room) {
          rejected.push({ name: file.name, code: 'TOO_MANY_FILES' });
          continue;
        }
        const v = validateFile(file, cfg);
        if (!v.ok) { rejected.push({ name: file.name, code: v.code }); continue; }
        const isVideo = (file.type || '').startsWith('video/');
        added.push({
          id: newId(),
          file,
          name: file.name,
          size: file.size,
          type: isVideo ? 'video' : 'image',
          status: 'pending',   // pending | uploading | done | error
          pct: 0,
          sent: 0,
          errorCode: null,
          attempts: 0,
          url: null,
          uploadId: null,
        });
      }
      state.entries.push(...added);
      if (added.length) state.finished = false;
      notify();
      return { added, rejected };
    }

    function remove(id) {
      const e = entry(id);
      if (!e) return;
      if (e.xhr) { try { e.xhr.abort(); } catch (err) { /* ignore */ } }
      if (e.url) { try { URL.revokeObjectURL(e.url); e.url = null; } catch (err) { /* ignore */ } }
      if (e.uploadId && (e.status === 'uploading' || e.status === 'pending')) {
        // tell the server to abort its Drive session (best effort)
        apiCancel(e.uploadId).catch(() => {});
      }
      state.entries = state.entries.filter((x) => x.id !== id);
      notify();
    }

    function clearFinished() {
      for (const e of state.entries) {
        if (e.status === 'done' && e.url) { try { URL.revokeObjectURL(e.url); e.url = null; } catch (err) { /* ignore */ } }
      }
      state.entries = state.entries.filter((e) => e.status !== 'done');
      if (!state.entries.length) state.finished = false;
      notify();
    }

    function clearAll() {
      for (const e of state.entries) {
        if (e.xhr) { try { e.xhr.abort(); } catch (err) { /* ignore */ } }
        if (e.url) { try { URL.revokeObjectURL(e.url); e.url = null; } catch (err) { /* ignore */ } }
        if (e.uploadId && e.status === 'uploading') apiCancel(e.uploadId).catch(() => {});
      }
      state.entries = [];
      state.running = false;
      state.finished = false;
      notify();
    }

    function anyIncomplete() {
      return state.entries.some((e) => e.status === 'pending' || e.status === 'uploading' || e.status === 'error');
    }

    /* ── HTTP ───────────────────────────────────────────────── */

    function xhrSend(url, { headers, body, onProgress }) {
      let xhr;
      const promise = new Promise((resolve, reject) => {
        let settled = false;
        let stallTimer = null;
        const done = (fn, arg) => {
          if (settled) return;
          settled = true;
          clearTimeout(stallTimer);
          fn(arg);
        };
        const armWatchdog = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (!settled) {
              try { xhr.abort(); } catch (e) { /* ignore */ }
              const err = new Error('STALLED');
              err.code = 'STALLED';
              err.status = 0;
              err.retryable = true;
              done(reject, err);
            }
          }, 120000);
        };

        xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        for (const [k, v] of Object.entries(headers || {})) {
          if (v !== undefined && v !== null) xhr.setRequestHeader(k, v);
        }
        xhr.responseType = 'text';
        xhr.upload.onprogress = (ev) => {
          armWatchdog();
          if (onProgress && ev.lengthComputable) onProgress(ev.loaded);
        };
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== XMLHttpRequest.DONE || settled) return;
          clearTimeout(stallTimer);
          settled = true;
          let data = null;
          try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* ignore */ }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ status: xhr.status, data });
            return;
          }
          const err = new Error((data && data.error) || ('HTTP_' + xhr.status));
          err.status = xhr.status;
          err.code = (data && data.error) || err.message;
          err.retryable =
            err.status >= 500 || err.status === 429 || err.code === 'NETWORK';
          reject(err);
        };
        xhr.onerror = () => {
          const err = new Error('NETWORK');
          err.status = 0;
          err.code = 'NETWORK';
          err.retryable = true;
          done(reject, err);
        };
        xhr.onabort = () => {
          const err = new Error('ABORTED');
          err.status = 0;
          err.code = 'ABORTED';
          err.retryable = false;
          done(reject, err);
        };
        armWatchdog();
        xhr.send(body);
      });
      promise.abort = () => {
        try { if (xhr) xhr.abort(); } catch (e) { /* ignore */ }
      };
      return promise;
    }

    function apiCancel(uploadId) {
      try {
        return fetch('/api/upload/cancel', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Upload-Token': getToken() || '',
          },
          body: JSON.stringify({ uploadId }),
        }).catch(() => {});
      } catch (e) {
        return Promise.resolve(); // relative URL unavailable (non-browser envs)
      }
    }

    /* ── Upload pipeline ────────────────────────────────────── */

    function run(entryRef) {
      const e = entryRef;
      e.status = 'uploading';
      e.errorCode = null;
      e.pct = 0;
      e.sent = 0;
      notify();
      uploadFile(e).then(
        () => {
          e.status = 'done';
          e.pct = 100;
          e.sent = e.size;
          // Revoke the preview only after Drive confirmed the file.
          if (e.url) { try { URL.revokeObjectURL(e.url); e.url = null; } catch (err) { /* ignore */ } }
          notify();
        },
        (err) => {
          // Keep the object URL on failure — the thumbnail must stay visible and
          // the file remains available for "আবার চেষ্টা করুন".
          e.status = 'error';
          e.errorCode = (err && err.code) || 'FAILED';
          notify();
        }
      );
    }

    async function uploadFile(e) {
      while (true) {
        e.attempts += 1;
        try {
          await uploadFileOnce(e);
          return;
        } catch (err) {
          if (isRestartTrigger(err) && e.attempts < MAX_FILE_ATTEMPTS) {
            const oldId = e.uploadId;
            if (oldId) apiCancel(oldId).catch(() => {}); // clean the orphaned server session
            const delay = ((cfg && cfg.restartDelayMs) || 800) * e.attempts;
            await sleep(delay);
            continue; // uploadFileOnce allocates a fresh upload id
          }
          throw err;
        }
      }
    }

    async function uploadFileOnce(e) {
      e.uploadId = newId();
      const uploader = (getUploader && getUploader()) || '';
      let offset = 0;
      let zeroProgress = 0;

      while (offset < e.size) {
        const end = Math.min(offset + cfg.chunkBytes, e.size);
        const chunk = e.file.slice(offset, end);
        const headers = {
          'X-Upload-Id': e.uploadId,
          'X-Offset': String(offset),
          'X-Total': String(e.size),
          'X-File-Name': encodeURIComponent(e.file.name),
          'X-Mime': e.file.type || '',
          'X-Uploader': encodeURIComponent(uploader),
          'X-Upload-Token': getToken() || '',
        };
        const result = await sendChunkRetry(e, chunk, headers, offset);

        if (result && result.done) {
          offset = e.size;
          e.sent = e.size;
          e.pct = 100;
          notify();
          return;
        }

        // Continue ONLY from the offset the server confirmed (Drive Range),
        // never blindly from offset + chunkLength.
        const recv = result && Number(result.received);
        let next;
        if (Number.isFinite(recv) && recv > offset) {
          next = Math.min(recv, e.size); // partial / resumed — Drive truth
        } else if (Number.isFinite(recv) && recv === offset) {
          // Server confirms zero new bytes for this chunk — resend the same
          // chunk; escalate to a bounded restart after repeated no-progress.
          zeroProgress += 1;
          if (zeroProgress > MAX_ZERO_PROGRESS) throw restartError();
          next = offset;
        } else {
          next = end; // legacy fallback (server always echoes received/done)
        }
        if (next === offset) continue; // resend the same chunk (no progress yet)
        zeroProgress = 0;
        offset = next;
        e.sent = offset;
        e.pct = Math.min(100, Math.round((offset / e.size) * 100));
        notify();
      }
    }

    async function sendChunkRetry(e, chunk, headers, offset) {
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_CHUNK_TRIES; attempt++) {
        const req = xhrSend('/api/upload/chunk', {
          headers,
          body: chunk,
          onProgress: (loaded) => {
            // Live per-file progress during the chunk transfer.
            if (loaded > 0) {
              e.sent = Math.min(e.size, offset + loaded);
              e.pct = Math.min(100, Math.round((e.sent / e.size) * 100));
            }
            if (onProgress) onProgress();
          },
        });
        e.xhr = req;
        try {
          const res = await req;
          e.xhr = null;
          return res.data || {};
        } catch (err) {
          e.xhr = null;
          lastErr = err;
          if (err.code === 'ABORTED') throw err;           // user cancelled
          if (isFileFatal(err)) throw err;                 // terminal per-file error
          if (isRestartTrigger(err)) throw err;            // restart whole file now
          if (err.code === 'STALLED' || err.code === 'NETWORK' || err.retryable) {
            if (attempt < MAX_CHUNK_TRIES) {
              const base = (cfg && cfg.backoffBaseMs) || 500;
              await sleep(Math.min(4000, base * Math.pow(2, attempt))); // exponential backoff
              continue;
            }
            // Chunk retries exhausted on a transient error — escalate to a
            // bounded full-file restart with a fresh upload session.
            throw restartError();
          }
          throw err;
        }
      }
      throw lastErr;
    }

    /* ── Scheduler: up to 2 files in parallel ───────────────── */

    const PARALLEL = 2;

    function start() {
      if (state.running) return false;
      // Only entries that are actually queued count — a failed entry becomes
      // eligible when retry() puts it back to 'pending', so counting it here
      // would spin up a worker with nothing to do and fire a spurious
      // "batch finished" (with its banner) straight away.
      const pending = state.entries.filter((e) => e.status === 'pending');
      if (!pending.length) return false;
      state.running = true;
      state.finished = false;
      notify();

      const worker = async () => {
        while (true) {
          const next = state.entries.find((e) => e.status === 'pending' && !e.claimed);
          if (!next) break;
          next.claimed = true;
          run(next);
          // Wait until this entry leaves the uploading state
          await new Promise((resolve) => {
            const tick = () => {
              const en = entry(next.id);
              if (!en || en.status === 'done' || en.status === 'error') resolve();
              else setTimeout(tick, 250);
            };
            setTimeout(tick, 250);
          });
        }
      };

      // run min(PARALLEL, pending) workers
      const workers = [];
      for (let i = 0; i < Math.min(PARALLEL, pending.length); i++) {
        workers.push(worker());
      }
      Promise.all(workers).then(() => {
        state.running = false;
        state.finished = true;
        for (const e of state.entries) delete e.claimed;
        notify();
      });
      return true;
    }

    function retry(id) {
      const e = entry(id);
      if (!e || e.status !== 'error') return;
      e.status = 'pending';
      e.errorCode = null;
      e.pct = 0;
      e.sent = 0;
      e.attempts = 0;
      e.uploadId = null;
      e.claimed = false;
      notify();
    }

    return {
      addFiles,
      remove,
      retry,
      clearFinished,
      clearAll,
      start,
      anyIncomplete,
      get entries() { return state.entries; },
      get running() { return state.running; },
      get finished() { return state.finished; },
      getToken,
      validateFile,
    };
  }

  global.createUploadEngine = createUploadEngine;
})(window);
