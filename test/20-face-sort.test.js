'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, MP4_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

/**
 * The recognition model itself is exercised separately (it needs real photos);
 * these tests cover the plumbing around it with a stubbed describer, so the
 * routing rules are pinned: exactly one matching face moves the file, anything
 * else leaves it alone.
 */

function fakeDescriptor(seed) {
  return Array.from({ length: 128 }, (_, i) => Math.sin(seed * 7.13 + i * 0.11));
}

async function adminToken(base) {
  const res = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  return (await res.json()).token;
}

function upload(base, { id, name, mime, prefix }) {
  return fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': id, 'X-Offset': '0', 'X-Total': String(S),
      'X-File-Name': encodeURIComponent(name), 'X-Mime': mime,
    },
    body: padTo(S, prefix),
  });
}

test('a single recognised face moves the photo into that person folder', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '', FACE_SORT: 'true' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const faces = require('../services/faces');
  const site = require('../services/site');

  const token = await adminToken(B);
  const added = await fetch(B + '/api/admin/people', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: 'রিফাত' }),
  });
  assert.equal(added.status, 200);
  const person = (await added.json()).person;
  assert.equal(person.name, 'রিফাত');

  // Enrol Rifat's face directly (the HTTP route needs the real model).
  assert.equal(site.addDescriptor(person.id, fakeDescriptor(1)), true);

  // One photo of Rifat, one of a stranger, one group shot, one video.
  const byName = {
    'rifat.jpg': [{ descriptor: fakeDescriptor(1), score: 0.99 }],
    'stranger.jpg': [{ descriptor: fakeDescriptor(9), score: 0.99 }],
    'group.jpg': [
      { descriptor: fakeDescriptor(1), score: 0.99 },
      { descriptor: fakeDescriptor(9), score: 0.98 },
    ],
    'nobody.jpg': [],
  };
  faces.setDescriberForTests(async () => byName[current] || []);

  let current = null;
  for (const [name, mime, prefix] of [
    ['rifat.jpg', 'image/jpeg', JPEG_PREFIX],
    ['stranger.jpg', 'image/jpeg', JPEG_PREFIX],
    ['group.jpg', 'image/jpeg', JPEG_PREFIX],
    ['nobody.jpg', 'image/jpeg', JPEG_PREFIX],
    ['clip.mp4', 'video/mp4', MP4_PREFIX],
  ]) {
    current = name;
    const id = 'face_' + name.replace(/\W/g, '_').slice(0, 10) + '_1';
    assert.equal((await upload(B, { id, name, mime, prefix })).status, 200);
    await faces.drain();
  }

  const folders = ctx.mock.state.folders();
  const peopleRoot = folders.find((f) => f.name === 'People');
  const rifatFolder = folders.find((f) => f.name === 'রিফাত');
  assert.ok(peopleRoot, 'a People folder was created');
  assert.ok(rifatFolder, "the person's folder was created");
  assert.deepEqual(rifatFolder.parents, [peopleRoot.id], 'nested under People');

  const stored = Object.fromEntries(ctx.mock.state.files().map((f) => [f.name, f.parents]));
  assert.deepEqual(stored['rifat.jpg'], [rifatFolder.id], 'the single match moved');
  for (const name of ['stranger.jpg', 'group.jpg', 'nobody.jpg', 'clip.mp4']) {
    assert.ok(!stored[name].includes(rifatFolder.id), `${name} stayed put`);
  }

  // Moved photos are still listed, and the gallery still serves them.
  const { items } = await (await fetch(B + '/api/gallery')).json();
  assert.ok(items.some((i) => i.name === 'rifat.jpg'), 'still in the gallery');

  const status = faces.status();
  assert.equal(status.moved, 1);
  assert.equal(status.failed, 0);
});

