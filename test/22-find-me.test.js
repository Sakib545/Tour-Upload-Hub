'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

function d(seed) {
  return Array.from({ length: 128 }, (_, i) => Math.sin(seed * 7.13 + i * 0.11));
}

test('find-me returns the visitor\u2019s own photos and no one else\u2019s', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '', FACE_SORT: 'true' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const faces = require('../services/faces');

  // Three uploads: two of "me", one of a stranger. The stubbed describer keys
  // off the pixel we plant in the first byte of each padded body.
  const owner = { A: d(1), B: d(1), C: d(9) };
  let current = null;
  faces.setDescriberForTests(async (buf) => {
    const tag = String.fromCharCode(buf[JPEG_PREFIX.length] || 0);
    return [{ descriptor: owner[tag] || d(0), score: 0.99, box: { width: 100, height: 100 }, imageWidth: 400, imageHeight: 400 }];
  });

  const put = (id, name, tag) => {
    const body = padTo(S, JPEG_PREFIX);
    body[JPEG_PREFIX.length] = tag.charCodeAt(0);
    return fetch(B + '/api/upload/chunk', {
      method: 'POST',
      headers: {
        'X-Upload-Id': id, 'X-Offset': '0', 'X-Total': String(S),
        'X-File-Name': encodeURIComponent(name), 'X-Mime': 'image/jpeg',
      },
      body,
    });
  };
  assert.equal((await put('findme_a', 'me1.jpg', 'A')).status, 200);
  assert.equal((await put('findme_b', 'me2.jpg', 'B')).status, 200);
  assert.equal((await put('findme_c', 'other.jpg', 'C')).status, 200);

  // The selfie carries "me"; only the two matching photos should come back.
  const selfie = padTo(2048, JPEG_PREFIX);
  selfie[JPEG_PREFIX.length] = 'A'.charCodeAt(0);
  const res = await fetch(B + '/api/gallery/find-me', {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: selfie,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 2, 'both of the visitor\u2019s photos, and not the stranger\u2019s');
  const names = data.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['me1.jpg', 'me2.jpg']);

  // A selfie with no face is reported, not treated as a match.
  faces.setDescriberForTests(async () => []);
  const none = await fetch(B + '/api/gallery/find-me', {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: selfie,
  });
  assert.equal((await none.json()).code, 'NO_FACE');
});
