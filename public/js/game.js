'use strict';

/**
 * ঢেউয়ের রেস — a third-person wave race.
 *
 * The camera sits behind and above the boat, so the sea recedes to a horizon
 * and everything approaches the player: buoys to dodge, fuel cans to grab,
 * ramps to jump. The original side-on version could only show a slice of the
 * water; from back here the whole channel is visible, which is what makes
 * steering a real decision rather than a reflex.
 *
 * Rendering is a small perspective projection rather than a 3D engine: every
 * object is a point (lateral x, distance z) scaled by focal / z. That is enough
 * for depth, costs nothing on a phone, and keeps the flat art style of the site.
 */

(function (global) {
  const TAU = Math.PI * 2;

  // Projection
  const FOCAL = 340;        // camera focal length in world units
  const CAM_HEIGHT = 95;    // how high the camera rides above the water
  const CAM_BACK = 30;      // how far behind the boat it sits
  const DRAW_DISTANCE = 1800;
  const LANE_HALF = 260;    // the channel is this wide either side of centre

  // Race
  const BASE_SPEED = 300;   // world units per second
  const MAX_SPEED = 760;
  const BOOST_SPEED = 980;
  const TRACK_LENGTH = 26000;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  function bn(n) {
    try {
      return Number(n).toLocaleString('bn-BD', { useGrouping: false });
    } catch (e) {
      return String(n);
    }
  }

  /* ── Obstacles and pickups ───────────────────────────────────── */

  const KINDS = {
    buoy:  { r: 46, score: 0, damage: 1 },
    jelly: { r: 40, score: 0, damage: 1 },
    fuel:  { r: 46, score: 0, damage: 0 },
    ramp:  { r: 70, score: 0, damage: 0 },
    coin:  { r: 40, score: 10, damage: 0 },
  };

  function createGame(canvas, opts) {
    const options = opts || {};
    const ctx = canvas.getContext('2d');
    const onState = options.onState || function () {};
    const crew = Array.isArray(options.crew) ? options.crew.slice(0, 6) : [];

    const state = {
      running: false,
      finished: false,
      t: 0,
      travelled: 0,
      speed: BASE_SPEED,
      x: 0,             // lateral position
      vx: 0,
      steer: 0,         // -1 .. 1 from input
      air: 0,           // height above water while jumping
      vy: 0,
      fuel: 100,
      boosting: false,
      lives: 3,
      score: 0,
      hitFlash: 0,
      things: [],
      rivals: [],
      nextSpawn: 600,
      best: Number(localStorage.getItem('dheu-best') || 0),
    };

    /* ── World generation ─────────────────────────────────────── */

    function spawnAhead() {
      const z = state.travelled + DRAW_DISTANCE;
      const roll = Math.random();
      let kind = 'buoy';
      if (roll > 0.86) kind = 'ramp';
      else if (roll > 0.72) kind = 'fuel';
      else if (roll > 0.52) kind = 'coin';
      else if (roll > 0.26) kind = 'jelly';
      state.things.push({ kind, z, x: rand(-LANE_HALF, LANE_HALF), spin: rand(0, TAU) });
      // Gaps shrink as the race goes on, so it gets harder without getting faster.
      const progress = state.travelled / TRACK_LENGTH;
      state.nextSpawn = rand(320, 620) * (1 - progress * 0.45);
    }

    function resetRivals() {
      state.rivals = crew.slice(0, 4).map((person, i) => ({
        person,
        z: 900 + i * 420,
        x: rand(-LANE_HALF * 0.8, LANE_HALF * 0.8),
        speed: BASE_SPEED * rand(0.92, 1.12),
        phase: rand(0, TAU),
      }));
    }

    function reset() {
      state.running = false;
      state.finished = false;
      state.t = 0;
      state.travelled = 0;
      state.speed = BASE_SPEED;
      state.x = 0;
      state.vx = 0;
      state.air = 0;
      state.vy = 0;
      state.fuel = 100;
      state.lives = 3;
      state.score = 0;
      state.hitFlash = 0;
      state.things = [];
      state.nextSpawn = 400;
      resetRivals();
      for (let z = 700; z < DRAW_DISTANCE; z += rand(340, 620)) {
        state.things.push({ kind: 'buoy', z, x: rand(-LANE_HALF, LANE_HALF), spin: rand(0, TAU) });
      }
      publish();
    }

    function publish() {
      onState({
        running: state.running,
        finished: state.finished,
        score: Math.round(state.score),
        best: Math.round(state.best),
        lives: state.lives,
        fuel: Math.round(state.fuel),
        speed: Math.round(state.speed),
        progress: clamp(state.travelled / TRACK_LENGTH, 0, 1),
        place: place(),
      });
    }

    function place() {
      let ahead = 0;
      for (const r of state.rivals) if (r.z > state.travelled) ahead += 1;
      return ahead + 1;
    }

    /* ── Waves ────────────────────────────────────────────────── */

    // One shared wave field: the boat rides it, and so does everything else,
    // which is what sells the water as a single surface.
    function waveAt(z, t) {
      return Math.sin(z * 0.0043 + t * 1.9) * 15 + Math.sin(z * 0.0011 - t * 0.9) * 9;
    }

    /* ── Update ───────────────────────────────────────────────── */

    function update(dt) {
      state.t += dt;
      if (!state.running) return;

      // Throttle: boost burns fuel, and running dry drops you to cruising.
      const wantBoost = state.boosting && state.fuel > 0;
      const target = wantBoost ? BOOST_SPEED : MAX_SPEED;
      state.speed += (target - state.speed) * Math.min(1, dt * 1.4);
      if (wantBoost) state.fuel = Math.max(0, state.fuel - dt * 26);

      state.travelled += state.speed * dt;
      state.score += state.speed * dt * 0.01;

      // Steering has weight: you lean into a turn and drift out of it.
      state.vx += state.steer * 520 * dt;
      state.vx *= Math.pow(0.0015, dt);
      state.x = clamp(state.x + state.vx * dt, -LANE_HALF - 40, LANE_HALF + 40);
      if (Math.abs(state.x) > LANE_HALF) state.vx *= 0.86; // soft channel edge

      // Jump arc
      if (state.air > 0 || state.vy > 0) {
        state.vy -= 460 * dt;
        state.air = Math.max(0, state.air + state.vy * dt);
        if (state.air === 0) state.vy = 0;
      }

      if (state.hitFlash > 0) state.hitFlash = Math.max(0, state.hitFlash - dt);

      // World
      state.nextSpawn -= state.speed * dt;
      if (state.nextSpawn <= 0) spawnAhead();
      state.things = state.things.filter((o) => o.z > state.travelled - 200);

      for (const r of state.rivals) {
        r.z += r.speed * dt;
        r.x += Math.sin(state.t * 0.8 + r.phase) * 40 * dt;
      }

      collide();

      if (state.travelled >= TRACK_LENGTH || state.lives <= 0) finish();
      publish();
    }

    function collide() {
      for (const o of state.things) {
        if (o.hit) continue;
        const dz = o.z - state.travelled;
        if (dz > 90 || dz < -60) continue;
        const spec = KINDS[o.kind];
        if (Math.abs(o.x - state.x) > spec.r) continue;
        // A jump clears everything except the ramp that launched it.
        if (state.air > 30 && o.kind !== 'ramp') continue;
        o.hit = true;
        if (o.kind === 'ramp') {
          state.vy = 250;
          state.air = Math.max(state.air, 1);
          state.score += 25;
        } else if (o.kind === 'fuel') {
          state.fuel = Math.min(100, state.fuel + 34);
        } else if (o.kind === 'coin') {
          state.score += spec.score;
        } else {
          state.lives -= 1;
          state.hitFlash = 0.45;
          state.speed = BASE_SPEED * 0.75;
          state.vx *= -0.4;
        }
      }
    }

    function finish() {
      state.running = false;
      state.finished = true;
      if (state.score > state.best) {
        state.best = state.score;
        try { localStorage.setItem('dheu-best', String(Math.round(state.score))); } catch (e) { /* private mode */ }
      }
      publish();
    }

    /* ── Drawing ──────────────────────────────────────────────── */

    let W = 0;
    let H = 0;
    let horizon = 0;

    // Two layers never change between frames: the sky (with its sun and glow)
    // and the vignette. Painting those gradients every frame was costing more
    // than the entire rest of the scene, so they are baked once per resize.
    const bg = document.createElement('canvas');
    const bgCtx = bg.getContext('2d');
    const vig = document.createElement('canvas');
    const vigCtx = vig.getContext('2d');

    function bakeLayers() {
      bg.width = W; bg.height = Math.ceil(horizon) + 4;
      vig.width = W; vig.height = H;

      const g = bgCtx.createLinearGradient(0, 0, 0, horizon);
      g.addColorStop(0, SKY_TOP);
      g.addColorStop(0.5, SKY_MID);
      g.addColorStop(0.86, SKY_LOW);
      g.addColorStop(1, '#ffb266');
      bgCtx.fillStyle = g;
      bgCtx.fillRect(0, 0, W, horizon + 4);

      const cx = W / 2;
      const cy = horizon - 30;
      const glow = bgCtx.createRadialGradient(cx, cy, 8, cx, cy, 140);
      glow.addColorStop(0, 'rgba(255, 226, 170, 0.85)');
      glow.addColorStop(1, 'rgba(255, 170, 90, 0)');
      bgCtx.fillStyle = glow;
      bgCtx.fillRect(cx - 150, cy - 150, 300, 300);
      bgCtx.fillStyle = SUN;
      bgCtx.beginPath();
      bgCtx.arc(cx, cy, 38, 0, TAU);
      bgCtx.fill();

      const v = vigCtx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35,
        W / 2, H * 0.55, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(3, 10, 22, 0.55)');
      vigCtx.clearRect(0, 0, W, H);
      vigCtx.fillStyle = v;
      vigCtx.fillRect(0, 0, W, H);
    }

    function resize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      horizon = H * 0.36;
      bakeLayers();
    }

    /** World point → screen. Returns null when it is behind the camera. */
    function project(x, z, lift) {
      const d = z - state.travelled + CAM_BACK;
      if (d < 12) return null;
      const scale = FOCAL / d;
      return {
        x: W / 2 + (x - state.x * 0.35) * scale,
        y: horizon + (CAM_HEIGHT - (lift || 0)) * scale,
        scale,
      };
    }

    /* ── Palette ──────────────────────────────────────────────
       Borrowed from the hero scene so the game feels like the same beach at
       the same hour, rather than a different app bolted on. */
    const SKY_TOP = '#2a1a4e';
    const SKY_MID = '#8a3f63';
    const SKY_LOW = '#ef7a35';
    const SUN = '#ffd79a';
    const SEA_FAR = '#2a6f96';
    const SEA_NEAR = '#0a2c4a';

    let sunX = 0;
    let sunY = 0;

    function sky() {
      // The camera pans a little with the boat, so the sun drifts across.
      sunX = W / 2 - state.x * 0.12;
      sunY = horizon - 30;
      ctx.drawImage(bg, sunX - W / 2, 0);
      if (sunX > W / 2) ctx.drawImage(bg, sunX - W / 2 - W, 0);
      else ctx.drawImage(bg, sunX - W / 2 + W, 0);

      ctx.fillStyle = 'rgba(255, 214, 190, 0.22)';
      for (let i = 0; i < 5; i++) {
        const cx = ((i * 317 + state.t * 9) % (W + 260)) - 130;
        const cy = horizon * (0.18 + i * 0.11);
        ctx.beginPath();
        ctx.ellipse(cx, cy, 70 + i * 22, 7 + i, 0, 0, TAU);
        ctx.fill();
      }
    }

    /** Height of the water surface at a distance, in screen pixels. */
    function surfaceY(z, scale) {
      return horizon + (CAM_HEIGHT - waveAt(z, state.t)) * scale;
    }

    function sea() {
      const g = ctx.createLinearGradient(0, horizon - 4, 0, H);
      g.addColorStop(0, SEA_FAR);
      g.addColorStop(0.4, '#14507a');
      g.addColorStop(1, SEA_NEAR);
      ctx.fillStyle = g;
      ctx.fillRect(0, horizon - 4, W, H - horizon + 4);

      // Rolling swell. Each band is filled only down to the next one, so the
      // whole sea costs about one screen of paint rather than twenty-six.
      const step = 130;
      const first = Math.floor(state.travelled / step) * step;
      const BANDS = 24;
      const line = (z, amp, y) => {
        const pts = [];
        for (let px = -20; px <= W + 20; px += 34) {
          pts.push([px, y + Math.sin((px + z * 0.7) * 0.012 + state.t * 2.2) * amp]);
        }
        return pts;
      };

      let prev = null;
      for (let i = BANDS; i >= 1; i--) {
        const z = first + i * step;
        const d = z - state.travelled + CAM_BACK;
        if (d < 12) continue;
        const scale = FOCAL / d;
        const y = surfaceY(z, scale);
        if (y < horizon - 30) continue;
        const near = clamp(scale * 2.2, 0, 1);
        const pts = line(z, 3 + near * 15, y);
        if (prev) {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (const pt of pts) ctx.lineTo(pt[0], pt[1]);
          for (let k = prev.length - 1; k >= 0; k--) ctx.lineTo(prev[k][0], prev[k][1]);
          ctx.closePath();
          ctx.fillStyle = `rgba(${18 + near * 12}, ${74 + near * 26}, ${118 + near * 30}, ${0.30 + near * 0.28})`;
          ctx.fill();
        }
        if (near > 0.3) {
          ctx.strokeStyle = `rgba(230, 246, 255, ${0.08 + near * 0.28})`;
          ctx.lineWidth = 1 + near * 2.2;
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (const pt of pts) ctx.lineTo(pt[0], pt[1]);
          ctx.stroke();
        }
        prev = pts;
      }
      // Below the nearest swell, plain deep water.
      if (prev) {
        ctx.beginPath();
        ctx.moveTo(prev[0][0], prev[0][1]);
        for (const pt of prev) ctx.lineTo(pt[0], pt[1]);
        ctx.lineTo(W + 20, H + 40);
        ctx.lineTo(-20, H + 40);
        ctx.closePath();
        ctx.fillStyle = 'rgba(10, 44, 74, 0.55)';
        ctx.fill();
      }

      // Sun path: additive so it reads as light on water rather than grey
      // slabs laid over it, and broken into flecks that ride the swell.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 2; i < 18; i++) {
        const z = state.travelled + i * 150;
        const scale = FOCAL / (z - state.travelled + CAM_BACK);
        const y = surfaceY(z, scale) + Math.sin(state.t * 3 + i) * 2;
        if (y > H) continue;
        const spread = 6 + scale * 120;
        const flecks = 2 + Math.round(scale * 5);
        for (let k = 0; k < flecks; k++) {
          const off = (k / (flecks - 1 || 1) - 0.5) * spread;
          const w = (6 + scale * 40) * (1 - Math.abs(off) / (spread * 0.7));
          if (w <= 0) continue;
          ctx.fillStyle = `rgba(255, 190, 110, ${clamp(scale * 0.35, 0, 0.11)})`;
          ctx.beginPath();
          ctx.ellipse(sunX + off + Math.sin(state.t * 2 + k + i) * 4, y, Math.max(1, w / 2),
            Math.max(0.8, 1.5 + scale * 4), 0, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();

      // Channel markers: paired posts rather than a drawn-on rope.
      for (let i = 1; i < 14; i++) {
        const z = state.travelled + i * 240;
        for (const side of [-1, 1]) {
          const p = project(side * (LANE_HALF + 60), z, waveAt(z, state.t));
          if (!p) continue;
          const h = 34 * p.scale * 3;
          ctx.fillStyle = i % 2 ? 'rgba(255, 210, 140, 0.8)' : 'rgba(226, 85, 74, 0.8)';
          ctx.fillRect(p.x - 2 * p.scale * 3, p.y - h, 4 * p.scale * 3, h);
        }
      }
    }

    function drawThing(o) {
      const lift = waveAt(o.z, state.t);
      const p = project(o.x, o.z, lift);
      if (!p) return;
      // Perspective scale runs away as an object reaches the camera, which
      // turned a passing buoy into a wall. Cap it and fade the last stretch.
      const s = Math.min(p.scale, 0.55) * 3.4;
      const fade = clamp((p.scale - 0.055) * 14, 0, 1);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = (o.hit && o.kind !== 'ramp' ? 0.22 : 1) * fade;

      // Everything sits in a small pool of shadow, which grounds it on the water.
      ctx.fillStyle = 'rgba(4, 20, 36, 0.35)';
      ctx.beginPath();
      ctx.ellipse(0, 2 * s, 20 * s, 6 * s, 0, 0, TAU);
      ctx.fill();

      if (o.kind === 'buoy') {
        ctx.fillStyle = '#e2554a';
        ctx.beginPath();
        ctx.moveTo(-11 * s, 0);
        ctx.quadraticCurveTo(-13 * s, -30 * s, 0, -34 * s);
        ctx.quadraticCurveTo(13 * s, -30 * s, 11 * s, 0);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#f7f2e8';
        ctx.fillRect(-12 * s, -22 * s, 24 * s, 7 * s);
        ctx.fillStyle = '#23262b';
        ctx.fillRect(-3 * s, -44 * s, 6 * s, 11 * s);
        ctx.fillStyle = '#ffd76b';
        ctx.beginPath();
        ctx.arc(0, -46 * s, 4 * s, 0, TAU);
        ctx.fill();
      } else if (o.kind === 'jelly') {
        const pulse = 1 + Math.sin(state.t * 3 + o.spin) * 0.12;
        ctx.strokeStyle = 'rgba(196, 160, 255, 0.75)';
        ctx.lineWidth = Math.max(1, 2.4 * s);
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(i * 5 * s, -14 * s);
          ctx.quadraticCurveTo(i * 7 * s + Math.sin(state.t * 4 + i) * 5 * s, -4 * s, i * 5 * s, 6 * s);
          ctx.stroke();
        }
        const grad = ctx.createRadialGradient(0, -20 * s, 2, 0, -20 * s, 20 * s * pulse);
        grad.addColorStop(0, 'rgba(233, 214, 255, 0.95)');
        grad.addColorStop(1, 'rgba(168, 122, 255, 0.55)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(0, -18 * s, 17 * s * pulse, 14 * s * pulse, 0, Math.PI, TAU);
        ctx.fill();
      } else if (o.kind === 'fuel') {
        ctx.fillStyle = '#f3b21c';
        ctx.beginPath();
        ctx.roundRect(-12 * s, -28 * s, 24 * s, 28 * s, 4 * s);
        ctx.fill();
        ctx.fillStyle = '#23262b';
        ctx.fillRect(-5 * s, -34 * s, 10 * s, 7 * s);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(-8 * s, -24 * s, 5 * s, 18 * s);
      } else if (o.kind === 'coin') {
        const w = Math.abs(Math.cos(state.t * 3.4 + o.spin));
        ctx.fillStyle = '#ffd76b';
        ctx.beginPath();
        ctx.ellipse(0, -24 * s, 12 * s * (0.25 + w * 0.75), 13 * s, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath();
        ctx.ellipse(-3 * s * w, -27 * s, 3 * s * w, 4 * s, 0, 0, TAU);
        ctx.fill();
      } else if (o.kind === 'ramp') {
        ctx.fillStyle = '#2fb3a0';
        ctx.beginPath();
        ctx.moveTo(-38 * s, 0);
        ctx.lineTo(38 * s, 0);
        ctx.lineTo(38 * s, -10 * s);
        ctx.lineTo(-38 * s, -30 * s);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        for (let i = -1; i <= 1; i++) {
          ctx.fillRect(i * 18 * s - 3 * s, -24 * s + i * 0, 6 * s, 18 * s);
        }
      }
      ctx.restore();
    }

    function drawRival(r) {
      const p = project(r.x, r.z, waveAt(r.z, state.t));
      if (!p) return;
      const s = Math.min(p.scale, 0.4) * 3.2;
      const fade = clamp((p.scale - 0.05) * 14, 0, 1);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = fade;
      // Wake first, so the boat sits in it.
      ctx.fillStyle = 'rgba(236, 250, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(-16 * s, 0);
      ctx.lineTo(16 * s, 0);
      ctx.lineTo(30 * s, 18 * s);
      ctx.lineTo(-30 * s, 18 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#eef3f8';
      ctx.beginPath();
      ctx.moveTo(-22 * s, -4 * s);
      ctx.quadraticCurveTo(0, 8 * s, 22 * s, -4 * s);
      ctx.lineTo(18 * s, -16 * s);
      ctx.lineTo(-18 * s, -16 * s);
      ctx.closePath();
      ctx.fill();
      const shirt = (r.person && r.person.avatar && r.person.avatar.shirt) || '#0ea5e9';
      const skin = (r.person && r.person.avatar && r.person.avatar.skin) || '#efbd93';
      ctx.fillStyle = shirt;
      ctx.fillRect(-8 * s, -34 * s, 16 * s, 18 * s);
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(0, -40 * s, 7 * s, 0, TAU);
      ctx.fill();
      if (r.person && r.person.name && p.scale > 0.13) {
        ctx.fillStyle = 'rgba(10, 26, 44, 0.6)';
        const label = r.person.name;
        ctx.font = `600 ${Math.round(clamp(12 * s, 9, 18))}px "Hind Siliguri", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        const w = ctx.measureText(label).width + 12;
        ctx.beginPath();
        ctx.roundRect(-w / 2, -62 * s, w, 20, 8);
        ctx.fill();
        ctx.fillStyle = '#eaf3fb';
        ctx.fillText(label, 0, -62 * s + 14);
      }
      ctx.restore();
    }

    function drawBoat() {
      const bob = waveAt(state.travelled, state.t) * 0.45;
      const cx = W / 2;
      const cy = H * 0.80 - state.air * 0.55 + bob;
      const tilt = clamp(state.vx / 420, -0.55, 0.55);
      const s = Math.min(W, 560) / 300;
      const fast = clamp((state.speed - BASE_SPEED) / (BOOST_SPEED - BASE_SPEED), 0, 1);

      // Spray thrown out either side, wider the faster you go.
      // The wake fades out towards the bottom instead of ending in a hard edge.
      const wake = ctx.createLinearGradient(0, cy, 0, cy + 92 * s);
      wake.addColorStop(0, 'rgba(236, 250, 255, 0.45)');
      wake.addColorStop(1, 'rgba(236, 250, 255, 0)');
      ctx.fillStyle = wake;
      ctx.beginPath();
      ctx.moveTo(cx - 26 * s, cy + 6 * s);
      ctx.quadraticCurveTo(cx - 78 * s * (0.7 + fast * 0.5), cy + 44 * s, cx - 96 * s, cy + 92 * s);
      ctx.lineTo(cx + 96 * s, cy + 92 * s);
      ctx.quadraticCurveTo(cx + 78 * s * (0.7 + fast * 0.5), cy + 44 * s, cx + 26 * s, cy + 6 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 7; i++) {
        const t = (state.t * 3 + i) % 1;
        const rr = (3 + i) * s * (0.6 + fast);
        ctx.beginPath();
        ctx.arc(cx + Math.sin(i * 2.1) * 70 * s * t, cy + 18 * s + t * 70 * s, rr * (1 - t), 0, TAU);
        ctx.fill();
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt * 0.3);
      if (state.hitFlash > 0 && Math.floor(state.hitFlash * 20) % 2 === 0) ctx.globalAlpha = 0.4;

      // Hull seen from behind: transom, then the sides falling away.
      ctx.fillStyle = '#dfe7ef';
      ctx.beginPath();
      ctx.moveTo(-52 * s, 4 * s);
      ctx.quadraticCurveTo(0, 30 * s, 52 * s, 4 * s);
      ctx.lineTo(42 * s, -22 * s);
      ctx.quadraticCurveTo(0, -30 * s, -42 * s, -22 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#cf2436';
      ctx.beginPath();
      ctx.moveTo(-48 * s, -6 * s);
      ctx.quadraticCurveTo(0, 4 * s, 48 * s, -6 * s);
      ctx.lineTo(46 * s, -14 * s);
      ctx.quadraticCurveTo(0, -6 * s, -46 * s, -14 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-40 * s, -21 * s, 80 * s, 3 * s);

      // Outboard
      ctx.fillStyle = '#23262b';
      ctx.fillRect(-7 * s, 2 * s, 14 * s, 18 * s);

      // Rider
      ctx.fillStyle = options.shirt || '#17948f';
      ctx.beginPath();
      ctx.roundRect(-15 * s, -52 * s, 30 * s, 34 * s, 6 * s);
      ctx.fill();
      ctx.fillStyle = options.skin || '#efbd93';
      ctx.beginPath();
      ctx.arc(0, -62 * s, 13 * s, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2b1d17';
      ctx.beginPath();
      ctx.arc(0, -66 * s, 13 * s, Math.PI, 0);
      ctx.fill();
      // Arms out to the wheel
      ctx.strokeStyle = options.skin || '#efbd93';
      ctx.lineWidth = 7 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-13 * s, -44 * s); ctx.lineTo(-24 * s, -30 * s);
      ctx.moveTo(13 * s, -44 * s); ctx.lineTo(24 * s, -30 * s);
      ctx.stroke();
      ctx.restore();

      if (state.boosting && state.fuel > 0) {
        for (let i = 0; i < 4; i++) {
          const a = 0.5 - i * 0.1;
          ctx.fillStyle = `rgba(255, ${170 - i * 20}, 80, ${a})`;
          ctx.beginPath();
          ctx.ellipse(cx, cy + (26 + i * 13) * s, (16 - i * 3) * s, (9 - i * 1.6) * s, 0, 0, TAU);
          ctx.fill();
        }
      }
    }

    /** Speed streaks and a vignette: cheap, and they sell the pace. */
    function overlay() {
      const fast = clamp((state.speed - MAX_SPEED * 0.8) / (BOOST_SPEED - MAX_SPEED * 0.8), 0, 1);
      if (fast > 0.02) {
        ctx.strokeStyle = `rgba(255,255,255,${0.05 + fast * 0.18})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * TAU + state.t * 2;
          const r0 = 120 + (i % 3) * 40;
          const x = W / 2 + Math.cos(a) * r0;
          const y = H * 0.6 + Math.sin(a) * r0 * 0.7;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(W / 2 + Math.cos(a) * (r0 + 70 * fast), H * 0.6 + Math.sin(a) * (r0 + 70 * fast) * 0.7);
          ctx.stroke();
        }
      }
      ctx.drawImage(vig, 0, 0);

      if (state.hitFlash > 0) {
        ctx.fillStyle = `rgba(226, 85, 74, ${state.hitFlash * 0.35})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function draw() {
      sky();
      sea();
      const sorted = state.things.slice().sort((a, b) => b.z - a.z);
      for (const r of state.rivals.slice().sort((a, b) => b.z - a.z)) drawRival(r);
      for (const o of sorted) drawThing(o);
      drawBoat();
      overlay();
    }

    /* ── Loop ─────────────────────────────────────────────────── */

    let raf = 0;
    let last = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      update(dt);
      draw();
    }

    function start() {
      reset();
      state.running = true;
      publish();
    }

    function stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    resize();
    reset();
    draw();
    last = performance.now();
    raf = requestAnimationFrame(frame);

    return {
      start,
      stop,
      resize,
      reset,
      setSteer(v) { state.steer = clamp(v, -1, 1); },
      setBoost(on) { state.boosting = !!on; },
      jump() {
        if (state.running && state.air <= 0) { state.vy = 210; state.air = 1; }
      },
      get state() { return state; },
    };
  }

  global.createWaveRace = createGame;
  global.bnNum = bn;
})(window);
