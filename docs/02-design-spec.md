# Tour Upload Hub — Design Specification (Phase 2: Design)

| | |
|---|---|
| **Document** | 02-design-spec.md |
| **Status** | v1.0 — Implemented as specified |
| **Related** | 01-project-plan.md (R-matrix), 03-qa-report.md |

> সারসংক্ষেপ (Bangla): ডিজাইন ফেজে UX ফ্লো, UI ডিজাইন সিস্টেম (রঙ, বাংলা টাইপোগ্রাফি, কার্ড,
> অ্যানিমেশন, ডার্ক মোড), API কন্ট্রাক্ট, আপলোড প্রোটোকল এবং নিরাপত্তা ডিজাইন ফাইনাল করা হয়েছে —
> build ফেজে হুবহু তা-ই বাস্তবায়িত হয়েছে।

---

## 1. Design principles

1. **Premium but simple** — one hero moment, one job per screen, soft shadows, rounded cards.
2. **Mobile-first, thumb-friendly** — 44px+ touch targets, sticky action button, safe-area padding.
3. **Zero confusion for non-technical users** — Bengali labels, plain-language errors, always-visible
   state (waiting → uploading % → done/retry).
4. **Trust & privacy cues** — privacy note in footer, uploader name optional, no sign-up.
5. **Calm motion** — entrance fade/slide, progress fill, a single success "pop"; no looping
   decoration (heart beats only inside the success message).
6. **Dark mode** — automatic via `prefers-color-scheme`, tokenized colors.

## 2. Information architecture / sitemap

```
/                Public tour page (hero + PIN gate + upload card + gallery link)
/gallery         Read-only gallery (lazy grid + lightbox)        [ENABLE_GALLERY]
/admin           Admin dashboard (login → stats/controls/QR)     [ADMIN_PASSWORD]
/api/...         JSON API (no HTML)
```

Public page states (data-driven from `GET /api/config`):
`pin gate?` → `uploads disabled?` (notice, buttons off) → `empty picker` → `files selected`
(summary + Upload) → `uploading` (per-file rows + batch bar) → `all done` (success banner) |
`partial/failed` (failure banner + retry).

## 3. User flows (happy & edge)

### 3.1 Visitor — upload (PIN configured)
```
Open link/QR → config: pinRequired=true → PIN card shown
→ enter PIN → POST /api/verify-pin → token in sessionStorage → upload card
→ tap "ছবি / ভিডিও বাছাই করুন" (or 📷 ক্যামেরা, or drag&drop)
→ files validated locally (type/size/count); previews listed; summary "Nটি ফাইল • size"
→ tap "Upload করুন" → engine sends 8 MB chunks, per-file %, batch bar, live total
→ every file: Drive 201 → ✓ সম্পন্ন; failures isolated with "আবার চেষ্টা করুন"
→ banner: "❤️ আপনার ছবি সফলভাবে Upload হয়েছে" | "Upload সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।"
```
### 3.2 Failure recovery
```
Chunk network error → retry ×3 → still failing / session lost (CHUNK_UNCERTAIN | UNKNOWN_UPLOAD)
→ file auto-restart with new upload id (≤3 attempts) → final state error → user taps retry
(per-file) or batch retry. Server aborted the stale Drive session (DELETE) so no orphans.
```
### 3.3 Admin
```
/admin → password → Bearer token (12 h)
→ overview: total files/size/folder name + 50 recent (name, uploader, type, size, time, Open ↗)
→ toggles: Allow uploads / Show gallery → PUT /api/admin/settings (instant, config reflects it)
→ QR card: img data-URL + URL + Download PNG  ("Scan করে Tour-এর ছবি Upload করুন")
```
### 3.4 Gallery viewer
```
/gallery → GET /api/gallery (recent media, Drive-backed)
→ grid: lazy-loaded Drive thumbnailLink (=s800), video badge ▶
→ click: lightbox — images via thumb (JPEG-safe, HEIC included) fallback proxy; video via
  authenticated Range proxy (seeking works); prev/next, Esc, swipe-free simple keys
→ no edit/delete controls anywhere for visitors
```

## 4. UI design system

### 4.1 Color tokens (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f2f7fb` | `#0a1522` | page |
| `--surface` | `#ffffff` | `#12202f` | cards |
| `--surface-2` | `#f6fafc` | `#0e1a26` | wells/rows |
| `--text` | `#0b253b` | `#e8f0f7` | headings/body |
| `--muted` | `#5c7289` | `#8fa6ba` | secondary |
| `--line` | `#e3edf4` | `#1e3042` | borders |
| brand | `#0ea5e9 → #6366f1` gradient | same | CTA, progress |
| `--ok / --danger / --warn` | green/red/amber + tinted bg | dimmed | states |

