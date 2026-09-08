'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const CHUNK = 1024 * 1024;
const TOTAL = CHUNK + 512;

async function firstChunk(base, id) {
  const res = await fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': id,
      'X-Offset': '0',
      'X-Total': String(TOTAL),
      'X-File-Name': encodeURIComponent('lim.jpg'),
      'X-Mime': 'image/jpeg',
    },
    body: padTo(CHUNK, JPEG_PREFIX),
  });
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

test('global active-session cap rejects excess sessions with 503 and cleanup aborts Drive sessions', async (t) => {
  const ctx = await start({
    env: {
      MAX_ACTIVE_UPLOADS: '2',
      MAX_UPLOADS_PER_IP: '10',
      MAX_SESSION_CREATES_PER_MIN_PER_IP: '1000',
    },
  });
  t.after(() => ctx.close());
  const B = ctx.base;

  let a = await firstChunk(B, 'limit_global_01');
  assert.equal(a.status, 200, JSON.stringify(a));
  let b = await firstChunk(B, 'limit_global_02');
  assert.equal(b.status, 200, JSON.stringify(b));
  let c = await firstChunk(B, 'limit_global_03');
  assert.equal(c.status, 503);
  assert.equal(c.data.error, 'UPLOAD_CAPACITY');
  assert.equal(ctx.mock.state.sessionsCount(), 2, 'no Drive session created over the cap');

  ctx.uploads.remove('limit_global_01');
  ctx.uploads.remove('limit_global_02');
  assert.ok(await waitUntil(() => ctx.mock.state.sessionsCount() === 0), 'removal aborts the Drive sessions');

  // capacity is free again
  a = await firstChunk(B, 'limit_global_04');
  assert.equal(a.status, 200, JSON.stringify(a));
  ctx.uploads.remove('limit_global_04');
  assert.ok(await waitUntil(() => ctx.mock.state.sessionsCount() === 0));
});
