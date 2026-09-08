'use strict';

/* Client-side UploadEngine tests (Node shims — no browser needed).
 * Covers bounded restart on UNKNOWN_UPLOAD / network / no-progress, trust in
 * server-confirmed offsets, and preview (object URL) retention until success,
 * removal or clearing. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Minimal browser shims ───────────────────────────────────────
const sent = [];   // { id, offset } per chunk POST
const handlers = []; // queue of fn(headers) -> outcome
let revokes = 0;
let created = 0;

class FakeURL {
  static createObjectURL() { created += 1; return 'blob:preview'; }
  static revokeObjectURL() { revokes += 1; }
}

class FakeXHR {
  constructor() {
    this.headers = {};
    this.upload = { onprogress: null };
    this.status = 0;
    this.responseText = '';
  }
  static get DONE() { return 4; }
  open(method, url) { this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send() {
    sent.push({ id: this.headers['X-Upload-Id'], offset: Number(this.headers['X-Offset']) });
    const outcome = handlers.length ? handlers.shift() : okChunk(this.headers);
    queueMicrotask(() => {
      if (outcome.kind === 'network') {
        if (this.onerror) this.onerror(new Error('network down'));
        return;
      }
      if (outcome.kind === 'ok') {
        this.status = outcome.status || 200;
        this.responseText = JSON.stringify(outcome.json || {});
        this.readyState = 4;
        if (this.onreadystatechange) this.onreadystatechange();
        return;
      }
      if (outcome.kind === 'http') {
        this.status = outcome.status;
        this.responseText = JSON.stringify({ error: outcome.code });
        this.readyState = 4;
        if (this.onreadystatechange) this.onreadystatechange();
      }
    });
  }
  abort() { /* user/engine abort */ }
}

global.window = globalThis;
global.XMLHttpRequest = FakeXHR;
global.URL = FakeURL;

const CHUNK = 1000;
const SIZE = 2500; // 3 chunks

function makeFile() {
  return {
    name: 'trip.jpg',
    type: 'image/jpeg',
    size: SIZE,
    slice: (a, b) => Buffer.alloc(Math.max(0, b - a), 7),
  };
}

const engineCfg = {
  maxFileBytes: 100 * 1024 * 1024,
  maxFilesPerUpload: 10,
  chunkBytes: CHUNK,
  backoffBaseMs: 1,
  restartDelayMs: 1,
};

function okChunk(headers) {
  const size = Number(headers['X-Total']);
  const offset = Number(headers['X-Offset']);
  const end = Math.min(offset + CHUNK, size);
  if (end >= size) return { kind: 'ok', json: { done: true, file: { id: 'df1' } } };
  return { kind: 'ok', json: { received: end } };
}

function makeEngine() {
  sent.length = 0;
  handlers.length = 0;
  revokes = 0;
  created = 0;
  require('../public/js/upload-engine.js'); // registers createUploadEngine once
  const engine = global.createUploadEngine({
    cfg: engineCfg,
    getToken: () => '',
    getUploader: () => 'Tester',
    onChange: () => {},
    onProgress: () => {},
  });
  const file = makeFile();
  const { added } = engine.addFiles([file]);
  added[0].url = FakeURL.createObjectURL();
  return { engine, entry: added[0] };
}

async function waitDone(engine) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!engine.running && engine.finished) return;
    if (!engine.running && engine.entries.some((e) => e.status === 'error')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('engine did not settle in time');
}

test('engine: normal upload trusts server-confirmed offsets and completes', async () => {
  const { engine, entry } = makeEngine();
  engine.start();
  await waitDone(engine);
  assert.equal(entry.status, 'done');
  assert.equal(entry.sent, SIZE);
  assert.equal(entry.url, null, 'object URL revoked after success');
  assert.equal(revokes, 1);
  assert.equal(sent.length, 3);
});

test('engine: UNKNOWN_UPLOAD restarts the file once with a fresh upload id, then completes', async () => {
  const { engine, entry } = makeEngine();
  handlers.push({ kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' });
  engine.start();
  await waitDone(engine);
  assert.equal(entry.status, 'done');
  assert.equal(entry.attempts, 2, 'exactly one bounded restart');
  assert.equal(sent.length, 1 + 3);
  assert.notEqual(sent[0].id, sent[1].id, 'restart uses a NEW upload id');
});

test('engine: repeated UNKNOWN_UPLOAD is bounded (3 attempts) and ends in a visible error', async () => {
  const { engine, entry } = makeEngine();
  handlers.push(
    { kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' },
    { kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' },
    { kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' }
  );
  engine.start();
  await waitDone(engine);
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorCode, 'UNKNOWN_UPLOAD');
  assert.equal(entry.attempts, 3, 'no infinite restart loop');
  assert.equal(sent.length, 3);
});

test('engine: network interruptions retry with backoff then escalate to a bounded restart', async () => {
  const { engine, entry } = makeEngine();
  handlers.push(
    { kind: 'network' }, { kind: 'network' }, { kind: 'network' } // chunk tries exhausted
  );
  engine.start();
  await waitDone(engine);
  assert.equal(entry.status, 'done');
  assert.equal(entry.attempts, 2, 'escalated to one full restart');
  assert.equal(new Set(sent.map((s) => s.id)).size, 2, 'two upload sessions used');
});

test('engine: repeated zero-progress acks escalate to a bounded restart', async () => {
  const { engine, entry } = makeEngine();
  handlers.push(
    { kind: 'ok', json: { received: 0 } },
    { kind: 'ok', json: { received: 0 } },
    { kind: 'ok', json: { received: 0 } }
  );
  engine.start();
  await waitDone(engine);
  assert.equal(entry.status, 'done');
  assert.equal(entry.attempts, 2);
});

test('engine: preview URL survives failure and is only revoked on remove/clear', async () => {
  const { engine, entry } = makeEngine();
  handlers.push(
    { kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' },
    { kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' },
    { kind: 'http', status: 422, code: 'UNKNOWN_UPLOAD' }
  );
  engine.start();
  await waitDone(engine);
  assert.equal(entry.status, 'error');
  assert.equal(entry.url, 'blob:preview', 'thumbnail stays while the file failed');
  assert.equal(revokes, 0, 'no revocation on failure');

  engine.remove(entry.id);
  assert.equal(revokes, 1, 'revoked on removal');
});
