# Tour Upload Hub — Project Plan (Phase 1: Planning)

| | |
|---|---|
| **Document** | 01-project-plan.md |
| **Version / Status** | v1.0 — Approved for build |
| **Date** | 2026-09-09 |
| **Product** | Private group-tour photo/video upload website → one Google Drive folder |
| **Owner** | Accio Assistant (Team Lead — planning, architecture, build, QA) |

> সারসংক্ষেপ (Bangla): লক্ষ্য — একটি ওয়েব লিংক/QR কোড শেয়ার করে Tour-এর সব সদস্য মোবাইল থেকে ছবি-ভিডিও
> Upload করবে, সব ফাইল স্বয়ংক্রিয়ভাবে আয়োজকের একটি নির্দিষ্ট Google Drive ফোল্ডারে জমা হবে।
> ফাইল Railway-এর ephemeral disk-এ জমা হয় না — সরাসরি chunked/resumable পদ্ধতিতে Drive-এ stream হয়।
> Admin প্যানেল, ঐচ্ছিক PIN, ঐচ্ছিক gallery, QR শেয়ারিং, সম্পূর্ণ নিরাপত্তা সুরক্ষা — সব scope-এর মধ্যে।

---

## 1. Business context & personas

**Problem:** Tour photos/videos are scattered across private chats; the organizer has to
collect them one-by-one and loses originals in chat compression.

**Solution:** One link/QR → simple Bengali mobile page → participants pick or capture
multiple photos/videos → everything lands in the organizer's Google Drive folder with the
original quality and filename.

**Personas**
1. **Tour organizer (owner)** — non-technical; owns the Drive folder; needs an admin
   dashboard, QR poster, and live on/off switches.
2. **Participant** — non-technical; smartphone (iPhone/Android); Bengali speaker; wants a
   giant upload button and clear success feedback; must not see technical errors.
3. **Remote viewer (optional)** — views the gallery if the owner enables it; read-only.

## 2. Scope

**In scope**
- Public upload page (mobile-first, Bengali), drag & drop, camera/gallery picker,
  multi-select, previews, per-file + overall progress, retry, no page refresh.
- Server-side streaming upload into a single configurable Google Drive folder
  (`GOOGLE_DRIVE_FOLDER_ID`) using resumable chunked sessions (no whole-file buffering,
  no permanent disk storage).
- Original filenames preserved; collisions prevented with ` (2)` suffixes; Drive never
  overwrites.
- Optional shared PIN (`TOUR_UPLOAD_PIN`) before uploads; optional gallery
  (`ENABLE_GALLERY`) with lazy thumbnails + lightbox + video playback; admin dashboard
  (`ADMIN_PASSWORD`) with stats, recent uploads, live toggles, QR download.
- GitHub + Railway ready; full setup docs.

**Out of scope (v1)**
- Deleting/editing files from the public UI (never exposed — by design).
- Multiple folder targets per tour, per-user quotas, email/SMS invites.
- Automatic HEIC→JPEG conversion (Drive thumbnails cover display; originals stay as-is).
- Native apps (web app only, installable to home screen).

## 3. Requirements traceability (original brief → implementation)

| # | Requirement (from brief) | Implemented in | Status |
|---|---|---|---|
| R1 | Node.js + Express, easy Railway deploy | `server/server.js`, `package.json` | ✅ |
| R2 | Plain HTML/CSS/JS frontend | `public/` | ✅ |
| R3 | No Google creds in frontend | env-only in `services/config.js`; API exposes only `publicConfig()` | ✅ |
| R4 | Google Drive API, server-side auth | `services/drive.js` (OAuth2 refresh token) | ✅ |
| R5 | Upload into `GOOGLE_DRIVE_FOLDER_ID` | session create `parents:[folderId]` | ✅ |
| R6 | Original filenames + collision protection | `utils/sanitize.js`, `ensureUniqueName()` | ✅ |
| R7 | Clear success after Drive confirms | chunk final `201` → `{done,file}` → UI banner | ✅ |
| R8 | Mobile-first beautiful UI + Bengali texts | `public/index.html`, `css/app.css`, `js/tour.js` | ✅ |
| R9 | Progress %, per-file status, retry, no refresh, no double upload | `public/js/upload-engine.js`, `tour.js` | ✅ |
| R10 | Large files; resumable/chunked; streaming; upload limits + clear error | chunk pipeline in `routes/api.js` + Drive resumable; `413 FILE_TOO_LARGE` | ✅ |
| R11 | Allowed formats (JPG/PNG/HEIC/WEBP/MP4/MOV/…) | `EXT_MIME` whitelist | ✅ |
| R12 | Folder not public; visitors never get creds; rate limiting; MIME validation; sanitize; no executables; abuse protection | `middleware/` + `utils/sanitize.js` | ✅ |
| R13 | Optional PIN mode | `POST /api/verify-pin` + HMAC token gate | ✅ |
| R14 | Secure HTTP headers | `middleware/security.js` | ✅ |
| R15 | Optional gallery (lazy, lightbox, videos, no edit/delete, backend data) | `routes/api.js` `/api/gallery*`, `public/gallery.html/js` | ✅ |
| R16 | Admin: login, totals, recent uploads, uploader/time/type, open-in-Drive, disable uploads, hide gallery, no public deletes | `routes/admin.js`, `public/admin.html/js` | ✅ |
| R17 | QR generation + "Scan করে Tour-এর ছবি Upload করুন" | `GET /api/admin/qr` (qrcode lib) | ✅ |
| R18 | Design: premium-simple, mobile-first, Bengali font, subtle animations, dark mode | `public/css/app.css` | ✅ |
| R19 | Env vars + folder structure + required files + 12-section README | `.env.example`, repo layout, `README.md` | ✅ |
| R20 | No permanent Railway disk storage; concurrent uploads; failed file ≠ batch failure; no overwrite; graceful Drive errors; safe logs | streaming chunk design, registry, `utils/logger.js` | ✅ |

