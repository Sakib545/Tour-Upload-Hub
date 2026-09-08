'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const CHUNK = 1024 * 1024;
const TAIL = 512;
const TOTAL = CHUNK + TAIL;
const PARTIAL = 3000;

async function chunkReq(base, opts) {
  const headers = {
    'X-Upload-Id': opts.id,
    'X-Offset': String(opts.offset),
    'X-Total': String(opts.total),
    'X-File-Name': encodeURIComponent(opts.name || 'a.jpg'),
    'X-Mime': 'image/jpeg',
  };
  const res = await fetch(base + '/api/upload/chunk', { method: 'POST', headers, body: opts.body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('partial chunk acceptance: server acks only Drive-confirmed bytes, upload resumes from there', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const id = 'partial_test_01';

  // Google only keeps PARTIAL bytes of the first chunk.
  ctx.mock.state.nextPutFault = { type: 'partial', bytes: PARTIAL };

  let r = await chunkReq(B, { id, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, PARTIAL, 'must ack only the confirmed partial bytes');

  // Resume from the confirmed offset with the remaining part of the chunk.
  r = await chunkReq(B, {
    id, offset: PARTIAL, total: TOTAL,
    body: padTo(CHUNK - PARTIAL, JPEG_PREFIX),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, CHUNK);

  // Final chunk.
  r = await chunkReq(B, { id, offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.equal(r.data.file.name, 'a.jpg');

  const stored = ctx.mock.state.files();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].size, TOTAL);
});
