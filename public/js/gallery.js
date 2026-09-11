'use strict';

/* Gallery page: filterable grid, one-tap downloads, fullscreen lightbox. */

(function () {
  const PIN_KEY = 'tourPinToken';

  const grid = $('#galleryGrid');
  const skeleton = $('#gallerySkeleton');
  const bar = $('#galleryBar');
  const chipsDyn = $('#chipsDyn');
  const status = $('#galleryStatus');
  const lightbox = $('#lightbox');
  const stage = $('#lbStage');
  const captionEl = $('#lbCaption');
  const lbDownload = $('#lbDownload');
  const lbShare = $('#lbShare');

  /** Absolute URL to the file, for sharing. */
  function shareUrl(item) {
    return new URL(item.src, location.origin).href;
  }

  /**
   * Share via the OS sheet (WhatsApp, Messenger, …) when the browser offers it,
   * otherwise copy the link. Every phone this is used on has Web Share; the
   * copy path is the desktop fallback.
   */
  async function shareItem(item) {
    const url = shareUrl(item);
    const data = { title: 'Tour Memories', text: 'এই ছবিটা দেখুন', url };
    try {
      if (navigator.share) { await navigator.share(data); return; }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // the user closed the sheet
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('লিংক কপি হয়েছে — WhatsApp-এ পেস্ট করুন।');
    } catch (e) {
      window.open(url, '_blank');
    }
  }
  const pinGate = $('#pinGate');
  const pinForm = $('#pinForm');
  const pinInput = $('#pinInput');
  const pinSubmit = $('#pinSubmit');
  const pinError = $('#pinError');
  const btnSelect = $('#btnSelect');
  const btnDownload = $('#btnDownload');

  let items = [];        // everything the server returned
  let shown = [];        // what the current filter shows (lightbox order)
  let pageCfg = null;    // /api/config payload (category chips etc.)
  let filters = [];      // [{ id, label, count }] — category or photo/video chips
  let people = [];       // [{ id: 'person:<id>', label, count }] — face-sorted
  let filter = 'all';
  let current = -1;
  let selecting = false;
  const picked = new Set();

  /* ── PIN gate (shared token with the upload page) ─────────── */

  function showPinGate(message) {
    pinGate.hidden = false;
    skeleton.hidden = true;
    status.hidden = true;
    pinError.hidden = !message;
    if (message) pinError.textContent = message;
    pinInput.value = '';
    pinInput.focus();
  }

  async function submitPin(ev) {
    ev.preventDefault();
    pinSubmit.disabled = true;
    pinError.hidden = true;
    const pin = pinInput.value.trim();
    try {
      const data = await api('/api/verify-pin', { method: 'POST', body: { pin } });
      sessionStorage.setItem(PIN_KEY, data.token);
      pinGate.hidden = true;
      status.hidden = false;
      status.textContent = 'ছবি লোড হচ্ছে…';
      showSkeleton();
      load();
    } catch (err) {
      pinError.hidden = false;
      pinError.textContent =
        err.code === 'INVALID_PIN' ? 'PIN সঠিক নয় — আবার চেষ্টা করুন।' : 'যাচাই করা যায়নি। আবার চেষ্টা করুন।';
    } finally {
      pinSubmit.disabled = false;
    }
  }

  pinForm.addEventListener('submit', submitPin);

  function failStatus(message) {
    skeleton.hidden = true;
    status.hidden = false;
    status.style.color = 'var(--danger)';
    status.textContent = message;
  }

  /* ── Loading placeholders ─────────────────────────────────── */

  function showSkeleton(n = 12) {
    skeleton.textContent = '';
    skeleton.hidden = false;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const s = document.createElement('div');
      s.className = 'skeleton';
      s.style.animationDelay = (i * 0.05).toFixed(2) + 's';
      frag.appendChild(s);
    }
    skeleton.appendChild(frag);
  }

  /* ── Grid ─────────────────────────────────────────────────── */

  const lazyObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const img = en.target;
        lazyObserver.unobserve(img);
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.dataset.src = '';
          img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        }
      }
    },
    { rootMargin: '400px' }
  );

  function tileFor(item, index) {
    const tile = document.createElement('div');
    tile.className = 'g-item';
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.style.animationDelay = Math.min(index * 0.025, 0.5).toFixed(3) + 's';

    const fallback = document.createElement('div');
    fallback.className = 'g-fallback';
    fallback.textContent = item.isVideo ? '🎬' : '🖼️';
    tile.appendChild(fallback);

    if (item.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.classList.add('lazy');
      img.loading = 'lazy';
      img.dataset.src = item.thumb;
      img.addEventListener('error', () => img.remove());
      tile.appendChild(img);
      lazyObserver.observe(img);
    }

    if (item.isVideo) {
      const badge = document.createElement('span');
      badge.className = 'g-video-badge';
      badge.textContent = '▶ ভিডিও';
      tile.appendChild(badge);
    }

    // One-tap download, without opening the file first.
    const dl = document.createElement('a');
    dl.className = 'g-dl';
    dl.href = item.download;
    dl.setAttribute('download', item.name);
    dl.title = 'এই ফাইলটি Download করুন';
    dl.textContent = '⬇';
    dl.addEventListener('click', (ev) => ev.stopPropagation());
    tile.appendChild(dl);

    const share = document.createElement('button');
    share.className = 'g-share';
    share.title = 'শেয়ার করুন';
    share.textContent = '↗';
    share.addEventListener('click', (ev) => { ev.stopPropagation(); shareItem(item); });
    tile.appendChild(share);

    const heart = document.createElement('button');
    heart.className = 'g-like' + (liked(item.id) ? ' is-on' : '');
    heart.title = 'পছন্দ';
    heart.textContent = '♥';
    heart.addEventListener('click', (ev) => {
      ev.stopPropagation();
      heart.classList.toggle('is-on', toggleLike(item.id));
      if (heart.classList.contains('is-on')) {
        heart.classList.remove('pop'); void heart.offsetWidth; heart.classList.add('pop');
      }
    });
    tile.appendChild(heart);

    const check = document.createElement('span');
    check.className = 'g-check';
    check.textContent = '✓';
    tile.appendChild(check);

    const activate = () => {
      if (selecting) togglePick(item, tile);
      else openLightbox(index);
    };
    tile.addEventListener('click', activate);
    tile.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
    });
    return tile;
  }

  function itemMatches(item, f) {
    if (f === 'all') return true;
    if (f === 'photo') return !item.isVideo;
    if (f === 'video') return item.isVideo;
    if (f.startsWith('person:')) return item.person === f.slice(7);
    return item.category === f;
  }

  function render() {
    shown = items.filter((it) => itemMatches(it, filter));
    grid.textContent = '';
    if (!shown.length) {
      status.hidden = false;
      if (filter === 'all') {
        status.textContent = 'এখনো কোনো ছবি নেই।';
      } else {
        const chip = filters.concat(people).find((x) => x.id === filter);
        status.textContent = chip
          ? `"${chip.label}"-তে এখনো কিছু নেই।`
          : 'এই ধরনের এখনো কিছু নেই।';
      }
      return;
    }
    status.hidden = true;
    const frag = document.createDocumentFragment();

    if (filter === 'all' && filters.length > 1) {
      // Everything at once reads better grouped: single photos, then group
      // photos, then videos (and any extra category the admin added).
      let index = 0;
      for (const group of filters) {
        const inGroup = shown.filter((it) => itemMatches(it, group.id));
        if (!inGroup.length) continue;
        frag.appendChild(sectionHead(group.label, inGroup.length));
        for (const item of inGroup) frag.appendChild(tileFor(item, index++));
      }
      // `shown` must follow the on-screen order so the lightbox arrows match.
      shown = filters
        .flatMap((group) => shown.filter((it) => itemMatches(it, group.id)))
        .concat(shown.filter((it) => !filters.some((g) => itemMatches(it, g.id))));
    } else {
      shown.forEach((item, i) => frag.appendChild(tileFor(item, i)));
    }
    grid.appendChild(frag);
    refreshBulkButton();
  }

  function sectionHead(label, count) {
    const head = document.createElement('div');
    head.className = 'g-section-head';
    const h = document.createElement('h2');
    h.textContent = label;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = `${count}টি`;
    const line = document.createElement('span');
    line.className = 'line';
    head.append(h, n, line);
    return head;
  }

  /* ── Filters ──────────────────────────────────────────────── */

  /** Build category chips (single / group / video) — or photo/video when the
   *  server did not enable category folders (flat mode). */
  function rebuildFilters() {
    filters = [];
    const cfgCats = (pageCfg && pageCfg.categories) || [];
    if (cfgCats.length) {
      filters = cfgCats.map((c) => ({
        id: c.id,
        label: c.label,
        count: items.filter((i) => i.category === c.id).length,
      }));
    } else {
      filters = [
        { id: 'photo', label: 'ছবি', count: items.filter((i) => !i.isVideo).length },
        { id: 'video', label: 'ভিডিও', count: items.filter((i) => i.isVideo).length },
      ];
    }

    $('#nAll').textContent = items.length;
    chipsDyn.textContent = '';
    // Whoever face sorting has actually filed photos under gets a chip too, so
    // "just my pictures" is one tap rather than a hunt through the whole wall.
    const seen = new Map();
    for (const item of items) {
      if (!item.person) continue;
      const entry = seen.get(item.person) || { name: item.personName || 'নাম নেই', count: 0 };
      entry.count += 1;
      seen.set(item.person, entry);
    }
    people = [...seen.entries()].map(([id, v]) => ({
      id: `person:${id}`, label: v.name, count: v.count, isPerson: true,
    })).sort((a, b) => b.count - a.count);

    $('#nAll').textContent = items.length;
    chipsDyn.textContent = '';
    for (const f of filters.concat(people)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (filter === f.id ? ' is-on' : '') + (f.isPerson ? ' chip-person' : '');
      b.dataset.filter = f.id;
      const span = document.createElement('span');
      span.className = 'chip-n';
      span.textContent = f.count;
      b.appendChild(document.createTextNode(`${f.isPerson ? '👤 ' : ''}${f.label} `));
      b.appendChild(span);
      chipsDyn.appendChild(b);
    }
    for (const chip of $$('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip.dataset.filter === filter);
    }
  }

  function refreshBulkButton() {
    const btn = $('#btnDownloadAll');
    if (!btn) return;
    const chip = filters.concat(people).find((x) => x.id === filter);
    btn.hidden = selecting || !shown.length;
    btn.textContent = chip && chip.isPerson
      ? `⬇ ${chip.label}-এর সব (${shown.length})`
      : `⬇ সব Download (${shown.length})`;
  }

  function setFilter(next) {
    filter = next;
    for (const chip of $$('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip.dataset.filter === next);
    }
    clearPicks();
    render();
    refreshBulkButton();
  }

  // Chip clicks are delegated so dynamically-built category chips work too.
  document.getElementById('galleryBar').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip[data-filter]');
    if (!chip) return;
    setFilter(chip.dataset.filter);
  });

  /* ── Selecting & downloading ──────────────────────────────── */

  function refreshDownloadBtn() {
    const n = picked.size;
    btnDownload.hidden = !selecting;
    btnDownload.disabled = n === 0;
    btnDownload.textContent = n ? `⬇ Download (${n})` : '⬇ Download';
  }

  function togglePick(item, tile) {
    if (picked.has(item.id)) picked.delete(item.id);
    else picked.add(item.id);
    tile.classList.toggle('is-picked', picked.has(item.id));
    refreshDownloadBtn();
  }

  function clearPicks() {
    picked.clear();
    for (const t of $$('.g-item.is-picked')) t.classList.remove('is-picked');
    refreshDownloadBtn();
  }

  btnSelect.addEventListener('click', () => {
    selecting = !selecting;
    grid.classList.toggle('is-selecting', selecting);
    btnSelect.classList.toggle('is-on', selecting);
    btnSelect.textContent = selecting ? 'বাতিল করুন' : 'নির্বাচন করুন';
    clearPicks();
  });

  /* ── Find my photos ───────────────────────────────────────── */

  const findMe = $('#findMe');

  /* Reactions live per device: no accounts, no server writes, and the little
     hearts still make the group compare whose photo did best. */
  const LIKES_KEY = 'tourLikes';
  let likes = {};
  try { likes = JSON.parse(localStorage.getItem(LIKES_KEY) || '{}'); } catch (e) { likes = {}; }
  function liked(id) { return !!likes[id]; }
  function toggleLike(id) {
    if (likes[id]) delete likes[id]; else likes[id] = 1;
    try { localStorage.setItem(LIKES_KEY, JSON.stringify(likes)); } catch (e) { /* private mode */ }
    return !!likes[id];
  }

  function openFindMe() {
    $('#findMeResult').hidden = true;
    $('#findMeResult').innerHTML = '';
    $('#findMeText').hidden = false;
    $('#findMePick').hidden = false;
    findMe.hidden = false;
  }
  function closeFindMe() { findMe.hidden = true; }

  async function runFindMe(file) {
    if (!file) return;
    $('#findMeText').hidden = true;
    $('#findMePick').hidden = true;
    const box = $('#findMeResult');
    box.hidden = false;
    box.innerHTML = '<div class="findme-spinner"></div><p class="muted-text">মুখ মিলিয়ে দেখা হচ্ছে…</p>';

    let data;
    try {
      const token = sessionStorage.getItem(PIN_KEY) || '';
      const res = await fetch('/api/gallery/find-me', {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'image/jpeg',
          ...(token ? { 'X-Upload-Token': token } : {}),
        },
        body: file,
      });
      data = await res.json();
      if (!res.ok) {
        box.innerHTML = `<p class="muted-text">${
          res.status === 429 ? 'একটু পরে আবার চেষ্টা করুন।' : 'এখন খোঁজা যাচ্ছে না।'
        }</p>`;
        resetFindMe();
        return;
      }
    } catch (e) {
      box.innerHTML = '<p class="muted-text">নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।</p>';
      resetFindMe();
      return;
    }

    if (!data.ok && data.code === 'NO_FACE') {
      box.innerHTML = '<p class="muted-text">সেলফিতে মুখ পাওয়া যায়নি — স্পষ্ট একটা ছবি দিন।</p>';
      resetFindMe();
      return;
    }
    if (!data.count) {
      box.innerHTML = '<p class="muted-text">আপনার মুখ আছে এমন কোনো ছবি পাওয়া গেল না।</p>';
      resetFindMe();
      return;
    }

    box.innerHTML = '';
    const head = document.createElement('p');
    head.innerHTML = `<b>${bnNum(data.count)}টি ছবি</b> পাওয়া গেছে`;
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'findme-grid';
    for (const item of data.items) {
      const tile = document.createElement('div');
      tile.className = 'g-item';
      if (item.thumb) {
        const img = document.createElement('img');
        img.src = item.thumb; img.alt = '';
        tile.appendChild(img);
      }
      tile.addEventListener('click', () => window.open(item.download, '_blank'));
      grid.appendChild(tile);
    }
    box.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'findme-actions';
    const dl = document.createElement('button');
    dl.className = 'btn btn-primary';
    dl.textContent = `⬇ সবগুলো Download (${bnNum(data.count)})`;
    dl.addEventListener('click', () => downloadMany(data.items));
    const again = document.createElement('button');
    again.className = 'btn btn-ghost';
    again.textContent = 'অন্য সেলফি';
    again.addEventListener('click', openFindMe);
    actions.append(dl, again);
    box.appendChild(actions);
  }

  function resetFindMe() {
    const retry = document.createElement('button');
    retry.className = 'btn btn-ghost';
    retry.style.marginTop = '12px';
    retry.textContent = 'আবার চেষ্টা করুন';
    retry.addEventListener('click', openFindMe);
    $('#findMeResult').appendChild(retry);
  }

  $('#btnFindMe').addEventListener('click', openFindMe);
  $('#btnSlideshow').addEventListener('click', startSlideshow);
  $('#findMeClose').addEventListener('click', closeFindMe);
  $('#findMePick').addEventListener('click', () => $('#findMeInput').click());
  $('#findMeInput').addEventListener('change', (ev) => {
    runFindMe(ev.target.files && ev.target.files[0]);
    ev.target.value = '';
  });
  findMe.addEventListener('click', (ev) => { if (ev.target === findMe) closeFindMe(); });

  /**
   * Browsers throttle bursts of downloads, so files are pulled one at a time
   * with a short gap. The visitor sees the progress in a toast.
   */
  async function downloadMany(list) {
    if (!list.length) return;
    toast(`${list.length}টি ফাইল Download শুরু হয়েছে…`);
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const a = document.createElement('a');
      a.href = item.download;
      a.download = item.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      await sleep(900);
    }
    toast('Download শেষ — ফোনের Downloads ফোল্ডার দেখুন ✅');
  }

  $('#btnDownloadAll').addEventListener('click', () => {
    // Everything currently on screen — which, with a person chip selected, is
    // exactly that person's folder.
    downloadMany(shown.slice());
  });

  btnDownload.addEventListener('click', () => {
    const list = shown.filter((it) => picked.has(it.id));
    downloadMany(list);
  });

  /* ── Lightbox ─────────────────────────────────────────────── */

  /** Ask the thumbnail proxy for a bigger preview than the grid needs. */
  function bigPreview(url, size) {
    if (!url) return null;
    return url + (url.includes('?') ? '&' : '?') + 's=' + size;
  }

  function renderLightbox() {
    const item = shown[current];
    if (!item) return;
    stage.textContent = '';

    const count = $('#lbCount');
    if (count) count.textContent = `${current + 1} / ${shown.length}`;
    const badge = $('#lbBadge');
    if (badge) {
      badge.textContent = item.categoryLabel || '';
      badge.hidden = !item.categoryLabel;
    }

    if (item.isVideo) {
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      if (item.thumb) video.poster = item.thumb;
      video.src = item.src; // the proxy supports Range, so seeking works
      stage.appendChild(video);
      video.addEventListener('error', () => {
        if (video.src) { video.removeAttribute('src'); video.load(); }
        captionEl.textContent = 'ভিডিওটি এখানে দেখা যাচ্ছে না — Download করে দেখুন।';
      }, { once: true });
    } else {
      const img = document.createElement('img');
      // Two-step: the proxied preview paints immediately (and is a
      // browser-friendly JPEG even for HEIC), then the original quietly
      // replaces it once it has finished downloading.
      const preview = bigPreview(item.thumb, 1400) || item.src;
      img.alt = item.name;
      img.src = preview;
      if (preview !== item.src) img.classList.add('is-preview');
      img.addEventListener('error', () => {
        if (img.src.endsWith(item.src)) {
          captionEl.textContent = 'এই ছবিটি ব্রাউজারে দেখা যাচ্ছে না — Download করে দেখুন।';
        } else {
          img.src = item.src;
        }
      }, { once: true });
      stage.appendChild(img);

      if (preview !== item.src) {
        const full = new Image();
        const shownFor = item.id;
        full.addEventListener('load', () => {
          // Ignore a late arrival for a photo the visitor has moved past.
          if (!lightbox.hidden && shown[current] && shown[current].id === shownFor) {
            img.src = full.src;
            img.classList.remove('is-preview');
          }
        });
        full.src = item.src;
      }
    }

    lbDownload.href = item.download;
    lbDownload.setAttribute('download', item.name);
    if (lbShare) lbShare.onclick = () => shareItem(item);

    const parts = [item.name];
    if (item.uploader) parts.push(`— ${item.uploader}`);
    if (item.size) parts.push(`(${fmtBytes(item.size)})`);
    captionEl.textContent = parts.join(' ');
  }

  /* Slideshow: step through the current filter, one photo every few seconds,
     pausing on videos so they can play out. */
  let slideTimer = null;
  function startSlideshow() {
    if (!shown.length) return;
    openLightbox(current >= 0 ? current : 0);
    document.body.classList.add('is-slideshow');
    const tick = () => {
      const item = shown[current];
      const wait = item && item.isVideo ? 9000 : 3500;
      slideTimer = setTimeout(() => { step(1); tick(); }, wait);
    };
    clearTimeout(slideTimer);
    tick();
  }
  function stopSlideshow() {
    clearTimeout(slideTimer);
    slideTimer = null;
    document.body.classList.remove('is-slideshow');
  }

  function openLightbox(index) {
    if (!shown.length) return;
    current = (index + shown.length) % shown.length;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    renderLightbox();
  }

  function closeLightbox() {
    stopSlideshow();
    lightbox.hidden = true;
    stage.textContent = '';
    document.body.style.overflow = '';
    current = -1;
  }

  function step(dir) {
    if (!shown.length) return;
    current = (current + dir + shown.length) % shown.length;
    renderLightbox();
  }

  // Swipe left / right on a phone, the way a photo app behaves.
  let touchX = null;
  let touchY = null;
  stage.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) return;
    touchX = ev.touches[0].clientX;
    touchY = ev.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (ev) => {
    if (touchX === null) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    touchX = null;
    touchY = null;
    // Horizontal only, so scrolling a tall photo never flips the page.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => step(-1));
  $('#lbNext').addEventListener('click', () => step(1));
  lightbox.addEventListener('click', (ev) => {
    if (ev.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (ev) => {
    if (lightbox.hidden) return;
    if (ev.key === 'Escape') closeLightbox();
    if (ev.key === 'ArrowLeft') step(-1);
    if (ev.key === 'ArrowRight') step(1);
  });

  /* ── Load ─────────────────────────────────────────────────── */

  async function load() {
    let data;
    try {
      const token = sessionStorage.getItem(PIN_KEY) || '';
      data = await api('/api/gallery', {
        headers: token ? { 'X-Upload-Token': token } : {},
      });
    } catch (err) {
      if (err.code === 'GALLERY_PIN_REQUIRED' || err.code === 'PIN_REQUIRED' || err.status === 401) {
        showPinGate('Gallery দেখতে PIN দিন।');
        return;
      }
      failStatus(
        err.code === 'GALLERY_DISABLED' || err.status === 404
          ? 'Gallery এই মুহূর্তে বন্ধ আছে।'
          : 'Gallery লোড করা যায়নি — নেটওয়ার্ক সমস্যা।'
      );
      return;
    }
    skeleton.hidden = true;
    skeleton.textContent = '';
    items = data.items || [];
    if (!items.length) {
      status.hidden = false;
      status.textContent = 'এখনো কোনো ছবি নেই — প্রথম ছবিটি Upload করুন!';
      return;
    }
    rebuildFilters();
    bar.hidden = false;
    // The selfie search only works when face recognition is switched on.
    $('#btnFindMe').hidden = !(pageCfg && pageCfg.faceSortEnabled);
    refreshDownloadBtn();
    render();
  }

  async function boot() {
    showSkeleton();
    let cfg = null;
    try {
      cfg = await api('/api/config');
    } catch (e) { /* treat as no pin requirement; load() will surface errors */ }
    pageCfg = cfg;
    // `galleryPinRequired` is false when the admin opened the gallery to
    // everyone, even though uploading still needs the PIN.
    if (cfg && cfg.galleryPinRequired && cfg.galleryEnabled) {
      const token = sessionStorage.getItem(PIN_KEY) || '';
      if (!token) {
        showPinGate('Gallery দেখতে PIN দিন।');
        return;
      }
    }
    load();
  }

  boot();
})();
