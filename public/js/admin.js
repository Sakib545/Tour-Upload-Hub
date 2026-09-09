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
    driveStatus: $('#driveStatus'),
    btnDriveTest: $('#btnDriveTest'),
    tglUploads: $('#tglUploads'),
    tglGallery: $('#tglGallery'),
    tglPublic: $('#tglPublic'),
    fTitle: $('#fTitle'),
    fSubtitle: $('#fSubtitle'),
    fDate: $('#fDate'),
    fLocation: $('#fLocation'),
    fPrivacy: $('#fPrivacy'),
    fCover: $('#fCover'),
    fFolderPhotos: $('#fFolderPhotos'),
    fFolderGroup: $('#fFolderGroup'),
    fFolderVideos: $('#fFolderVideos'),
    btnSaveContent: $('#btnSaveContent'),
    btnResetContent: $('#btnResetContent'),
    saveHint: $('#saveHint'),
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
      applySettings(data.settings);
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
    const cats = data.stats.byCategory || {};
    el.statSplit.textContent = `${cats.single || 0} / ${cats.group || 0} / ${cats.video || 0}`;
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

  // The settings the server last confirmed — used to fill the form and to undo.
  let saved = null;

  function applySettings(settings) {
    if (!settings) return;
    saved = settings;
    const flags = settings.flags || {};
    el.tglUploads.checked = !!flags.uploadsEnabled;
    el.tglGallery.checked = !!flags.galleryVisible;
    el.tglPublic.checked = !!flags.galleryPublic;
    fillForm(settings);
  }

  function fillForm(settings) {
    const site = settings.site || {};
    const folders = settings.folders || {};
    el.fTitle.value = site.title || '';
    el.fSubtitle.value = site.subtitle || '';
    el.fDate.value = site.date || '';
    el.fLocation.value = site.location || '';
    el.fPrivacy.value = site.privacyNote || '';
    el.fCover.value = site.coverUrl || '';
    el.fFolderPhotos.value = folders.photos || '';
    el.fFolderGroup.value = folders.group || '';
    el.fFolderVideos.value = folders.videos || '';
    el.saveHint.textContent = '';
  }

  function formBody() {
    return {
      site: {
        title: el.fTitle.value,
        subtitle: el.fSubtitle.value,
        date: el.fDate.value,
        location: el.fLocation.value,
        privacyNote: el.fPrivacy.value,
        coverUrl: el.fCover.value,
      },
      folders: {
        photos: el.fFolderPhotos.value,
        group: el.fFolderGroup.value,
        videos: el.fFolderVideos.value,
      },
    };
  }

  async function saveSettings(body, { successToast }) {
    const data = await apiAdmin('/api/admin/settings', { method: 'PUT', body });
    applySettings(data.settings);
    // The durable copy lives in the Drive folder — say so when it did not land.
    el.saveHint.textContent = data.persisted
      ? 'Saved to your Drive folder.'
      : 'Saved for now, but NOT written to Drive — it will reset on redeploy.';
    if (successToast) toast(successToast, { bad: !data.persisted });
    return data;
  }

  async function updateSetting() {
    try {
      const data = await saveSettings(
        {
          uploadsEnabled: el.tglUploads.checked,
          galleryVisible: el.tglGallery.checked,
          galleryPublic: el.tglPublic.checked,
        },
        { successToast: null }
      );
      const flags = data.settings.flags;
      toast(
        !flags.uploadsEnabled
          ? 'Uploads are DISABLED — visitors will see a notice.'
          : flags.galleryPublic
            ? 'Gallery is open to everyone. Uploading still asks for the PIN.'
            : 'Settings saved.',
        { bad: !flags.uploadsEnabled }
      );
    } catch (err) {
      toast('Could not save setting: ' + (err.code || 'error'), { bad: true });
      loadOverview(true);
    }
  }

  async function saveContent() {
    el.btnSaveContent.disabled = true;
    try {
      await saveSettings(formBody(), { successToast: 'Page content updated.' });
    } catch (err) {
      toast('Could not save: ' + (err.code || 'error'), { bad: true });
    } finally {
      el.btnSaveContent.disabled = false;
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
    el.tglPublic.addEventListener('change', updateSetting);
    el.btnDriveTest.addEventListener('click', testDrive);
    el.btnSaveContent.addEventListener('click', saveContent);
    el.btnResetContent.addEventListener('click', () => {
      if (saved) fillForm(saved);
    });

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
