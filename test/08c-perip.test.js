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

test('per-IP active-session cap rejects excess sessions with 429', async (t) => {
  const ctx = await start({
    env: {
      MAX_ACTIVE_UPLOADS: '10',
      MAX_UPLOADS_PER_IP: '2',
      MAX_SESSION_CREATES_PER_MIN_PER_IP: '1000',
    },
  });
  t.after(() => ctx.close());
  const B = ctx.base;

  let a = await firstChunk(B, 'limit_perip_001');
  assert.equal(a.status, 200, JSON.stringify(a));
  let b = await firstChunk(B, 'limit_perip_002');
  assert.equal(b.status, 200, JSON.stringify(b));
  let c = await firstChunk(B, 'limit_perip_003');
  assert.equal(c.status, 429);
  assert.equal(c.data.error, 'TOO_MANY_UPLOADS');
  assert.equal(ctx.mock.state.sessionsCount(), 2, 'no Drive session created over the IP cap');

  // cleanup frees the per-IP budget again
  ctx.uploads.remove('limit_perip_001');
  ctx.uploads.remove('limit_perip_002');
  assert.ok(await waitUntil(() => ctx.mock.state.sessionsCount() === 0));
  a = await firstChunk(B, 'limit_perip_004');
  assert.equal(a.status, 200, JSON.stringify(a));
  ctx.uploads.remove('limit_perip_004');
  assert.ok(await waitUntil(() => ctx.mock.state.sessionsCount() === 0));
});
