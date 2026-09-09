'use strict';

const logger = require('../utils/logger');
const drive = require('./drive');
const state = require('./state');
const site = require('./site');

/**
 * Durable home for everything the admin can edit.
 *
 * `data/state.json` and `data/site.json` are only a local cache — Railway wipes
 * the container disk on every redeploy, so an edited title would silently snap
 * back to the env defaults. The real copy is a small JSON file kept inside the
 * tour's own Google Drive folder: no database, no extra service, and it travels
 * with the photos it belongs to.
 *
 * Both functions are best-effort and never throw; callers decide what to tell
 * the admin when a save did not reach Drive.
 */

const isTest = process.env.NODE_ENV === 'test';
let loaded = false;

function payload() {
  const s = state.settings;
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    flags: {
      uploadsEnabled: s.uploadsEnabled,
      galleryVisible: s.galleryVisible,
      galleryPublic: s.galleryPublic,
    },
    // The admin view hides face descriptors; the durable copy needs them, or
    // every redeploy would forget who is who.
    site: { ...site.adminView(), people: site.peopleWithDescriptors() },
  };
}

/** Restore admin settings from Drive at boot. Returns true when something was applied. */
async function loadAll() {
  if (isTest) return false;
  let raw;
  try {
    raw = await drive.readSettingsFile();
  } catch (e) {
    logger.warn('persist: could not read settings from Drive', { code: e && e.code });
    return false;
  }
  loaded = true;
  if (!raw) return false;
  if (raw.flags && typeof raw.flags === 'object') state.update(raw.flags);
  if (raw.site && typeof raw.site === 'object') {
    site.update({ content: raw.site.content, categories: raw.site.categories });
    site.restorePeople(raw.site.people);
    // Folder names may differ from the env defaults we started with.
    drive.resetFolderCache();
  }
  logger.info('persist: settings restored from Drive');
  return true;
}

/** Push the current settings to Drive. Resolves to true when stored. */
async function saveAll() {
  if (isTest) return false;
  try {
    await drive.writeSettingsFile(payload());
    loaded = true;
    return true;
  } catch (e) {
    logger.warn('persist: could not save settings to Drive', { code: e && e.code });
    return false;
  }
}

module.exports = {
  loadAll,
  saveAll,
  get synced() {
    return loaded;
  },
};
