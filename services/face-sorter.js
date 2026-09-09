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
async function sortFile({ fileId }) {
  if (!cfg.faces.enabled) return 'skipped';
  const people = site.peopleWithDescriptors().filter((p) => (p.descriptors || []).length);
  if (!people.length) return 'skipped';

  const got = await imageBytes(fileId);
  if (!got) return 'skipped';

  const found = await faces.describeImage(got.buffer);
  // Exactly one face is the whole point: "single photos, filed by person".
  if (found.length !== 1) return 'skipped';

  const hit = faces.matchPerson(found[0].descriptor, people);
  if (!hit) return 'skipped';

  const parents = Array.isArray(got.meta.parents) ? got.meta.parents : [];
  const target = await drive.personFolderId(hit.person.id, hit.person.folder);
  if (parents.includes(target)) return 'skipped'; // already filed

  await drive.moveFile(fileId, { from: parents[0] || cfg.google.folderId, to: target });
  logger.info('faces: photo filed under a person', {
    id: fileId,
    person: hit.person.name,
    distance: Number(hit.distance.toFixed(3)),
  });
  return 'moved';
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

/** Extract one reference descriptor from an enrolment photo. */
async function describeReference(buffer) {
  const found = await faces.describeImage(buffer);
  if (!found.length) return { ok: false, code: 'NO_FACE' };
  if (found.length > 1) return { ok: false, code: 'MANY_FACES' };
  return { ok: true, descriptor: found[0].descriptor };
}

function install() {
  faces.setHandler(sortFile);
}

module.exports = { install, sortFile, rescanAll, describeReference };
