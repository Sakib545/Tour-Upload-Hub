'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

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

test('uploads still work when sub-folders are disabled', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '', SEPARATE_MEDIA_FOLDERS: 'false' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  const res = await upload(B, {
    id: 'flat_photo_01', name: 'flat.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX,
  });
  assert.equal(res.status, 200);
  assert.equal(ctx.mock.state.folders().length, 0, 'no sub-folders are created');
  const stored = ctx.mock.state.files().find((f) => f.name === 'flat.jpg');
  assert.deepEqual(stored.parents, ['FOLDER_ID_123']);
});
