'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

test('public gallery (no PIN): open metadata/media, hide toggle blocks instantly', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const state = require('../services/state'); // after start(): env/config already loaded
  const B = ctx.base;

  // seed one public file
  const seedRes = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'public_seed_001', 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('open.jpg'), 'X-Mime': 'image/jpeg',
    },
    body: padTo(S, JPEG_PREFIX),
  });
  assert.equal(seedRes.status, 200);

  // 1. List without any token -> 200 (public mode)
  let res = await fetch(B + '/api/gallery');
  assert.equal(res.status, 200);
  const { items } = await res.json();
  assert.equal(items.length, 1);
  assert.ok(!items[0].src.includes('?gt='), 'no signed URL when the gallery is public');
  const item = items[0];

  // 2. Media without any token -> 200
  res = await fetch(B + item.src);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf[0] === 0xff && buf[1] === 0xd8);

  // 3. Admin hides the gallery -> 404 for list AND content immediately
  state.update({ galleryVisible: false });
  res = await fetch(B + '/api/gallery');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'GALLERY_DISABLED');
  res = await fetch(B + item.src);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'GALLERY_DISABLED');
});
