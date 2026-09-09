'use strict';

/**
 * Filename / MIME sanitization and validation.
 * Only phone-camera image & video formats are allowed — no executables,
 * scripts, SVGs or other HTML-capable formats can be uploaded.
 */

const EXT_MIME = {
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  heic: ['image/heic', 'image/heif'],
  heif: ['image/heic', 'image/heif'],
  bmp: ['image/bmp'],
  mp4: ['video/mp4'],
  mov: ['video/quicktime', 'video/mp4'],
  m4v: ['video/x-m4v', 'video/mp4'],
  '3gp': ['video/3gpp', 'video/mp4'],
  '3g2': ['video/3gpp2', 'video/mp4'],
};

const ALLOWED_EXTS = new Set(Object.keys(EXT_MIME));

// MIME values some phones send that tell us nothing — we then trust the extension.
const AMBIGUOUS_MIMES = new Set(['', 'application/octet-stream']);

/**
 * Validate a submitted file name + mime + size.
 * @returns {{ok:true, base:string, ext:string, mimeType:string, fileName:string, size:number}
 *          |{ok:false, code:string}}
 */
function validateFile({ name = '', mime = '', size = 0, maxBytes = Infinity }) {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, code: 'EMPTY_FILE' };
  if (size > maxBytes) return { ok: false, code: 'FILE_TOO_LARGE' };

  const clean = cleanFileName(name);
  if (!clean) return { ok: false, code: 'INVALID_NAME' };

  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return { ok: false, code: 'INVALID_TYPE' };
  const base = clean.slice(0, dot).trim();
  const ext = clean.slice(dot + 1).toLowerCase();
  if (!base) return { ok: false, code: 'INVALID_NAME' };
  if (!ALLOWED_EXTS.has(ext)) return { ok: false, code: 'INVALID_TYPE' };

  const allowedMimes = EXT_MIME[ext];
  const provided = (mime || '').toLowerCase();
  if (provided && !AMBIGUOUS_MIMES.has(provided) && !allowedMimes.includes(provided)) {
    return { ok: false, code: 'INVALID_TYPE' };
  }

  return {
    ok: true,
    base,
    ext,
    mimeType: allowedMimes[0],
    fileName: `${base}.${ext}`,
    size,
  };
}

function isAllowedExtension(ext) {
  return ALLOWED_EXTS.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

/** Strip anything dangerous or weird from a raw client-provided name. */
function cleanFileName(raw) {
  let n = String(raw || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '') // control chars
    .trim();
  if (!n) return '';
  // No path components
  n = n.split('/').pop().split('\\').pop();
  // Characters that are illegal or risky in filenames / Drive queries
  n = n.replace(/[<>:"|?*'"]/g, '');
  // Collapse whitespace
  n = n.replace(/\s+/g, ' ').trim();
  // No leading dots / no dot-only names
  n = n.replace(/^\.+/, '');
  // Hard cap on length (keep extension room)
  n = n.slice(0, 180).trim();
  return n;
}

/** True when the sanitized base name is non-empty and not a reserved shape. */
function baseNameFromFileName(cleanName) {
  const dot = cleanName.lastIndexOf('.');
  if (dot <= 0) return cleanName;
  return cleanName.slice(0, dot);
}

/** Safe single-quote escaping for Drive API `q` query strings. */
function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Pack uploader metadata into the Drive file `description` field. */
function encodeDescription({ uploader = '', originalName = '', at = null, category = '' } = {}) {
  const safe = JSON.stringify({
    u: String(uploader || '').slice(0, 60),
    n: String(originalName || '').slice(0, 200),
    a: at || new Date().toISOString(),
    c: String(category || '').slice(0, 24),
  });
  return safe.length <= 1024 ? safe : safe.slice(0, 1020) + '"}' ;
}

/** Parse uploader metadata back out of a Drive `description` value. */
function parseDescription(desc) {
  if (!desc) return { uploader: '', originalName: '', at: null, category: '' };
  try {
    const j = JSON.parse(desc);
    return {
      uploader: typeof j.u === 'string' ? j.u : '',
      originalName: typeof j.n === 'string' ? j.n : '',
      at: typeof j.a === 'string' ? j.a : null,
      category: typeof j.c === 'string' ? j.c : '',
    };
  } catch (e) {
    return { uploader: '', originalName: '', at: null, category: '' };
  }
}

module.exports = {
  EXT_MIME,
  ALLOWED_EXTS,
  validateFile,
  cleanFileName,
  baseNameFromFileName,
  isAllowedExtension,
  escapeDriveQuery,
  encodeDescription,
  parseDescription,
};
