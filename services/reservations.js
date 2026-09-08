'use strict';

/**
 * In-process display-name reservation.
 *
 * Two people may upload files with the same sanitized name (e.g. two phones both
 * producing "IMG_0001.jpg") at the same moment. Reservation makes the chosen
 * unique name visible to other in-process uploads *before* the Drive round-trip,
 * closing the check-then-create race without weakening Google Drive as the
 * source of truth: existence is still re-verified against Drive while the
 * reservation lock is held.
 *
 * Reservations are released on completion / cancellation / failure, or expire
 * automatically (safety net) so a crashed upload cannot hold a name forever.
 */

const RESERVE_TTL_MS = 24 * 60 * 60 * 1000; // safety-net expiry
const MAX_SUFFIX = 200;

// name -> expiresAt
const reserved = new Map();

// Tiny FIFO so Drive existence checks for the same name never overlap.
let chain = Promise.resolve();

function isReserved(name) {
  const exp = reserved.get(name);
  if (!exp) return false;
  if (exp > Date.now()) return true;
  reserved.delete(name);
  return false;
}

function release(name) {
  if (name) reserved.delete(name);
}

/** Run fn while holding the global reservation lock (Drive queries serialized). */
function locked(fn) {
  const run = chain.then(fn, fn);
  // Keep the chain alive even when fn throws.
  chain = run.catch(() => {});
  return run;
}

/**
 * Pick a name that is neither reserved in-process nor already present in Drive,
 * then reserve it. The caller must release() it when the upload finishes,
 * fails, or is cancelled (eviction does this for abandoned sessions).
 *
 * @param {string} desired sanitized file name (e.g. "IMG_0001.jpg")
 * @param {(name:string)=>Promise<boolean>} existsInDrive async existence check
 * @returns {Promise<{name:string, release:()=>void}>}
 */
async function acquire(desired, existsInDrive) {
  const base = desired.replace(/\.[^.]+$/, '');
  const ext = desired.includes('.') ? desired.slice(desired.lastIndexOf('.')) : '';

  const candidate = await locked(async () => {
    if (!isReserved(desired) && !(await existsInDrive(desired))) return desired;
    for (let i = 2; i <= MAX_SUFFIX; i++) {
      const alt = `${base} (${i})${ext}`;
      if (alt.length > 180) break;
      if (!isReserved(alt) && !(await existsInDrive(alt))) return alt;
    }
    const ts = Date.now();
    return `${base.slice(0, 120)}-${ts}${ext}`;
  });

  reserved.set(candidate, Date.now() + RESERVE_TTL_MS);
  return {
    name: candidate,
    release: () => release(candidate),
  };
}

/** Prune expired reservations (safety net for crashed uploads). */
function sweep() {
  const now = Date.now();
  for (const [name, exp] of reserved) {
    if (exp <= now) reserved.delete(name);
  }
}

let timer = null;
function startSweeper() {
  if (timer) return;
  timer = setInterval(sweep, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { acquire, release, isReserved, sweep, startSweeper };
