'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;
const PIN = '4321';

async function adminToken(base) {
  const res = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

function putSettings(base, token, body) {
  return fetch(base + '/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
}

test('admin edits the page content and it shows up in /api/config', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: PIN } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  const res = await putSettings(B, token, {
    site: {
      title: 'সাজেক ২০২৬',
      subtitle: 'আমাদের সব স্মৃতি',
      date: '১২–১৪ ডিসেম্বর',
      location: 'সাজেক ভ্যালি',
      privacyNote: 'ছবি শুধু আমাদের গ্রুপের জন্য',
      coverUrl: 'javascript:alert(1)', // rejected: not http(s)
    },
    folders: { group: 'Group Shots' },
  });
  assert.equal(res.status, 200);
  const saved = (await res.json()).settings;
  assert.equal(saved.site.title, 'সাজেক ২০২৬');
  assert.equal(saved.site.coverUrl, '', 'only http(s) cover URLs are accepted');
  assert.equal(saved.folders.group, 'Group Shots');

  const cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.tourTitle, 'সাজেক ২০২৬');
  assert.equal(cfg.tourSubtitle, 'আমাদের সব স্মৃতি');
  assert.equal(cfg.tourLocation, 'সাজেক ভ্যালি');
  assert.equal(cfg.folderNames.group, 'Group Shots');

  // Renamed folder is the one new group photos are created in.
  const pin = await (await fetch(B + '/api/verify-pin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  })).json();
  const up = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'settings_group_01', 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('all-of-us.jpg'), 'X-Mime': 'image/jpeg',
      'X-Group': '1', 'X-Upload-Token': pin.token,
    },
    body: padTo(S, JPEG_PREFIX),
  });
  assert.equal(up.status, 200);
  const folders = ctx.mock.state.folders();
  const renamed = folders.find((f) => f.name === 'Group Shots');
  assert.ok(renamed, 'the renamed folder was created');
  const stored = ctx.mock.state.files().find((f) => f.name === 'all-of-us.jpg');
  assert.deepEqual(stored.parents, [renamed.id]);
});

test('gallery can be public while uploading still needs the PIN', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: PIN } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  // Seed one photo through the PIN-gated upload path.
  const pin = await (await fetch(B + '/api/verify-pin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
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

  // Admin opens it to everyone.
  assert.equal((await putSettings(B, token, { galleryPublic: true })).status, 200);

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
  const cfg = await (await fetch(B + '/api/config')).json();
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
