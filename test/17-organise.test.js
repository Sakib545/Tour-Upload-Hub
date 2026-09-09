'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

/**
 * The tidy-up action moves files that were uploaded before the category
 * folders existed and are therefore still loose in the main folder.
 */
test('admin tidy-up moves loose files into the photo and video folders', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  // One normal upload first, so the category folders exist.
  const seeded = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'organise_seed_01', 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent('new.jpg'), 'X-Mime': 'image/jpeg',
      'X-Category': 'single',
    },
    body: padTo(S, JPEG_PREFIX),
  });
  assert.equal(seeded.status, 200);

  // Two files planted directly in the root folder, as older uploads would be.
  ctx.mock.state.addFile({ name: 'legacy.jpg', mimeType: 'image/jpeg', parents: ['FOLDER_ID_123'] });
  ctx.mock.state.addFile({ name: 'legacy.mp4', mimeType: 'video/mp4', parents: ['FOLDER_ID_123'] });

  const login = await fetch(B + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  const token = (await login.json()).token;
  const organise = () => fetch(B + '/api/admin/organise', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: '{}',
  });

  const res = await organise();
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.photos, 1);
  assert.equal(result.videos, 1);
  assert.equal(result.failed, 0);

  const folders = ctx.mock.state.folders();
  const photos = folders.find((f) => f.name === 'Photos').id;
  const videos = folders.find((f) => f.name === 'Videos').id;
  const stored = ctx.mock.state.files();
  assert.deepEqual(stored.find((f) => f.name === 'legacy.jpg').parents, [photos]);
  assert.deepEqual(stored.find((f) => f.name === 'legacy.mp4').parents, [videos]);
  assert.deepEqual(stored.find((f) => f.name === 'new.jpg').parents, [photos]);

  // The moved files are now listed in the gallery under their categories.
  const { items } = await (await fetch(B + '/api/gallery')).json();
  const byName = Object.fromEntries(items.map((i) => [i.name, i.category]));
  assert.equal(byName['legacy.jpg'], 'single');
  assert.equal(byName['legacy.mp4'], 'video');

  // Running it again is a no-op: nothing is left loose in the root folder.
  assert.equal((await (await organise()).json()).total, 0);
});
