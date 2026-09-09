'use strict';

/**
 * Regressions for bugs found by review. Each test failed before its fix.
 */

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

function uploadJpeg(base, { id, name, category = '' }) {
  return fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': id,
      'X-Offset': '0',
      'X-Total': String(S),
      'X-File-Name': encodeURIComponent(name),
      'X-Mime': 'image/jpeg',
      'X-Category': category,
      'Content-Type': 'application/octet-stream',
    },
    body: padTo(S, JPEG_PREFIX),
  });
}

test('media in a sub-folder is served even with a cold folder cache', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const drive = require('../services/drive');

  await drive.ensureMediaFolders();
  const photos = ctx.mock.state.folders().find((f) => f.name === 'Photos');
  assert.ok(photos, 'the Photos sub-folder exists');

  const planted = ctx.mock.state.addFile({
    name: 'OLD.jpg',
    mimeType: 'image/jpeg',
    parents: [photos.id],
    body: padTo(2048, JPEG_PREFIX),
  });
  const fileId = planted.id || planted;

  // Exactly the state after boot: persist.loadAll() clears the resolved
  // sub-folder ids, and a direct media URL arrives before any listing.
  drive.resetFolderCache();

  const res = await fetch(`${ctx.base}/api/gallery/file/${fileId}/content`);
  assert.equal(res.status, 200, 'a cold cache must not 404 the file');
  await res.arrayBuffer();
});

test('a colliding folder rename never drops a built-in category', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  // Point two built-ins at the same Drive folder name.
  const res = await fetch(B + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      categories: [
        { id: 'single', folder: 'Videos' },
        { id: 'group', folder: 'Group Photos' },
        { id: 'video', folder: 'Videos' },
      ],
    }),
  });
  assert.equal(res.status, 200);

  const cats = (await res.json()).site.categories;
  const ids = cats.map((c) => c.id);
  assert.deepEqual(ids.sort(), ['group', 'single', 'video'], 'every built-in survives');

  const folders = cats.map((c) => c.folder.toLowerCase());
  assert.equal(new Set(folders).size, folders.length, 'folders stay unique');

  const cfg = await (await fetch(B + '/api/config')).json();
  assert.ok(cfg.categories.some((c) => c.id === 'video'), 'the video chip is still offered');
});

test("admin overview labels an 'any' custom category like the gallery does", async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  const before = await (await fetch(B + '/api/config')).json();
  const saved = await fetch(B + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      categories: [
        ...before.categories.map((c) => ({ id: c.id })),
        { label: 'Day 1', folder: 'Day 1', media: 'any' },
      ],
    }),
  });
  const custom = (await saved.json()).site.categories.find((c) => !c.builtin);
  assert.ok(custom, 'the custom category was created');

  const up = await uploadJpeg(B, { id: 'regress_any_cat_1', name: 'day1.jpg', category: custom.id });
  assert.equal(up.status, 200);
  assert.ok((await up.json()).done);

  const gallery = await (await fetch(B + '/api/gallery')).json();
  const item = gallery.items.find((i) => i.name === 'day1.jpg');
  assert.equal(item.categoryLabel, 'Day 1', 'the gallery uses the custom label');

  const overview = await (
    await fetch(B + '/api/admin/overview', { headers: { Authorization: 'Bearer ' + token } })
  ).json();
  const row = overview.recent.find((r) => r.name === 'day1.jpg');
  assert.equal(row.categoryLabel, 'Day 1', 'the admin list must agree with the gallery');
});

test('a completed upload with no returned file id still leaves a tombstone', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const uploads = ctx.uploads;

  uploads.create('tombstone_no_fileid_1', {
    total: 100,
    name: 'x.jpg',
    mimeType: 'image/jpeg',
    sessionUri: 'http://example.invalid/session',
  });
  // Drive confirmed every byte but the 201 (and its id) never reached us.
  uploads.complete('tombstone_no_fileid_1', { fileId: null, name: 'x.jpg', total: 100 });

  const tomb = uploads.tombstoneDone('tombstone_no_fileid_1');
  assert.ok(tomb, 'a re-sent final chunk must be answered from the tombstone');
  assert.equal(tomb.total, 100);
});
