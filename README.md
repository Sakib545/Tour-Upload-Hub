# 📸 Tour Upload Hub

A private group-tour photo & video sharing website. Everyone on the tour opens one link
(or scans one QR code), picks photos/videos on their phone, and everything streams
**straight into one Google Drive folder you own**.

- **Node.js + Express** backend, plain HTML/CSS/JS frontend — no build step, tiny footprint.
- Files are uploaded in **resumable chunks** and streamed to Google Drive — a 2 GB video
  never sits in server memory or on Railway's ephemeral disk.
- Mobile-first Bengali UI ("Tour Memories") with PIN gate, admin dashboard, optional
  public gallery, and QR-code sharing.
- **Uploads are filed into category folders**: single photos → `Photos/`,
  group photos → `Group Photos/`, videos → `Videos/` (created automatically;
  visitors pick a category on the upload page). Grabbing just the videos is
  one click in Drive.
- **Admin-editable site content**: title / subtitle / date / location /
  privacy note / cover URL and the category labels + Drive folder names can be
  changed live from the `/admin` dashboard (persisted in `data/site.json`) —
  no redeploy or env-var editing needed.
- **One-tap downloads**: every gallery tile has a download button, several files can be
  selected and pulled at once, and the admin gets direct links to each Drive folder.

---

- **Public gallery, PIN-gated uploads**: with "Anyone can view the gallery" on, visitors
  browse and download freely but still need the PIN to add anything (`GALLERY_PUBLIC`).
- **Settings survive redeploys**: admin edits (page content, category folder names,
  toggles) are written to `.tour-hub-settings.json` inside your own Drive folder, since
  Railway's disk is wiped on every deploy. The file is hidden from the gallery and from
  admin file counts.
- **Tidy up old uploads**: the admin's **Sort existing files into folders** button
  re-parents files added before the category folders existed.

- **Admin-defined categories**: the three built-ins (single / group / video) can be
  renamed, and the organiser can add their own — "Day 1", "Drone shots" — each with its
  own Drive folder. A custom category set to ANY takes both photos and videos.
- **Upload from the dashboard**: the admin token stands in for the PIN, so the organiser
  can add files straight from /admin, into any category, even while visitor uploads are
  paused.

- **Countdown to the tour**: set a start (and optional end) in the admin panel and the
  public page counts down the days, hours, minutes and seconds in Bengali numerals,
  switching to a "tour is on" banner and then a gentle "upload the rest" note by itself.

- **Face sorting (optional)**: enrol each person once from the admin panel, and any
  photo showing exactly that one face is filed into `People/<name>` automatically —
  no more hunting through the gallery for your own pictures. Group shots stay put,
  since a Drive file lives in one folder. Runs on a pure JS/WASM model, in the
  background, after the upload is safely stored; off unless `FACE_SORT=true`.

- **The beach crew is your crew**: everyone enrolled gets a figure in the hero scene, and
  each one is doing something different — flying the kite, taking the selfie, riding,
  driving the speedboat, swimming, sitting on the sand. Figures are adult proportioned
  and can wear either the person's own colours (editable in the admin panel) or their
  enrolled portrait as the head. The skin tone is read off that portrait automatically,
  so the body matches the face. Hovering a figure shows the name.

- **Mini game at `/game`**: ঢেউয়ের রেস, a third-person wave race — the camera sits
  behind the boat, obstacles come at you down the channel, and the rival boats are named
  after the enrolled crew. Touch or keyboard, no login, best score kept locally.

- **"আমার ছবি খুঁজুন"**: a visitor takes a selfie and the gallery returns the photos
  their face appears in — no enrolment, no login. The selfie is compared once and never
  stored. Needs FACE_SORT on.
- **Share & react**: every photo has a share button (the OS share sheet on a phone —
  WhatsApp, Messenger — or copy-link on desktop) and a ♥ that is remembered per device.
- **Slideshow**: a ▶ button plays the current filter full-screen, pausing on videos.

- **Faster uploads**: each chunk is sized from the measured speed of the last one — small
  on a weak signal (a dropped chunk is cheap to resend), large on a strong one (fewer round
  trips) — and the next chunk is read from disk while the current one is in flight. On a
  30 MB file this roughly halves the number of requests versus the old fixed 8 MB. Tunable
  with `UPLOAD_CHUNK_MIN/MAX/START_MB` and `UPLOAD_CONCURRENCY`.

