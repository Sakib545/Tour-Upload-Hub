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
    tglPublic: $('#tglPublic'),
    btnOrganise: $('#btnOrganise'),
    organiseHint: $('#organiseHint'),
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
    loadFaces();
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

  const MEDIA_LABEL = { photo: 'PHOTO', video: 'VIDEO', any: 'ANY' };

  /** ISO instant → the "YYYY-MM-DDTHH:mm" a datetime-local input expects. */
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** …and back, so the server stores an unambiguous instant. */
  function fromLocalInput(value) {
    if (!value) return '';
    const d = new Date(value);
    return isNaN(d) ? '' : d.toISOString();
  }

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
    // <input type="datetime-local"> wants the viewer's own local time.
    set('#siteStartAt', toLocalInput(c.startAt));
    set('#siteEndAt', toLocalInput(c.endAt));
    buildCategoryRows(site.categories || []);
  }

  function categoryRow(cat) {
    const tr = document.createElement('tr');
    tr.dataset.catId = cat.id || '';
    tr.dataset.builtin = cat.builtin ? '1' : '';

    const tdType = document.createElement('td');
    if (cat.builtin) {
      // The three built-ins are the fallback routing, so their kind is fixed.
      const tag = document.createElement('span');
      tag.className = 'cat-tag';
      tag.textContent = MEDIA_LABEL[cat.media] || cat.media;
      tdType.appendChild(tag);
    } else {
      const sel = document.createElement('select');
      sel.className = 'input';
      sel.dataset.field = 'media';
      for (const [value, text] of [['photo', 'PHOTO'], ['video', 'VIDEO'], ['any', 'ANY']]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        sel.appendChild(opt);
      }
      sel.value = cat.media || 'any';
      tdType.appendChild(sel);
    }

    const field = (name, value) => {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.className = 'input';
      inp.dataset.field = name;
      inp.maxLength = 80;
      inp.value = value || '';
      td.appendChild(inp);
      return td;
    };

    const tdActions = document.createElement('td');
    if (!cat.builtin) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'cat-remove';
      rm.title = 'Remove this category';
      rm.setAttribute('aria-label', 'Remove this category');
      rm.textContent = '✕';
      rm.addEventListener('click', () => tr.remove());
      tdActions.appendChild(rm);
    }

    tr.append(tdType, field('label', cat.label), field('folder', cat.folder), tdActions);
    return tr;
  }

  function buildCategoryRows(cats) {
    const body = $('#catTableBody');
    if (!body) return;
    body.textContent = '';
    for (const cat of cats) body.appendChild(categoryRow(cat));
  }

  function addCategoryRow() {
    const body = $('#catTableBody');
    if (!body) return;
    if (body.children.length >= 12) {
      toast('12টির বেশি category রাখা যাবে না।', { bad: true });
      return;
    }
    // Removing a category never deletes its Drive folder or its files.
    body.appendChild(categoryRow({ id: '', label: '', folder: '', media: 'any', builtin: false }));
    const last = body.lastElementChild.querySelector('[data-field="label"]');
    if (last) last.focus();
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
      startAt: fromLocalInput(val('#siteStartAt')),
      endAt: fromLocalInput(val('#siteEndAt')),
    };
    const categories = [];
    for (const tr of $$('#catTableBody tr')) {
      const label = tr.querySelector('[data-field="label"]');
      const folder = tr.querySelector('[data-field="folder"]');
      if (!label || !folder) continue;
      const media = tr.querySelector('[data-field="media"]');
      const row = {
        // No id = a new category; the server mints one.
        id: tr.dataset.catId || '',
        label: label.value.trim(),
        folder: folder.value.trim(),
      };
      if (media) row.media = media.value;
      if (!row.id && !row.label && !row.folder) continue;
      categories.push(row);
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
      fillUploadCategories(data.site.categories || []);
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
    el.tglPublic.checked = !!settings.galleryPublic;
  }

  async function updateSetting() {
    try {
      const data = await apiAdmin('/api/admin/settings', {
        method: 'PUT',
        body: {
          uploadsEnabled: el.tglUploads.checked,
          galleryVisible: el.tglGallery.checked,
          galleryPublic: el.tglPublic.checked,
        },
      });
      setToggles(data.settings);
      // The durable copy lives in the Drive folder — say so when it did not land.
      const where = data.persisted ? '' : ' (saved for now, but NOT written to Drive)';
      toast(
        !data.settings.uploadsEnabled
          ? 'Uploads are DISABLED — visitors will see a notice.' + where
          : data.settings.galleryPublic
            ? 'Gallery is open to everyone. Uploading still asks for the PIN.' + where
            : 'Settings saved.' + where,
        { bad: !data.settings.uploadsEnabled || !data.persisted }
      );
    } catch (err) {
      toast('Could not save setting: ' + (err.code || 'error'), { bad: true });
      loadOverview(true);
    }
  }

  async function organise() {
    el.btnOrganise.disabled = true;
    el.organiseHint.textContent = 'Moving files…';
    try {
      const r = await apiAdmin('/api/admin/organise', { method: 'POST', body: {} });
      const moved = r.photos + r.videos;
      el.organiseHint.textContent = moved
        ? `Moved ${r.photos} photo(s) and ${r.videos} video(s).` + (r.failed ? ` ${r.failed} failed.` : '')
        : 'Nothing to move — everything is already in a folder.';
      toast(moved ? `Sorted ${moved} file(s) into folders.` : 'Already tidy.', { bad: !!r.failed });
      loadOverview(true);
    } catch (err) {
      el.organiseHint.textContent = '';
      toast('Could not sort files: ' + (err.code || 'error'), { bad: true });
    } finally {
      el.btnOrganise.disabled = false;
    }
  }

  /* ── Upload straight from the dashboard ───────────────────── */

  // Same chunked engine the visitor page uses; the admin token stands in for
  // the PIN, so this keeps working while visitor uploads are paused.
  let adminEngine = null;
  let adminCfg = null;

  function fillUploadCategories(cats) {
    const sel = $('#adminUploadCat');
    if (!sel) return;
    const previous = sel.value;
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto (by file type)';
    sel.appendChild(auto);
    for (const c of cats) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.label} → ${c.folder}`;
      sel.appendChild(opt);
    }
    if (previous && cats.some((c) => c.id === previous)) sel.value = previous;
  }

  function renderAdminUploads(entries) {
    const list = $('#adminUploadList');
    if (!list) return;
    list.textContent = '';
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'admin-upload-row'
        + (e.status === 'done' ? ' is-done' : e.status === 'error' ? ' is-error' : '');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.name;

      const state = document.createElement('span');
      state.className = 'state';
      state.textContent =
        e.status === 'done' ? '✓ সম্পন্ন'
          : e.status === 'error' ? 'ব্যর্থ'
            : e.status === 'uploading' ? `${e.pct || 0}%`
              : 'অপেক্ষা…';

      li.append(name, state);
      list.appendChild(li);
    }
    const busy = entries.some((e) => e.status === 'pending' || e.status === 'uploading');
    const btn = $('#btnAdminUpload');
    if (btn) {
      btn.hidden = !entries.some((e) => e.status === 'pending' || e.status === 'error');
      btn.disabled = busy;
    }
    const hint = $('#adminUploadHint');
    if (hint && entries.length) {
      const done = entries.filter((e) => e.status === 'done').length;
      const failed = entries.filter((e) => e.status === 'error').length;
      hint.textContent = busy
        ? `${done}/${entries.length} শেষ…`
        : failed
          ? `${done} সফল, ${failed} ব্যর্থ।`
          : `${done}টি ফাইল Drive-এ জমা হয়েছে।`;
    }
  }

  async function ensureAdminEngine() {
    if (adminEngine) return adminEngine;
    if (!adminCfg) adminCfg = await api('/api/config');
    adminEngine = createUploadEngine({
      cfg: {
        maxFileBytes: adminCfg.maxFileBytes,
        maxFilesPerUpload: adminCfg.maxFilesPerUpload,
        chunkBytes: adminCfg.chunkMB * 1024 * 1024,
      },
      getToken: () => token,
      getUploader: () => 'Admin',
      onChange: (entries) => renderAdminUploads(entries),
      onProgress: (entries) => renderAdminUploads(entries),
    });
    return adminEngine;
  }

  async function pickAdminFiles() {
    await ensureAdminEngine();
    $('#adminFileInput').click();
  }

  async function addAdminFiles(fileList) {
    const engine = await ensureAdminEngine();
    const chosen = $('#adminUploadCat').value;
    const res = engine.addFiles(fileList, { category: chosen });
    if (res.rejected && res.rejected.length) {
      toast(`${res.rejected.length}টি ফাইল নেওয়া যায়নি (ধরন বা আকার)।`, { bad: true });
    }
    // Every file follows the category picked above, videos included.
    if (chosen) for (const e of res.added) engine.setCategory(e.id, chosen);
    renderAdminUploads(engine.entries);
  }

  async function startAdminUpload() {
    const engine = await ensureAdminEngine();
    // Re-queue anything that failed on an earlier attempt, then run the batch.
    for (const e of engine.entries) {
      if (e.status === 'error') engine.retry(e.id);
    }
    engine.start();
  }

  /* ── People & face sorting ────────────────────────────────── */

  let enrollTargetId = null;

  function personRow(person, enabled) {
    const li = document.createElement('li');
    li.className = 'person-row';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = person.name;

    const samples = document.createElement('span');
    samples.className = person.samples ? 'samples' : 'warn';
    samples.textContent = person.samples
      ? `${person.samples}টি নমুনা ছবি`
      : 'নমুনা ছবি দিন — নইলে চেনা যাবে না';

    // The four colours that make this person's beach figure recognisable.
    const swatches = document.createElement('span');
    swatches.className = 'swatches';
    const avatar = person.avatar || {};
    for (const [key, label] of [
      ['skin', 'গায়ের রং'], ['hair', 'চুল'], ['shirt', 'জামা'], ['shorts', 'প্যান্ট'],
    ]) {
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'swatch';
      input.title = label;
      input.value = avatar[key] || '#efbd93';
      input.addEventListener('change', () => saveAvatar(person.id, { [key]: input.value }));
      swatches.appendChild(input);
    }

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const enroll = document.createElement('button');
    enroll.type = 'button';
    enroll.className = 'btn btn-ghost btn-xs';
    enroll.textContent = '+ নমুনা ছবি';
    enroll.disabled = !enabled;
    enroll.title = enabled ? 'এই ব্যক্তির স্পষ্ট, একা একটি ছবি দিন' : 'FACE_SORT চালু করুন';
    enroll.addEventListener('click', () => {
      enrollTargetId = person.id;
      $('#enrollInput').click();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cat-remove';
    remove.title = 'সরিয়ে দিন (Drive-এর ছবি বা ফোল্ডার মুছবে না)';
    remove.textContent = '✕';
    remove.addEventListener('click', () => removePerson(person));

    li.append(who, samples, swatches, spacer, enroll, remove);
    return li;
  }

  function renderPeople(data) {
    const list = $('#peopleList');
    if (!list) return;
    if (data.heroCrew) $('#heroCrewMode').value = data.heroCrew;
    const enabled = !!(data.status && data.status.enabled);
    $('#facesOff').hidden = enabled;
    list.textContent = '';
    for (const person of data.people || []) list.appendChild(personRow(person, enabled));
    if (!(data.people || []).length) {
      const li = document.createElement('li');
      li.className = 'muted-text';
      li.textContent = 'এখনো কেউ যোগ করা হয়নি।';
      list.appendChild(li);
    }
    $('#btnRescan').disabled = !enabled;

    const st = data.status || {};
    const bits = [];
    if (st.pending) bits.push(`${st.pending}টি বাকি`);
    if (st.moved) bits.push(`${st.moved}টি ছবি সরানো হয়েছে`);
    if (st.failed) bits.push(`${st.failed}টি ব্যর্থ`);
    if (st.lastError) bits.push(st.lastError);
    $('#facesStatus').textContent = bits.join(' · ');
  }

  async function saveAvatar(id, patch) {
    try {
      await apiAdmin('/api/admin/people/' + id, { method: 'PATCH', body: { avatar: patch } });
      toast('রং সেভ হয়েছে — hero পেজ রিফ্রেশ করলে দেখবেন।');
    } catch (err) {
      toast('রং সেভ করা যায়নি।', { bad: true });
    }
  }

  async function saveCrewMode() {
    try {
      await apiAdmin('/api/admin/settings', {
        method: 'PUT',
        body: { heroCrew: $('#heroCrewMode').value },
      });
      toast('Hero-র দল বদলানো হয়েছে।');
    } catch (err) {
      toast('বদলানো যায়নি।', { bad: true });
    }
  }

  async function loadFaces() {
    try {
      renderPeople(await apiAdmin('/api/admin/faces'));
    } catch (err) { /* the section simply stays empty */ }
  }

  async function addPerson() {
    const input = $('#personName');
    const name = input.value.trim();
    if (!name) return;
    try {
      await apiAdmin('/api/admin/people', { method: 'POST', body: { name } });
      input.value = '';
      loadFaces();
    } catch (err) {
      toast(err.code === 'BAD_NAME' ? 'এই নামটি ব্যবহার করা যাচ্ছে না।' : 'যোগ করা যায়নি।', { bad: true });
    }
  }

  async function removePerson(person) {
    try {
      await apiAdmin('/api/admin/people/' + person.id, { method: 'DELETE' });
      loadFaces();
    } catch (err) {
      toast('সরানো যায়নি।', { bad: true });
    }
  }

  // The enrolment photo is sent as raw bytes and never stored — only the
  // 128-number descriptor it produces is kept.
  async function enrollPhoto(file) {
    if (!file || !enrollTargetId) return;
    const target = enrollTargetId;
    enrollTargetId = null;
    $('#facesStatus').textContent = 'মুখ শনাক্ত করা হচ্ছে…';
    try {
      const res = await fetch('/api/admin/people/' + target + '/enroll', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/jpeg', Authorization: 'Bearer ' + token },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          NO_FACE: 'ছবিতে কোনো মুখ পাওয়া যায়নি।',
          MANY_FACES: 'একাধিক মুখ আছে — একজনের ছবি দিন।',
          FACES_UNAVAILABLE: 'Face recognition চালু নেই।',
        }[data.error] || 'নমুনা ছবি নেওয়া যায়নি।', { bad: true });
        $('#facesStatus').textContent = '';
        return;
      }
      toast('নমুনা ছবি যোগ হয়েছে।');
      loadFaces();
    } catch (err) {
      toast('নমুনা ছবি পাঠানো যায়নি।', { bad: true });
    }
  }

  async function rescanFaces() {
    $('#btnRescan').disabled = true;
    $('#facesStatus').textContent = 'পুরনো ছবিগুলো সারিতে দেওয়া হচ্ছে…';
    try {
      const r = await apiAdmin('/api/admin/faces/rescan', { method: 'POST', body: {} });
      toast(`${r.queued}টি ছবি মিলিয়ে দেখা হচ্ছে…`);
      // The queue runs in the background; poll a few times so the count moves.
      for (let i = 0; i < 10; i++) {
        await new Promise((done) => setTimeout(done, 1500));
        const data = await apiAdmin('/api/admin/faces');
        renderPeople(data);
        if (!data.status.pending && !data.status.working) break;
      }
    } catch (err) {
      toast('চালানো যায়নি।', { bad: true });
    } finally {
      $('#btnRescan').disabled = false;
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
    el.btnOrganise.addEventListener('click', organise);
    $('#btnAddPerson').addEventListener('click', addPerson);
    $('#personName').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); addPerson(); }
    });
    $('#btnRescan').addEventListener('click', rescanFaces);
    $('#heroCrewMode').addEventListener('change', saveCrewMode);
    $('#enrollInput').addEventListener('change', (ev) => {
      enrollPhoto(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });
    el.btnDriveTest.addEventListener('click', testDrive);
    const saveBtn = $('#btnSaveSite');
    if (saveBtn) saveBtn.addEventListener('click', saveSite);
    const addCat = $('#btnAddCat');
    if (addCat) addCat.addEventListener('click', addCategoryRow);
    $('#btnAdminPick').addEventListener('click', pickAdminFiles);
    $('#btnAdminUpload').addEventListener('click', startAdminUpload);
    $('#adminFileInput').addEventListener('change', (ev) => {
      addAdminFiles(ev.target.files);
      ev.target.value = '';
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
