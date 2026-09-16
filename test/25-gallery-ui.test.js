'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/gallery.js'), 'utf8');

function element(tag = 'div') {
  return {
    tagName: tag, hidden: false, style: {}, dataset: {}, children: [], events: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    set textContent(value) { this.text = String(value); this.children = []; },
    get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    addEventListener(name, fn) { this.events[name] = fn; },
    setAttribute() {}, focus() {},
  };
}
async function boot({ cfg = {}, replies = [{ items: [] }] } = {}) {
  const nodes = new Map();
  const get = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  get('#pinGate').hidden = true;
  const calls = [];
  const storage = { getItem() { return null; }, setItem() {} };
  vm.runInNewContext(source, {
    $: get, $$: () => [],
    document: { getElementById: id => get('#' + id), createElement: element,
      createDocumentFragment: element, createTextNode: text => ({ textContent: text }),
      addEventListener() {}, body: element() },
    sessionStorage: storage, localStorage: storage,
    IntersectionObserver: class { observe() {} unobserve() {} },
    api: async url => {
      calls.push(url);
      if (url === '/api/config') return cfg;
      const response = replies.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return { get, calls, settle };
}
const failure = (code, status = 500) => Object.assign(new Error(code), { code, status });

test('gallery script boots and renders a photo', async () => {
  const app = await boot({ replies: [{ items: [{ id: 'photo123', name: 'Photo', isImage: true, src: '/photo', download: '/photo' }] }] });
  assert.deepEqual(app.calls, ['/api/config', '/api/gallery']);
  assert.equal(app.get('#galleryStatus').hidden, true);
  assert.equal(app.get('#gallerySkeleton').hidden, true);
  assert.equal(app.get('#galleryBar').hidden, false);
  assert.ok(app.get('#galleryGrid').children.length);
});
test('Drive authentication failure is distinguished from network failure', async () => {
  const app = await boot({ replies: [failure('DRIVE_AUTH')] });
  assert.match(app.get('#galleryStatus').textContent, /Drive সংযোগ সমস্যা/);
  assert.doesNotMatch(app.get('#galleryStatus').textContent, /নেটওয়ার্ক সমস্যা/);
});
test('retry recovers from a network failure', async () => {
  const app = await boot({ replies: [failure('NETWORK', 0), { items: [] }] });
  const button = app.get('#galleryStatus').children.find(c => c.tagName === 'button');
  assert.ok(button);
  button.events.click();
  await app.settle();
  assert.match(app.get('#galleryStatus').textContent, /প্রথম ছবিটি Upload করুন/);
  assert.equal(app.get('#galleryStatus').style.color, '');
  assert.equal(app.get('#gallerySkeleton').hidden, true);
});
test('PIN protection is preserved', async () => {
  const app = await boot({ cfg: { galleryPinRequired: true, galleryEnabled: true } });
  assert.deepEqual(app.calls, ['/api/config']);
  assert.equal(app.get('#pinGate').hidden, false);
});
test('expired PIN token shows the gate', async () => {
  const app = await boot({ replies: [failure('GALLERY_PIN_REQUIRED', 401)] });
  assert.equal(app.get('#pinGate').hidden, false);
});
test('only explicit gallery-disabled errors say the gallery is closed', async () => {
  const disabled = await boot({ replies: [failure('GALLERY_DISABLED', 404)] });
  assert.match(disabled.get('#galleryStatus').textContent, /বন্ধ আছে/);
  const missing = await boot({ replies: [failure('NOT_FOUND', 404)] });
  assert.doesNotMatch(missing.get('#galleryStatus').textContent, /বন্ধ আছে/);
});
test('invalid success payload is handled as a recoverable failure', async () => {
  const app = await boot({ replies: [null] });
  assert.match(app.get('#galleryStatus').textContent, /সঠিক উত্তর আসেনি/);
  assert.ok(app.get('#galleryStatus').children.find(c => c.tagName === 'button'));
});
