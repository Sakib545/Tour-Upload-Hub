'use strict';

/**
 * Lightweight file-signature (magic bytes) sniffing for the first chunk of an
 * upload. Only the advertised phone-camera formats are recognised; anything
 * unrecognisable (e.g. an .exe or HTML file renamed to .jpg) fails safely.
 *
 * Memory is bounded: callers inspect only a small prefix (a few hundred bytes),
 * never the whole file.
 */

// How many leading bytes we look at (covers every format below).
const PROBE_BYTES = 256;

const BRAND_MP4 = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7',
  'mp41', 'mp42', 'avc1', 'mp4v', 'dash', 'cmfc', 'mp4 ', 'M4V ', 'm4v ',
  'dby1', 'msnv', 'ndas', 'ndsc', 'ndsh', 'ndsm', 'ndsp', 'ndss',
  'ndxc', 'ndxh', 'ndxm', 'ndxr', 'ndxs',
]);
const BRAND_3GP = new Set(['3gp4', '3gp5', '3gp6', '3gp7']);
const BRAND_HEIC = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1', 'heif',
]);

function asciiAt(buf, start, len) {
  if (buf.length < start + len) return null;
  return buf.toString('latin1', start, start + len);
}

/**
 * Validate a buffer prefix against the claimed extension.
 * @param {string} ext lower-case extension without dot
 * @param {Buffer} buf small prefix (never the whole file)
 * @returns {{ok:true}|{ok:false, code:'INVALID_FILE_CONTENT'}}
 */
function sniffPrefix(ext, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, code: 'INVALID_FILE_CONTENT' };
  }

  switch (ext) {
    case 'jpg':
    case 'jpeg':
      // FF D8 FF
      if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { ok: true };
      }
      return { ok: false, code: 'INVALID_FILE_CONTENT' };

    case 'png':
      if (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
      ) {
        return { ok: true };
      }
      return { ok: false, code: 'INVALID_FILE_CONTENT' };

    case 'gif':
      if (buf.length >= 6) {
        const head = buf.toString('latin1', 0, 6);
        if (head === 'GIF87a' || head === 'GIF89a') return { ok: true };
      }
      return { ok: false, code: 'INVALID_FILE_CONTENT' };

    case 'webp':
      if (
        buf.length >= 12 &&
        buf.toString('latin1', 0, 4) === 'RIFF' &&
        buf.toString('latin1', 8, 12) === 'WEBP'
      ) {
        return { ok: true };
      }
      return { ok: false, code: 'INVALID_FILE_CONTENT' };

    case 'bmp':
      if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { ok: true };
      return { ok: false, code: 'INVALID_FILE_CONTENT' };

    case 'heic':
    case 'heif': {
      if (buf.length < 12 || asciiAt(buf, 4, 4) !== 'ftyp') {
        return { ok: false, code: 'INVALID_FILE_CONTENT' };
      }
      const brand = asciiAt(buf, 8, 4);
      if (brand && BRAND_HEIC.has(brand)) return { ok: true };
      return { ok: false, code: 'INVALID_FILE_CONTENT' };
    }

    case 'mov': {
      if (buf.length < 12 || asciiAt(buf, 4, 4) !== 'ftyp') {
        return { ok: false, code: 'INVALID_FILE_CONTENT' };
      }
      const brand = asciiAt(buf, 8, 4);
      if (brand === 'qt  ') return { ok: true };
      return { ok: false, code: 'INVALID_FILE_CONTENT' };
    }

    case '3gp':
    case '3g2': {
      if (buf.length < 12 || asciiAt(buf, 4, 4) !== 'ftyp') {
        return { ok: false, code: 'INVALID_FILE_CONTENT' };
      }
      const brand = asciiAt(buf, 8, 4);
      if (brand && BRAND_3GP.has(brand)) return { ok: true };
      return { ok: false, code: 'INVALID_FILE_CONTENT' };
    }

    case 'mp4':
    case 'm4v': {
      if (buf.length < 12 || asciiAt(buf, 4, 4) !== 'ftyp') {
        return { ok: false, code: 'INVALID_FILE_CONTENT' };
      }
      const brand = asciiAt(buf, 8, 4);
      if (brand && (BRAND_MP4.has(brand) || BRAND_3GP.has(brand))) return { ok: true };
      return { ok: false, code: 'INVALID_FILE_CONTENT' };
    }

    default:
      // Extension already passed the allowlist; treat unknown sniff rules as a
      // safe failure rather than guessing.
      return { ok: false, code: 'INVALID_FILE_CONTENT' };
  }
}

module.exports = { sniffPrefix, PROBE_BYTES };