## 1. Local setup

Prerequisites: **Node.js ≥ 18**.

```bash
# 1. Get the code
git clone <your-repo-url>
cd tour-upload-hub

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env
#    …then fill in the values (sections below)

# 4. Run locally
npm start          # → http://localhost:3000
```

---

## 2. Google Cloud project setup

1. Go to <https://console.cloud.google.com> and sign in with the Google account that owns
   the Drive folder (or create a project for this app).
2. Create or select a project (top bar → New Project).
3. Note the **Project ID** — you won't need it again for this setup.

---

## 3. Enable the Google Drive API

1. In your project: **APIs & Services → Library**.
2. Search for **Google Drive API** → open it → **Enable**.

### Pick ONE authentication method

Either the **service account** below (simplest) **or** the OAuth refresh token in
sections 4–5. You do not need both.

> **Important:** a service account (Option A) only works when the destination folder
> lives in a **Google Workspace Shared Drive**. A service account owns every file it
> creates and has no Drive storage of its own, so uploading into a normal personal
> "My Drive" folder fails with `403 storageQuotaExceeded` — which the app reports as
> `DRIVE_QUOTA` / "Drive-এ জায়গা নেই". For a personal Drive folder use **Option B**
> (OAuth refresh token, sections 4–5); the files are then owned by you.

### Option A — service account, Shared Drive only (no refresh token)

1. Open **IAM & Admin → Service Accounts → Create service account**.
2. Name it `tour-upload-hub`, finish creation, then open it.
3. Open **Keys → Add key → Create new key → JSON** and download the key.
4. Share the destination Google Drive folder with the JSON file's
   `client_email` as **Editor**.
5. Put the complete minified JSON value in `GOOGLE_SERVICE_ACCOUNT_JSON`.

When this variable is set, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
`GOOGLE_REFRESH_TOKEN` are not required. Keep the JSON key secret.

---

## 4. Option B — create credentials (OAuth client)

*Skip sections 4–5 entirely if you set `GOOGLE_SERVICE_ACCOUNT_JSON` above.*


