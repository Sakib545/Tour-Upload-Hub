'use strict';

/**
 * Builds a single self-contained HTML file showing the home hero and the
 * countdown exactly as the deployed site renders them — CSS inlined, a small
 * stand-in for tour.js, no server needed. Handy for checking a visual change
 * before pushing.
 *
 *   node scripts/build-preview.js [outputPath] [portraitsDir]
 *
 * Pass a folder of square portrait JPEGs (the same 160px crops the enrolment
 * route stores) to preview the beach crew with real faces as well as cartoons;
 * the file then carries a toggle between the two.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const out = process.argv[2] || path.join(ROOT, 'hero-countdown-preview.html');
const portraitsDir = process.argv[3] || '';

// Portraits are embedded as data URLs so the preview stays a single file.
// An optional avatars.json in the same folder supplies per-person colours,
// e.g. the skin tone the enrolment step reads off each portrait.
const avatarsPath = portraitsDir ? path.join(portraitsDir, 'avatars.json') : '';
const avatarsByFile = avatarsPath && fs.existsSync(avatarsPath)
  ? JSON.parse(fs.readFileSync(avatarsPath, 'utf8'))
  : {};
const portraitFiles = portraitsDir && fs.existsSync(portraitsDir)
  ? fs.readdirSync(portraitsDir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, 8)
  : [];
const avatars = portraitFiles.map((f) => avatarsByFile[f] || null);

const portraits = portraitsDir && fs.existsSync(portraitsDir)
  ? fs.readdirSync(portraitsDir)
      .filter((f) => /\.jpe?g$/i.test(f))
      .sort()
      .slice(0, 6)
      .map((f) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(portraitsDir, f)).toString('base64'))
  : [];

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');

const crewJs = fs.readFileSync(path.join(ROOT, 'public/js/crew.js'), 'utf8');
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

  // A sample crew, so the beach figures can be checked without a server.
  var PORTRAITS = __PORTRAITS__;
  var AVATARS = __AVATARS__;
  var PALETTE = [
    { skin: '#efbd93', hair: '#2b1d17', shirt: '#17948f', shorts: '#2b3a52' },
    { skin: '#d1996a', hair: '#c98b3c', shirt: '#d9483b', shorts: '#3b3f2c' },
    { skin: '#9a6440', hair: '#1c130f', shirt: '#6b4bd6', shorts: '#243b46' },
    { skin: '#f7d7bd', hair: '#5b3b21', shirt: '#ec4899', shorts: '#4a3f6b' },
    { skin: '#7a4a2c', hair: '#6b6b6b', shirt: '#f59e0b', shorts: '#2b3a52' },
    { skin: '#d1996a', hair: '#2b1d17', shirt: '#0ea5e9', shorts: '#243b46' },
  ];
  var NAMES = ['বন্ধু ১', 'বন্ধু ২', 'বন্ধু ৩', 'বন্ধু ৪', 'বন্ধু ৫', 'বন্ধু ৬', 'বন্ধু ৭'];
  var count = PORTRAITS.length || 5;
  var CREW = [];
  for (var i = 0; i < count; i++) {
    var base = PALETTE[i % PALETTE.length];
    var sampled = AVATARS[i] || null;
    CREW.push({
      id: 'p' + (i + 1),
      name: NAMES[i],
      // The skin tone read off the portrait wins; the rest stays palette.
      avatar: sampled ? Object.assign({}, base, sampled) : base,
      hasFace: !!PORTRAITS[i],
    });
  }

  function drawCrew(mode) {
    renderCrew({ heroCrew: mode, crew: CREW });
    if (mode !== 'photo') return;
    // The real page serves these from /api/crew/<id>/face.jpg; here they are
    // embedded, so the preview needs no server.
    var imgs = document.querySelectorAll('image[data-person]');
    for (var i = 0; i < imgs.length; i++) {
      var idx = CREW.findIndex(function (c) { return c.id === imgs[i].getAttribute('data-person'); });
      if (idx >= 0 && PORTRAITS[idx]) imgs[i].setAttribute('href', PORTRAITS[idx]);
    }
  }
  drawCrew(PORTRAITS.length ? 'photo' : 'cartoon');

  var toggle = document.getElementById('crewToggle');
  if (toggle) {
    if (!PORTRAITS.length) toggle.hidden = true;
    toggle.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      var all = toggle.querySelectorAll('button[data-mode]');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('is-on', all[i] === btn);
      drawCrew(btn.dataset.mode);
    });
  }
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
    .preview-toggle { max-width: 620px; margin: 18px auto 0; justify-content: center; }
  </style>
</head>
<body class="${bodyClass}">
${hero}
  <div class="gallery-bar preview-toggle" id="crewToggle">
    <button type="button" class="chip is-on" data-mode="photo">আসল মুখ</button>
    <button type="button" class="chip" data-mode="cartoon">কার্টুন মূর্তি</button>
    <button type="button" class="chip" data-mode="off">কেউ নয়</button>
  </div>
  <p class="preview-note">
    <b>এটি শুধু preview</b> — আসল সাইট নয়। Patch deploy করার পর hero, লেখা আর countdown
    ঠিক এভাবেই দেখাবে। এখানে ৩০ দিন পরের একটি তারিখ ধরে ঘড়ি চলছে।
    ব্রাউজারের theme light / dark বদলে দুটোই দেখে নিতে পারেন।
  </p>
<script>${crewJs}</script>
<script>${script}</script>
</body>
</html>
`;

fs.writeFileSync(
  out,
  page
    .replace('__PORTRAITS__', JSON.stringify(portraits))
    .replace('__AVATARS__', JSON.stringify(avatars))
);
console.log(`preview written: ${out} (${page.length} bytes)`);
