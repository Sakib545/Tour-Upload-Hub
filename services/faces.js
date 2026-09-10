'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const logger = require('../utils/logger');
const { cfg } = require('./config');

/**
 * Face sorting.
 *
 * A photo with exactly one recognised face is moved into that person's folder,
 * so everyone can grab their own pictures without picking through the gallery.
 * Photos with several faces (or none) are left where the uploader put them —
 * that is what makes this "single photos, sorted by person" rather than an
 * attempt to tag every group shot.
 *
 * Everything here is optional and lazy: with FACE_SORT off (the default) no
 * model is downloaded, no dependency is loaded, and the upload path is
 * untouched. Recognition runs in the background after a file is safely at
 * Drive, never in the request that stores it.
 *
 * The stack is deliberately pure JS/WASM (@vladmandic/face-api on tfjs-wasm),
 * so it installs on any host without native builds. One photo costs roughly a
 * second of CPU, and the queue runs one at a time.
 */

const MODEL_FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

const MODEL_DIR = path.resolve(__dirname, '..', 'data', 'face-models');

let faceapi = null;
let ready = null;          // promise of the one-time setup
let describer = null;      // (buffer) => [{ descriptor: number[], score }]
let lastError = '';

/* ── Model bootstrap ─────────────────────────────────────────── */

async function downloadModels() {
  await fsp.mkdir(MODEL_DIR, { recursive: true });
  for (const name of MODEL_FILES) {
    const dest = path.join(MODEL_DIR, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const url = `${cfg.faces.modelUrl}/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed (${res.status}) for ${name}`);
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    logger.info('faces: model file cached', { name });
  }
}

/** Load the models once. Resolves to true when recognition is usable. */
async function init() {
  if (!cfg.faces.enabled) return false;
  if (ready) return ready;
  ready = (async () => {
    try {
      // Required lazily so the dependency is only needed when the feature is on.
      const tf = require('@tensorflow/tfjs');
      const wasm = require('@tensorflow/tfjs-backend-wasm');
      faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      const sharp = require('sharp');

      wasm.setWasmPaths(
        path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')) + '/dist/'
      );
      await tf.setBackend('wasm');
      await tf.ready();

      await downloadModels();
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);

      describer = async (buffer) => {
        const { data, info } = await sharp(buffer)
          .rotate()
          .removeAlpha()
          .resize({ width: cfg.faces.workingWidth, withoutEnlargement: true })
          .raw()
          .toBuffer({ resolveWithObject: true });
        const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
        try {
          const found = await faceapi
            .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
          return found.map((f) => ({
            descriptor: Array.from(f.descriptor),
            score: f.detection.score,
            // Box in the working image, so a caller can crop the face out.
            box: {
              x: Math.max(0, Math.round(f.detection.box.x)),
              y: Math.max(0, Math.round(f.detection.box.y)),
              width: Math.round(f.detection.box.width),
              height: Math.round(f.detection.box.height),
            },
            imageWidth: info.width,
            imageHeight: info.height,
          }));
        } finally {
          tensor.dispose();
        }
      };

      logger.info('faces: recognition ready', { backend: tf.getBackend() });
      return true;
    } catch (e) {
      lastError = e.message;
      logger.warn('faces: recognition unavailable, photos stay where they are', {
        err: e.message,
      });
      describer = null;
      return false;
    }
  })();
  return ready;
}

/** Crop one detected face to a small square JPEG (for the hero figures). */
async function cropFace(buffer, face, size = 160) {
  if (!face || !face.box) return null;
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    return null;
  }
  // Rotate first and read the metadata from the *rotated* bytes: sharp reports
  // the file's original dimensions until the rotation is materialised, which
  // silently mis-scales the crop for any phone photo with EXIF orientation.
  const rotated = await sharp(buffer).rotate().removeAlpha().toBuffer();
  const meta = await sharp(rotated).metadata();
  // The box is in working-image coordinates; scale it back to the original.
  const scale = face.imageWidth ? (meta.width || face.imageWidth) / face.imageWidth : 1;
  const pad = 0.42; // include hair and chin, not just the detected rectangle
  const cx = (face.box.x + face.box.width / 2) * scale;
  const cy = (face.box.y + face.box.height / 2) * scale;
  const half = (Math.max(face.box.width, face.box.height) * scale * (1 + pad)) / 2;
  const left = Math.max(0, Math.round(cx - half));
  const top = Math.max(0, Math.round(cy - half));
  const side = Math.max(
    16,
    Math.round(Math.min(half * 2, (meta.width || 0) - left, (meta.height || 0) - top))
  );
  const out = await sharp(rotated)
    .extract({ left, top, width: side, height: side })
    .resize(size, size, { fit: 'cover' })
    .jpeg({ quality: 72 })
    .toBuffer();
  return out;
}

/**
 * Average skin tone from a face crop, so the cartoon body matches the person.
 * Samples a band across the cheeks and chin — below the eyes, inside the face
 * — and trims it to a believable range so a dark photo does not produce a
 * muddy body.
 */
