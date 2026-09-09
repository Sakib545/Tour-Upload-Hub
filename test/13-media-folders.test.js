'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, MP4_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

function upload(base, { id, name, mime, prefix }) {
  return fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': id,
      'X-Offset': '0',
      'X-Total': String(S),
      'X-File-Name': encodeURIComponent(name),
      'X-Mime': mime,
    },
    body: padTo(S, prefix),
  });
}

test('photos and videos are filed into separate Drive sub-folders', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  const photo = await upload(B, {
    id: 'folders_photo_01', name: 'beach.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX,
  });
  assert.equal(photo.status, 200);
  const video = await upload(B, {
    id: 'folders_video_01', name: 'sunset.mp4', mime: 'video/mp4', prefix: MP4_PREFIX,
  });
  assert.equal(video.status, 200);

  // Both sub-folders were created exactly once, directly under the root folder.
  const folders = ctx.mock.state.folders();
  const photos = folders.find((f) => f.name === 'Photos');
  const videos = folders.find((f) => f.name === 'Videos');
  assert.ok(photos, 'a Photos folder was created');
  assert.ok(videos, 'a Videos folder was created');
  assert.equal(folders.length, 2, 'sub-folders are resolved once, not per upload');

  // Each file landed in the folder matching its type.
  const stored = ctx.mock.state.files();
  const jpg = stored.find((f) => f.name === 'beach.jpg');
  const mp4 = stored.find((f) => f.name === 'sunset.mp4');
  assert.deepEqual(jpg.parents, [photos.id]);
  assert.deepEqual(mp4.parents, [videos.id]);

  // The gallery still lists files that live in the sub-folders.
  const listRes = await fetch(B + '/api/gallery');
  assert.equal(listRes.status, 200);
  const { items } = await listRes.json();
  assert.equal(items.length, 2);
  const names = items.map((i) => i.name).sort();
  assert.deepEqual(names, ['beach.jpg', 'sunset.mp4']);

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