1. **APIs & Services → OAuth consent screen**.
   - User type: **External** (any Google account works; you'll approve it yourself).
   - Fill the app name + your email; on "Scopes" you can skip adding scopes manually
     (the token script requests the scope); publish the app (Status → **Publish**) so the
     consent screen doesn't stay in "Testing" mode.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Desktop app**.
   - Create → copy the **Client ID** and **Client secret** into `.env`:
     ```
     GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
     GOOGLE_CLIENT_SECRET=xxxx
     ```

> **When is OAuth the better choice?**
> A service account is a separate "robot" account — to write into your personal folder you
> would have to share the folder with that robot email. OAuth uses **your own account** with
> a stored refresh token, which is simpler and matches "a folder owned by me".
>
> **Why full Drive scope?** With the more restrictive `drive.file` scope, an app can only
> touch files/folders it created itself — pointing it at a folder you made manually in the
> Drive web UI returns "File not found". The default scope lets the app write into any folder
> you own, which is exactly what this tool needs. The token lives only in your server
> environment variables and is never exposed to website visitors.

---

## 5. Obtain a Google refresh token

The repo includes a zero-dependency helper. With `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in `.env`:

```bash
npm run get-token
```

A browser opens → sign in with the Drive-folder owner account → click **Allow**.
Copy the printed refresh token into `.env`:

```
GOOGLE_REFRESH_TOKEN=1//0xxxx...
```

---

## 6. Get your Google Drive folder ID

1. Create a folder in Google Drive (e.g. "Tour 2026 Photos").
2. Open it in the browser. The URL looks like:
   `https://drive.google.com/drive/folders/1AbC...XYZ`
3. The long ID after `/folders/` is your `GOOGLE_DRIVE_FOLDER_ID`.

The folder stays **private** — it is never made publicly writable or shared.

---

## Face sorting (optional)

1. `npm run faces:install` — adds `@vladmandic/face-api`, `@tensorflow/tfjs`,
   `@tensorflow/tfjs-backend-wasm` and `sharp` (~300 MB of `node_modules`; they are
   declared as optional dependencies so a normal deploy installs them too — use
   `npm install --omit=optional` if you never plan to switch this on).
2. Set `FACE_SORT=true` and redeploy. Model weights (~12 MB) are fetched once at boot
   and cached under `data/face-models`.
3. In the admin dashboard, add each person and give them **one clear photo of just
   them**. Only the 128-number descriptor is kept — the photo itself is never stored.
4. New uploads are sorted as they arrive. **পুরনো ছবিগুলোও মিলিয়ে দেখুন** re-runs the
   whole gallery, which is what you want right after enrolling someone.

Accuracy notes: the same face across renditions measures around 0.33–0.39 apart and
two different faces around 0.64, so the default threshold of 0.5 separates them with
room on both sides. Raise `FACE_MATCH_THRESHOLD` for looser matching, lower it for
stricter. A photo is only moved when it contains exactly one recognised face.

## 7. Environment variables

See `.env.example` for the full commented list. Essentials:

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Default `3000` (Railway sets this itself) |
| `PUBLIC_SITE_URL` | yes (for QR) | Public HTTPS URL, e.g. `https://my-tour.up.railway.app` |
| `GOOGLE_DRIVE_FOLDER_ID` | **yes** | Destination folder ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | option A | Full service-account key, one line |
| `GOOGLE_CLIENT_ID` | option B | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | option B | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | option B | From step 5 |
| `SEPARATE_MEDIA_FOLDERS` | no | `true` (default): each upload category gets its own Drive sub-folder |
| `PHOTOS_FOLDER_NAME` / `VIDEOS_FOLDER_NAME` | no | Default folder names for the single-photo / video categories (default `Photos` / `Videos`; group photos default to `Group Photos`). All three are editable live in `/admin` |
| `ADMIN_PASSWORD` | **yes** | Password for `/admin` |
| `TOUR_UPLOAD_PIN` | no | If set, visitors must enter it before uploading |
| `ENABLE_GALLERY` | no | `true`/`false`, default `true` |
| `ENABLE_UPLOADS` | no | Default initial state (admin can toggle live) |
| `GALLERY_VISIBLE` | no | Default initial state (admin can toggle live) |
| `MAX_FILE_SIZE_MB` | no | Default `2048` (2 GB per file) |
| `MAX_FILES_PER_UPLOAD` | no | Default `50` files per batch |
| `UPLOAD_CHUNK_MB` | no | Default `8` |
| `GALLERY_LIMIT` | no | Max files listed in the gallery (default `300`) |
| `MAX_ACTIVE_UPLOADS` | no | Max in-flight sessions server-wide (default `150`) |
| `MAX_UPLOADS_PER_IP` | no | Max in-flight sessions per IP (default `40`) |
| `MAX_SESSION_CREATES_PER_MIN_PER_IP` | no | Max new Drive sessions/IP/minute (default `60`) |
| `UPLOAD_SESSION_IDLE_MINUTES` | no | Idle uploads aborted after this (default `120`) |
| `GALLERY_TOKEN_TTL_HOURS` | no | Signed media-URL lifetime in PIN mode (default `3`) |
| `TOUR_TITLE` / `TOUR_SUBTITLE` / `TOUR_DATE` / `TOUR_LOCATION` / `TOUR_PRIVACY_NOTE` / `TOUR_COVER_URL` | no | Page content — these are just the defaults; the admin can override them live from `/admin` ("Tour page & Drive folders") |

All values above are read **only** server-side. `.env` is git-ignored — never commit it.

---

## 8. Run locally

```bash
npm start
```

Then open:
- `http://localhost:3000` — public upload page
- `http://localhost:3000/admin` — admin dashboard (uses `ADMIN_PASSWORD`)
- `http://localhost:3000/gallery` — gallery (if enabled)

To test the PIN flow, set `TOUR_UPLOAD_PIN=1234` in `.env` and restart.

---

## 9. Push to GitHub

```bash
git init
git add .
git commit -m "Tour upload hub"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

> Double-check `.gitignore` covers `.env` and `node_modules` before pushing.
> The real `.env` must **never** be pushed.

---

## 10. Deploy on Railway

1. Create an account at <https://railway.app> and install the GitHub integration.
2. **New Project → Deploy from GitHub repo** → pick this repository.
3. Railway detects `package.json` automatically (Nixpacks) and runs `npm start`.
   No `Dockerfile` or `railway.json` needed.
4. Open your service → **Settings → Networking → Generate Domain** to get a public URL.

---

## 11. Set Railway environment variables

In your service → **Variables**, add every required value from `.env.example`
(the same names). Minimum set:

```
PORT            (Railway provides this automatically)
PUBLIC_SITE_URL=https://your-app.up.railway.app
GOOGLE_DRIVE_FOLDER_ID=…
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
GOOGLE_REFRESH_TOKEN=…
ADMIN_PASSWORD=…
TOUR_UPLOAD_PIN=…        (optional)
ENABLE_GALLERY=true      (optional)
```

After saving variables, Railway restarts the service. Watch **Deployments** logs — you
should see `tour-upload-hub listening on port …` and `drive: folder access OK`.

Open `https://your-app.up.railway.app/admin`, sign in, and download the **QR code** to
share with the tour group.

---

## 12. Security notes

- **Credentials never leave the server.** The browser talks only to your own backend;
  Google tokens/refresh tokens are environment variables server-side.
- **The Drive folder is never publicly writable.** Uploads use your own authenticated
  OAuth session; only the configured folder ID is accepted.
- **No permanent storage on Railway.** Files are chunked and piped to Google Drive.
  Railway's ephemeral disk is only ever used for the tiny `data/state.json` toggle file
  (which resets on redeploy by design — the durable defaults are `ENABLE_UPLOADS` /
  `GALLERY_VISIBLE` env vars).
- **Type safety (two layers):** only camera formats are allowed (JPG/JPEG/PNG/WEBP/GIF/
  HEIC/HEIF/BMP/MP4/MOV/M4V/3GP/3G2). The server checks extension + MIME **and** the
  magic bytes of the first chunk's prefix, so an `.exe` or an HTML file renamed to
  `.jpg` is rejected with `INVALID_FILE_CONTENT` before any Drive session is created.
  Only a small prefix is inspected — the full file is never buffered.
- **Recovery:** chunk offsets advance only from Google's confirmed `Range` response.
  If a chunk fails mid-flight the server probes the Drive session and the upload
  continues from Drive's real byte count (partial chunks and duplicate re-sends are
  handled); only genuinely lost sessions cause a bounded full-file restart with a
  fresh upload id. Every retry/restart is bounded, and a file is never marked
  complete unless Google confirms it.