async function sampleSkin(cropBuffer) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    return null;
  }
  const img = sharp(cropBuffer);
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (w < 20 || h < 20) return null;
  // Two cheek patches: left and right of centre, below the eyes and above the
  // jaw. Sampling the middle instead would average in a beard or a mouth.
  const patches = [0.22, 0.64].map((leftFrac) => ({
    left: Math.round(w * leftFrac),
    top: Math.round(h * 0.56),
    width: Math.max(4, Math.round(w * 0.14)),
    height: Math.max(4, Math.round(h * 0.12)),
  }));
  const samples = [];
  for (const patch of patches) {
    const { data } = await sharp(cropBuffer)
      .extract(patch)
      .resize(1, 1, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (data && data.length >= 3) samples.push([data[0], data[1], data[2]]);
  }
  if (!samples.length) return null;
  // The brighter cheek wins: one side is usually in shadow.
  const brightest = samples.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]))[0];
  // Lift very dark samples (shadow, backlight) without changing the hue.
  const rgb = brightest;
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  // Skin is warm: red highest, blue lowest, and never flat grey. Sunglasses,
  // a shadow or a hand across the cheek fail this, and it is better to keep
  // the assigned palette colour than to paint someone grey.
  const saturation = max ? (max - min) / max : 0;
  if (saturation < 0.12 || rgb[0] < rgb[2] || rgb[0] <= rgb[1]) return null;
  const lift = max < 150 ? 150 / Math.max(max, 1) : 1;
  return '#' + rgb
    .map((v) => Math.min(255, Math.round(v * lift)).toString(16).padStart(2, '0'))
    .join('');
}

/** Test seam: swap in a describer so the plumbing can be exercised offline. */
function setDescriberForTests(fn) {
  describer = fn;
  ready = Promise.resolve(!!fn);
  lastError = '';
}

/** Faces in one image. Returns [] when recognition is off or unavailable. */
async function describeImage(buffer) {
  if (!(await init())) return [];
  if (!describer) return [];
  return describer(buffer);
}

/* ── Matching ────────────────────────────────────────────────── */

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Closest enrolled person for one descriptor, or null when nothing is near
 * enough. `people` is [{ id, name, descriptors: number[][] }].
 */
function matchPerson(descriptor, people) {
  let best = null;
  let bestDist = Infinity;
  for (const person of people || []) {
    for (const known of person.descriptors || []) {
      const d = distance(descriptor, known);
      if (d < bestDist) {
        bestDist = d;
        best = person;
      }
    }
  }
  if (!best || bestDist > cfg.faces.threshold) return null;
  return { person: best, distance: bestDist };
}

/* ── Background queue ────────────────────────────────────────── */

// One at a time: recognition is CPU-bound and the host is small.
const queue = [];
let working = false;
let handler = null;
const stats = { queued: 0, done: 0, moved: 0, skipped: 0, failed: 0 };
// What happened to the last few photos, so the dashboard can explain itself.
const recent = [];
const REASONS = ['moved', 'no_face', 'many_faces', 'no_match', 'already',
  'no_enrolments', 'unreadable', 'unavailable', 'off', 'error'];
const tally = Object.fromEntries(REASONS.map((r) => [r, 0]));

function record(entry) {
  const outcome = entry && REASONS.includes(entry.outcome) ? entry.outcome : 'error';
  tally[outcome] += 1;
  recent.unshift({ ...entry, outcome, at: Date.now() });
  if (recent.length > 24) recent.pop();
}

/** The worker that actually sorts one file; supplied by routes/api at boot. */
function setHandler(fn) {
  handler = fn;
}

function enqueue(job) {
  if (!cfg.faces.enabled || !handler) return false;
  queue.push(job);
  stats.queued += 1;
  pump();
  return true;
}

async function pump() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        const result = await handler(job);
        const entry = typeof result === 'string' ? { outcome: result } : (result || {});
        record(entry);
        if (entry.outcome === 'moved') stats.moved += 1;
        else stats.skipped += 1;
      } catch (e) {
        stats.failed += 1;
        record({ outcome: 'error', message: e.message });
        logger.warn('faces: could not sort a photo', { id: job && job.fileId, err: e.message });
      }
      stats.done += 1;
    }
  } finally {
    working = false;
  }
}

/** Wait for the queue to drain — used by the admin rescan and by tests. */
async function drain() {
  while (working || queue.length) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function status() {
  return {
    enabled: cfg.faces.enabled,
    // `ready` separates "switched off" from "switched on but the model never
    // loaded", which look identical from the outside and need opposite fixes.
    ready: !!describer,
    pending: queue.length,
    working,
    lastError,
    tally: { ...tally },
    recent: recent.slice(0, 12),
    ...stats,
  };
}

module.exports = {
  init,
  describeImage,
  cropFace,
  sampleSkin,
  matchPerson,
  distance,
  enqueue,
  setHandler,
  drain,
  status,
  setDescriberForTests,
  MODEL_DIR,
};
