// melody/onboard.js - first-visit demo song + 5-step coach-mark tutorial (a part, see MELODY.md "Onboarding").
//   Demo: 4 bars at 90 BPM (C Am F G), arpeggio backing, soft brush drums; bars 1-2 hold a finished melody on layer 1
//   (a glide instrument, snapped onto bright bands); bars 3-4 are empty with a faint dashed "ghost" path through the
//   band maxima (a suggestion: not playable, gone once anything is drawn there). The demo loads only on a first visit
//   (main.js: no autosave, no share link, empty inbox, tutorial not done) and never replaces an autosave or a share link.
//   Tutorial: 1 Play -> 2 finish bars 3-4 -> 3 change a chord (mentions Auto-fit) -> 4 try another instrument ->
//   5 Settings tour (opening Settings briefly highlights its tab strip) -> "You made music!" card. Steps advance on the
//   real actions (5: on Next only); Next / Skip on every card. "melody.tutorial" = 'done' once finished or skipped.
//   Settings > Song > "Start here": Replay tutorial, Load demo song, New song (confirmed inside the panel).
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody, md = NS.model;
  const { LO, HI, LPB, SPB, clamp } = md;
  const DONE_KEY = 'melody.tutorial';

  // Melody keyframes [sixteenth, midi] for bars 1-2 (over C and Am) and the ghost's target contour for bars 3-4 (F, G).
  const MELODY = [[0, 64], [4, 67], [8, 72], [12, 67], [16, 69], [20, 72], [24, 76], [28, 72]];
  const MEL_END = 30;   // the line ends just before bar 3 (sixteenths)
  const GHOST = [[32, 69], [36, 72], [40, 77], [44, 72], [48, 71], [52, 74], [56, 79], [60, 74]];
  const GHOST_BARS = [2, 3];

  function demoSong() {
    return {
      v: 2, key: 0, mode: 'major', bars: 4, bpm: 90, chords: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']],
      layers: [{ id: 'l1', name: 'Melody', color: '#5ad1ff', sound: 'clarinet', mode: 'line', vol: 0.85 }],
      backing: { sound: 'pluck', vol: 0.42, on: true, style: 'arp' },
      master: 1, bandsOthers: false, fx: {},
      drums: { on: true, preset: 'brush', kit: 'brush', vol: 0.3, vary: false, bars: {},
        pat: { len: 16, kick: 'x.......x.......', snare: 'x..ox..ox..ox..o', hat: '....x.......x...', perc: '................' } },
      ext: { demo: { ghost: 1 } }, grid: 8, loop: true, snap: false,
    };
  }
  NS.demoSong = demoSong;

  VH.melody.parts.push((M) => {
    const ui = VH.ui, V = M.view;
    let alive = true;

    // ---------- demo song ----------
    // Bars 1-2: hold each keyframe on the nearest bright band (snap), with a short glide into the next one.
    function fillMelody(S) {
      const A = 0, l0 = S.layers[0];
      l0.lines = [{ id: 's1', v: new Float32Array(S.bars * LPB).fill(NaN) }];
      const line = l0.lines[0].v;
      const snapAt = (t16, m) => M.bands.snap(m, Math.floor(t16 / SPB), A);
      const keys = MELODY.map(([t, m]) => [t, snapAt(t, m)]);
      const GL = 3;   // glide samples
      for (let k = 0; k < keys.length; k++) {
        const [t, m] = keys[k], i0 = t * 3, next = keys[k + 1], i1 = (next ? next[0] : MEL_END) * 3;
        for (let i = i0; i < i1; i++) {
          const u = next && i >= i1 - GL ? (i - (i1 - GL) + 1) / (GL + 1) : 0;
          line[i] = clamp(m + (next ? (next[1] - m) * u : 0), LO, HI);
        }
      }
    }
    function loadDemo(label) {
      M.replaceSong(demoSong(), label || null, fillMelody);
      if (label) M.toast('Demo song loaded · Ctrl+Z goes back');
    }
    M.loadDemo = loadDemo;

    // ---------- ghost path (bars 3-4): through the consonance maxima nearest a pleasant contour ----------
    let ghostMemo = null;
    function drawnIn(S, bars) {
      return S.layers.some((l) => {
        for (const b of bars) {
          for (const st of md.strokes(l)) for (let i = b * LPB; i < (b + 1) * LPB && i < st.v.length; i++) if (!isNaN(st.v[i])) return true;
          if (l.notes.some((n) => n.s < (b + 1) * SPB && n.s + n.d > b * SPB)) return true;
        }
        return false;
      });
    }
    // [{ t16, d, m }] or null when hidden (no demo flag, fewer than 4 bars, or something drawn in bars 3-4).
    function ghost() {
      const S = M.song;
      if (!(S.ext && S.ext.demo && S.ext.demo.ghost) || S.bars < 4 || drawnIn(S, GHOST_BARS)) return null;
      const cols = GHOST_BARS.map((b) => M.bands.column(b, M.active));
      if (ghostMemo && ghostMemo.cols.every((c, k) => c === cols[k])) return ghostMemo.pts;
      const pts = GHOST.map(([t, want], k) => {
        const peaks = M.bandsAt(t).peaks().filter((m) => Math.abs(m - want) <= 3.5);
        const m = peaks.length ? peaks.reduce((a, p) => (Math.abs(p - want) < Math.abs(a - want) ? p : a)) : M.bandsAt(t).snap(want);
        const end = k + 1 < GHOST.length ? GHOST[k + 1][0] : (GHOST_BARS[GHOST_BARS.length - 1] + 1) * SPB - 2;
        return { t16: t, d: end - t, m };
      });
      ghostMemo = { cols, pts };
      return pts;
    }
    M.ghost = ghost;
    M.on('draw', (ctx, view) => {
      const g = ghost();
      if (!g) return;
      ctx.save();
      ctx.setLineDash([6, 6]); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.42)'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      g.forEach((p, k) => {
        const x0 = view.xOf(p.t16), x1 = view.xOf(p.t16 + p.d) - (k + 1 < g.length ? view.U() * 0.8 : 0), y = view.yOf(p.m);
        if (k === 0) ctx.moveTo(x0, y); else ctx.lineTo(x0 + view.U() * 0.4, y);
        ctx.lineTo(x1, y);
      });
      ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,255,255,0.5)';
      g.forEach((p) => { ctx.beginPath(); ctx.arc(view.xOf(p.t16) + view.U() * 0.4, view.yOf(p.m), 2.5, 0, 2 * Math.PI); ctx.fill(); });
      ctx.restore();
    });

    // ---------- coach marks ----------
    const STEPS = [
      { id: 'play', text: 'Press <b>Play</b> to hear the start of the song.', place: ['above', 'below'] },
      { id: 'draw', text: '<b>Finish it!</b> Draw on the bright lines in bars 3–4. Bright = sounds good with the chord.', place: ['left', 'right', 'above', 'inside'] },
      { id: 'chord', text: 'Now <b>change a chord</b>. Click a chord name and watch the bands (and your notes) move.' +
        '<span class="mel-coach-sub">Your notes move to fit the new chord (Auto-fit; you can turn it off in Settings › Edit).</span>', place: ['below', 'above'] },
      { id: 'inst', text: '<b>Try another instrument</b>: flute, harp, strings, piano… Each one gets its own harmony map.', place: ['above', 'below'] },
      { id: 'settings', text: '<b>Settings</b> is packed: backing styles, drums, effects, mixer, export (MIDI/WAV/MP3), and 🎲 generators.', place: ['above', 'left', 'below'] },
    ];
    const TABS_MS = 2600;   // how long opening Settings (step 5) highlights its tab strip
    const box = ui.h('div', 'mel-coach'), ring = ui.h('div', 'mel-coach-ring'), card = ui.h('div', 'mel-coach-card');
    box.hidden = true; box.append(ring, card); M.el.append(box);
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite'); card.setAttribute('aria-label', 'Tutorial');
    let step = -1, chordSnap = '', soundSnap = '', played = false, advT = 0, tabsT = 0, tabsOn = false, tabsGlow = false;
    const soundsOf = (S) => JSON.stringify(S.layers.map((l) => l.sound));
    const tut = M.tutorial = {
      get step() { return step; },
      get active() { return step >= 0; },
      start() {
        const hint = document.querySelector('.vh-stage > .vh-hint');
        if (hint) hint.remove();
        played = false; go(0);
      },
      next() { go(step + 1); },
      skip() { finish(); },
      el: box,
    };
    function finish() {
      VH.store.set(DONE_KEY, 'done');
      step = -1; box.hidden = true; M.forget(advT); advT = 0; tabsOff();
    }
    function tabsOff() { M.forget(tabsT); tabsT = 0; tabsOn = tabsGlow = false; box.classList.remove('mel-coach-tabs'); }
    function go(k) {
      M.forget(advT); advT = 0; tabsOff();
      if (k >= STEPS.length) { step = STEPS.length; VH.store.set(DONE_KEY, 'done'); render(); return; }
      step = k;
      if (STEPS[k].id === 'chord') chordSnap = JSON.stringify(M.song.chords);
      if (STEPS[k].id === 'inst') soundSnap = soundsOf(M.song);
      render();
      if (STEPS[k].id === 'settings' && M.ui.drawer.isOpen) showTabs();
    }
    function advanceSoon(from, ms) {   // advance from step `from` after a short beat (only if still there)
      if (advT) return;
      advT = M.later(() => { advT = 0; if (step === from) go(from + 1); }, ms);
    }
    function render() {
      box.hidden = step < 0;
      if (step < 0) return;
      const last = step >= STEPS.length;
      box.classList.toggle('final', last);
      if (last) {
        card.innerHTML = '<div class="mel-coach-txt"><b>You made music! 🎉</b> Start fresh with <i>New song</i>, or keep going.</div>' +
          '<div class="mel-coach-btns"><button type="button" class="vh-btn" data-a="new">New song…</button>' +
          '<button type="button" class="vh-btn mel-coach-next" data-a="close">Keep going</button></div>' +
          '<div class="mel-coach-confirm" hidden><span>Replace this song with an empty one? (Ctrl+Z brings it back)</span>' +
          '<button type="button" class="vh-btn mel-danger" data-a="yes">New song</button><button type="button" class="vh-btn" data-a="no">Cancel</button></div>';
      } else {
        card.innerHTML = '<div class="mel-coach-n">' + (step + 1) + ' / ' + STEPS.length + '</div><div class="mel-coach-txt">' + STEPS[step].text + '</div>' +
          '<div class="mel-coach-btns"><button type="button" class="vh-btn mel-coach-skip" data-a="skip">Skip</button>' +
          '<button type="button" class="vh-btn mel-coach-next" data-a="next">Next</button></div>';
      }
      card.append(ui.h('i', 'mel-coach-arrow'));
      position();
    }
    card.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'next') tut.next();
      else if (a === 'skip' || a === 'close') finish();
      else if (a === 'new') { card.querySelector('.mel-coach-confirm').hidden = false; card.querySelector('[data-a="yes"]').focus(); position(); }
      else if (a === 'no') { card.querySelector('.mel-coach-confirm').hidden = true; position(); }
      else if (a === 'yes') { finish(); M.newSong(); }
    });
    card.addEventListener('pointerdown', (e) => e.stopPropagation());

    // Target rect (relative to M.el) of the current step.
    function targetRect() {
      const er = M.el.getBoundingClientRect(), cr = V.cv.getBoundingClientRect(), k = cr.width / V.VW || 1;
      const rel = (r) => ({ left: r.left - er.left, top: r.top - er.top, width: r.width, height: r.height });
      const id = step < STEPS.length ? STEPS[step].id : '';
      if (id === 'play') {
        const b = [...M.ui.dock.children].find((c) => c.title === 'Play / stop (Space)');
        return b ? rel(b.getBoundingClientRect()) : null;
      }
      if (id === 'draw') {
        const x0 = Math.max(V.X0, V.sx(V.xOf(GHOST_BARS[0] * SPB))), x1 = Math.min(V.VW, V.sx(V.xOf((GHOST_BARS[1] + 1) * SPB)));
        if (x1 <= x0) return null;
        return { left: cr.left - er.left + x0 * k, top: cr.top - er.top + V.HDR * k, width: (x1 - x0) * k, height: V.MH * k };
      }
      if (id === 'inst') {
        const b = M.ui.dock.querySelector('[title="Instrument of the active layer"]');
        return b ? rel(b.getBoundingClientRect()) : null;
      }
      if (id === 'settings') {
        const tabs = tabsOn && M.ui.drawer.isOpen && M.ui.drawer.el.querySelector('.vh-ptabs');
        if (tabs && tabs.offsetWidth) {   // the panel's tab strip (Song · Sound · Mix · Edit · Export), clipped to the panel
          const r = tabs.getBoundingClientRect(), pr = M.ui.drawer.el.getBoundingClientRect();
          const l = Math.max(r.left, pr.left + 4), w = Math.min(r.right, pr.right - 4) - l;
          return rel({ left: l, top: r.top, width: Math.max(20, w), height: r.height });
        }
        const b = M.ui.drawer.button;
        return b ? rel(b.getBoundingClientRect()) : null;
      }
      if (id === 'chord') {
        const b = Math.min(2, M.song.bars - 1), cx = V.sx((b + 0.5) * V.BW), w = Math.min(V.BW - 8, 70);
        return { left: cr.left - er.left + (cx - w / 2) * k, top: cr.top - er.top + 3 * k, width: w * k, height: (V.HDR - 6) * k };
      }
      return null;
    }
    function position() {
      if (box.hidden) return;
      const W = M.el.clientWidth, H = M.el.clientHeight, pad = 8, gap = 12;
      card.style.maxWidth = Math.min(300, W - 2 * pad) + 'px';
      const t = targetRect(), arrow = card.querySelector('.mel-coach-arrow');
      ring.hidden = !t || (tabsOn && !tabsGlow);   // step 5: the tab-strip ring is brief; the card stays by the panel
      if (t) Object.assign(ring.style, { left: t.left - 4 + 'px', top: t.top - 4 + 'px', width: t.width + 8 + 'px', height: t.height + 8 + 'px' });
      let cw = card.offsetWidth, ch = card.offsetHeight, side = 'none';
      if (t) {   // first candidate side that fits; beside the target the card may narrow (down to 150 px)
        const full = Math.min(300, W - 2 * pad);
        const fits = (p) => {
          if (p === 'inside') return true;
          let mw = full;
          if (p === 'left' || p === 'right') {
            mw = Math.min(full, p === 'left' ? t.left - gap - pad : W - t.left - t.width - gap - pad);
            if (mw < 150) return false;
          }
          card.style.maxWidth = mw + 'px'; cw = card.offsetWidth; ch = card.offsetHeight;
          return p === 'above' ? t.top - gap - ch >= pad : p === 'below' ? t.top + t.height + gap + ch <= H - pad
            : p === 'left' ? t.left - gap - cw >= pad : t.left + t.width + gap + cw <= W - pad;
        };
        const place = tabsOn ? ['left', 'above', 'below'] : STEPS[step].place;
        side = place.find(fits) || 'inside';
        if (side === 'inside') { card.style.maxWidth = full + 'px'; cw = card.offsetWidth; ch = card.offsetHeight; }
      }
      let x = (W - cw) / 2, y = (H - ch) / 2;
      if (t) {
        const cx = t.left + t.width / 2, cy = t.top + t.height / 2;
        if (side === 'above') { x = cx - cw / 2; y = t.top - gap - ch; }
        else if (side === 'below') { x = cx - cw / 2; y = t.top + t.height + gap; }
        else if (side === 'left') { x = t.left - gap - cw; y = Math.min(cy, t.top + 90) - ch / 2; }
        else if (side === 'right') { x = t.left + t.width + gap; y = Math.min(cy, t.top + 90) - ch / 2; }
        else { x = cx - cw / 2; y = t.top + t.height - ch - 16; }
        x = clamp(x, pad, Math.max(pad, W - cw - pad)); y = clamp(y, pad, Math.max(pad, H - ch - pad));
        if (arrow) {   // the arrow sits on the card edge facing the target, aimed at its centre
          const ax = clamp(cx - x, 14, cw - 14), ay = clamp(Math.min(cy, t.top + 90) - y, 14, ch - 14);
          arrow.className = 'mel-coach-arrow ' + side;
          arrow.style.left = side === 'above' || side === 'below' ? ax + 'px' : '';
          arrow.style.top = side === 'left' || side === 'right' ? ay + 'px' : '';
          arrow.hidden = side === 'inside';
        }
      } else if (arrow) arrow.hidden = true;
      card.style.left = Math.round(x) + 'px'; card.style.top = Math.round(y) + 'px';
      card.dataset.side = side;
    }
    tut.position = position;
    const reposition = () => { if (!box.hidden) position(); };
    M.on('layout', reposition); M.on('scroll', reposition);
    // Step 5: opening Settings highlights its tab strip for a moment (the card sits above the panel meanwhile).
    function showTabs() {
      tabsOff();
      tabsOn = tabsGlow = true; box.classList.add('mel-coach-tabs');   // above the panel while it is open
      tabsT = M.later(() => { tabsT = 0; tabsGlow = false; reposition(); }, TABS_MS);
      M.later(reposition, 260);
    }
    M.ui.drawer.onChange((d) => {
      if (step >= 0 && step < STEPS.length && STEPS[step].id === 'settings') { if (d.isOpen) showTabs(); else tabsOff(); }
      reposition(); M.later(reposition, 260);   // the panel pushes the stage (CSS transition)
    });
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(reposition); ro.observe(M.el); }
    window.addEventListener('resize', reposition);
    M.cleanups.push(() => window.removeEventListener('resize', reposition));

    // ---------- advancing on real actions ----------
    M.on('play', () => { if (step === 0) played = true; });
    M.on('bar', (b) => { if (step === 0 && played && b >= GHOST_BARS[0]) advanceSoon(0, 300); });
    M.on('stop', () => { if (step === 0 && played) advanceSoon(0, 300); });
    M.on('song', (S) => {
      if (step === 1 && drawnIn(S, GHOST_BARS)) advanceSoon(1, 700);
      else if (step === 2 && JSON.stringify(S.chords) !== chordSnap) advanceSoon(2, 900);
      else if (step === 3 && soundsOf(S) !== soundSnap) advanceSoon(3, 700);
      reposition();
    });

    // ---------- Settings > Song: Start here ----------
    const sec = M.ui.addPanelSection('Start here', 80, { group: 'song' });
    const row = ui.h('div', 'vh-row'); sec.append(row);
    ui.button(row, { label: 'Replay tutorial', onClick: () => { M.ui.drawer.close(); loadDemo('Load demo song'); tut.start(); } }).classList.add('mel-replay');
    ui.button(row, { label: 'Load demo song', onClick: () => loadDemo('Load demo song') }).classList.add('mel-loaddemo');
    const newBtn = ui.button(row, { label: 'New song', onClick: () => { conf.hidden = false; conf.querySelector('.mel-danger').focus(); } });
    newBtn.classList.add('mel-newsong');
    const conf = ui.h('div', 'vh-row mel-confirm', '<span class="vh-desc">Replace this song with an empty one? Ctrl+Z brings it back.</span>');
    conf.hidden = true; sec.append(conf);
    ui.button(conf, { label: 'Yes, new song', onClick: () => { conf.hidden = true; if (tut.active) finish(); M.newSong(); M.toast('New song · Ctrl+Z goes back'); } }).classList.add('mel-danger');
    ui.button(conf, { label: 'Cancel', onClick: () => { conf.hidden = true; newBtn.focus(); } });
    sec.append(ui.h('div', 'vh-desc', 'The demo is half finished: draw the rest. Loading it or starting a new song is one undo step.'));

    // ---------- first visit ----------
    if (M.firstVisit) {
      loadDemo(null);
      M.later(() => { if (alive) tut.start(); }, 400);
    }

    return {
      destroy() {
        alive = false;
        if (ro) ro.disconnect();
      },
    };
  });
})();
