'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const CHUNK = 1024 * 1024;
const TOTAL = CHUNK + 512;

test('session-creation attempts per IP/minute are rate limited with 429', async (t) => {
  const ctx = await start({ env: { MAX_SESSION_CREATES_PER_MIN_PER_IP: '2' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  for (let i = 0; i < 2; i++) {
    const res = await fetch(B + '/api/upload/chunk', {
      method: 'POST',
      headers: {
        'X-Upload-Id': 'rate_limit_00' + i,
        'X-Offset': '0',
        'X-Total': String(TOTAL),
        'X-File-Name': encodeURIComponent('rate.jpg'),
        'X-Mime': 'image/jpeg',
      },
      body: padTo(CHUNK, JPEG_PREFIX),
    });
    const data = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, JSON.stringify(data));
    ctx.uploads.remove('rate_limit_00' + i); // free capacity, tracker window stays
  }

  // Third session creation inside the same minute -> RATE_LIMITED
  const res = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'rate_limit_002',
      'X-Offset': '0',
      'X-Total': String(TOTAL),
      'X-File-Name': encodeURIComponent('rate.jpg'),
      'X-Mime': 'image/jpeg',
    },
    body: padTo(CHUNK, JPEG_PREFIX),
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 429);
  assert.equal(data.error, 'RATE_LIMITED');
  assert.equal(ctx.mock.state.sessionsCount(), 0, 'no Drive session for the rejected attempt');
});
