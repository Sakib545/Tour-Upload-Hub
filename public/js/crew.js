'use strict';

/**
 * The beach crew.
 *
 * The scene ships with anonymous figures doing things — flying a kite, taking a
 * selfie, riding, swimming, sitting on the sand. Each of those is now an empty
 * slot that this file fills with one enrolled person, so everybody in the tour
 * is somewhere in the picture doing something of their own rather than lined up
 * in a row.
 *
 * Proportions are adult: the head is about a sixth of the figure and the legs
 * about half, which is what stops a flat cartoon from reading as a child.
 * Everything is drawn from the feet up (origin at ground level, y negative
 * upward), so a slot only has to say where the ground is and how far away the
 * person stands.
 */

(function (global) {
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';

  // Skeleton of a standing adult, 100 units tall.
  const HIP = -44;
  const SHOULDER = -76;
  const HEAD_Y = -88;
  const HEAD_R = 10.5;

  /** Slots, in the order people are placed into them. */
  const SLOTS = ['atv', 'lounge', 'selfie-a', 'horse', 'boat', 'swim-a', 'selfie-b', 'swim-b'];
  const POSE_FOR = {
    atv: 'drive',
    lounge: 'lounge',
    'selfie-a': 'selfie',
    'selfie-b': 'stand',
    horse: 'ride',
    boat: 'sitLow',
    'swim-a': 'swim',
    'swim-b': 'swim',
  };

  // Sitting figures on the sand, for whoever is left over.
  const SAND_Y = 566;
  const SAND_FIRST_X = 190;
  const SAND_STEP = 96;
  const SAND_SCALE = 1.35;
  const SAND_MAX = 4;

  const PALETTE = [
    { skin: '#efbd93', hair: '#2b1d17', shirt: '#17948f', shorts: '#2b3a52' },
    { skin: '#d1996a', hair: '#c98b3c', shirt: '#d9483b', shorts: '#3b3f2c' },
    { skin: '#9a6440', hair: '#1c130f', shirt: '#6b4bd6', shorts: '#243b46' },
    { skin: '#efbd93', hair: '#2b1d17', shirt: '#f2ece1', shorts: '#4a3f6b' },
    { skin: '#d1996a', hair: '#1c130f', shirt: '#f5b942', shorts: '#2b3a52' },
    { skin: '#9a6440', hair: '#2b1d17', shirt: '#0ea5e9', shorts: '#243b46' },
    { skin: '#efbd93', hair: '#6b4423', shirt: '#e2554a', shorts: '#3b3f2c' },
  ];

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null && v !== '') node.setAttribute(k, String(v));
    }
    return node;
  }

  function shade(hex, amount) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    return '#' + [1, 2, 3].map((i) => {
      const v = Math.round(parseInt(m[i], 16) * amount);
      return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    }).join('');
  }

  function limb(d, colour, width) {
    return el('path', {
      d, stroke: colour, 'stroke-width': width || 9,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none',
    });
  }

  /** Head: either drawn, or the enrolled portrait clipped into a circle. */
  function head(g, person, colours, mode, cx, cy, r) {
    if (!(mode === 'photo' && person.hasFace)) {
      g.appendChild(el('circle', { cx, cy, r, fill: colours.skin }));
      g.appendChild(el('path', {
        d: `M${cx} ${cy - r - 1.5} q${r * 1.35} ${r * 0.35} ${r * 1.35} ${r * 1.25}`
          + ` q-${r * 1.35} -${r * 0.6} -${r * 2.7} 0`
          + ` q0 -${r * 0.9} ${r * 1.35} -${r * 1.25}z`,
        fill: colours.hair,
      }));
      return;
    }
    // A real face needs more room than a drawn one to be recognisable at this
    // size, so the portrait head is a little larger and sits slightly higher.
    const pr = r * 1.45;
    const pcy = cy - r * 0.35;
    const clipId = `crewClip-${person.id}`;
    const clip = el('clipPath', { id: clipId });
    clip.appendChild(el('circle', { cx, cy: pcy, r: pr }));
    g.appendChild(clip);
    g.appendChild(el('circle', { cx, cy: pcy, r: pr + 1.6, fill: '#ffffff', opacity: '0.92' }));
    const img = el('image', {
      x: cx - pr, y: pcy - pr, width: pr * 2, height: pr * 2,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': `url(#${clipId})`,
      // Tagged so an offline preview can swap in embedded portraits.
      'data-person': person.id,
    });
    const href = `/api/crew/${person.id}/face.jpg`;
    img.setAttributeNS(XLINK, 'href', href);
    img.setAttribute('href', href);
    g.appendChild(img);
  }

  /** Torso + neck, shared by every upright pose. */
  function upperBody(g, colours, shoulderY, hipY) {
    g.appendChild(limb(`M0 ${shoulderY + 2} L0 ${shoulderY - 6}`, colours.limb, 8));
    g.appendChild(el('path', {
      d: `M-17 ${shoulderY} h34 l-3 ${hipY - shoulderY} h-28 z`,
      fill: colours.shirt,
    }));
  }

  function legsStanding(g, colours) {
    g.appendChild(el('path', { d: `M-15 ${HIP} h30 l-1 15 h-28 z`, fill: colours.shorts }));
    g.appendChild(limb(`M-8 ${HIP + 13} L-9 -3`, colours.limb, 11));
    g.appendChild(limb(`M8 ${HIP + 13} L10 -3`, colours.limb, 11));
    g.appendChild(el('ellipse', { cx: -10, cy: 0, rx: 7, ry: 3.5, fill: shade(colours.skin, 0.72) }));
    g.appendChild(el('ellipse', { cx: 11, cy: 0, rx: 7, ry: 3.5, fill: shade(colours.skin, 0.72) }));
  }

  /* ── Poses ───────────────────────────────────────────────────── */

  const poses = {
    stand(g, person, colours, mode) {
      legsStanding(g, colours);
      upperBody(g, colours, SHOULDER, HIP);
      g.appendChild(limb(`M-14 ${SHOULDER + 3} L-19 ${HIP + 4}`, colours.limb));
      g.appendChild(limb(`M14 ${SHOULDER + 3} L19 ${HIP + 4}`, colours.limb));
      head(g, person, colours, mode, 0, HEAD_Y, HEAD_R);
    },

    /**
     * Lounging in the beach chair under the umbrella: back against the
     * backrest, legs stretched out front to the sand, one arm on the armrest.
     * Drawn to sit in the second chair of the scene's parasol group.
     */
    lounge(g, person, colours, mode) {
      // Far arm resting back on the armrest, then the far leg (both behind).
      g.appendChild(limb('M-4 -40 L-18 -26', shade(colours.limb, 0.72), 8));
      g.appendChild(limb('M-4 -2 L24 -12', shade(colours.limb, 0.7), 9.5));
      g.appendChild(limb('M24 -12 L28 15', shade(colours.limb, 0.7), 8.5));
      // Torso leaning back against the backrest.
      const trunk = el('g', { transform: 'rotate(-15 0 -5)' });
      upperBody(trunk, colours, -48, -6);
      g.appendChild(trunk);
      // Near leg stretched forward, foot on the sand.
      g.appendChild(limb('M4 -4 L32 -14', colours.limb, 10));
      g.appendChild(limb('M32 -14 L38 18', colours.limb, 9));
      // Shorts sit at the hips on the seat.
      g.appendChild(el('path', { d: 'M-12 -8 h24 l4 7 h-30z', fill: colours.shorts }));
      // Near arm relaxed on the lap / armrest.
      g.appendChild(limb('M8 -40 L24 -24', colours.limb, 8.5));
      head(g, person, colours, mode, -10, -56, 10);
    },

    selfie(g, person, colours, mode) {
      legsStanding(g, colours);
      upperBody(g, colours, SHOULDER, HIP);
      g.appendChild(limb(`M-14 ${SHOULDER + 3} L-20 ${HIP + 6}`, colours.limb));
      g.appendChild(limb(`M14 ${SHOULDER + 3} L26 ${SHOULDER - 16}`, colours.limb));
      const phone = el('g', { transform: `translate(26 ${SHOULDER - 22}) rotate(12)` });
      phone.appendChild(el('rect', { x: -5, y: -9, width: 10, height: 17, rx: 2, fill: '#2b3a52' }));
      phone.appendChild(el('rect', {
        class: 'cb-flash', x: -3.6, y: -7.4, width: 7.2, height: 13, rx: 1.4, fill: '#8fd6f5',
      }));
      g.appendChild(phone);
      head(g, person, colours, mode, 0, HEAD_Y, HEAD_R);
    },

    /** Cross-legged on the sand. */
    sit(g, person, colours, mode) {
      const hip = -20;
      const shoulder = -52;
      // Knees out to the sides, shins crossing in front, then the feet.
      g.appendChild(limb('M-6 -14 L-22 -6', colours.limb, 12));
      g.appendChild(limb('M6 -14 L22 -6', colours.limb, 12));
      g.appendChild(limb('M-20 -5 L6 -3', colours.limb, 10));
      g.appendChild(limb('M20 -5 L-4 -3', colours.limb, 10));
      g.appendChild(el('path', {
        d: 'M-19 -24 h38 l3 14 q-22 7 -44 0z', fill: colours.shorts,
      }));
      upperBody(g, colours, shoulder, hip);
      g.appendChild(limb(`M-14 ${shoulder + 3} L-18 -18`, colours.limb));
      g.appendChild(limb(`M14 ${shoulder + 3} L18 -18`, colours.limb));
      head(g, person, colours, mode, 0, shoulder - 12, HEAD_R);
    },

    /** Seated but upright, for the speedboat. */
    sitLow(g, person, colours, mode) {
      const hip = -16;
      const shoulder = -48;
      g.appendChild(el('path', { d: 'M-14 -18 h28 l2 14 h-32z', fill: colours.shorts }));
      upperBody(g, colours, shoulder, hip);
      g.appendChild(limb(`M-13 ${shoulder + 4} L-20 -20`, colours.limb));
      g.appendChild(limb(`M13 ${shoulder + 4} L20 -20`, colours.limb));
      head(g, person, colours, mode, 0, shoulder - 12, HEAD_R);
    },

    /** On horseback: one leg down the near flank, one hand on the reins. */
    ride(g, person, colours, mode) {
      const hip = -14;
      const shoulder = -46;
      g.appendChild(el('path', { d: 'M-13 -16 h26 l3 12 h-30z', fill: colours.shorts }));
      g.appendChild(limb('M-4 -6 L-12 26', colours.limb, 9.5));
      upperBody(g, colours, shoulder, hip);
      g.appendChild(limb(`M-13 ${shoulder + 4} L-18 -16`, colours.limb));
      g.appendChild(limb(`M13 ${shoulder + 4} L28 -8`, colours.limb));
      head(g, person, colours, mode, 0, shoulder - 12, HEAD_R);
    },

    /**
     * Riding the ATV: seated on the quad, shins forward onto the pegs, hands
     * out on the handlebar (far arm behind the torso, near arm on top).
     */
    drive(g, person, colours, mode) {
      // Far leg, then the near one — both reach forward to the front pegs.
      g.appendChild(limb('M-2 -4 L4 14', shade(colours.limb, 0.7), 8.5));
      g.appendChild(limb('M4 -6 L22 16', colours.limb, 10));
      g.appendChild(el('path', {
        d: 'M-13 -9 h26 l4 8 h-34z', fill: colours.shorts,
      }));
      // Far arm to the front bar — drawn first so the torso overlaps its root.
      g.appendChild(limb('M-6 -36 L24 -24', shade(colours.limb, 0.72), 7.5));
      upperBody(g, colours, -40, -6);
      // Near arm on top, hand on the front grip (the ATV art draws the bar
      // across x ≈ 14–40 at the same height once the slot scale is applied).
      g.appendChild(limb('M8 -37 L42 -24', colours.limb, 9));
      head(g, person, colours, mode, 0, -52, 10.5);
    },

    /** Waist-deep in the sea, arms thrown up. */
    swim(g, person, colours, mode) {
      const shoulder = -34;
      upperBody(g, colours, shoulder, 0);
      g.appendChild(limb(`M-14 ${shoulder + 3} L-30 ${shoulder - 20}`, colours.limb));
      g.appendChild(limb(`M14 ${shoulder + 3} L30 ${shoulder - 22}`, colours.limb));
      head(g, person, colours, mode, 0, shoulder - 12, HEAD_R);
    },
  };

  /* ── Assembly ────────────────────────────────────────────────── */

  function coloursFor(person, index) {
    const a = (person && person.avatar) || PALETTE[index % PALETTE.length];
    const skin = a.skin || '#efbd93';
    return {
      skin,
      // Arms and legs are drawn a little darker than the face: pale skin over
      // pale sand is the one pairing this scene cannot show.
      limb: shade(skin, 0.82),
      hair: a.hair || '#2b1d17',
      shirt: a.shirt || '#17948f',
      shorts: a.shorts || '#2b3a52',
    };
  }

  const GROUNDED = { stand: 1, kite: 1, selfie: 1, sit: 1 };

  function figure(person, index, pose, mode) {
    const g = el('g', {});
    if (GROUNDED[pose]) {
      g.appendChild(el('ellipse', {
        cx: 0, cy: 2, rx: pose === 'sit' ? 26 : 16, ry: 4,
        fill: '#7a5a2c', opacity: 0.22,
      }));
    }
    (poses[pose] || poses.stand)(g, person, coloursFor(person, index), mode);
    if (person && person.name) {
      const title = el('title', {});
      title.textContent = person.name;
      g.appendChild(title);
    }
    return g;
  }

  /**
   * Fill every slot. People take the activity slots first, in order, and
   * anyone left over sits on the sand; slots with nobody in them keep an
   * anonymous beachgoer, so the scene is never half-empty.
   */
  function renderCrew(cfg) {
    const conf = cfg || {};
    const mode = conf.heroCrew || 'cartoon';
    const people = mode === 'off' || !Array.isArray(conf.crew) ? [] : conf.crew.slice(0, 12);

    SLOTS.forEach((slot, i) => {
      const node = document.querySelector(`[data-slot="${slot}"]`);
      if (!node) return;
      node.textContent = '';
      const person = people[i] || { id: `extra-${slot}`, name: '', avatar: null };
      node.appendChild(figure(person, i, POSE_FOR[slot], mode));
    });

    const row = document.getElementById('crewFigures');
    if (!row) return;
    row.textContent = '';
    const sitters = people.slice(SLOTS.length);
    const count = Math.max(2, Math.min(SAND_MAX, sitters.length || 2));
    for (let i = 0; i < count; i++) {
      const person = sitters[i] || { id: `sand-${i}`, name: '', avatar: null };
      const g = el('g', {
        class: `cb-sit cb-sit-${(i % 4) + 1}`,
        transform: `translate(${SAND_FIRST_X + i * SAND_STEP} ${SAND_Y}) scale(${SAND_SCALE})`,
      });
      g.appendChild(figure(person, SLOTS.length + i, 'sit', mode));
      row.appendChild(g);
    }
  }

  global.renderCrew = renderCrew;
})(window);
