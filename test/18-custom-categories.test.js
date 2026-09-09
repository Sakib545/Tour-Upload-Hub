'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

async function adminToken(base) {
  const res = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

function putSite(base, token, body) {
  return fetch(base + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
}

test('admin can add a custom category and uploads land in its folder', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  const before = await (await fetch(B + '/api/config')).json();
  assert.deepEqual(before.categories.map((c) => c.id), ['single', 'group', 'video']);

  // Keep the built-ins and append one of the organiser's own.
  const res = await putSite(B, token, {
    categories: [
      ...before.categories.map((c) => ({ id: c.id })),
      { label: 'ড্রোন শট', folder: 'Drone Shots', media: 'any' },
    ],
  });
  assert.equal(res.status, 200);
  const cats = (await res.json()).site.categories;
  assert.equal(cats.length, 4);
  const custom = cats[3];
  assert.match(custom.id, /^c_[a-z0-9]{6}$/, 'a stable id is minted');
  assert.equal(custom.folder, 'Drone Shots');
  assert.equal(custom.builtin, false);

  // It shows up as a chip for visitors…
  const cfg = await (await fetch(B + '/api/config')).json();
  assert.ok(cfg.categories.some((c) => c.id === custom.id && c.label === 'ড্রোন শট'));

  // …and an upload tagged with it lands in the new Drive folder.
  const up = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'custom_cat_upload1', 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('aerial.jpg'), 'X-Mime': 'image/jpeg',
      'X-Category': custom.id,
    },
    body: padTo(S, JPEG_PREFIX),
  });
  assert.equal(up.status, 200);
  const folder = ctx.mock.state.folders().find((f) => f.name === 'Drone Shots');
  assert.ok(folder, 'the folder was created on Drive');
  assert.deepEqual(
    ctx.mock.state.files().find((f) => f.name === 'aerial.jpg').parents,
    [folder.id]
  );

  const { items } = await (await fetch(B + '/api/gallery')).json();
  const item = items.find((i) => i.name === 'aerial.jpg');
  assert.equal(item.category, custom.id);
  assert.equal(item.categoryLabel, 'ড্রোন শট');
});

test('built-ins survive, duplicate folders are refused, removals stick', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  // Two categories may not share one Drive folder.
  const clash = await putSite(B, token, {
    categories: [
      { id: 'single', label: 'একক ছবি', folder: 'Photos' },
      { id: 'group', label: 'গ্রুপ ছবি', folder: 'Photos' },
      { id: 'video', label: 'ভিডিও', folder: 'Videos' },
    ],
  });
  assert.equal(clash.status, 200);
  const after = (await clash.json()).site.categories;
  assert.equal(after.find((c) => c.id === 'single').folder, 'Photos');
  assert.notEqual(after.find((c) => c.id === 'group').folder, 'Photos');

  // A payload that omits the built-ins gets them back — they are the fallback
  // routing for uploads that arrive without a category.
  const dropped = await putSite(B, token, {
    categories: [{ label: 'শুধু ড্রোন', folder: 'Drone Only', media: 'photo' }],
  });
  const kept = (await dropped.json()).site.categories;
  for (const id of ['single', 'group', 'video']) {
    assert.ok(kept.some((c) => c.id === id), `${id} is still there`);
  }
  const custom = kept.find((c) => c.folder === 'Drone Only');
  assert.ok(custom);

  // Leaving a custom category out of a later save removes it.
  const removed = await putSite(B, token, {
    categories: kept.filter((c) => c.builtin).map((c) => ({ id: c.id })),
  });
  const finalCats = (await removed.json()).site.categories;
  assert.equal(finalCats.length, 3);
  assert.ok(!finalCats.some((c) => c.id === custom.id));
});

test('an admin token can upload even while visitor uploads are paused', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '4321' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  const pause = await fetch(B + '/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ uploadsEnabled: false }),
  });
  assert.equal(pause.status, 200);

  const send = (headers) => fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('by-admin.jpg'), 'X-Mime': 'image/jpeg',
      ...headers,
    },
    body: padTo(S, JPEG_PREFIX),
  });

  // A visitor is turned away…
  const visitor = await send({ 'X-Upload-Id': 'admin_up_visitor01' });
  assert.equal(visitor.status, 403);
  assert.equal((await visitor.json()).error, 'UPLOADS_DISABLED');

  // …the admin is not.
  const admin = await send({ 'X-Upload-Id': 'admin_up_admin0001', 'X-Upload-Token': token });
  assert.equal(admin.status, 200);
  assert.ok(ctx.mock.state.files().some((f) => f.name === 'by-admin.jpg'));
});