Travel theme: sky blue → indigo gradient hero text, soft cyan/lavender blurred blobs,
white cards.

### 4.2 Typography
- `Hind Siliguri` (Google Fonts, `display=swap`) → fallback `Noto Sans Bengali`,
  `Bangla Sangam MN` (iOS), system Bengali fonts — covers চন্দ্রবিন্দু/যুক্তাক্ষর rendering.
- Scale: hero `clamp(2rem→3rem)` bold gradient; section titles 1.15–1.3rem; body 1rem;
  meta 0.8–0.9rem muted.

### 4.3 Components
`card` (radius 20, hairline border, soft shadow) · `btn primary/ghost/outline`, `btn-lg`,
`btn-block`, `btn-xs` · `input` / `input-lg` · pill toggles (admin) · `file-row`
(thumb 56px, name ellipsis, mini progress, status, remove ✕) · `banner ok/bad big` ·
`toast` · gallery `g-item` tiles · `lightbox` · `admin-table`, `stat-card`, `qr-wrap`.
Motion: `rowIn` (fade+6px) for list/banner, `pop` for success, `heartBeat` in ❤️,
progress `width .3s`. Respects `prefers-reduced-motion` implicitly (short, subtle).

### 4.4 Key UI copy (Bengali, from brief)
Title **Tour Memories** · subtitle **আমাদের Tour-এর সব ছবি ও ভিডিও এখানে Upload করুন** ·
pick **ছবি / ভিডিও বাছাই করুন** · action **Upload করুন** · success **❤️ আপনার ছবি সফলভাবে
Upload হয়েছে** · failure **Upload সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।** · empty **এখনও কোনো
ছবি নির্বাচন করা হয়নি** · privacy **আপনার Upload করা ফাইল শুধু আমাদের Tour Drive-এ সংরক্ষিত হবে।**

## 5. Technical design

### 5.1 Runtime architecture (no build step)
```
Browser (public/*.html, css/app.css, js/*)
   │ fetch/JSON + XHR chunk streams (same-origin)
Express (server/server.js)
   ├ routes/api.js      config · verify-pin · upload prepare/chunk/cancel · gallery(+content proxy)
   ├ routes/admin.js    login · overview · settings · qr
   ├ middleware/        security headers · rate limiters · auth (HMAC tokens)
   ├ services/          drive.js (OAuth+resumable) · config · state · uploads registry
   └ utils/             logger · sanitize · tokens
   └────────► Google Drive REST API (resumable sessions, files.list, media Range GET)
```

### 5.2 API contract (server routes ↔ client)

| Method & path | Auth | Body/headers | Success | Errors |
|---|---|---|---|---|
| `GET /api/config` | – | – | public config JSON | – |
| `GET /api/health` | – | – | `{ok,uptime}` | – |
| `POST /api/verify-pin` | rate 15/15m | `{pin}` | `{token}` | 401 INVALID_PIN, 429 |
| `POST /api/upload/prepare` | upload gate | `{files[],uploader}` | `{accepted[],rejected[]}` | 401/403/429 |
| `POST /api/upload/chunk` | upload gate | headers `X-Upload-Id/-Offset/-Total/-File-Name/-Mime/-Uploader/-Token` + raw bytes | `{received}` \| `{done,file}` | 401 PIN_REQUIRED · 403 UPLOADS_DISABLED · 413 FILE_TOO_LARGE · 415 INVALID_TYPE · 422 UNKNOWN_UPLOAD · 409 OUT_OF_ORDER · 503 CHUNK_UNCERTAIN · drive codes |
| `POST /api/upload/cancel` | upload gate | `{uploadId}` | `{ok}` | 400 |
| `GET /api/gallery` | rate | – | `{items:[{id,name,isImage,isVideo,mimeType,size,createdTime,uploader,thumb,src}]}` | 404 GALLERY_DISABLED |
| `GET /api/gallery/file/:id/content` | rate | `Range` (video) | stream 200/206 | 404 (id not in folder), 502 |
| `POST /api/admin/login` | rate 10/15m | `{password}` | `{token}` | 401 |
| `GET /api/admin/overview` | Bearer | – | `{stats,recent[50],settings}` | 401 |
| `PUT /api/admin/settings` | Bearer | `{uploadsEnabled?,galleryVisible?}` | `{settings}` | 401 |
| `GET /api/admin/qr` | Bearer | – | `{publicUrl,dataUrl,scanText}` | 401 |

