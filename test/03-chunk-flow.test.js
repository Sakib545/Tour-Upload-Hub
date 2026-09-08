'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const CHUNK = 1024 * 1024; // 1 MB (UPLOAD_CHUNK_MB=1 in tests)
const TAIL = 512;
const TOTAL = CHUNK + TAIL;

async function chunkReq(base, opts) {
  const headers = {
    'X-Upload-Id': opts.id,
    'X-Offset': String(opts.offset),
    'X-Total': String(opts.total),
    'X-File-Name': encodeURIComponent(opts.name || 'holiday.jpg'),
    'X-Mime': opts.mime || 'image/jpeg',
  };
  const res = await fetch(base + '/api/upload/chunk', { method: 'POST', headers, body: opts.body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('normal chunk flow: 308-range ack per chunk, final chunk -> 201 done', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const id = 'flow_test_000001';

  // chunk 0 (full configured chunk)
  let r = await chunkReq(B, { id, offset: 0, total: TOTAL, body: padTo(CHUNK, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.received, CHUNK, 'first chunk ack must be the Drive-confirmed 1 MB');
  assert.equal(ctx.mock.state.sessionsCount(), 1, 'one live Drive session');

  // final chunk
  r = await chunkReq(B, { id, offset: CHUNK, total: TOTAL, body: padTo(TAIL, JPEG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.ok(r.data.file && r.data.file.id);
  assert.equal(r.data.file.name, 'holiday.jpg');
  assert.equal(r.data.file.size, TOTAL);
  assert.equal(ctx.mock.state.sessionsCount(), 0, 'session removed after completion');

  const stored = ctx.mock.state.files();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'holiday.jpg');
  assert.equal(stored[0].size, TOTAL);
});
