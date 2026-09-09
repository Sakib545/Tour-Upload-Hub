'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, MP4_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

function upload(base, { id, name, mime, prefix, category = '' }) {
  const headers = {
    'X-Upload-Id': id,
    'X-Offset': '0',
    'X-Total': String(S),
    'X-File-Name': encodeURIComponent(name),
    'X-Mime': mime,
  };
  if (category) headers['X-Category'] = category;
  return fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers,
    body: padTo(S, prefix),
  });
}

test('uploads are filed by category (single/group/video) and tagged in the gallery', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  // A group photo → its own "Group Photos" sub-folder.
  const group = await upload(B, {
    id: 'cat_group_01', name: 'everyone.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX, category: 'group',
  });
  assert.equal(group.status, 200);

  // A video without a category header still uses the legacy "Videos" routing.
  const video = await upload(B, {
    id: 'cat_video_01', name: 'clip.mp4', mime: 'video/mp4', prefix: MP4_PREFIX,
  });
  assert.equal(video.status, 200);

  const folders = ctx.mock.state.folders();
  const groupFolder = folders.find((f) => f.name === 'Group Photos');
  const videosFolder = folders.find((f) => f.name === 'Videos');
  assert.ok(groupFolder, 'a Group Photos folder was created');
  assert.ok(videosFolder, 'a Videos folder was created');

  const stored = ctx.mock.state.files();
  assert.deepEqual(stored.find((f) => f.name === 'everyone.jpg').parents, [groupFolder.id]);
  assert.deepEqual(stored.find((f) => f.name === 'clip.mp4').parents, [videosFolder.id]);

  // A category that contradicts the file type is ignored → legacy photo folder.
  const wrong = await upload(B, {
    id: 'cat_wrong_01', name: 'solo.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX, category: 'video',
  });
  assert.equal(wrong.status, 200);

  // Public config exposes the category chips.
  const cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.separateMediaFolders, true);
  assert.deepEqual(cfg.categories.map((c) => c.id), ['single', 'group', 'video']);
  assert.deepEqual(cfg.categories.map((c) => c.media), ['photo', 'photo', 'video']);

  // The gallery lists every category folder and tags each item.
  const { items } = await (await fetch(B + '/api/gallery')).json();
  assert.equal(items.length, 3);
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName['everyone.jpg'].category, 'group');
  assert.equal(byName['everyone.jpg'].categoryLabel, 'গ্রুপ ছবি');
  assert.equal(byName['clip.mp4'].category, 'video');
  // Untagged image files fall back to the first photo category ('single').
  assert.equal(byName['solo.jpg'].category, 'single');
});
