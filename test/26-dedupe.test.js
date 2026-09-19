'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, MP4_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;
const SIG_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SIG_B = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

async function upload(base, { id, name, sig, prefix = JPEG_PREFIX, mime = 'image/jpeg' }) {
  const headers = {
    'X-Upload-Id': id,
    'X-Offset': '0',
    'X-Total': String(S),
    'X-File-Name': encodeURIComponent(name),
    'X-Mime': mime,
  };
  if (sig) headers['X-File-Sig'] = sig;
  const res = await fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers,
    body: padTo(S, prefix),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function precheck(base, sigs) {
  const res = await fetch(base + '/api/upload/precheck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sigs }),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('duplicate detection: the same file is never stored or sent twice', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;

  // 1. Nothing is known before anything was uploaded.
  let pc = await precheck(B, [SIG_A]);
  assert.equal(pc.status, 200);
  assert.deepEqual(pc.data.known, {});

  // 2. First upload of the file goes through normally.
  let r = await upload(B, { id: 'dedupe_first_01', name: 'sunset.jpg', sig: SIG_A });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.ok(!r.data.duplicate);
  assert.equal(ctx.mock.state.files().length, 1);
  const sessionsAfterFirst = ctx.mock.state.sessionsCount();

  // 3. The precheck now reports it — the client skips the file entirely.
  pc = await precheck(B, [SIG_A, SIG_B]);
  assert.equal(pc.status, 200);
  assert.ok(pc.data.known[SIG_A], 'uploaded signature is known');
  assert.equal(pc.data.known[SIG_A].name, 'sunset.jpg');
  assert.ok(!pc.data.known[SIG_B], 'an unseen signature stays unknown');

  // 4. A client that sends it anyway (fresh upload id, even a different
  //    file name) is answered as a duplicate — no second Drive file, no new
  //    Drive session.
  r = await upload(B, { id: 'dedupe_again_01', name: 'sunset-copy.jpg', sig: SIG_A });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.file.name, 'sunset.jpg', 'points at the stored copy');
  assert.equal(ctx.mock.state.files().length, 1, 'nothing stored twice');
  assert.equal(ctx.mock.state.sessionsCount(), sessionsAfterFirst, 'no Drive session opened');

  // 5. A genuinely different file with its own signature still uploads.
  r = await upload(B, {
    id: 'dedupe_other_01', name: 'clip.mp4', sig: SIG_B,
    prefix: MP4_PREFIX, mime: 'video/mp4',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.ok(!r.data.duplicate);
  assert.equal(ctx.mock.state.files().length, 2);

  // 6. An upload with no signature at all behaves exactly as before.
  r = await upload(B, { id: 'dedupe_nosig_01', name: 'nosig.jpg' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.ok(!r.data.duplicate);
  assert.equal(ctx.mock.state.files().length, 3);

  // 7. Garbage signatures are ignored, not trusted and not crashed on.
  pc = await precheck(B, ['../../etc/passwd', 'ZZZZ', '', 12345]);
  assert.equal(pc.status, 200);
  assert.deepEqual(pc.data.known, {});
});

test('duplicate index is rebuilt from Drive, so it survives a restart', async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const B = ctx.base;
  const dedupe = require('../services/dedupe');
  // Tests in one file share the module registry — this run starts against a
  // brand-new mock Drive, so drop anything the previous test remembered.
  dedupe.reset();

  const r = await upload(B, { id: 'dedupe_persist01', name: 'boat.jpg', sig: SIG_A });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);

  // Simulate a redeploy: the in-memory map is gone, Drive is not.
  dedupe.reset();

  const pc = await precheck(B, [SIG_A]);
  assert.equal(pc.status, 200);
  assert.ok(pc.data.known[SIG_A], 'signature recovered from the file description');
  assert.equal(pc.data.known[SIG_A].name, 'boat.jpg');
});
