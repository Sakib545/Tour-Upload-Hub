#!/usr/bin/env node
'use strict';

/**
 * Guards the hero scene against one specific, invisible mistake.
 *
 * An element can carry a `transform` attribute (where it sits in the scene) and
 * a CSS class that animates `transform` (how it wobbles). The animation wins:
 * the attribute is replaced outright, the element loses its placement and is
 * drawn at the origin — so a figure, a horse or a quad bike silently vanishes
 * off the side of the picture while the markup still looks perfect.
 *
 * The fix is to animate the individual `translate` / `rotate` / `scale`
 * properties instead, which compose with the attribute rather than replacing
 * it. This script fails the build if the pairing reappears.
 *
 *   node scripts/check-scene.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');

/** Keyframes that set the `transform` shorthand. */
function shorthandKeyframes() {
  const names = new Set();
  const re = /@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (/(^|[;{\s])transform\s*:/.test(m[2])) names.add(m[1]);
  }
  return names;
}

/** Classes whose animation uses one of those keyframes. */
function riskyClasses(names) {
  const map = new Map();
  const re = /([^{}]+)\{([^}]*animation:[^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const anim = /animation:\s*([\w-]+)/.exec(m[2]);
    if (!anim || !names.has(anim[1])) continue;
    for (const cls of m[1].match(/\.[\w-]+/g) || []) {
      map.set(cls.slice(1), anim[1]);
    }
  }
  return map;
}

const risky = riskyClasses(shorthandKeyframes());
const problems = [];

for (const page of ['index.html', 'gallery.html', 'admin.html']) {
  const file = path.join(ROOT, 'public', page);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  for (const tag of html.match(/<(?:g|svg|path|circle|ellipse|rect|image)[^>]*>/g) || []) {
    if (!/\stransform="/.test(tag)) continue;
    const cls = /class="([^"]*)"/.exec(tag);
    if (!cls) continue;
    for (const name of cls[1].split(/\s+/)) {
      if (risky.has(name)) {
        problems.push(`${page}: class "${name}" animates transform, but the element also `
          + `sets transform="${/transform="([^"]+)"/.exec(tag)[1]}" — the attribute is ignored.`);
      }
    }
  }
}

if (problems.length) {
  console.error('scene check failed:\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nAnimate translate/rotate/scale instead of the transform shorthand,');
  console.error('or move the placement onto a wrapper element.');
  process.exit(1);
}

console.log(`scene check passed (${risky.size} animated classes inspected)`);
