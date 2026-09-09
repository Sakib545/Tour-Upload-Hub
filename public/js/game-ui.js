'use strict';

/** Wires the race engine to the page: HUD, touch pads, keyboard, crew. */

(function () {
  const canvas = document.getElementById('raceCanvas');
  const card = document.getElementById('startCard');
  const hud = document.getElementById('hud');
  const pads = document.getElementById('pads');
  let game = null;

  const PLACES = ['১ম', '২য়', '৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ'];

  function renderHud(s) {
    document.getElementById('hudScore').textContent = bnNum(s.score);
    document.getElementById('hudPlace').textContent = PLACES[s.place - 1] || `${bnNum(s.place)}তম`;
    document.getElementById('hudLives').textContent = '❤'.repeat(Math.max(0, s.lives)) || '—';
    document.getElementById('hudProgress').style.width = (s.progress * 100).toFixed(1) + '%';
    document.getElementById('hudFuel').style.width = s.fuel + '%';

    if (s.finished) endRace(s);
  }

  function endRace(s) {
    hud.hidden = true;
    pads.hidden = true;
    card.hidden = false;
    const won = s.progress >= 1;
    document.getElementById('cardTitle').textContent = won ? '🏁 রেস শেষ!' : 'নৌকা ভেঙে গেছে';
    document.getElementById('cardText').textContent = won
      ? `${bnNum(s.score)} পয়েন্ট, অবস্থান ${PLACES[s.place - 1] || s.place}।`
      : `${bnNum(s.score)} পয়েন্ট পর্যন্ত গিয়েছিলেন।`;
    document.getElementById('cardBest').textContent = `সেরা স্কোর: ${bnNum(s.best)}`;
    document.getElementById('btnPlay').textContent = 'আবার খেলুন';
  }

  const PICK_KEY = 'dheu-player';
  let crewList = [];

  /**
   * One button per enrolled person, with their portrait when there is one.
   * The choice is remembered, so everyone lands on their own racer next time
   * they open the page on that phone.
   */
  function buildPicker(crew) {
    const row = document.getElementById('pickerRow');
    const wrap = document.getElementById('picker');
    row.textContent = '';
    if (!crew.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    const saved = localStorage.getItem(PICK_KEY);
    let chosen = crew.find((p) => p.id === saved) || crew[0];

    const select = (person) => {
      chosen = person;
      try { localStorage.setItem(PICK_KEY, person.id); } catch (e) { /* private mode */ }
      for (const b of row.children) b.classList.toggle('is-on', b.dataset.id === person.id);
      if (game) game.setPlayer(person);
    };

    for (const person of crew) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'racer';
      btn.dataset.id = person.id;

      const face = document.createElement('span');
      face.className = 'face';
      if (person.hasFace) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = `/api/crew/${person.id}/face.jpg`;
        face.appendChild(img);
      } else {
        const initial = document.createElement('span');
        initial.className = 'initial';
        initial.textContent = (person.name || '?').trim().charAt(0);
        face.style.background = (person.avatar && person.avatar.shirt) || '#17334f';
        face.appendChild(initial);
      }

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = person.name;

      btn.append(face, who);
      btn.addEventListener('click', () => select(person));
      row.appendChild(btn);
    }
    select(chosen);
  }

  async function boot() {
    let cfg = null;
    try {
      cfg = await api('/api/config');
    } catch (e) { /* the game works fine without the crew */ }

    crewList = (cfg && cfg.crew) || [];
    game = createWaveRace(canvas, {
      crew: crewList,
      skin: '#efbd93',
      shirt: '#17948f',
      onState: renderHud,
    });
    buildPicker(crewList);

    document.getElementById('cardBest').textContent =
      `সেরা স্কোর: ${bnNum(Number(localStorage.getItem('dheu-best') || 0))}`;

    if (crewList.length > 1) {
      document.getElementById('cardText').textContent +=
        ` সামনে ${bnNum(Math.min(4, crewList.length - 1))} জন প্রতিদ্বন্দ্বী আছে।`;
    }
  }

  document.getElementById('btnPlay').addEventListener('click', () => {
    card.hidden = true;
    hud.hidden = false;
    pads.hidden = false;
    game.start();
  });

  /* ── Controls ─────────────────────────────────────────────── */

  const hold = (id, on, off) => {
    const el = document.getElementById(id);
    const down = (ev) => { ev.preventDefault(); on(); };
    const up = (ev) => { ev.preventDefault(); off(); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  };

  for (const id of ['padLeft', 'padRight', 'padJump', 'padBoost']) {
    const el = document.getElementById(id);
    // Stop a pad press from also reaching the canvas underneath it.
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  }

  hold('padLeft', () => game.setSteer(-1), () => game.setSteer(0));
  hold('padRight', () => game.setSteer(1), () => game.setSteer(0));
  hold('padBoost', () => game.setBoost(true), () => game.setBoost(false));
  document.getElementById('padJump').addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    game.jump();
  });

  /**
   * Touch steering is absolute: the boat goes where your thumb is, rather than
   * accelerating while you hold a direction. On a phone that is the difference
   * between steering and wrestling. Pointer capture keeps it working when the
   * finger slides off the canvas mid-turn.
   */
  function aim(ev) {
    if (!game) return;
    const r = canvas.getBoundingClientRect();
    const rel = (ev.clientX - r.left) / r.width - 0.5;   // -0.5 .. 0.5
    game.setTarget(rel * 2.2 * game.lanes);
  }
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    aim(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (ev.pressure === 0 && ev.buttons === 0) return;
    aim(ev);
  });
  const release = (ev) => {
    if (ev && ev.pointerId !== undefined && canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    if (game) game.setTarget(null);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  const keys = {};
  addEventListener('keydown', (ev) => {
    if (!game) return;
    keys[ev.key] = true;
    if (ev.key === 'ArrowLeft') game.setSteer(-1);
    if (ev.key === 'ArrowRight') game.setSteer(1);
    if (ev.key === ' ') { ev.preventDefault(); game.jump(); }
    if (ev.key === 'Shift') game.setBoost(true);
  });
  addEventListener('keyup', (ev) => {
    if (!game) return;
    keys[ev.key] = false;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      game.setSteer(keys.ArrowLeft ? -1 : keys.ArrowRight ? 1 : 0);
    }
    if (ev.key === 'Shift') game.setBoost(false);
  });

  addEventListener('resize', () => { if (game) game.resize(); });
  boot();
})();
