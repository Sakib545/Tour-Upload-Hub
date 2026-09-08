'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const CHUNK = 1024 * 1024;
const TAIL = 512;
const TOTAL = CHUNK + TAIL;

async function chunkReq(base, opts) {
  const headers = {
    'X-Upload-Id': opts.id,
    'X-Offset': String(opts.offset),
    'X-Total': String(opts.total),
    'X-File-Name': encodeURIComponent(opts.name || 'dup.jpg'),
    'X-Mime': 'image/jpeg',
  };
  const res = await fetch(base + '/api/upload/chunk', { method: 'POST', headers, body: opts.body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('duplicate chunk resend (lost response): answered from confirmed offset, bytes never re-sent to Drive', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const id = 'dup_resend_0001';

  let r = await chunkReq(B, { id, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200);
  assert.equal(r.data.received, CHUNK);
  assert.equal(ctx.mock.state.putCount, 1, 'one chunk PUT so far');

  // Identical re-send of chunk 0 (the previous response may have been lost).
  r = await chunkReq(B, { id, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, CHUNK, 'idempotent ack from the confirmed offset');
  assert.equal(ctx.mock.state.putCount, 1, 'duplicate never reached Drive again');

  r = await chunkReq(B, { id, offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 200);
  assert.equal(r.data.done, true);

  const stored = ctx.mock.state.files();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].size, TOTAL);
});
