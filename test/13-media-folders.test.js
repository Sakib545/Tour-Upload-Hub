'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, MP4_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

function upload(base, { id, name, mime, prefix, group }) {
  const headers = {
    'X-Upload-Id': id,
    'X-Offset': '0',
    'X-Total': String(S),
    'X-File-Name': encodeURIComponent(name),
    'X-Mime': mime,
  };
  if (group) headers['X-Group'] = '1';
  return fetch(base + '/api/upload/chunk', { method: 'POST', headers, body: padTo(S, prefix) });
}

test('single photos, group photos and videos each get their own folder', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  const photo = await upload(B, {
    id: 'folders_photo_01', name: 'beach.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX,
  });
  assert.equal(photo.status, 200);
  const groupPhoto = await upload(B, {
    id: 'folders_group_01', name: 'everyone.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX,
    group: true,
  });
  assert.equal(groupPhoto.status, 200);
  const video = await upload(B, {
    id: 'folders_video_01', name: 'sunset.mp4', mime: 'video/mp4', prefix: MP4_PREFIX,
  });
  assert.equal(video.status, 200);

  // The three sub-folders were created exactly once, under the root folder.
  const folders = ctx.mock.state.folders();
  const photos = folders.find((f) => f.name === 'Photos');
  const group = folders.find((f) => f.name === 'Group Photos');
  const videos = folders.find((f) => f.name === 'Videos');
  assert.ok(photos && group && videos, 'all three sub-folders were created');
  assert.equal(folders.length, 3, 'sub-folders are resolved once, not per upload');

  // Each file landed in the folder matching its kind.
  const stored = ctx.mock.state.files();
  assert.deepEqual(stored.find((f) => f.name === 'beach.jpg').parents, [photos.id]);
  assert.deepEqual(stored.find((f) => f.name === 'everyone.jpg').parents, [group.id]);
  assert.deepEqual(stored.find((f) => f.name === 'sunset.mp4').parents, [videos.id]);

  // The gallery lists files from every sub-folder and tags each category.
  const listRes = await fetch(B + '/api/gallery');
  assert.equal(listRes.status, 200);
  const { items } = await listRes.json();
  assert.equal(items.length, 3);
  const byName = Object.fromEntries(items.map((i) => [i.name, i.category]));
  assert.deepEqual(byName, {
    'beach.jpg': 'single',
    'everyone.jpg': 'group',
    'sunset.mp4': 'video',
  });

  // …and their media is still served (parent verification accepts sub-folders).
  const item = items.find((i) => i.name === 'beach.jpg');
  const mediaRes = await fetch(B + item.src);
  assert.equal(mediaRes.status, 200);
});

test('download links carry an attachment filename', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  const res = await upload(B, {
    id: 'download_photo_01', name: 'কক্সবাজার.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX,
  });
  assert.equal(res.status, 200);

  const { items } = await (await fetch(B + '/api/gallery')).json();
  const item = items[0];
  assert.ok(item.download.includes('download=1'), 'a download URL is offered');

  const dl = await fetch(B + item.download);
  assert.equal(dl.status, 200);
  const cd = dl.headers.get('content-disposition') || '';
  assert.match(cd, /^attachment;/);
  assert.match(cd, /filename\*=UTF-8''/, 'non-ASCII names survive via RFC 5987');

  // Without the flag the file still streams inline (gallery viewing).
  const inline = await fetch(B + item.src);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-disposition'), null);
});
