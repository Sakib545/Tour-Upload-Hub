'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

/**
 * Admin-edited settings live in a small JSON file inside the tour's own Drive
 * folder, because Railway's disk is wiped on every redeploy. The store itself
 * skips this in tests (hermetic runs), so the Drive layer is exercised here.
 *
 * services/drive is required only AFTER start() so it sees the test env.
 */

test('settings survive as a JSON file in the Drive folder', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const drive = require('../services/drive');

  assert.equal(await drive.readSettingsFile(), null, 'nothing saved yet');

  const settings = {
    flags: { uploadsEnabled: true, galleryVisible: true, galleryPublic: true },
    site: { title: 'সাজেক ২০২৬', subtitle: 'সব স্মৃতি' },
    folders: { photos: 'Photos', group: 'Group Photos', videos: 'Videos' },
    seenFolderIds: ['fld_old'],
  };
  assert.equal(await drive.writeSettingsFile(settings), true);

  const readBack = await drive.readSettingsFile();
  assert.deepEqual(readBack, settings);

  // Overwriting reuses the same file rather than piling up copies.
  settings.site.title = 'সাজেক ২০২৭';
  await drive.writeSettingsFile(settings);
  const stored = ctx.mock.state.files().filter((f) => f.name === drive.SETTINGS_FILE);
  assert.equal(stored.length, 1);
  assert.equal((await drive.readSettingsFile()).site.title, 'সাজেক ২০২৭');
});

test('the settings file never shows up as tour content', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const drive = require('../services/drive');

  await drive.writeSettingsFile({ site: { title: 'x' } });

  const upload = await fetch(ctx.base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': 'settings_hidden_01', 'X-Offset': '0', 'X-Total': '4096',
      'X-File-Name': encodeURIComponent('real.jpg'), 'X-Mime': 'image/jpeg',
    },
    body: padTo(4096, JPEG_PREFIX),
  });
  assert.equal(upload.status, 200);

  const { items } = await (await fetch(ctx.base + '/api/gallery')).json();
  assert.deepEqual(items.map((i) => i.name), ['real.jpg']);

  const res = await fetch(ctx.base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  const token = (await res.json()).token;
  const overview = await (await fetch(ctx.base + '/api/admin/overview', {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  assert.equal(overview.stats.totalFiles, 1, 'the settings file is not counted');
  assert.deepEqual(overview.recent.map((r) => r.name), ['real.jpg']);
});
