'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

const S = 4096;

function upload(base, { id, name, category }) {
  return fetch(base + '/api/upload/chunk', {
    method: 'POST',
    headers: {
      'X-Upload-Id': id,
      'X-Offset': '0',
      'X-Total': String(S),
      'X-File-Name': encodeURIComponent(name),
      'X-Mime': 'image/jpeg',
      'X-Category': category,
    },
    body: padTo(S, JPEG_PREFIX),
  });
}

test('admin can edit tour page content & category folders; they apply instantly', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  // Admin sign-in.
  const login = await fetch(B + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();

  // Writing site settings without a token is rejected.
  const anon = await fetch(B + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: { title: 'hacked' } }),
  });
  assert.equal(anon.status, 401);

  // Save new page content and rename the group folder.
  const put = await fetch(B + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      content: {
        title: 'Cox Tour 2026',
        subtitle: 'সবার ছবি এখানে',
        date: '12–15 Sep 2026',
        location: "Cox's Bazar, Bangladesh",
        privacyNote: 'শুধু দলটির জন্য',
        coverUrl: 'https://example.com/cover.jpg',
      },
      categories: [
        { id: 'single', media: 'photo', label: 'একক ছবি', folder: 'Photos' },
        { id: 'group', media: 'photo', label: 'গ্রুপ ছবি', folder: 'Group Shots' },
        { id: 'video', media: 'video', label: 'ভিডিও', folder: 'Videos' },
      ],
    }),
  });
  assert.equal(put.status, 200);
  const { site } = await put.json();
  assert.equal(site.content.title, 'Cox Tour 2026');
  assert.equal(site.categories.find((c) => c.id === 'group').folder, 'Group Shots');

  // The public page config reflects the edits right away.
  const cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.tourTitle, 'Cox Tour 2026');
  assert.equal(cfg.tourLocation, "Cox's Bazar, Bangladesh");
  assert.equal(cfg.categories.find((c) => c.id === 'group').label, 'গ্রুপ ছবি');

  // A group upload after the rename lands in the NEW "Group Shots" folder.
  const up = await upload(B, { id: 'renamed_01', name: 'after-rename.jpg', category: 'group' });
  assert.equal(up.status, 200);
  const groupFolder = ctx.mock.state.folders().find((f) => f.name === 'Group Shots');
  assert.ok(groupFolder, 'the renamed Group Shots folder was created');
  const file = ctx.mock.state.files().find((f) => f.name === 'after-rename.jpg');
  assert.deepEqual(file.parents, [groupFolder.id]);

  // An empty title/cover keeps working (title falls back to a sane default).
  const put2 = await fetch(B + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      content: { title: '', coverUrl: 'not-a-url' },
      categories: [],
    }),
  });
  assert.equal(put2.status, 200);
  const { site: site2 } = await put2.json();
  assert.equal(site2.content.title, 'Cox Tour 2026');   // previous kept
  assert.equal(site2.content.coverUrl, 'https://example.com/cover.jpg'); // invalid URL kept previous
});
