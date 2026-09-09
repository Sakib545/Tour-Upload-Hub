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
        const outcome = await handler(job);
        if (outcome === 'moved') stats.moved += 1;
        else stats.skipped += 1;
      } catch (e) {
        stats.failed += 1;
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
    pending: queue.length,
    working,
    lastError,
    ...stats,
  };
}

module.exports = {
  init,
  describeImage,
  matchPerson,
  distance,
  enqueue,
  setHandler,
  drain,
  status,
  setDescriberForTests,
  MODEL_DIR,
};