- **Filename reservation:** simultaneous uploads with the same name get distinct
  display names (`IMG_0001.jpg`, `IMG_0001 (2).jpg`, …) via an in-process reservation
  system layered on top of Drive as the source of truth. Drive never overwrites;
  reservations are released on completion/cancel/failure/timeout.
- **Rate limiting** on PIN verification, login, chunk uploads and the admin API.
- **Upload abuse limits:** `MAX_ACTIVE_UPLOADS` / `MAX_UPLOADS_PER_IP` /
  `MAX_SESSION_CREATES_PER_MIN_PER_IP` cap concurrent sessions and session creation;
  excess sessions get clear 429/503 JSON errors. Tiny non-final first chunks never
  create a Drive session. Abandoned sessions are aborted after
  `UPLOAD_SESSION_IDLE_MINUTES` and their reservations released.
- **PIN-protected gallery:** when `TOUR_UPLOAD_PIN` is set, the PIN is required for
  gallery metadata **and** every image/video. Media URLs carry a short-lived signed
  token (`?gt=…`, lifetime `GALLERY_TOKEN_TTL_HOURS`) because `<img>`/`<video>` cannot
  send headers. Hiding the gallery from admin blocks every gallery route immediately.
  Without a PIN the gallery stays public.
- **Auth tokens are signed and stateless** (HMAC, purpose-scoped, expiring) — no server
  session store to leak. Admin and authentication responses are sent `Cache-Control:
  no-store`; errors never include credentials, Drive session URLs or stack traces.
- **Thumbnails are proxied, never hot-linked.** Drive's own `thumbnailLink` is not
  readable by a visitor's browser for a private folder, so previews are fetched
  server-side with the access token and served from your own origin (also keeping the
  PIN gate in force for every preview).
