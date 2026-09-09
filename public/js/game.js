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

    function resize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      horizon = H * 0.36;
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

    function sky() {
      const g = ctx.createLinearGradient(0, 0, 0, horizon);
      g.addColorStop(0, '#241a4d');
      g.addColorStop(0.55, '#6b3f6e');
      g.addColorStop(1, '#e2743c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, horizon + 2);

      const sunX = W * 0.72;
      const sunY = horizon - 26;
      ctx.fillStyle = '#ffd9a0';
      ctx.beginPath();
      ctx.arc(sunX, sunY, 34, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(sunX, sunY, 62, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    function sea() {
      const g = ctx.createLinearGradient(0, horizon, 0, H);
      g.addColorStop(0, '#1d5f86');
      g.addColorStop(0.45, '#12456b');
      g.addColorStop(1, '#0b2c4c');
      ctx.fillStyle = g;
      ctx.fillRect(0, horizon, W, H - horizon);

      // Foam lines at fixed world intervals: the only real cue for speed.
      const step = 240;
      const first = Math.floor(state.travelled / step) * step;
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      for (let i = 0; i < 26; i++) {
        const z = first + i * step;
        const lift = waveAt(z, state.t);
        const a = project(-LANE_HALF - 260, z, lift);
        const b = project(LANE_HALF + 260, z, lift);
        if (!a || !b) continue;
        ctx.lineWidth = Math.max(0.6, 3 * a.scale);
        ctx.globalAlpha = clamp(a.scale * 2.4, 0, 0.5);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Channel edges
      for (const side of [-1, 1]) {
        ctx.strokeStyle = 'rgba(255, 210, 140, 0.35)';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < 30; i++) {
          const z = state.travelled + i * 60;
          const p = project(side * (LANE_HALF + 40), z, waveAt(z, state.t));
          if (!p) continue;
          if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
        }
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    function drawThing(o) {
      const lift = waveAt(o.z, state.t);
      const p = project(o.x, o.z, lift);
      if (!p) return;
      const s = p.scale;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (o.hit && o.kind !== 'ramp') ctx.globalAlpha = 0.25;

      if (o.kind === 'buoy') {
        ctx.fillStyle = '#e2554a';
        ctx.fillRect(-9 * s * 3, -34 * s * 3, 18 * s * 3, 34 * s * 3);
        ctx.fillStyle = '#f2ece1';
        ctx.fillRect(-9 * s * 3, -22 * s * 3, 18 * s * 3, 8 * s * 3);
      } else if (o.kind === 'jelly') {
        ctx.fillStyle = 'rgba(196, 160, 255, 0.9)';
        ctx.beginPath();
        ctx.arc(0, -16 * s * 3, 15 * s * 3, Math.PI, 0);
        ctx.fill();
        ctx.strokeStyle = 'rgba(196, 160, 255, 0.7)';
        ctx.lineWidth = Math.max(1, 2 * s * 3);
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(i * 8 * s * 3, -16 * s * 3);
          ctx.lineTo(i * 8 * s * 3 + Math.sin(state.t * 3 + i) * 4 * s * 3, 4 * s * 3);
          ctx.stroke();
        }
      } else if (o.kind === 'fuel') {
        ctx.fillStyle = '#f3b21c';
        ctx.fillRect(-11 * s * 3, -26 * s * 3, 22 * s * 3, 26 * s * 3);
        ctx.fillStyle = '#23262b';
        ctx.fillRect(-5 * s * 3, -32 * s * 3, 10 * s * 3, 7 * s * 3);
      } else if (o.kind === 'coin') {
        ctx.fillStyle = '#ffd76b';
        ctx.beginPath();
        ctx.ellipse(0, -22 * s * 3, 11 * s * 3 * Math.abs(Math.cos(state.t * 3 + o.spin)), 12 * s * 3, 0, 0, TAU);
        ctx.fill();
      } else if (o.kind === 'ramp') {
        ctx.fillStyle = '#2fb3a0';
        ctx.beginPath();
        ctx.moveTo(-34 * s * 3, 0);
        ctx.lineTo(34 * s * 3, 0);
        ctx.lineTo(34 * s * 3, -8 * s * 3);
        ctx.lineTo(-34 * s * 3, -26 * s * 3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    function drawRival(r) {
      const p = project(r.x, r.z, waveAt(r.z, state.t));
      if (!p) return;
      const s = p.scale * 3;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.ellipse(0, 0, 26 * s, 9 * s, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0ea5e9';
      ctx.fillRect(-10 * s, -22 * s, 20 * s, 18 * s);
      ctx.fillStyle = '#efbd93';
      ctx.beginPath();
      ctx.arc(0, -28 * s, 7 * s, 0, TAU);
      ctx.fill();
      if (r.person && r.person.name && p.scale > 0.16) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `${Math.round(11 * Math.min(2, s))}px "Hind Siliguri", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(r.person.name, 0, -40 * s);
      }
      ctx.restore();
    }

    function drawBoat() {
      const bob = waveAt(state.travelled, state.t) * 0.35;
      const cx = W / 2;
      const cy = H * 0.80 - state.air * 0.55 + bob;
      const tilt = clamp(state.vx / 420, -0.5, 0.5);
      const s = Math.min(W, 520) / 320;

      // Wake
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.moveTo(cx - 26 * s, cy + 8 * s);
      ctx.lineTo(cx + 26 * s, cy + 8 * s);
      ctx.lineTo(cx + 74 * s, cy + 74 * s);
      ctx.lineTo(cx - 74 * s, cy + 74 * s);
      ctx.closePath();
      ctx.fill();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt * 0.28);
      if (state.hitFlash > 0 && Math.floor(state.hitFlash * 20) % 2 === 0) ctx.globalAlpha = 0.45;

      // Hull, seen from behind
      ctx.fillStyle = '#e9edf2';
      ctx.beginPath();
      ctx.moveTo(-46 * s, 6 * s);
      ctx.quadraticCurveTo(0, 26 * s, 46 * s, 6 * s);
      ctx.lineTo(38 * s, -18 * s);
      ctx.lineTo(-38 * s, -18 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#cf2436';
      ctx.fillRect(-38 * s, -6 * s, 76 * s, 8 * s);

      // Rider
      ctx.fillStyle = '#17948f';
      ctx.fillRect(-13 * s, -46 * s, 26 * s, 30 * s);
      ctx.fillStyle = options.skin || '#efbd93';
      ctx.beginPath();
      ctx.arc(0, -56 * s, 12 * s, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2b1d17';
      ctx.beginPath();
      ctx.arc(0, -60 * s, 12 * s, Math.PI, 0);
      ctx.fill();
      ctx.restore();

      if (state.boosting && state.fuel > 0) {
        ctx.fillStyle = 'rgba(255, 196, 107, 0.75)';
        for (let i = 0; i < 3; i++) {
          const w = (10 - i * 2) * s;
          ctx.beginPath();
          ctx.ellipse(cx + (i - 1) * 22 * s, cy + 22 * s + i * 8 * s, w, w * 0.6, 0, 0, TAU);
          ctx.fill();
        }
      }
    }

    function draw() {
      sky();
      sea();
      // Far things first so nearer ones overlap them.
      const sorted = state.things.slice().sort((a, b) => b.z - a.z);
      for (const r of state.rivals.slice().sort((a, b) => b.z - a.z)) drawRival(r);
      for (const o of sorted) drawThing(o);
      drawBoat();
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
