'use strict';

/* Admin dashboard: login → stats / controls / recent uploads / QR. */

(function () {
  const TOKEN_KEY = 'tourAdminToken';
  let token = '';

  const el = {
    loginCard: $('#loginCard'),
    loginForm: $('#loginForm'),
    loginPassword: $('#loginPassword'),
    loginError: $('#loginError'),
    loginBtn: null,
    dashboard: $('#dashboard'),
    statFiles: $('#statFiles'),
    statSize: $('#statSize'),
    statSplit: $('#statSplit'),
    statFolder: $('#statFolder'),
    folderLinks: $('#folderLinks'),
    tglUploads: $('#tglUploads'),
    tglGallery: $('#tglGallery'),
    recentBody: $('#recentBody'),
    recentNote: $('#recentNote'),
    qrImg: $('#qrImg'),
    qrUrl: $('#qrUrl'),
    qrDownload: $('#qrDownload'),
  };
  el.loginBtn = $('#loginForm button[type="submit"]');

  function setView(loggedIn) {
    el.loginCard.hidden = loggedIn;
    el.dashboard.hidden = !loggedIn;
  }

  async function apiAdmin(path, opts = {}) {
    return api(path, { ...opts, bearer: token });
  }

  /* ── Overview ─────────────────────────────────────────────── */

  async function loadOverview(silent) {
    try {
      const data = await apiAdmin('/api/admin/overview');
      renderStats(data);
      renderRecent(data.recent || []);
      setToggles(data.settings || {});
      return true;
    } catch (err) {
      if (!silent && err.code === 'ADMIN_UNAUTHORIZED') {
        token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        setView(false);
        toast('Session expired — sign in again.', { bad: true });
      } else if (!silent) {
        toast('Could not load overview: ' + (err.code || 'error'), { bad: true });
      }
      return false;
    }
  }

  /** Count up to the new value so a changed number is noticeable. */
  function countTo(node, value) {
    const target = Number(value) || 0;
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(target);
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || from === target || target > 5000) {
      node.textContent = target.toLocaleString();
      return;
    }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = Math.round(from + (target - from) * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderStats(data) {
    countTo(el.statFiles, data.stats.totalFiles);
    el.statSize.textContent = fmtBytes(data.stats.totalSize);
    el.statSplit.textContent = `${(data.stats.photoCount || 0).toLocaleString()} / ${(data.stats.videoCount || 0).toLocaleString()}`;
    el.statFolder.textContent = data.stats.folderName || '—';
    renderFolderLinks(data);
  }

  function folderLink(label, url) {
    const a = document.createElement('a');
    a.className = 'btn btn-outline btn-block';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    return a;
  }

  function renderFolderLinks(data) {
    if (!el.folderLinks) return;
    el.folderLinks.textContent = '';
    if (data.folderLinks) {
      el.folderLinks.appendChild(folderLink('📷 Photos folder', data.folderLinks.photos));
      el.folderLinks.appendChild(folderLink('🎬 Videos folder', data.folderLinks.videos));
    }
    if (data.rootFolderUrl) {
      el.folderLinks.appendChild(folderLink('📁 Tour folder', data.rootFolderUrl));
    }
  }

  function typeInfo(mime) {
    if (!mime) return { label: 'FILE', cls: '' };
    if (mime.startsWith('video/')) return { label: 'VIDEO', cls: 'video' };
    if (mime.startsWith('image/')) return { label: 'IMAGE', cls: '' };
    return { label: 'FILE', cls: '' };
  }

  function renderRecent(rows) {
    el.recentBody.textContent = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'No uploads yet.';
      tr.appendChild(td);
      el.recentBody.appendChild(tr);
      el.recentNote.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = r.name;
      tdName.title = r.name;

      const tdUser = document.createElement('td');
      tdUser.textContent = r.uploader || '—';

      const tdType = document.createElement('td');
      const info = typeInfo(r.mimeType);
      const badge = document.createElement('span');
      badge.className = 'type-badge' + (info.cls ? ' ' + info.cls : '');
      badge.textContent = info.label;
      tdType.appendChild(badge);

      const tdSize = document.createElement('td');
      tdSize.textContent = fmtBytes(r.size);

      const tdTime = document.createElement('td');
      tdTime.textContent = fmtTime(r.createdTime);

      const tdOpen = document.createElement('td');
      if (r.driveUrl) {
        const a = document.createElement('a');
        a.className = 'drive-link';
        a.href = r.driveUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open ↗';
        tdOpen.appendChild(a);
      } else {
        tdOpen.textContent = '—';
      }

      tr.append(tdName, tdUser, tdType, tdSize, tdTime, tdOpen);
      frag.appendChild(tr);
    }
    el.recentBody.appendChild(frag);
    el.recentNote.textContent = `Showing ${rows.length} most recent uploads.`;
  }

  function setToggles(settings) {
    el.tglUploads.checked = !!settings.uploadsEnabled;
    el.tglGallery.checked = !!settings.galleryVisible;
  }

  async function updateSetting() {
    try {
      const data = await apiAdmin('/api/admin/settings', {
        method: 'PUT',
        body: {
          uploadsEnabled: el.tglUploads.checked,
          galleryVisible: el.tglGallery.checked,
        },
      });
      setToggles(data.settings);
      toast(
        data.settings.uploadsEnabled
          ? 'Uploads are ENABLED.'
          : 'Uploads are DISABLED — visitors will see a notice.',
        { bad: !data.settings.uploadsEnabled }
      );
      if (!data.settings.galleryVisible && el.tglGallery.checked === false) {
        // nothing extra needed; gallery link disappears automatically
      }
    } catch (err) {
      toast('Could not save setting: ' + (err.code || 'error'), { bad: true });
      loadOverview(true);
    }
  }

  /* ── QR ───────────────────────────────────────────────────── */

  async function loadQr() {
    try {
      const data = await apiAdmin('/api/admin/qr');
      el.qrImg.src = data.dataUrl;
      el.qrUrl.textContent = data.publicUrl;
      el.qrUrl.title = data.publicUrl;
      el.qrDownload.href = data.dataUrl;
    } catch (err) {
      toast('Could not generate QR: ' + (err.code || 'error'), { bad: true });
    }
  }

  /* ── Login ────────────────────────────────────────────────── */

  async function submitLogin(ev) {
    ev.preventDefault();
    el.loginError.hidden = true;
    el.loginBtn.disabled = true;
    const password = el.loginPassword.value;
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        body: { password },
      });
      token = data.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      const ok = await loadOverview();
      if (ok) {
        setView(true);
        el.loginPassword.value = '';
        loadQr();
      }
    } catch (err) {
      el.loginError.hidden = false;
      el.loginError.textContent =
        err.code === 'ADMIN_UNAUTHORIZED' ? 'Wrong password.' : 'Login failed — try again.';
    } finally {
      el.loginBtn.disabled = false;
    }
  }

  /* ── Boot ─────────────────────────────────────────────────── */

  async function init() {
    el.loginForm.addEventListener('submit', submitLogin);
    el.tglUploads.addEventListener('change', updateSetting);
    el.tglGallery.addEventListener('change', updateSetting);

    token = sessionStorage.getItem(TOKEN_KEY) || '';
    if (token) {
      const ok = await loadOverview();
      if (ok) {
        setView(true);
        loadQr();
        return;
      }
    }
    setView(false);
    el.loginPassword.focus();
  }

  init();
})();