- **Gallery safety:** normal visitors get read-only thumbnails/lightbox. There is no
  edit/delete control anywhere for visitors. The gallery proxy verifies each file really
  lives in your folder before serving it, so random Drive file IDs can't be probed.
- **Drive diagnostics:** the admin dashboard shows the live Drive connection status and
  has a **Test Drive access** button that opens (and immediately aborts) a real upload
  session — nothing is stored, but permission and storage-quota failures surface with
  Google's own reason string plus the exact fix.
- **Startup checks:** the server verifies that `GOOGLE_DRIVE_FOLDER_ID` is really a
  Drive folder (visible in admin as `drive` status), and rejects too-short
  `ADMIN_PASSWORD` (< 8 chars) / `TOUR_UPLOAD_PIN` (< 4 chars) at boot.
- **Headers:** strict CSP, `nosniff`, frame denial, HSTS on HTTPS.
- **Logs** contain event info only — never tokens, PINs, passwords, or session URLs.
- The admin toggle state is stored on ephemeral disk: after a Railway redeploy it resets
  to your env defaults. For fully permanent "uploads off" simply set `ENABLE_UPLOADS=false`.

## Tests

Automated tests use Node's built-in test runner and a **mock Google Drive server** —
no real Google credentials are needed (and none are claimed to have been used).

```bash
npm ci
npm test          # node --test test/
npm run check     # syntax-check every JS file
npm audit
```

Covered: photo/video sub-folder routing, category (single/group/video) folder
routing + gallery tagging, admin site-content/category updates, download
filenames, PIN auth + expiry, gallery access with/without PIN, upload-disabled
mode, valid/invalid file signatures, normal 308→201 chunk flow, partial chunk
acceptance, duplicate chunk re-send, `UNKNOWN_UPLOAD`/`OUT_OF_ORDER`/network/
stall/session-loss recovery, active-session limits, simultaneous duplicate
filenames, and preview retention until completion. A real end-to-end upload
still needs the organizer's Google credentials (see the 5-minute smoke test in
`docs/03-qa-report.md`).

---

## How uploads work (architecture)

```
Phone browser                         Your server (Railway)                 Google Drive
─────────────                         ─────────────────────                 ────────────
Select N files
For each file:
  slice into 8 MB chunks ──────────►  validate chunk ─────────────────────► resumable session
  chunk 1 (X-Offset 0)                stream pipe (no buffering)             bytes 0-8MB  → 308
  chunk 2 (X-Offset 8MB) ──────────►  stream pipe ───────────────────────► bytes 8-16MB → 308
  … final chunk ────────────────────►                                       → 201 + file id ✓
```

- Several people upload at once; up to 2 files per person run in parallel.
- One failed file never blocks the rest; every file has its own status + retry button.
- Chunk offsets only ever advance from Google's `Range` response. If a chunk dies
  mid-flight (network, 5xx, stall) the server **probes the Drive session** and answers
  with Drive's real byte count — the client resumes from there instead of re-uploading
  from zero. Only when the session is genuinely gone (server restart, session 404) does
  the client restart the file with a fresh upload id, bounded to a few attempts and
  cleaning up the orphaned session first.
- Nothing is loaded fully into memory; the request stream is piped straight to Drive
  (the first-chunk magic-byte check inspects only a small prefix).
- The gallery and admin list read directly from Drive (the folder is the source of truth),
  so there is no database to keep in sync.

## Project structure

```
├── server/                   # app.js (Express app factory), server.js (entry point)
├── routes/                   # api.js (config/pin/upload/gallery), admin.js
├── services/                 # drive.js (OAuth + resumable), uploads registry,
│                             # reservations.js (filename lock), config, state,
│                             # site.js (admin-editable content & categories)
├── middleware/               # security headers, rate limiters, auth guards
├── utils/                    # logger, sanitizer, sniff.js (magic bytes), HMAC tokens
├── scripts/get-refresh-token.js
├── public/                   # index.html / gallery.html / admin.html + css + js
├── test/                     # node:test suite + mock Google Drive server
├── data/                     # runtime admin toggles (ephemeral, git-ignored)
├── .env.example
└── package.json
```
