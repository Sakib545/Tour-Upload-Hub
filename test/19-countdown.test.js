'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/boot');

async function adminToken(base) {
  const res = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-pass-123' }),
  });
  return (await res.json()).token;
}

function putSite(base, token, content) {
  return fetch(base + '/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ content }),
  });
}

test('tour start/end drive the public countdown', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '' } });
  t.after(() => ctx.close());
  const B = ctx.base;
  const token = await adminToken(B);

  // Nothing set: the page gets empty strings and renders no countdown.
  let cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.tourStartAt, '');
  assert.equal(cfg.tourEndAt, '');

  const start1 = '2026-12-12T03:00:00.000Z';
  const end1 = '2026-12-14T12:00:00.000Z';
  const res = await putSite(B, token, { startAt: start1, endAt: end1 });
  assert.equal(res.status, 200);
  const saved = (await res.json()).site.content;
  assert.equal(saved.startAt, start1);
  assert.equal(saved.endAt, end1);

  cfg = await (await fetch(B + '/api/config')).json();
  assert.equal(cfg.tourStartAt, start1);
  assert.equal(cfg.tourEndAt, end1);

  // A local datetime without a zone is accepted and normalised to an instant.
  const local = await putSite(B, token, { startAt: '2026-12-12T09:00' });
  const normalised = (await local.json()).site.content.startAt;
  assert.equal(normalised, new Date('2026-12-12T09:00').toISOString());

  // Junk and out-of-range values are dropped rather than stored.
  for (const bad of ['not a date', '1899-01-01T00:00:00Z', '<script>alert(1)</script>']) {
    const r = await putSite(B, token, { startAt: bad });
    assert.equal((await r.json()).site.content.startAt, '', `rejected: ${bad}`);
  }

  // Clearing the field removes the countdown again.
  const cleared = await putSite(B, token, { startAt: '', endAt: '' });
  const after = (await cleared.json()).site.content;
  assert.equal(after.startAt, '');
  assert.equal(after.endAt, '');
});
