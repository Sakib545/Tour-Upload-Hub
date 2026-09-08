'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const CHUNK = 1024 * 1024;
const TAIL = 512;
const TOTAL = CHUNK + TAIL;
const BIG = 2 * CHUNK;

async function chunkReq(base, opts) {
  const headers = {
    'X-Upload-Id': opts.id,
    'X-Offset': String(opts.offset),
    'X-Total': String(opts.total),
    'X-File-Name': encodeURIComponent(opts.name || 'rec.jpg'),
    'X-Mime': 'image/jpeg',
  };
  const res = await fetch(base + '/api/upload/chunk', { method: 'POST', headers, body: opts.body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitUntil(fn, { timeout = 3000, every = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

test('recovery: UNKNOWN_UPLOAD, server session loss + restart, OUT_OF_ORDER, interruption resume', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;

  // (a) Chunk for an upload id the server never saw -> UNKNOWN_UPLOAD
  let r = await chunkReq(B, { id: 'unknown_upload_1', offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'UNKNOWN_UPLOAD');

  // (b) Server-side session loss mid-file (simulated registry eviction)
  const idA = 'lossy_upload_001';
  r = await chunkReq(B, { id: idA, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200);
  assert.equal(r.data.received, CHUNK);
  ctx.uploads.remove(idA); // eviction / server restart wipes the in-memory entry
  assert.ok(await waitUntil(() => ctx.mock.state.sessionsCount() === 0), 'aborted Drive session on eviction');

  r = await chunkReq(B, { id: idA, offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'UNKNOWN_UPLOAD');

  // (c) Restart the same file from offset 0 with a fresh session -> completes
  r = await chunkReq(B, { id: idA, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, CHUNK);
  r = await chunkReq(B, { id: idA, offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.equal(ctx.mock.state.files().length, 1, 'only the restarted file exists in Drive');

  // (d) Client skips bytes -> OUT_OF_ORDER after Drive reconciliation
  const idB = 'order_upload_001';
  r = await chunkReq(B, { id: idB, offset: 0, total: BIG, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200);
  assert.equal(r.data.received, CHUNK);
  r = await chunkReq(B, { id: idB, offset: CHUNK + TAIL, total: BIG, body: padTo(CHUNK - TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'OUT_OF_ORDER');
  assert.ok(await waitUntil(() => ctx.mock.state.sessionsCount() === 0), 'partial session aborted after OUT_OF_ORDER');

  // (e) Upstream answers 500 AFTER committing the chunk -> server probes Drive
  //     and the upload resumes from Drive's confirmed offset (no restart).
  const idC = 'net_upload_0001';
  ctx.mock.state.nextPutFault = 'http500';
  r = await chunkReq(B, { id: idC, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, CHUNK, 'resumed from the byte Drive confirmed despite the 500');
  r = await chunkReq(B, { id: idC, offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);

  // (f) Interruption on the SECOND chunk (mid-file): Drive commits the chunk
  //     but the response is lost (simulated upstream 500). The next request is
  //     reconciled via a probe and continues from Drive's confirmed offset —
  //     NO full-file restart, NO duplicate.
  const idD = 'net_upload_0002';
  const BIGGER = 2 * CHUNK + TAIL;
  r = await chunkReq(B, { id: idD, offset: 0, total: BIGGER, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, CHUNK);

  ctx.mock.state.nextPutFault = 'http500'; // chunk 1 commits at Drive, response lost
  r = await chunkReq(B, { id: idD, offset: CHUNK, total: BIGGER, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, 2 * CHUNK, 'resumed from the Drive-confirmed offset, no restart');

  r = await chunkReq(B, { id: idD, offset: 2 * CHUNK, total: BIGGER, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);

  // Server survived throughout.
  let h = await fetch(B + '/api/health');
  assert.equal(h.status, 200);

  const files = ctx.mock.state.files();
  const names = files.map((f) => f.name);
  assert.equal(files.length, 3, 'exactly one file per completed upload (no duplicates)');
  assert.ok(!names.some((n, i) => names.indexOf(n) !== i), 'no duplicate files');
});
