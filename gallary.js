diff --git a/public/js/gallery.js b/public/js/gallery.js
index 99f026a..36608e4 100644
--- a/public/js/gallery.js
+++ b/public/js/gallery.js
@@ -95,13 +95,56 @@
 
   pinForm.addEventListener('submit', submitPin);
 
-  function failStatus(message) {
+  function failStatus(message, { code = '', retry = false } = {}) {
     skeleton.hidden = true;
+    skeleton.textContent = '';
     status.hidden = false;
     status.style.color = 'var(--danger)';
     status.textContent = message;
+    // The code is what turns "it does not work" into a fixable report, so it
+    // is shown to the visitor rather than buried in the console.
+    if (code) {
+      const tag = document.createElement('small');
+      tag.className = 'muted-text';
+      tag.style.display = 'block';
+      tag.textContent = `(${code})`;
+      status.appendChild(tag);
+    }
+    if (retry) {
+      const btn = document.createElement('button');
+      btn.type = 'button';
+      btn.className = 'btn-ghost';
+      btn.style.marginTop = '10px';
+      btn.textContent = 'আবার চেষ্টা করুন';
+      btn.addEventListener('click', () => {
+        status.hidden = true;
+        status.textContent = '';
+        status.style.color = '';
+        showSkeleton();
+        load();
+      });
+      status.appendChild(btn);
+    }
   }
 
+  /**
+   * Every gallery failure used to read "নেটওয়ার্ক সমস্যা", which hid the
+   * difference between a dead Drive credential and a phone with no signal.
+   */
+  const LOAD_ERRORS = {
+    GALLERY_DISABLED: ['Gallery এই মুহূর্তে বন্ধ আছে।', false],
+    DRIVE_FOLDER_NOT_FOUND: ['Drive ফোল্ডার পাওয়া যায়নি — admin-কে জানান।', false],
+    DRIVE_PERMISSION: ['Drive-এ অনুমতি নেই — admin-কে জানান।', false],
+    DRIVE_QUOTA: ['Drive-এ জায়গা নেই — admin-কে জানান।', false],
+    DRIVE_AUTH: ['Drive সংযোগ সমস্যা — admin-কে জানান।', false],
+    DRIVE_BUSY: ['Drive এখন ব্যস্ত — একটু পরে আবার চেষ্টা করুন।', true],
+    DRIVE_NETWORK: ['Drive-এ পৌঁছানো যাচ্ছে না — একটু পরে আবার চেষ্টা করুন।', true],
+    DRIVE_ERROR: ['Drive থেকে ছবি আনা যায়নি — admin-কে জানান।', true],
+    RATE_LIMITED: ['অনেকবার চেষ্টা হয়েছে — একটু পরে আবার চেষ্টা করুন।', true],
+    INTERNAL_ERROR: ['সার্ভারে সমস্যা হয়েছে — admin-কে জানান।', true],
+    NETWORK: ['নেটওয়ার্ক সমস্যা — ইন্টারনেট দেখে আবার চেষ্টা করুন।', true],
+  };
+
   /* ── Loading placeholders ─────────────────────────────────── */
 
   function showSkeleton(n = 12) {
@@ -701,11 +744,12 @@
         showPinGate('Gallery দেখতে PIN দিন।');
         return;
       }
-      failStatus(
-        err.code === 'GALLERY_DISABLED' || err.status === 404
-          ? 'Gallery এই মুহূর্তে বন্ধ আছে।'
-          : 'Gallery লোড করা যায়নি — নেটওয়ার্ক সমস্যা।'
-      );
+      const code = err.status === 404 ? 'GALLERY_DISABLED' : err.code || 'UNKNOWN';
+      const known = LOAD_ERRORS[code];
+      failStatus(known ? known[0] : 'Gallery লোড করা যায়নি।', {
+        code: known && code === 'GALLERY_DISABLED' ? '' : code,
+        retry: known ? known[1] : true,
+      });
       return;
     }
     skeleton.hidden = true;
diff --git a/services/drive.js b/services/drive.js
index 783c6b6..c762ae8 100644
--- a/services/drive.js
+++ b/services/drive.js
@@ -196,6 +196,9 @@ async function authHeaders() {
   return { authorization: `Bearer ${token}` };
 }
 
+/** Ceiling for one Drive JSON call. Google is normally well under a second. */
+const API_TIMEOUT_MS = Number(process.env.DRIVE_API_TIMEOUT_MS || 20000);
+
 /** JSON request with a single automatic retry after token refresh on 401. */
 async function apiJson(method, path, { body, query = '', retry = true } = {}) {
   const headers = await authHeaders();
@@ -207,6 +210,9 @@ async function apiJson(method, path, { body, query = '', retry = true } = {}) {
       method,
       headers,
       body: body !== undefined ? JSON.stringify(body) : undefined,
+      // Without this a stalled Drive connection never settles, and the
+      // visitor's page sits on "ছবি লোড হচ্ছে…" until the browser gives up.
+      signal: AbortSignal.timeout(API_TIMEOUT_MS),
     });
   } catch (e) {
     throw new DriveError('NETWORK', 'Google Drive network error', { retryable: true });
