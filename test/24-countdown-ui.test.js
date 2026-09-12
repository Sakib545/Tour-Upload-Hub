'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/tour.js'), 'utf8');
const countdownCode = source.slice(source.indexOf('  function prettyDate('),
  source.indexOf('  /* ── Boot'));

function clock(config, initialNow, reducedMotion = false) {
  let now = initialNow;
  const intervals = new Map();
  const events = {};
  let nextId = 0;
  const el = {};
  for (const key of ['countdown', 'cdLabel', 'cdWhen', 'cdDays', 'cdHours', 'cdMins', 'cdSecs']) {
    const classes = new Set();
    el[key] = { hidden: true, textContent: '', className: '', offsetWidth: 1,
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c) } };
  }
  class ClockDate extends Date { static now() { return now; } }
  const document = { hidden: false, addEventListener: (name, cb) => { events[name] = cb; } };
  const context = vm.createContext({ cfg: config, el, reducedMotion, document,
    Date: ClockDate, setInterval: (fn) => { intervals.set(++nextId, fn); return nextId; },
    clearInterval: (id) => intervals.delete(id) });
  vm.runInContext('let countdownTimer = null;\n' + countdownCode + '\nstartCountdown();', context);
  return { el, intervals, document, events, advance(value) {
    now = value;
    for (const tick of intervals.values()) tick();
  } };
}

test('public countdown runs before PIN entry and counts all four units', () => {
  const start = Date.parse('2026-09-19T00:15:00Z');
  const c = clock({ tourStartAt: new Date(start).toISOString() }, start - 90061000);
  assert.equal(c.el.countdown.hidden, false);
  assert.equal(c.el.countdown.className, 'countdown');
  for (const key of ['cdDays', 'cdHours', 'cdMins', 'cdSecs']) {
    assert.equal(c.el[key].textContent, (1).toLocaleString('bn-BD'));
  }
  assert.equal(c.intervals.size, 1);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
});

test('clock transitions live then past and stops; past dates never start a timer', () => {
  const start = Date.parse('2026-09-19T00:15:00Z');
  const cfg = { tourStartAt: new Date(start).toISOString(), tourEndAt: new Date(start + 60000).toISOString() };
  const c = clock(cfg, start - 1000);
  c.advance(start);
  assert.equal(c.el.countdown.className, 'countdown is-live');
  c.advance(start + 60001);
  assert.equal(c.el.countdown.className, 'countdown is-past');
  assert.equal(c.intervals.size, 0);
  assert.equal(clock(cfg, start + 60001).intervals.size, 0);
});

test('background clock pauses and catches up once; reduced motion skips digit animation', () => {
  const start = Date.parse('2026-09-19T00:15:00Z');
  const c = clock({ tourStartAt: new Date(start).toISOString() }, start - 60000, true);
  assert.equal(c.el.cdSecs.classList.contains('cd-bump'), false);
  c.document.hidden = true;
  c.events.visibilitychange();
  assert.equal(c.intervals.size, 0);
  c.advance(start);
  c.document.hidden = false;
  c.events.visibilitychange();
  c.events.visibilitychange();
  assert.equal(c.el.countdown.className, 'countdown is-live');
  assert.equal(c.intervals.size, 1);
});

test('unset and invalid dates preserve the existing hidden-countdown behavior', () => {
  for (const tourStartAt of ['', 'invalid']) {
    const c = clock({ tourStartAt }, Date.now());
    assert.equal(c.el.countdown.hidden, true);
    assert.equal(c.intervals.size, 0);
  }
});

test('home header overrides the fixed illustration height without changing its artwork band', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
  const rules = [...css.matchAll(/body\.page-home \.hero\s*\{([^}]+)\}/g)];
  assert.match(rules.at(-1)[1], /height:\s*auto\s*;/);
  assert.match(rules.at(-1)[1], /padding:\s*var\(--band\)/);
  assert.match(css, /\.countdown \.cd-n\.cd-bump \{ animation: none !important; \}/);
});
