'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  start, JPEG_PREFIX, PNG_PREFIX, HEIC_PREFIX, MP4_PREFIX, EXE_PREFIX, HTML_PREFIX, padTo,
} = require('./helpers/boot');

async function chunkReq(base, opts) {
  const headers = {
    'X-Upload-Id': opts.id,
    'X-Offset': String(opts.offset || 0),
    'X-Total': String(opts.total),
    'X-File-Name': encodeURIComponent(opts.name),
    'X-Mime': opts.mime,
  };
  const res = await fetch(base + '/api/upload/chunk', { method: 'POST', headers, body: opts.body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('file signatures: disguised executables/html rejected, valid formats accepted, no Drive session for fakes', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const S = 4096;

  // 1. EXE bytes renamed to .jpg -> INVALID_FILE_CONTENT, NO Drive session
  let r = await chunkReq(B, { id: 'magic_exe_00001', total: S, name: 'photo.jpg', mime: 'image/jpeg', body: padTo(S, EXE_PREFIX) });
  assert.equal(r.status, 415);
  assert.equal(r.data.error, 'INVALID_FILE_CONTENT');
  assert.equal(ctx.mock.state.sessionsCount(), 0);

  // 2. HTML renamed to .jpg -> rejected
  r = await chunkReq(B, { id: 'magic_html_0001', total: S, name: 'photo.jpg', mime: 'image/jpeg', body: padTo(S, HTML_PREFIX) });
  assert.equal(r.status, 415);
  assert.equal(r.data.error, 'INVALID_FILE_CONTENT');
  assert.equal(ctx.mock.state.sessionsCount(), 0);

  // 3. Too small to identify safely -> rejected
  r = await chunkReq(B, { id: 'magic_tiny_0001', total: 2, name: 'tiny.jpg', mime: 'image/jpeg', body: Buffer.from([0xff, 0xd8]) });
  assert.equal(r.status, 415);
  assert.equal(r.data.error, 'INVALID_FILE_CONTENT');

  // 4. Tiny NON-final first chunk (file is bigger than the chunk) -> BAD_REQUEST, no session
  const CHUNK = 1024 * 1024;
  r = await chunkReq(B, {
    id: 'magic_smallchunk1', total: CHUNK + 100, name: 'big.jpg', mime: 'image/jpeg',
    body: padTo(100, JPEG_PREFIX), // 100 bytes claiming a multi-chunk file
  });
  assert.equal(r.status, 400);
  assert.equal(ctx.mock.state.sessionsCount(), 0);

  // 5. Valid PNG -> completes
  r = await chunkReq(B, { id: 'magic_png_00001', total: S, name: 'pic.png', mime: 'image/png', body: padTo(S, PNG_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);

  // 6. Valid HEIC -> completes
  r = await chunkReq(B, { id: 'magic_heic_0001', total: S, name: 'img.heic', mime: 'image/heic', body: padTo(S, HEIC_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);

  // 7. Valid MP4 -> completes
  r = await chunkReq(B, { id: 'magic_mp4_00001', total: S, name: 'clip.mp4', mime: 'video/mp4', body: padTo(S, MP4_PREFIX) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);

  const files = ctx.mock.state.files();
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((f) => f.name).sort(), ['clip.mp4', 'img.heic', 'pic.png']);
});
