'use strict';

const crypto = require('crypto');

/**
 * Stateless signed tokens (HMAC) used for:
 *  - participant PIN proof  (purpose: 'pin')
 *  - admin authentication   (purpose: 'admin')
 * Keys are derived from the respective secret, so changing the secret
 * invalidates every outstanding token. No sessions stored on the server.
 */

function deriveKey(secret, purpose) {
  return crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();
}

function signToken(payload, secret, purpose) {
  const key = deriveKey(secret, purpose);
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Verify a token; on success returns the payload, otherwise null. */
function verifyToken(token, secret, purpose) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const key = deriveKey(secret, purpose);
  const expected = crypto.createHmac('sha256', key).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.exp || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/** Constant-time string comparison helper (for PIN / admin password checks). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hoursFromNow(h) {
  return Date.now() + h * 3600 * 1000;
}

module.exports = { signToken, verifyToken, safeEqual, hoursFromNow };
