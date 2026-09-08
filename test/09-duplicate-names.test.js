'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

async function uploadOnce(base, id, name) {
  const res = await fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': id,
      'X-Offset': '0',
      'X-Total': String(S),
      'X-File-Name': encodeURIComponent(name),
      'X-Mime': 'image/jpeg',
    },
    body: padTo(S, JPEG_PREFIX),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('simultaneous uploads with the same filename get distinct display names', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;

  // Two uploads with the same sanitized name racing each other.
  const [r1, r2] = await Promise.all([
    uploadOnce(B, 'race_file_000001', 'IMG_0001.jpg'),
    uploadOnce(B, 'race_file_000002', 'IMG_0001.jpg'),
  ]);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.ok(r1.data.done && r2.data.done);

  const files = ctx.mock.state.files();
  assert.equal(files.length, 2);
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ['IMG_0001 (2).jpg', 'IMG_0001.jpg'], 'no two files share one name');

  // A later upload with the same name still gets the next free suffix.
  const r3 = await uploadOnce(B, 'race_file_000003', 'IMG_0001.jpg');
  assert.equal(r3.status, 200);
  assert.ok(r3.data.done);
  const namesAfter = ctx.mock.state.files().map((f) => f.name).sort();
  assert.deepEqual(namesAfter, ['IMG_0001 (2).jpg', 'IMG_0001 (3).jpg', 'IMG_0001.jpg']);
});
