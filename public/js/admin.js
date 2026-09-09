'use strict';

/* Admin dashboard: login → stats / controls / recent uploads / QR. */

(function () {
  const TOKEN_KEY = 'tourAdminToken';
  let token = '';
  let siteData = null; // last /api/admin/overview site payload (content+categories)

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
    driveStatus: $('#driveStatus'),
    btnDriveTest: $('#btnDriveTest'),
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
      siteData = data.site || siteData;
      renderStats(data);
      renderRecent(data.recent || []);
      setToggles(data.settings || {});
      fillSiteForm(siteData);
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
    if (data.drive) renderDrive(data.drive);
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
    if (data.folderLinks && data.folderLinks.length) {
      for (const link of data.folderLinks) {
        el.folderLinks.appendChild(folderLink(`📁 ${link.label} — ${link.folder}`, link.url));
      }
    }
    if (data.rootFolderUrl) {
      el.folderLinks.appendChild(folderLink('📂 Destination folder', data.rootFolderUrl));
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
      badge.textContent = r.categoryLabel || info.label;
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

  /* ── Tour page content & categories ──────────────────────── */

  const MEDIA_LABEL = { photo: 'PHOTO', video: 'VIDEO' };

  function fillSiteForm(site) {
    if (!site) return;
    const c = site.content || {};
    const set = (id, v) => {
      const n = $(id);
      if (n) n.value = v || '';
    };
    set('#siteTitle', c.title);
    set('#siteSubtitle', c.subtitle);
    set('#siteDate', c.date);
    set('#siteLocation', c.location);
    set('#sitePrivacy', c.privacyNote);
    set('#siteCover', c.coverUrl);
    buildCategoryRows(site.categories || []);
  }

  function buildCategoryRows(cats) {
    const body = $('#catTableBody');
    if (!body) return;
    body.textContent = '';
    for (const cat of cats) {
      const tr = document.createElement('tr');

      const tdType = document.createElement('td');
      tdType.textContent = `${cat.id} · ${MEDIA_LABEL[cat.media] || cat.media}`;

      const tdLabel = document.createElement('td');
      const inpLabel = document.createElement('input');
      inpLabel.className = 'input';
      inpLabel.dataset.cat = cat.id;
      inpLabel.dataset.field = 'label';
      inpLabel.maxLength = 80;
      inpLabel.value = cat.label || '';
      tdLabel.appendChild(inpLabel);

      const tdFolder = document.createElement('td');
      const inpFolder = document.createElement('input');
      inpFolder.className = 'input';
      inpFolder.dataset.cat = cat.id;
      inpFolder.dataset.field = 'folder';
      inpFolder.maxLength = 80;
      inpFolder.value = cat.folder || '';
      tdFolder.appendChild(inpFolder);

      tr.append(tdType, tdLabel, tdFolder);
      body.appendChild(tr);
    }
  }

  function collectSiteForm() {
    const val = (id) => {
      const n = $(id);
      return n ? n.value.trim() : '';
    };
    const content = {
      title: val('#siteTitle'),
      subtitle: val('#siteSubtitle'),
      date: val('#siteDate'),
      location: val('#siteLocation'),
      privacyNote: val('#sitePrivacy'),
      coverUrl: val('#siteCover'),
    };
    const categories = [];
    const baseCats = (siteData && siteData.categories) || [];
    for (const tr of $$('#catTableBody tr')) {
      const label = tr.querySelector('[data-field="label"]');
      const folder = tr.querySelector('[data-field="folder"]');
      if (!label || !folder) continue;
      const base = baseCats.find((c) => c.id === label.dataset.cat);
      if (!base) continue;
      categories.push({
        id: base.id,
        media: base.media,
        label: label.value.trim(),
        folder: folder.value.trim(),
      });
    }
    return { content, categories };
  }

  async function saveSite() {
    const btn = $('#btnSaveSite');
    const note = $('#siteSavedNote');
    if (btn) btn.disabled = true;
    if (note) note.textContent = '';
    try {
      const data = await apiAdmin('/api/admin/site', { method: 'PUT', body: collectSiteForm() });
      siteData = data.site;
      fillSiteForm(data.site);
      loadOverview(true); // refresh folder links / stats with the new folders
      if (note) note.textContent = '✔ Saved — changes are live now.';
      toast('Tour page & folders saved.');
    } catch (err) {
      if (note) note.textContent = 'Save failed: ' + (err.code || 'error');
      toast('Could not save: ' + (err.code || 'error'), { bad: true });
    } finally {
      if (btn) btn.disabled = false;
      setTimeout(() => {
        if (note) note.textContent = '';
      }, 6000);
    }
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

  /* ── Drive connection ─────────────────────────────────────── */

  // What each failure actually means, and what to change to fix it.
  const DRIVE_HELP = {
    DRIVE_QUOTA: {
      title: 'The uploading account has no Drive storage.',
      steps: [
        'A service account owns every file it creates, and service accounts get no storage of their own — so writing into a personal "My Drive" folder always fails this way.',
        'Fix A (recommended): remove GOOGLE_SERVICE_ACCOUNT_JSON and use the OAuth refresh token instead (README sections 4–5). Files are then owned by you.',
        'Fix B: move the destination folder into a Google Workspace Shared Drive and share it with the service account as Content manager.',
      ],
    },
    DRIVE_PERMISSION: {
      title: 'The account may read the folder but not write to it.',
      steps: [
        'Open the destination folder in Drive → Share.',
        'If you use a service account, add its client_email as Editor.',
        'If you use OAuth, make sure GOOGLE_REFRESH_TOKEN belongs to an account with edit rights on that folder.',
      ],
    },
    DRIVE_FOLDER_NOT_FOUND: {
      title: 'The folder ID is wrong, or invisible to this account.',
      steps: [
        'Copy GOOGLE_DRIVE_FOLDER_ID again from the folder URL (the part after /folders/).',
        'Share that folder with the uploading account.',
      ],
    },
    FOLDER_NOT_FOUND: {
      title: 'The folder ID is wrong, or invisible to this account.',
      steps: [
        'Copy GOOGLE_DRIVE_FOLDER_ID again from the folder URL (the part after /folders/).',
        'Share that folder with the uploading account.',
      ],
    },
    DRIVE_AUTH: {
      title: 'Google rejected the credentials.',
      steps: [
        'Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN, or the service-account JSON.',
        'A refresh token stops working if the OAuth consent screen is still in "Testing" — publish it.',
      ],
    },
  };

  function renderDrive(result, { busy = false } = {}) {
    if (!el.driveStatus) return;
    el.driveStatus.textContent = '';

    const pill = document.createElement('span');
    pill.className = 'drive-pill' + (busy ? ' busy' : result && result.ok ? '' : ' bad');
    pill.textContent = busy
      ? 'Checking…'
      : result && result.ok
        ? 'Drive connected — uploads can be written'
        : `Problem: ${(result && result.code) || 'UNKNOWN'}`;
    el.driveStatus.appendChild(pill);
    if (busy) return;

    const detail = document.createElement('p');
    detail.className = 'drive-detail';
    const bits = [];
    if (result && result.folderName) bits.push(`Folder: ${result.folderName}`);
    if (result && result.name) bits.push(`Folder: ${result.name}`);
    if (result && result.reason) bits.push(`Google reason: ${result.reason}`);
    if (result && result.msg) bits.push(result.msg);
    detail.textContent = bits.join(' · ');
    if (detail.textContent) el.driveStatus.appendChild(detail);

    const help = result && DRIVE_HELP[result.code];
    if (help) {
      const box = document.createElement('div');
      box.className = 'drive-fix';
      const h = document.createElement('strong');
      h.textContent = help.title;
      box.appendChild(h);
      const ol = document.createElement('ol');
      for (const step of help.steps) {
        const li = document.createElement('li');
        li.textContent = step;
        ol.appendChild(li);
      }
      box.appendChild(ol);
      el.driveStatus.appendChild(box);
    }
  }

  async function testDrive() {
    el.btnDriveTest.disabled = true;
    renderDrive(null, { busy: true });
    try {
      const data = await apiAdmin('/api/admin/drive-test', { method: 'POST', body: {} });
      renderDrive(data);
      toast(data.ok ? 'Drive write test passed.' : 'Drive test failed — see the details above.', { bad: !data.ok });
    } catch (err) {
      renderDrive({ ok: false, code: err.code || 'REQUEST_FAILED' });
      toast('Could not run the Drive test: ' + (err.code || 'error'), { bad: true });
    } finally {
      el.btnDriveTest.disabled = false;
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
    el.btnDriveTest.addEventListener('click', testDrive);
    const saveBtn = $('#btnSaveSite');
    if (saveBtn) saveBtn.addEventListener('click', saveSite);

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
