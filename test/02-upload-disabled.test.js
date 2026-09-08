'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, JPEG_PREFIX, padTo } = require('./helpers/boot');

test('uploads-disabled mode rejects all upload traffic', async (t) => {
  const ctx = await start({ env: { ENABLE_UPLOADS: 'false' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  const cfg = await fetch(B + '/api/config');
  const cfgData = await cfg.json();
  assert.equal(cfgData.uploadsEnabled, false);

  const total = 4096;
  const headers = {
    'X-Upload-Id': 'disabled_test_01',
    'X-Offset': '0',
    'X-Total': String(total),
    'X-File-Name': encodeURIComponent('no.jpg'),
    'X-Mime': 'image/jpeg',
  };
  const res = await fetch(B + '/api/upload/chunk', {
    method: 'POST',
    headers,
    body: padTo(total, JPEG_PREFIX),
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 403);
  assert.equal(data.error, 'UPLOADS_DISABLED');
});