### 5.3 Upload protocol (chunk lifecycle)
```
Client: for each file (≤2 files in parallel, one chunk at a time each):
  chunk = file.slice(offset, offset+8MB)
  PUT /api/upload/chunk (raw body, X-Offset, X-Total …)
Server:
  offset 0 → sanitize name/mime/size → ensure unique name → createDriveResumableSession
             (metadata: name, parents=[FOLDER_ID], description={uploader,original,time})
  each chunk → stream req pipe → Drive PUT w/ Content-Range bytes a-b/total
             → 308 ⇒ advance offset → {received}
             → 201 ⇒ file id ⇒ {done:true}
             → any failure ⇒ abort Drive session (DELETE) + remove registry entry
                                ⇒ 503 CHUNK_UNCERTAIN ⇒ client restarts file (new id, ≤3)
  duplicate ack of already-stored bytes ⇒ drain & echo {received} (idempotent retry)
Idle sessions evicted after 2 h (abort + DELETE) — no orphaned partial uploads.
```

### 5.4 Data design (DB-less)
- **Source of truth:** Drive folder contents (files.list, `orderBy=createdTime desc`).
- **Per-file metadata:** file `description` = JSON `{u:uploader, n:originalName, a:createdAt}`.
- **Name collisions:** append ` (2)`, ` (3)` … (Drive never overwrites; `files.create` always new).
- **Runtime state:** in-memory chunk registry (`services/uploads.js`); admin toggles in
  ephemeral `data/state.json` with env-var defaults.

### 5.5 Environment matrix (server-only; never in frontend)
`PORT` · `PUBLIC_SITE_URL` · `GOOGLE_DRIVE_FOLDER_ID` · `GOOGLE_CLIENT_ID` ·
`GOOGLE_CLIENT_SECRET` · `GOOGLE_REFRESH_TOKEN` · `GOOGLE_DRIVE_SCOPE`(opt) · `ADMIN_PASSWORD`
· `TOUR_UPLOAD_PIN`(opt) · `ENABLE_GALLERY` · `ENABLE_UPLOADS` · `GALLERY_VISIBLE` ·
`MAX_FILE_SIZE_MB` · `MAX_FILES_PER_UPLOAD` · `UPLOAD_CHUNK_MB` · `GALLERY_LIMIT` · `TOUR_*` texts

### 5.6 Security design
- Folder stays private; server authenticates with owner's OAuth token (env only).
- Allowed types via extension↔MIME whitelist (`EXT_MIME`); ambiguous client MIME falls back to
  extension; executables/scripts/SVG/HTML rejected server-side (not just client-side).
- Filename sanitization: strip paths/control/quotes, cap length, NFC normalize.
- PIN & admin: constant-time compare; proof via purpose-scoped expiring HMAC tokens;
  rate limits; uploads gate re-checked on every chunk.
- Gallery content proxy verifies each file id's parent == configured folder before serving.
- Headers: CSP (`default-src 'self'`, external only Google Fonts + `https:` images/media),
  `nosniff`, `X-Frame-Options DENY`, HSTS on HTTPS, Referrer-Policy, Permissions-Policy.
- Logs: event info only — never tokens, PINs, passwords, or secret material.
- Errors: mapped JSON codes; stack traces never sent to clients.

### 5.7 Non-functional targets
- Concurrency: many simultaneous uploaders; 2 parallel files/visitor; shared registry in memory.
- Single-file failure never fails the batch; overall + per-file progress always visible.
- Request timeouts raised (30 min server receive window); chunk watchdog 120 s on client.
- Railway: no file bytes on disk; deploy = `npm start`, Nixpacks auto-detect.

## 6. Acceptance checklist (hard requirements from brief)

- [x] All uploaded files land in the single configured Drive folder, owned by organizer.
- [x] Mobile picker + camera capture + multi-select + drag&drop (desktop).
- [x] Preserve original names; no collisions; no overwrite ever.
- [x] Chunked/resumable/streamed (no whole-file memory, no permanent disk).
- [x] PNG/JPG/JPEG/WEBP/GIF/HEIC/HEIF/BMP/MP4/MOV/M4V/3GP/3G2.
- [x] Rate limits, MIME validation, sanitize, no executables, optional PIN, secure headers.
- [x] Progress %, per-file status, retry, success/failure/no-files/privacy Bengali strings.
- [x] Optional lazy gallery + lightbox + video play; no visitor edit/delete.
- [x] Admin: login, totals, recent, uploader/time/type, open in Drive, disable uploads,
      hide gallery, QR download, no public deletes.
- [x] GitHub + Railway ready; `.env.example`/`.gitignore`/README 12 sections.
- [x] Consistent env names end-to-end; frontend/backend routes match (QA verified).
