'use strict';

/* Gallery page: lazy grid + fullscreen lightbox, powered by Drive data via the backend. */

(function () {
  const PIN_KEY = 'tourPinToken';

  const grid = $('#galleryGrid');
  const status = $('#galleryStatus');
  const lightbox = $('#lightbox');
  const stage = $('#lbStage');
  const captionEl = $('#lbCaption');
  const pinGate = $('#pinGate');
  const pinForm = $('#pinForm');
  const pinInput = $('#pinInput');
  const pinSubmit = $('#pinSubmit');
  const pinError = $('#pinError');

  let items = [];
  let current = -1;
  let loadedSrc = ''; // guard: avoid re-setting the same media element repeatedly

  /* ── PIN gate (shared token from the upload page) ─────────── */

  function showPinGate(message) {
    pinGate.hidden = false;
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
    status.style.color = 'var(--danger)';
    status.textContent = message;
  }

  /* ── Grid ─────────────────────────────────────────────────── */

  function tileFor(item, index) {
    const tile = document.createElement('div');
    tile.className = 'g-item';
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;

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
    } else if (item.isImage) {
      // No Drive thumbnail (e.g. some HEIC) — show the tile; lightbox can still try.
      tile.classList.add('has-media');
    }

    if (item.isVideo) {
      const badge = document.createElement('span');
      badge.className = 'g-video-badge';
      badge.textContent = '▶ ভিডিও';
      tile.appendChild(badge);
    }

    const open = () => openLightbox(index);
    tile.addEventListener('click', open);
    tile.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
    return tile;
  }

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

  /* ── Lightbox ─────────────────────────────────────────────── */

  function mediaSource(item) {
    // Drive thumbnailLink is a universal JPEG — perfect for viewing. Fall back to
    // the authenticated proxy for files Drive could not thumbnail (e.g. some HEIC).
    return item.thumb || item.src;
  }

  function renderLightbox() {
    const item = items[current];
    if (!item) return;
    stage.textContent = '';
    loadedSrc = '';

    if (item.isVideo) {
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      if (item.thumb) video.poster = item.thumb;
      video.src = item.src; // proxy supports Range so seeking works
      stage.appendChild(video);
      loadedSrc = item.src;
      video.addEventListener('error', () => {
        if (video.src) { video.removeAttribute('src'); video.load(); }
        captionEl.textContent = 'ভিডিওটি এখানে দেখা যাচ্ছে না।';
      }, { once: true });
    } else {
      const img = document.createElement('img');
      const src = mediaSource(item);
      img.alt = item.name;
      img.src = src;
      loadedSrc = src;
      img.addEventListener('error', () => {
        if (img.src === item.src) {
          captionEl.textContent = 'এই ছবিটি ব্রাউজারে দেখা যাচ্ছে না (HEIC হতে পারে)।';
        } else {
          // thumb failed → try the authenticated original
          img.src = item.src;
        }
      }, { once: true });
      stage.appendChild(img);
    }

    const parts = [item.name];
    if (item.uploader) parts.push(`— ${item.uploader}`);
    if (item.size) parts.push(`(${fmtBytes(item.size)})`);
    captionEl.textContent = parts.join(' ');
  }

  function openLightbox(index) {
    if (!items.length) return;
    current = (index + items.length) % items.length;
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
    if (!items.length) return;
    current = (current + dir + items.length) % items.length;
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
    items = data.items || [];
    if (!items.length) {
      status.textContent = 'এখনো কোনো ছবি নেই — প্রথম ছবিটি Upload করুন!';
      return;
    }
    status.hidden = true;
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => frag.appendChild(tileFor(item, i)));
    grid.appendChild(frag);
  }

  async function boot() {
    let cfg = null;
    try {
      cfg = await api('/api/config');
    } catch (e) { /* treat as no pin requirement; load() will surface errors */ }
    if (cfg && cfg.pinRequired && cfg.galleryEnabled) {
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
