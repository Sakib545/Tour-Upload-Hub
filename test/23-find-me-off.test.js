'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

// Its own file: cfg reads FACE_SORT once per process, so "off" cannot share a
// process with a suite that turned it on.
test('find-me is refused when face sorting is off', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const res = await fetch(ctx.base + '/api/gallery/find-me', {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: padTo(2048, JPEG_PREFIX),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'FACES_DISABLED');
});