## 4. Key architecture decisions (and why)

1. **OAuth refresh token (Desktop-app client), not service account** — the folder is owned
   by the organizer's personal account; service accounts would require sharing the folder
   with a robot email.
2. **Default scope `drive` (full, own account)** — `drive.file` returns "File not found"
   for folders the app didn't create; full scope works with any folder the owner makes.
   Token lives only in server env vars.
3. **Chunked resumable uploads (client→server→Drive), zero buffering** — each 8 MB chunk
   is piped straight into a Drive resumable session. Memory usage is O(chunk), not O(file);
   Railway's ephemeral disk is never used for file bytes.
4. **No database** — Drive folder is the source of truth; gallery & admin list it live.
   Uploader metadata is packed into each file's Drive `description` field.
5. **Stateless HMAC tokens** (PIN proof, admin) — no session store; PIN/admin secret change
   invalidates all tokens.
6. **Ephemeral `data/state.json`** only for admin live toggles; durable defaults are env
   vars (`ENABLE_UPLOADS`, `GALLERY_VISIBLE`) that survive redeploys.

## 5. Delivery phases

| Phase | Milestone | Output | Status |
|---|---|---|---|
| 1 | Plan | `docs/01-project-plan.md` | ✅ this document |
| 2 | Design | `docs/02-design-spec.md` | ✅ |
| 3 | Build | Full source (server, routes, services, middleware, utils, public) | ✅ |
| 4 | QA | `docs/03-qa-report.md` + route/protocol tests | ✅ |
| 5 | Docs & deploy prep | `README.md`, `.env.example`, `.gitignore`, `package.json` | ✅ |
| 6 | Live deploy | Railway service (needs organizer's Google credentials) | ⏳ owner action |

## 6. Roles (RACI)

| Activity | Accio Assistant (Lead) | Specialist teammates |
|---|---|---|
| Plan / architecture / build / QA | **R / A** | — |
| Tour cover art / poster design | C | **Design Expert** (optional phase 7) |
| Public site findability (SEO/GEO) | C | **SEO·GEO Assistant** (optional phase 7) |
| Live no-code site variant | C | **Site Builder** (not needed — code deploy preferred) |

The product is one cohesive codebase; building it end-to-end by the lead avoids split-brain
integration risk. Specialists add value only for isolated creative/marketing assets.

## 7. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Wrong OAuth scope → folder 404 | High | Default full `drive` scope + boot folder-access check + README warning |
| Railway ephemeral disk reset | Medium | No file bytes stored; toggles reset to env defaults (documented) |
| Very large video over slow mobile network | Medium | Chunked upload, per-chunk retries, automatic file restart, generous server timeouts |
| Connection drops mid-upload | Medium | Resumable sessions; client restarts file with fresh session (≤3 attempts) |
| HEIC not previewable on some browsers | Low | Drive JPEG thumbnails; fallback message; originals intact in Drive |
| PIN brute force | Medium | Rate-limited PIN endpoint + constant-time compare |
| Abuse / disabled tour | Medium | Live admin kill-switch; per-IP rate limits on all endpoints |

## 8. Definition of done

- All R1–R20 above demonstrably implemented and verified (see QA report).
- Server boots with missing-creds fail-fast message; routes return consistent JSON errors.
- Mobile upload path works from picker/camera; no full-page refresh during upload.
- GitHub + Railway ready (`npm start`), env var names identical across code/.env.example/README.

## 9. Assumptions

- Organizer will create the Google folder, OAuth client, and refresh token using README steps.
- Railway provides `PORT`; organizer adds remaining env vars.
- Node ≥ 18 on the deploy target.
