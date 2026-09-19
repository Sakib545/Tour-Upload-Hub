'use strict';

/* Client-side UploadEngine duplicate detection (Node shims — no browser).
 * Covers: an already-uploaded file is skipped without sending a byte, a new
 * file still uploads, a second copy in the same batch is caught locally, and a
 * failing / hanging precheck never blocks the upload. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sent = [];        // { id, offset, sig } per chunk POST
let prechecks = [];     // signature batches the engine asked about
let knownSigs = {};     // what the fake server answers with
let precheckMode = 'ok'; // ok | fail | hang
let failNames = new Set(); // file names the fake server refuses

class FakeURL {
  static createObjectURL() { return 'blob:preview'; }
  static revokeObjectURL() { /* counted elsewhere */ }
}

const CHUNK = 1000;
const SIZE = 2500; // 3 chunks

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
    const offset = Number(this.headers['X-Offset']);
    const name = decodeURIComponent(this.headers['X-File-Name'] || '');
    sent.push({ id: this.headers['X-Upload-Id'], offset, sig: this.headers['X-File-Sig'], name });
    const size = Number(this.headers['X-Total']);
    const end = Math.min(offset + CHUNK, size);
    const refuse = failNames.has(name);
    queueMicrotask(() => {
      if (refuse) {
        // A per-file fatal error: no retries, no restart.
        this.status = 415;
        this.responseText = JSON.stringify({ error: 'INVALID_FILE_CONTENT' });
      } else {
        this.status = 200;
        this.responseText = JSON.stringify(
          end >= size ? { done: true, file: { id: 'df1' } } : { received: end }
        );
      }
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
    });
  }
  abort() { /* no-op */ }
}

global.window = globalThis;
global.XMLHttpRequest = FakeXHR;
global.URL = FakeURL;

// The engine talks to /api/upload/precheck with fetch; answer it locally.
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/upload/precheck')) {
    const body = JSON.parse((opts && opts.body) || '{}');
    prechecks.push(body.sigs || []);
    if (precheckMode === 'fail') throw new Error('offline');
    if (precheckMode === 'hang') return new Promise(() => {}); // never settles
    const known = {};
    for (const s of body.sigs || []) {
      if (knownSigs[s]) known[s] = { name: knownSigs[s] };
    }
    return { ok: true, json: async () => ({ known }) };
  }
  return { ok: true, json: async () => ({}) };
};

function makeFile(name = 'trip.jpg', fill = 7) {
  return {
    name,
    type: 'image/jpeg',
    size: SIZE,
    lastModified: 1700000000000 + fill,
    // A real Blob slice; the engine reads head/tail through arrayBuffer().
    slice: (a, b) => new Blob([Buffer.alloc(Math.max(0, b - a), fill)]),
  };
}

const engineCfg = {
  maxFileBytes: 100 * 1024 * 1024,
  maxFilesPerUpload: 10,
  chunkBytes: CHUNK,
  backoffBaseMs: 1,
  restartDelayMs: 1,
  dedupe: true,
};

function makeEngine(files) {
  sent.length = 0;
  prechecks = [];
  failNames = new Set();
  require('../public/js/upload-engine.js');
  const engine = global.createUploadEngine({
    cfg: engineCfg,
    getToken: () => '',
    getUploader: () => 'Tester',
    onChange: () => {},
    onProgress: () => {},
  });
  const { added } = engine.addFiles(files);
  return { engine, added };
}

async function waitDone(engine) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!engine.running && engine.finished) return;
    if (!engine.running && engine.entries.some((e) => e.status === 'error')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('engine did not settle in time');
}

test('engine: a file already in Drive is skipped without sending a byte', async () => {
  precheckMode = 'ok';
  knownSigs = {};
  // Learn the signature this file produces, then pretend Drive already has it.
  const probe = makeEngine([makeFile('sunset.jpg', 9)]);
  probe.engine.start();
  await waitDone(probe.engine);
  const sig = probe.added[0].sig;
  assert.ok(sig, 'a signature was computed');
  assert.equal(sent.length, 3, 'first time it really uploads');

  knownSigs = { [sig]: 'sunset.jpg' };
  const { engine, added } = makeEngine([makeFile('sunset.jpg', 9)]);
  engine.start();
  await waitDone(engine);

  assert.equal(added[0].status, 'done');
  assert.equal(added[0].duplicate, true);
  assert.equal(added[0].duplicateOf, 'sunset.jpg');
  assert.equal(added[0].pct, 100);
  assert.equal(sent.length, 0, 'not one chunk left the device');
  assert.deepEqual(prechecks, [[sig]]);
});

test('engine: an unseen file still uploads, and carries its signature', async () => {
  precheckMode = 'ok';
  knownSigs = { deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef: 'other.jpg' };
  const { engine, added } = makeEngine([makeFile('new.jpg', 3)]);
  engine.start();
  await waitDone(engine);

  assert.equal(added[0].status, 'done');
  assert.ok(!added[0].duplicate);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].sig, added[0].sig, 'signature travels with the chunks');
});

test('engine: the same file picked twice in one batch is only sent once', async () => {
  precheckMode = 'ok';
  knownSigs = {};
  const { engine, added } = makeEngine([makeFile('same.jpg', 5), makeFile('same.jpg', 5)]);
  engine.start();
  await waitDone(engine);

  const dups = added.filter((e) => e.duplicate);
  assert.equal(dups.length, 1, 'exactly one copy was recognised as a duplicate');
  assert.equal(added.filter((e) => e.status === 'done').length, 2);
  assert.equal(sent.length, 3, 'only one file worth of chunks');
});

test('engine: a broken or hanging precheck never blocks the upload', async () => {
  for (const mode of ['fail', 'hang']) {
    precheckMode = mode;
    knownSigs = {};
    const { engine, added } = makeEngine([makeFile('resilient.jpg', 4)]);
    engine.start();
    await waitDone(engine);
    assert.equal(added[0].status, 'done', `mode ${mode}`);
    assert.ok(!added[0].duplicate, `mode ${mode}`);
    assert.equal(sent.length, 3, `mode ${mode}: uploaded anyway`);
  }
  precheckMode = 'ok';
});

test('engine: a whole batch costs one precheck request, not one per file', async () => {
  precheckMode = 'ok';
  knownSigs = {};
  const files = [1, 2, 3, 4, 5].map((n) => makeFile(`batch-${n}.jpg`, n + 20));
  const { engine, added } = makeEngine(files);
  engine.start();
  await waitDone(engine);

  assert.equal(added.filter((e) => e.status === 'done').length, 5);
  assert.equal(prechecks.length, 1, 'exactly one round trip for the batch');
  assert.equal(prechecks[0].length, 5, 'all five signatures in it');
  assert.equal(sent.length, 15, 'three chunks per file');
});

test('engine: a stood-down copy comes back when the file it waited on fails', async () => {
  precheckMode = 'ok';
  knownSigs = {};
  const { engine, added } = makeEngine([makeFile('twice.jpg', 8), makeFile('twice.jpg', 8)]);
  // The content itself is refused, so the copy that stood down has to try too
  // rather than inherit a success that never happened.
  failNames = new Set(['twice.jpg']);

  engine.start();
  await waitDone(engine);

  assert.equal(added.filter((e) => e.status === 'error').length, 2, 'both end visibly failed');
  assert.ok(!added.some((e) => e.duplicate), 'nobody is left claiming success');
  const tried = new Set(sent.map((c) => c.id));
  assert.equal(tried.size, 2, 'the revived copy really did attempt its own upload');
});
