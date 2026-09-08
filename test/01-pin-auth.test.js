'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');
const { signToken } = require('../utils/tokens');

const PIN = '7788';

async function jsonReq(base, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, data };
}

function chunkBody(base, opts) {
  const h = {
    'X-Upload-Id': opts.id,
    'X-Offset': String(opts.offset),
    'X-Total': String(opts.total),
    'X-File-Name': encodeURIComponent(opts.name || 'photo.jpg'),
    'X-Mime': opts.mime || 'image/jpeg',
  };
  if (opts.token) h['X-Upload-Token'] = opts.token;
  if (opts.uploader) h['X-Uploader'] = encodeURIComponent(opts.uploader);
  return jsonReq(base, '/api/upload/chunk', { method: 'POST', headers: h, body: opts.body });
}

test('PIN authentication: wrong/correct pin, gate on uploads, expiry', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: PIN, ADMIN_PASSWORD: 'x'.repeat(12) } });
  t.after(() => ctx.close());
  const B = ctx.base;

  // wrong PIN -> 401
  let r = await jsonReq(B, '/api/verify-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '0000' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.data && r.data.error, 'INVALID_PIN');

  // correct PIN -> token + no-store header
  const pinRes = await fetch(B + '/api/verify-pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(pinRes.status, 200);
  assert.equal(pinRes.headers.get('cache-control'), 'no-store');
  const pinData = await pinRes.json();
  assert.ok(pinData.token && pinData.token.length > 40);

  // config reports pinRequired
  const cfg = await jsonReq(B, '/api/config');
  assert.equal(cfg.data.pinRequired, true);

  // upload without token -> 401 PIN_REQUIRED
  const total = 4096;
  r = await chunkBody(B, { id: 'pin_test_000001', offset: 0, total, body: padTo(total, JPEG_PREFIX) });
  assert.equal(r.status, 401);
  assert.equal(r.data && r.data.error, 'PIN_REQUIRED');

  // upload with an EXPIRED pin token -> 401 PIN_REQUIRED
  const expired = signToken({ purpose: 'pin', exp: Date.now() - 1000 }, PIN, 'pin');
  r = await chunkBody(B, {
    id: 'pin_test_000002', offset: 0, total, token: expired,
    body: padTo(total, JPEG_PREFIX),
  });
  assert.equal(r.status, 401);
  assert.equal(r.data && r.data.error, 'PIN_REQUIRED');

  // upload with a valid token -> done, uploader metadata stored in Drive
  r = await chunkBody(B, {
    id: 'pin_test_000003', offset: 0, total,
    token: pinData.token, uploader: 'Rahim', name: 'rahim.jpg',
    body: padTo(total, JPEG_PREFIX),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.ok(r.data.file && r.data.file.id);
  assert.equal(r.data.file.name, 'rahim.jpg');

  const stored = ctx.mock.state.files();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'rahim.jpg');
  const desc = JSON.parse(stored[0].description || '{}');
  assert.equal(desc.u, 'Rahim');
});
