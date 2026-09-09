'use strict';

/**
 * Builds a single self-contained HTML file showing the home hero and the
 * countdown exactly as the deployed site renders them — CSS inlined, a small
 * stand-in for tour.js, no server needed. Handy for checking a visual change
 * before pushing.
 *
 *   node scripts/build-preview.js [outputPath]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = process.argv[2] || path.join(ROOT, 'hero-countdown-preview.html');

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');

const head = html.slice(0, html.indexOf('</head>'));
const fonts = (head.match(/<link[^>]*fonts[^>]*>/g) || []).join('\n  ');
const hero = html.slice(html.indexOf('<header'), html.indexOf('</header>') + 9);
const bodyClass = (html.match(/<body class="([^"]*)"/) || [, 'page-home'])[1];

const script = `
  // Minimal stand-in for tour.js: fills the hero and ticks the clock.
  var start = new Date(Date.now() + 30 * 864e5 + 5 * 36e5 + 42 * 6e4);
  var q = function (s) { return document.querySelector(s); };
  var bn = function (n) {
    try { return Number(n).toLocaleString('bn-BD', { useGrouping: false }); }
    catch (e) { return String(n); }
  };

  q('#heroTitle').textContent = 'Tour Memories';
  q('#heroSub').textContent =
    'আমাদের Tour-এর সব ছবি ও ভিডিও এখানে থাকবে — আপনার কাছে থাকলে আপলোড দিন';
  q('#heroMeta').textContent =
    '📅 ' + start.toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' }) +
    ', ' + start.toLocaleTimeString('bn-BD', { hour: 'numeric', minute: '2-digit' }) +
    '  •  📍 Cox’s Bazar by Shakil Sheikh';

  q('#countdown').hidden = false;
  q('#cdLabel').textContent = 'ট্যুর শুরু হতে বাকি';
  q('#cdWhen').textContent =
    start.toLocaleDateString('bn-BD', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
    ' · ' + start.toLocaleTimeString('bn-BD', { hour: 'numeric', minute: '2-digit' });

  function set(id, v) {
    var n = q(id);
    var t = bn(v);
    if (n.textContent === t) return;
    n.textContent = t;
    n.classList.remove('cd-bump');
    void n.offsetWidth;
    n.classList.add('cd-bump');
  }
  function tick() {
    var left = Math.max(0, start - Date.now());
    var d = Math.floor(left / 864e5); left -= d * 864e5;
    var h = Math.floor(left / 36e5); left -= h * 36e5;
    var m = Math.floor(left / 6e4); left -= m * 6e4;
    set('#cdDays', d); set('#cdHours', h); set('#cdMins', m); set('#cdSecs', Math.floor(left / 1e3));
  }
  tick();
  setInterval(tick, 1000);
`;

const page = `<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tour Memories — hero & countdown preview</title>
  ${fonts}
  <style>${css}</style>
  <style>
    .preview-note {
      max-width: 620px; margin: 26px auto; padding: 16px 20px;
      font-family: var(--font); color: var(--muted); font-size: 0.92rem; line-height: 1.7;
      border: 1px dashed var(--line); border-radius: 16px;
    }
    .preview-note b { color: var(--text); }
  </style>
</head>
<body class="${bodyClass}">
${hero}
  <p class="preview-note">
    <b>এটি শুধু preview</b> — আসল সাইট নয়। Patch deploy করার পর hero, লেখা আর countdown
    ঠিক এভাবেই দেখাবে। এখানে ৩০ দিন পরের একটি তারিখ ধরে ঘড়ি চলছে।
    ব্রাউজারের theme light / dark বদলে দুটোই দেখে নিতে পারেন।
  </p>
<script>${script}</script>
</body>
</html>
`;

fs.writeFileSync(out, page);
console.log(`preview written: ${out} (${page.length} bytes)`);
