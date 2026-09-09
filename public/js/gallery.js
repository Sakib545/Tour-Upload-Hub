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
        const chip = filters.find((x) => x.id === filter);
        status.textContent = chip
          ? `"${chip.label}"-তে এখনো কিছু নেই।`
          : 'এই ধরনের এখনো কিছু নেই।';
      }
      return;
    }
    status.hidden = true;
    const frag = document.createDocumentFragment();
    shown.forEach((item, i) => frag.appendChild(tileFor(item, i)));
    grid.appendChild(frag);
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
    for (const f of filters) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (filter === f.id ? ' is-on' : '');
      b.dataset.filter = f.id;
      const span = document.createElement('span');
      span.className = 'chip-n';
      span.textContent = f.count;
      b.appendChild(document.createTextNode(`${f.label} `));
      b.appendChild(span);
      chipsDyn.appendChild(b);
    }
    for (const chip of $$('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip.dataset.filter === filter);
    }
  }

  function setFilter(next) {
    filter = next;
    for (const chip of $$('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip.dataset.filter === next);
    }
    clearPicks();
    render();
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

  btnDownload.addEventListener('click', () => {
    const list = shown.filter((it) => picked.has(it.id));
    downloadMany(list);
  });

  /* ── Lightbox ─────────────────────────────────────────────── */

  function renderLightbox() {
    const item = shown[current];
    if (!item) return;
    stage.textContent = '';

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
      // The proxied thumbnail is a browser-friendly JPEG even for HEIC files;
      // the original is the fallback when Drive could not render one.
      const first = item.thumb || item.src;
      img.alt = item.name;
      img.src = first;
      img.addEventListener('error', () => {
        if (img.src.endsWith(item.src) || first === item.src) {
          captionEl.textContent = 'এই ছবিটি ব্রাউজারে দেখা যাচ্ছে না — Download করে দেখুন।';
        } else {
          img.src = item.src;
        }
      }, { once: true });
      stage.appendChild(img);
    }

    lbDownload.href = item.download;
    lbDownload.setAttribute('download', item.name);

    const parts = [item.name];
    if (item.categoryLabel) parts.push(`· ${item.categoryLabel}`);
    if (item.uploader) parts.push(`— ${item.uploader}`);
    if (item.size) parts.push(`(${fmtBytes(item.size)})`);
    captionEl.textContent = parts.join(' ');
  }

  function openLightbox(index) {
    if (!shown.length) return;
    current = (index + shown.length) % shown.length;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    renderLightbox();
  }

  function closeLightbox() {
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
