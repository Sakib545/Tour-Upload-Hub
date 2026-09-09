'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;
const PIN = '4321';

/**
 * The organiser can open the gallery to everyone — visitors browse and
 * download without the PIN — while uploading keeps its own PIN gate.
 */
test('gallery can be public while uploading still needs the PIN', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: PIN } });
  t.after(() => ctx.close());
  const B = ctx.base;

  const login = await fetch(B + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  const token = (await login.json()).token;

  // Seed one photo through the PIN-gated upload path.
  const pin = await (await fetch(B + '/api/verify-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  })).json();
  const up = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'public_mode_01', 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('view-me.jpg'), 'X-Mime': 'image/jpeg',
      'X-Upload-Token': pin.token,
    },
    body: padTo(S, JPEG_PREFIX),
  });
  assert.equal(up.status, 200);

  // Default: the gallery is gated with the PIN.
  assert.equal((await fetch(B + '/api/gallery')).status, 401);
  let cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.galleryPinRequired, true);

  // Admin opens it to everyone.
  const put = await fetch(B + '/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ galleryPublic: true }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).settings.galleryPublic, true);

  const listRes = await fetch(B + '/api/gallery');
  assert.equal(listRes.status, 200);
  const { items } = await listRes.json();
  assert.equal(items.length, 1);
  assert.ok(!items[0].src.includes('gt='), 'no signed token needed in public mode');

  // Viewing and downloading work without any token…
  assert.equal((await fetch(B + items[0].src)).status, 200);
  const dl = await fetch(B + items[0].download);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') || '', /^attachment;/);

  cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.galleryPinRequired, false);
  assert.equal(cfg.pinRequired, true, 'uploading still advertises the PIN gate');

  // …but uploading without the PIN is still refused.
  const anon = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'public_mode_02', 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('sneaky.jpg'), 'X-Mime': 'image/jpeg',
    },
    body: padTo(S, JPEG_PREFIX),
  });
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error, 'PIN_REQUIRED');
});
