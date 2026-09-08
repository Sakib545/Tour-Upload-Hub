'use strict';

/* Tour page controller: config, PIN gate, file selection UI, engine wiring. */

(function () {
  const PIN_KEY = 'tourPinToken';
  const NAME_KEY = 'tourUploaderName';

  let cfg = null;
  let engine = null;
  const rowEls = new Map(); // entry id -> { pct, bar, status, row }
  let rafPending = false;
  let wasRunning = false;

  const el = {
    heroTitle: $('#heroTitle'),
    heroSub: $('#heroSub'),
    heroMeta: $('#heroMeta'),
    heroCover: $('#heroCover'),
    privacyNote: $('#privacyNote'),
    pinGate: $('#pinGate'),
    pinForm: $('#pinForm'),
    pinInput: $('#pinInput'),
    pinSubmit: $('#pinSubmit'),
    pinError: $('#pinError'),
    uploadPanel: $('#uploadPanel'),
    uploadsDisabled: $('#uploadsDisabled'),
    dropzoneCard: $('#dropzoneCard'),
    emptyState: $('#emptyState'),
    noFilesText: $('#noFilesText'),
    btnPick: $('#btnPick'),
    btnCamera: $('#btnCamera'),
    fileInput: $('#fileInput'),
    cameraInput: $('#cameraInput'),
    pickRow: $('#pickRow'),
    btnAddMore: $('#btnAddMore'),
    selSummary: $('#selSummary'),
    fileList: $('#fileList'),
    batchProgress: $('#batchProgress'),
    batchBar: $('#batchBar'),
    batchLabel: $('#batchLabel'),
    batchPct: $('#batchPct'),
    actionRow: $('#actionRow'),
    btnStart: $('#btnStart'),
    banner: $('#banner'),
    galleryLinkWrap: $('#galleryLinkWrap'),
    uploaderName: $('#uploaderName'),
  };

  const getToken = () => sessionStorage.getItem(PIN_KEY) || '';
  const getUploader = () => el.uploaderName.value.trim();

  /* ── Error copy (Bengali) ─────────────────────────────────── */

  function errorText(code) {
    const map = {
      PIN_REQUIRED: 'PIN প্রয়োজন',
      INVALID_PIN: 'PIN সঠিক নয়',
      UPLOADS_DISABLED: 'Upload বর্তমানে বন্ধ',
      FILE_TOO_LARGE: `ফাইল ${cfg ? cfg.maxFileSizeMB : ''} MB-এর বেশি`,
      INVALID_TYPE: 'ফরম্যাট সমর্থিত নয়',
      INVALID_FILE_CONTENT: 'ফাইলটি সঠিক ছবি/ভিডিও নয় — বাদ দেওয়া হয়েছে',
      EMPTY_FILE: 'ফাইলটি খালি',
      DRIVE_FOLDER_NOT_FOUND: 'Drive ফোল্ডার পাওয়া যায়নি (admin-কে জানান)',
      DRIVE_PERMISSION: 'Drive অনুমতি সমস্যা (admin-কে জানান)',
      DRIVE_AUTH: 'Drive সংযোগ সমস্যা (admin-কে জানান)',
      DRIVE_BUSY: 'Drive ব্যস্ত, আবার চেষ্টা করুন',
      DRIVE_NETWORK: 'নেটওয়ার্ক সমস্যা',
      CHUNK_UNCERTAIN: 'Upload থেমে গেছে — আবার চেষ্টা হচ্ছে…',
      SESSION_LOST: 'Upload পুনরায় শুরু হচ্ছে…',
      UNKNOWN_UPLOAD: 'Upload পুনরায় শুরু হয়েছে — আবার চেষ্টা করুন',
      OUT_OF_ORDER: 'Upload পুনরায় শুরু হচ্ছে…',
      RATE_LIMITED: 'অনেকবার চেষ্টা হয়েছে, একটু পর চেষ্টা করুন',
      UPLOAD_CAPACITY: 'একসাথে অনেকগুলো Upload চলছে — একটু পরে চেষ্টা করুন',
      TOO_MANY_UPLOADS: 'আপনার একসাথে অনেকগুলো Upload চলছে — শেষ হলে আবার চেষ্টা করুন',
      NETWORK: 'নেটওয়ার্ক সমস্যা',
      ABORTED: 'Upload বাতিল হয়েছে',
      STALLED: 'Upload থেমে গেছে — আবার চেষ্টা হচ্ছে…',
      FAILED: 'Upload ব্যর্থ হয়েছে',
    };
    return map[code] || 'Upload ব্যর্থ হয়েছে';
  }

  const STATUS_TEXT = {
    pending: 'অপেক্ষা…',
    done: '✓ সম্পন্ন',
    error: '',
  };

  /* ── Banner / toast ───────────────────────────────────────── */

  function showBanner(kind, title, actions) {
    el.banner.hidden = false;
    el.banner.className = 'banner ' + kind;
    el.banner.textContent = '';
    const p = document.createElement('p');
    p.style.margin = '0';
    p.innerHTML = title; // only our own static strings, never user data
    el.banner.appendChild(p);
    if (actions && actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'banner-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (a.kind || 'btn-ghost');
        b.textContent = a.label;
        b.addEventListener('click', a.fn);
        wrap.appendChild(b);
      }
      el.banner.appendChild(wrap);
    }
    el.banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideBanner() { el.banner.hidden = true; el.banner.textContent = ''; }

  /* ── Row rendering ────────────────────────────────────────── */

  function thumbNode(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'file-thumb';
    if (entry.type === 'video') {
      wrap.textContent = '🎬';
      return wrap;
    }
    if (!entry.url) {
      wrap.textContent = '🖼️';
      return wrap;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.src = entry.url;
    wrap.appendChild(img);
    return wrap;
  }

  function buildRow(entry) {
    const row = document.createElement('li');
    row.className = 'file-row';
    row.dataset.id = entry.id;

    const thumb = thumbNode(entry);
    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = fmtBytes(entry.size);
    const mini = document.createElement('div');
    mini.className = 'mini-progress';
    const fill = document.createElement('i');
    mini.appendChild(fill);
    info.appendChild(name);
    info.appendChild(meta);
    info.appendChild(mini);

    const status = document.createElement('div');
    status.className = 'file-status st-wait';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.title = 'বাদ দিন';
    remove.textContent = '✕';
    remove.addEventListener('click', () => engine.remove(entry.id));

    row.append(thumb, info, status, remove);
    return { row, fill, status };
  }

  function refreshRow(entry) {
    const cached = rowEls.get(entry.id);
    if (!cached) return;
    const { row, fill, status } = cached;

    if (entry.status === 'done') row.classList.add('is-done');

    // The object URL is revoked only on completion — swap the live preview for
    // an icon exactly then. While pending/uploading (and on failure, where the
    // thumbnail must stay for retry) the <img> is preserved.
    if (entry.status === 'done') {
      const thumb = row.querySelector('.file-thumb');
      if (thumb && thumb.firstElementChild && thumb.firstElementChild.tagName === 'IMG') {
        thumb.textContent = entry.type === 'video' ? '🎬' : '🖼️';
      }
    }

    fill.style.width = entry.pct + '%';

    if (entry.status === 'uploading') {
      status.className = 'file-status st-uploading';
      status.textContent = entry.pct + '%';
    } else if (entry.status === 'pending') {
      status.className = 'file-status st-wait';
      status.textContent = STATUS_TEXT.pending;
    } else if (entry.status === 'done') {
      status.className = 'file-status st-done';
      status.textContent = STATUS_TEXT.done;
    } else if (entry.status === 'error') {
      status.className = 'file-status st-error';
      status.textContent = errorText(entry.errorCode);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-xs';
      retry.textContent = 'আবার চেষ্টা করুন';
      retry.addEventListener('click', () => {
        engine.retry(entry.id);
        engine.start();
      });
      status.appendChild(retry);
    }
  }

  function reconcileRows() {
    const entries = engine.entries;
    const ids = new Set(entries.map((e) => e.id));
    for (const id of Array.from(rowEls.keys())) {
      if (!ids.has(id)) {
        const cached = rowEls.get(id);
        cached.row.remove();
        rowEls.delete(id);
      }
    }
    for (const entry of entries) {
      if (!rowEls.has(entry.id)) {
        const built = buildRow(entry);
        el.fileList.appendChild(built.row);
        rowEls.set(entry.id, { row: built.row, fill: built.fill, status: built.status });
      }
      refreshRow(entry);
    }
  }

  function makeThumbUrl(entry) {
    if (entry.type === 'video') return;
    if (entry.url) return;
    try { entry.url = URL.createObjectURL(entry.file); } catch (e) { /* ignore */ }
  }

  /* ── Totals / actions ─────────────────────────────────────── */

  function totals() {
    let bytes = 0;
    for (const e of engine.entries) bytes += e.size;
    return { count: engine.entries.length, bytes };
  }

  function sentBytes() {
    let sent = 0;
    for (const e of engine.entries) sent += e.sent || 0;
    return sent;
  }

  function refreshTotals() {
    const t = totals();
    const empty = t.count === 0;

    el.emptyState.hidden = !empty;
    el.fileList.hidden = empty;
    el.pickRow.hidden = empty;
    el.actionRow.hidden = empty || engine.running;
    el.btnStart.disabled = empty || engine.running;
    el.btnStart.textContent = engine.running ? 'Upload হচ্ছে…' : 'Upload করুন';
    el.btnPick.disabled = false;
    el.btnAddMore.disabled = false;

    if (empty) {
      el.selSummary.textContent = '';
      return;
    }
    el.selSummary.textContent = `${t.count}টি ফাইল • ${fmtBytes(t.bytes)}`;

    if (engine.running || (engine.entries.some((e) => e.status === 'uploading'))) {
      el.batchProgress.hidden = false;
      const totalB = t.bytes || 1;
      const pct = Math.min(100, Math.round((sentBytes() / totalB) * 100));
      el.batchBar.style.width = pct + '%';
      el.batchPct.textContent = pct + '%';
      const done = engine.entries.filter((e) => e.status === 'done').length;
      el.batchLabel.textContent = `Upload হচ্ছে… (${done}/${t.count})`;
    } else {
      el.batchProgress.hidden = true;
    }
  }

  function handleBatchEnd() {
    const entries = engine.entries;
    if (!entries.length) return;
    const ok = entries.filter((e) => e.status === 'done').length;
    const bad = entries.filter((e) => e.status === 'error').length;

    if (bad === 0) {
      const n = entries.length;
      showBanner('ok big', `<span class="heart">❤️</span> আপনার ছবি সফলভাবে Upload হয়েছে — ${n}টি ফাইল`, [
        { label: 'ঠিক আছে', kind: 'btn-outline', fn: () => { engine.clearFinished(); hideBanner(); } },
        { label: '+ আরও ফাইল যোগ করুন', kind: 'btn-primary', fn: () => { engine.clearFinished(); hideBanner(); el.btnPick.focus(); } },
      ]);
    } else if (ok > 0) {
      showBanner('bad', 'Upload সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।', [
        { label: 'ব্যর্থ ফাইল আবার চেষ্টা করুন', kind: 'btn-primary', fn: retryAll },
      ]);
    } else {
      showBanner('bad', 'Upload সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।', [
        { label: 'আবার চেষ্টা করুন', kind: 'btn-primary', fn: retryAll },
      ]);
    }
  }

  function retryAll() {
    hideBanner();
    for (const e of engine.entries) {
      if (e.status === 'error') engine.retry(e.id);
    }
    engine.start();
  }

  /* ── Engine change / progress handlers ────────────────────── */

  function onEngineChange() {
    // Global gate errors: PIN expired / uploads disabled mid-flight
    const pinHit = engine.entries.find((e) => e.errorCode === 'PIN_REQUIRED' || e.errorCode === 'INVALID_PIN');
    if (pinHit) {
      engine.clearAll();
      el.uploadPanel.hidden = true;
      showGate('PIN-এর মেয়াদ শেষ হয়েছে — আবার PIN দিন।');
      return;
    }
    const disabledHit = engine.entries.find((e) => e.errorCode === 'UPLOADS_DISABLED');
    if (disabledHit) {
      engine.clearAll();
      setDisabledUi(true);
      return;
    }

    reconcileRows();
    refreshTotals();
    if (wasRunning && !engine.running && engine.finished) {
      handleBatchEnd();
    }
    wasRunning = engine.running;
  }

  function onProgressFast() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!engine) return;
      for (const entry of engine.entries) {
        if (entry.status !== 'uploading') continue;
        const cached = rowEls.get(entry.id);
        if (!cached) continue;
        cached.fill.style.width = entry.pct + '%';
        cached.status.className = 'file-status st-uploading';
        cached.status.textContent = entry.pct + '%';
      }
      if (!el.batchProgress.hidden) {
        const t = totals();
        const totalB = t.bytes || 1;
        const pct = Math.min(100, Math.round((sentBytes() / totalB) * 100));
        el.batchBar.style.width = pct + '%';
        el.batchPct.textContent = pct + '%';
      }
    });
  }

  /* ── PIN gate ─────────────────────────────────────────────── */

  function showGate(message) {
    el.pinGate.hidden = false;
    el.pinError.hidden = !message;
    if (message) el.pinError.textContent = message;
    el.pinInput.value = '';
    el.pinInput.focus();
  }

  async function submitPin(ev) {
    ev.preventDefault();
    el.pinSubmit.disabled = true;
    el.pinError.hidden = true;
    const pin = el.pinInput.value.trim();
    try {
      const data = await api('/api/verify-pin', { method: 'POST', body: { pin } });
      sessionStorage.setItem(PIN_KEY, data.token);
      el.pinGate.hidden = true;
      showUploadUi();
      toast('PIN যাচাই হয়েছে — এখন Upload করতে পারবেন ✅');
    } catch (err) {
      el.pinError.hidden = false;
      el.pinError.textContent =
        err.code === 'INVALID_PIN' ? 'PIN সঠিক নয় — আবার চেষ্টা করুন।' : 'যাচাই করা যায়নি। আবার চেষ্টা করুন।';
    } finally {
      el.pinSubmit.disabled = false;
    }
  }

  /* ── UI states ────────────────────────────────────────────── */

  function setDisabledUi(disabled) {
    el.uploadsDisabled.hidden = !disabled;
    el.emptyState.style.opacity = disabled ? '0.4' : '1';
    el.btnPick.disabled = disabled;
    el.btnCamera.disabled = disabled;
    el.btnAddMore.disabled = disabled;
    el.dropzoneCard.style.pointerEvents = disabled ? 'none' : 'auto';
  }

  function showUploadUi() {
    el.pinGate.hidden = true;
    el.uploadPanel.hidden = false;
    el.uploadsDisabled.hidden = !(cfg && !cfg.uploadsEnabled);
    setDisabledUi(cfg ? !cfg.uploadsEnabled : false);
  }

  function addPicked(fileList) {
    if (!fileList || !fileList.length) return;
    const res = engine.addFiles(fileList);
    for (const r of res.rejected) {
      const why =
        r.code === 'FILE_TOO_LARGE'
          ? `"${r.name}" — সাইজ ${cfg.maxFileSizeMB} MB-এর বেশি, বাদ দেওয়া হয়েছে`
          : r.code === 'TOO_MANY_FILES'
            ? `সর্বোচ্চ ${cfg.maxFilesPerUpload}টি ফাইল একসাথে নেওয়া যায়`
            : `"${r.name}" — সমর্থিত ফরম্যাট নয়`;
      toast(why, { bad: true });
    }
    if (res.added.length) {
      for (const a of res.added) makeThumbUrl(a);
      hideBanner();
      toast(`${res.added.length}টি ফাইল বাছাই হয়েছে`);
    }
  }

  /* ── Boot ─────────────────────────────────────────────────── */

  async function init() {
    try {
      cfg = await api('/api/config');
    } catch (e) {
      toast('সার্ভার থেকে তথ্য নেওয়া যায়নি', { bad: true });
      return;
    }

    // Hero + texts
    document.title = cfg.tourTitle || 'Tour Memories';
    el.heroTitle.textContent = cfg.tourTitle;
    el.heroSub.textContent = cfg.tourSubtitle;
    el.privacyNote.textContent = cfg.privacyNote;
    const metaParts = [];
    if (cfg.tourDate) metaParts.push(`📅 ${cfg.tourDate}`);
    if (cfg.tourLocation) metaParts.push(`📍 ${cfg.tourLocation}`);
    if (metaParts.length) el.heroMeta.textContent = metaParts.join('  •  ');
    if (cfg.coverUrl) {
      const img = new Image();
      img.onload = () => { el.heroCover.src = cfg.coverUrl; el.heroCover.hidden = false; };
      img.src = cfg.coverUrl;
    }
    if (cfg.galleryEnabled) el.galleryLinkWrap.hidden = false;

    // Restore uploader name
    try {
      const saved = localStorage.getItem(NAME_KEY);
      if (saved) el.uploaderName.value = saved;
    } catch (e) { /* ignore */ }
    el.uploaderName.addEventListener('input', () => {
      try { localStorage.setItem(NAME_KEY, el.uploaderName.value); } catch (e) { /* ignore */ }
    });

    // Engine
    engine = createUploadEngine({
      cfg: {
        maxFileBytes: cfg.maxFileBytes,
        maxFilesPerUpload: cfg.maxFilesPerUpload,
        chunkBytes: cfg.chunkMB * 1024 * 1024,
      },
      getToken,
      getUploader,
      onChange: onEngineChange,
      onProgress: onProgressFast,
    });

    // Events
    el.pinForm.addEventListener('submit', submitPin);
    el.btnPick.addEventListener('click', () => el.fileInput.click());
    el.btnAddMore.addEventListener('click', () => el.fileInput.click());
    el.btnCamera.addEventListener('click', () => el.cameraInput.click());

    el.fileInput.addEventListener('change', () => {
      addPicked(el.fileInput.files);
      el.fileInput.value = '';
    });
    el.cameraInput.addEventListener('change', () => {
      addPicked(el.cameraInput.files);
      el.cameraInput.value = '';
    });

    // Drag & drop (desktop)
    ['dragenter', 'dragover'].forEach((evName) =>
      el.dropzoneCard.addEventListener(evName, (ev) => {
        ev.preventDefault();
        el.dropzoneCard.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((evName) =>
      el.dropzoneCard.addEventListener(evName, (ev) => {
        ev.preventDefault();
        el.dropzoneCard.classList.remove('dragover');
      })
    );
    el.dropzoneCard.addEventListener('drop', (ev) => {
      if (ev.dataTransfer && ev.dataTransfer.files) addPicked(ev.dataTransfer.files);
    });

    el.btnStart.addEventListener('click', () => {
      if (engine.running) return;
      hideBanner();
      engine.start();
    });

    window.addEventListener('beforeunload', (ev) => {
      if (engine.running) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });

    // Initial state
    if (cfg.pinRequired && !getToken()) {
      showGate();
    } else {
      showUploadUi();
    }
  }

  init();
})();