test('with no enrolled faces nothing is touched', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '', FACE_SORT: 'true' } });
  t.after(() => ctx.close());
  const faces = require('../services/faces');
  const site = require('../services/site');
  for (const p of site.people) site.removePerson(p.id);

  faces.setDescriberForTests(async () => [{ descriptor: fakeDescriptor(1), score: 0.99 }]);
  assert.equal((await upload(ctx.base, {
    id: 'face_nopeople_01', name: 'alone.jpg', mime: 'image/jpeg', prefix: JPEG_PREFIX,
  })).status, 200);
  await faces.drain();

  assert.ok(!ctx.mock.state.folders().some((f) => f.name === 'People'));
});

test('matching is by distance, with a threshold', () => {
  const faces = require('../services/faces');
  const a = fakeDescriptor(1);
  const near = a.map((v, i) => v + (i % 2 ? 0.01 : -0.01));
  const far = fakeDescriptor(42);
  const people = [{ id: 'p_aaaaaa', name: 'A', descriptors: [a] }];

  assert.ok(faces.distance(a, near) < faces.distance(a, far));
  assert.equal(faces.matchPerson(near, people).person.id, 'p_aaaaaa');
  assert.equal(faces.matchPerson(far, people), null);
  assert.equal(faces.matchPerson(a, []), null);
});

test('the beach crew is exposed to the public page and can be restyled', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '', FACE_SORT: 'true' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const site = require('../services/site');
  for (const p of site.people) site.removePerson(p.id);

  const token = await adminToken(B);
  const H = { 'content-type': 'application/json', Authorization: 'Bearer ' + token };
  const created = await (await fetch(B + '/api/admin/people', {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'তানভীর' }),
  })).json();
  const id = created.person.id;

  // Every person gets figure colours, and the public page can read them.
  let cfg = await (await fetch(B + '/api/config')).json();
  const member = cfg.crew.find((c) => c.id === id);
  assert.ok(member, 'the person appears in the crew');
  assert.match(member.avatar.skin, /^#[0-9a-f]{6}$/);
  assert.equal(member.hasFace, false, 'no portrait until someone enrols one');
  assert.equal(cfg.heroCrew, 'cartoon');

  // Recolouring is admin-only and sanitised.
  const patched = await fetch(B + '/api/admin/people/' + id, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ avatar: { shirt: '#ff8800', hair: 'javascript:x' } }),
  });
  assert.equal(patched.status, 200);
  cfg = await (await fetch(B + '/api/config')).json();
  const after = cfg.crew.find((c) => c.id === id);
  assert.equal(after.avatar.shirt, '#ff8800');
  assert.match(after.avatar.hair, /^#[0-9a-f]{6}$/, 'a junk colour is refused, not stored');

  // The portrait is only served once one exists.
  assert.equal((await fetch(B + '/api/crew/' + id + '/face.jpg')).status, 404);
  assert.equal(site.setPortrait(id, Buffer.from('ffd8ffe000104a4649460001', 'hex')), true);
  const face = await fetch(B + '/api/crew/' + id + '/face.jpg');
  assert.equal(face.status, 200);
  assert.equal(face.headers.get('content-type'), 'image/jpeg');
  assert.equal((await (await fetch(B + '/api/config')).json()).crew.find((c) => c.id === id).hasFace, true);

  // The hero mode is a setting like any other.
  const mode = await fetch(B + '/api/admin/settings', {
    method: 'PUT', headers: H, body: JSON.stringify({ heroCrew: 'photo' }),
  });
  assert.equal(mode.status, 200);
  assert.equal((await mode.json()).settings.heroCrew, 'photo');
  assert.equal((await (await fetch(B + '/api/config')).json()).heroCrew, 'photo');

  // Anything outside the three known modes is ignored.
  await fetch(B + '/api/admin/settings', {
    method: 'PUT', headers: H, body: JSON.stringify({ heroCrew: 'nonsense' }),
  });
  assert.equal((await (await fetch(B + '/api/config')).json()).heroCrew, 'photo');
});
