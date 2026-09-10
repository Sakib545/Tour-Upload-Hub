'use strict';

const logger = require('../utils/logger');
const { cfg } = require('./config');
const drive = require('./drive');
const site = require('./site');
const faces = require('./faces');

/**
 * Decides where a photo belongs once it is safely at Drive.
 *
 * The rule is deliberately narrow: a photo showing exactly one face, and that
 * face matching one enrolled person, is moved into that person's folder.
 * Group shots stay put — a file can only live in one Drive folder, so
 * scattering them would just hide them from everyone else.
 */

const SORTABLE = /^image\//;

/** Fetch bytes for recognition — the preview if Drive has one, else the file. */
async function imageBytes(fileId) {
  let meta = null;
  try {
    meta = await drive.getFileMeta(fileId);
  } catch (e) {
    return null;
  }
  if (!meta || !SORTABLE.test(String(meta.mimeType || ''))) return null;

  // A Drive-rendered preview is a browser-friendly JPEG (HEIC included) and a
  // fraction of the download, which is all a 128-d descriptor needs.
  if (meta.thumbnailLink) {
    try {
      const thumb = await drive.fetchThumbnail(meta.thumbnailLink, cfg.faces.workingWidth);
      if (thumb && thumb.buffer) return { buffer: thumb.buffer, meta };
    } catch (e) { /* fall through to the original */ }
  }
  try {
    return { buffer: await drive.downloadFile(fileId), meta };
  } catch (e) {
    return null;
  }
}

/**
 * Sort one file. Returns 'moved' or 'skipped'; throws only on unexpected
 * failures, which the queue records and moves past.
 */
/**
 * Every outcome is named. "Nothing happened" is the least useful thing an
 * automatic feature can report, and every one of these has a different fix:
 * enrol somebody, enrol a better photo, or accept that a group shot stays put.
 */
async function sortFile({ fileId }) {
  if (!cfg.faces.enabled) return { outcome: 'off' };

  const people = site.peopleWithDescriptors().filter((p) => (p.descriptors || []).length);
  if (!people.length) return { outcome: 'no_enrolments' };

  const got = await imageBytes(fileId);
  if (!got) return { outcome: 'unreadable' };
  const name = got.meta.name || fileId;

  if (!(await faces.init())) return { outcome: 'unavailable', name };

  const found = await faces.describeImage(got.buffer);
  // Exactly one face is the whole point: "single photos, filed by person".
  if (!found.length) return { outcome: 'no_face', name };
  if (found.length > 1) return { outcome: 'many_faces', name, faces: found.length };

  const hit = faces.matchPerson(found[0].descriptor, people);
  if (!hit) {
    // Say how close it got: a near miss is a threshold problem, a wide miss
    // means this person was never enrolled.
    let best = Infinity;
    for (const person of people) {
      for (const d of person.descriptors) {
        best = Math.min(best, faces.distance(found[0].descriptor, d));
      }
    }
    return { outcome: 'no_match', name, distance: Number(best.toFixed(2)) };
  }

  const parents = Array.isArray(got.meta.parents) ? got.meta.parents : [];
  const target = await drive.personFolderId(hit.person.id, hit.person.folder);
  if (parents.includes(target)) return { outcome: 'already', name, person: hit.person.name };

  await drive.moveFile(fileId, { from: parents[0] || cfg.google.folderId, to: target });
  logger.info('faces: photo filed under a person', {
    id: fileId,
    person: hit.person.name,
    distance: Number(hit.distance.toFixed(3)),
  });
  return { outcome: 'moved', name, person: hit.person.name, distance: Number(hit.distance.toFixed(2)) };
}

/** Queue every photo already in Drive — used after enrolling a new face. */
async function rescanAll() {
  if (!cfg.faces.enabled) return { queued: 0 };
  const { files } = await drive.listFolderFiles({ kinds: 'media', cap: 5000 });
  let queued = 0;
  for (const f of files) {
    if (!SORTABLE.test(String(f.mimeType || ''))) continue;
    if (faces.enqueue({ fileId: f.id })) queued += 1;
  }
  return { queued };
}

/**
 * Extract one reference descriptor from an enrolment photo, plus a small
 * square crop of the face for the hero figures.
 */
async function describeReference(buffer) {
  const found = await faces.describeImage(buffer);
  if (!found.length) return { ok: false, code: 'NO_FACE' };
  if (found.length > 1) return { ok: false, code: 'MANY_FACES' };
  let crop = null;
  let skin = null;
  try {
    crop = await faces.cropFace(buffer, found[0]);
    if (crop) skin = await faces.sampleSkin(crop);
  } catch (e) {
    crop = null; // the descriptor is what matters; the portrait is a bonus
  }
  return { ok: true, descriptor: found[0].descriptor, face: crop, skin };
}

function install() {
  faces.setHandler(sortFile);
}

module.exports = { install, sortFile, rescanAll, describeReference };
