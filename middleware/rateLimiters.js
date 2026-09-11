'use strict';

const rateLimit = require('express-rate-limit');

const json429 = (req, res) => {
  res.status(429).json({ error: 'RATE_LIMITED', message: 'অনেকবার চেষ্টা হয়েছে। একটু পরে আবার চেষ্টা করুন।' });
};

/** Generic light limiter for normal JSON endpoints. */
const light = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

/** PIN verification attempts (stops brute-forcing a short PIN). */
const pinVerify = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

/** Admin login attempts. */
const adminLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

/**
 * Chunk-upload traffic. Generous per-IP budget because a single large video
 * can need a few hundred chunks (e.g. 2 GB ÷ 8 MB = 256 chunks).
 */
const uploadChunks = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

/**
 * Gallery media (thumbnails + originals). A single visitor scrolling a
 * 300-item gallery legitimately makes hundreds of requests, so the generic
 * `light` limiter (300 / 15 min) would lock them out mid-scroll.
 */
const media = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 4000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

/** Admin dashboard API. */
const adminApi = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

// Face search reads every photo through the recognition model, so it is far
// heavier than a listing. A handful per few minutes is plenty for a guest.
const faceSearch = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED' },
});

module.exports = {
  faceSearch, light, pinVerify, adminLogin, uploadChunks, adminApi, media };
