'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/boot');

/** The mini game is a plain page: no PIN, no Drive, nothing to break uploads. */
test('the mini game is served and needs no authentication', async (t) => {
  const ctx = await start({ env: { TOUR_UPLOAD_PIN: '4321' } });
  t.after(() => ctx.close());
  const B = ctx.base;

  for (const path of ['/game', '/game/', '/js/game.js', '/js/game-ui.js']) {
    const res = await fetch(B + path);
    assert.equal(res.status, 200, path);
  }

  const page = await (await fetch(B + '/game')).text();
  assert.match(page, /raceCanvas/, 'the canvas is in the page');
  assert.match(page, /game-ui\.js/, 'the wiring script is loaded');
  assert.equal((await fetch(B + '/game')).headers.get('cache-control'), 'no-cache');

  // The home page offers a way in.
  const home = await (await fetch(B + '/')).text();
  assert.match(home, /href="\/game"/);
});
