'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, MP4_PREFIX, padTo } = require('./helpers/boot');
const { signToken } = require('../utils/tokens');

const PIN = '7788';
const S = 4096;

test('PIN-protected gallery: metadata, thumbnails and media all require proof', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: PIN, ADMIN_PASSWORD: 'x'.repeat(12) } });
  t.after(() => ctx.close());
  const state = require('../services/state'); // after start(): env/config already loaded
  const B = ctx.base;

  // obtain a PIN token
  const pinRes = await fetch(B + '/api/verify-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  const { token } = await pinRes.json();
  assert.ok(token);

  // seed two files through the (PIN-gated) upload API
  async function seed(id, name, mime, prefix) {
    const res = await fetch(B + '/api/upload/chunk', {
      method: 'POST',
      headers: {
        'X-Upload-Id': id, 'X-Offset': '0', 'X-Total': String(S),
        'X-File-Name': encodeURIComponent(name), 'X-Mime': mime,
        'X-Upload-Token': token,
      },
      body: padTo(S, prefix),
    });
    assert.equal(res.status, 200, name + ' ' + (await res.text()));
  }
  await seed('gallery_seed_001', 'beach.jpg', 'image/jpeg', JPEG_PREFIX);
  await seed('gallery_seed_002', 'boat.mp4', 'video/mp4', MP4_PREFIX);

  // 1. List without any proof -> 401
  let res = await fetch(B + '/api/gallery');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'GALLERY_PIN_REQUIRED');

  // 2. List with the PIN token -> items carry signed media URLs (?gt=)
  res = await fetch(B + '/api/gallery', { headers: { 'X-Upload-Token': token } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { items } = await res.json();
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.ok(item.src.includes('?gt='), 'media src must be signed in PIN mode');
  }
  const jpeg = items.find((i) => i.mimeType === 'image/jpeg');

  // 3. Media without a signed URL -> 401
  res = await fetch(B + `/api/gallery/file/${jpeg.id}/content`);
  assert.equal(res.status, 401);

  // 4. Media with the signed URL -> 200 + private short cache
  res = await fetch(B + jpeg.src);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /private/);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff);

  // 5. Expired signed token -> 401
  const expiredGal = signToken({ purpose: 'gal', exp: Date.now() - 1000 }, PIN, 'gal');
  res = await fetch(B + `/api/gallery/file/${jpeg.id}/content?gt=${encodeURIComponent(expiredGal)}`);
  assert.equal(res.status, 401);

  // 6. Admin hides the gallery -> even valid tokens get 404 on EVERY route
  state.update({ galleryVisible: false });
  res = await fetch(B + '/api/gallery', { headers: { 'X-Upload-Token': token } });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'GALLERY_DISABLED');
  res = await fetch(B + jpeg.src);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'GALLERY_DISABLED');
  state.update({ galleryVisible: true });

  // sanity after restore
  res = await fetch(B + '/api/gallery', { headers: { 'X-Upload-Token': token } });
  assert.equal(res.status, 200);
});
