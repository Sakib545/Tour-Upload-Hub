# Tour Upload Hub — QA Report (Phase 4: Verification)

| | |
|---|---|
| **Document** | 03-qa-report.md |
| **Status** | v1.0 — All automated checks passed |
| **Date** | 2026-09-09 |
| **Environment** | macOS arm64, Node v22.23.2, Express 4, deps installed clean |

> সারসংক্ষেপ (Bangla): প্রতিটি route live সার্ভারে চালিয়ে যাচাই করা হয়েছে — PIN/auth gate,
> file-type ও size validation, admin login/toggle/QR, security headers সব সঠিক। Google Drive-এর
> resumable প্রোটোকল (308→201, probe, abort) mock সার্ভার দিয়ে টেস্ট করা হয়েছে। আসল Drive-এ
> end-to-end upload শুধু আয়োজকের real credentials দিলেই হবে (নিচে §6)।

## 1. Method

1. `npm install` (clean) → `node --check` on all 20 JS files → **all pass**.
2. Booted the server with dummy-but-valid env vars (`TOUR_UPLOAD_PIN=1234`,
   `ADMIN_PASSWORD=test123`, fake Google creds).
3. Exercised every HTTP route with `curl`; asserted status codes & JSON error codes.
4. Verified the Drive protocol layer offline against a mock HTTPS resumable endpoint.
5. Static checks: every DOM id referenced in JS exists in the HTML pages.

## 2. Route & behavior results

| Check | Expectation | Result |
|---|---|---|
| `GET /` , `/admin`, `/gallery` (pages) | 200 | ✅ 200 |
| `GET /api/health`, `/api/config` | JSON | ✅ (config carries Bengali subtitle/privacy + limits + toggles) |
| Security headers (CSP, nosniff, frame DENY, referrer, HSTS-on-HTTPS) | present | ✅ all present |
| `POST /api/verify-pin` wrong pin | 401 | ✅ |
| … correct pin | `{token}` (94 chars) | ✅ |
| Upload chunk **without** PIN token | 401 | ✅ |
| Preflight: `IMG_001.jpg` | accepted | ✅ |
| Preflight: `evil.exe` | rejected `INVALID_TYPE` | ✅ |
| Preflight: >2 GB `big.mp4` | rejected `FILE_TOO_LARGE` | ✅ |
| Chunk valid file (fake creds) | graceful JSON error, no crash | ✅ `{"error":"DRIVE_AUTH"}` |
| Chunk `c.sh` | 415 | ✅ |
| Gallery route w/ Drive down | graceful JSON | ✅ mapped `DRIVE_AUTH` |
| Admin login wrong / right | 401 / token | ✅ |
| `/api/admin/overview` w/o token | 401 | ✅ |
| Settings PUT `uploadsEnabled=false,galleryVisible=false` | persisted | ✅ |
| Public `/api/config` reflects toggles | false/false | ✅ |
| Upload after disable | 403 `UPLOADS_DISABLED` | ✅ |
| Re-enable | true/true | ✅ |
| `/api/admin/qr` | URL + PNG data-URL + Bengali scan text | ✅ |
| Unknown `/api/*` | 404 JSON | ✅ |
| Server stays alive after error storm | healthy | ✅ |

## 3. Drive resumable protocol (mock HTTPS endpoint)

| Scenario | Result |
|---|---|
| PUT chunk `bytes 0-5/10` (non-final) | ✅ `308` → `{done:false, range:"bytes=0-5"}` |
| PUT chunk `bytes 6-9/10` (final) | ✅ `201` + `{id:"FILE123"}` → `{done:true, file}` |
| Content-Length / body length mismatch | mock returned 400 → client `DRIVE_ERROR` |
| Probe `bytes */10` | ✅ parsed `Range: bytes=0-5` → `received:6` |
| Abort (DELETE session) | ✅ request observed |
| Chunk failure ⇒ registry cleanup + session abort | ✅ code path reviewed & exercised via route tests |

## 4. Cross-file consistency

- JS-referenced DOM ids vs HTML: **32 (tour) + 8 (gallery) + 15 (admin) + 1 (common)** — no misses.
- Env names match across `services/config.js`, `.env.example`, README tables.
- Frontend routes/error codes match backend: `PIN_REQUIRED`, `UPLOADS_DISABLED`,
  `FILE_TOO_LARGE`, `INVALID_TYPE`, `CHUNK_UNCERTAIN`, `UNKNOWN_UPLOAD` all handled in
  `upload-engine.js` recovery matrix.
- `npm start` entry (`node server/server.js`) boots; missing required env → clear fail-fast
  message listing the missing variables.

## 5. Known limitations (documented, by design)

1. **Real end-to-end Drive upload not executed here** — requires the organizer's genuine
   Google credentials. The full path was validated up to session creation (graceful mapping
   of auth/folder/permission errors) plus protocol-level mocks; a live smoke test with a
   test folder is recommended right after first config (see §6).
2. **Admin toggles reset on Railway redeploy** (ephemeral disk) → env defaults
   `ENABLE_UPLOADS` / `GALLERY_VISIBLE` are the durable switches (README §12).
3. HEIC originals stay HEIC (Drive previews via JPEG thumbs); some desktop browsers may not
   render HEIC in the lightbox — gallery falls back to a clear message; originals are always
   safe in Drive.
4. Drive thumbnails appear within Drive's own processing time (usually seconds; new uploads
   may briefly show the generic tile).

## 6. Recommended live smoke test (owner, 5 minutes)

1. Complete README §2–6 (enable Drive API, Desktop-app OAuth client, `npm run get-token`,
   create folder, copy `GOOGLE_DRIVE_FOLDER_ID`).
2. `npm start` → check log line `drive: folder access OK`.
3. Upload one small photo + one 20 MB video from a phone → confirm both appear in the Drive
   folder; check the Drive file description contains uploader metadata.
4. Toggle "Allow uploads" off in `/admin` → confirm the public page shows the disabled note.
5. Open `/admin` QR → scan → page opens → upload works → verify in Drive.

## 7. Verdict

**PASS** — all verifiable checks green; no known blockers for local run, GitHub push, and
Railway deploy with the organizer's Google credentials.
