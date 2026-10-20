// synthed.js - the shared synth editor (window.VH.synthEditor), for synth.v2 sounds (see js/core/synth.js).
// VH.synthEditor.open({ soundId?, model?, name?, onSave(sound), onClose() }) -> editor api (also VH.synthEditor.current).
// A large modal: oscillators 1-3 (wave, drawable partials, oct/semi/detune/level/unison/spread/stretch), filter with a
// response curve, draggable amp + filter ADSRs, 2 LFOs, glide + gain, presets, 🎲 randomize, and a live harmony preview:
// the analytic spectrum and a C3..C6 band map against a C-major triad (VH.harmony.dissonanceSpectra), redrawn within
// ~30 ms of any change. Audition: keys A W S E D F T G Y H U J K (C4..C5) and clicks on the band map.
// Editing a saved sound (soundId) applies every change live (VH.sounds.save with the same id, debounced).
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  const doc = root.document;
  const KEYS = 'awsedftgyhujk';
  const MAP_LO = 48, MAP_HI = 84, MAP_ROWS = 144;   // C3..C6, quarter-tone rows
  const TRIAD = [60, 64, 67];
  const CONS_K = 0.8, BRIGHT = 0.5;   // consonance = exp(-dissonance / CONS_K); "bright" above BRIGHT
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const WAVE_LABEL = { sine: 'Sine', saw: 'Saw', square: 'Square', triangle: 'Triangle', noise: 'Noise', partials: 'Draw' };
  let current = null;

  // Consonance of each map row (bottom = C3 .. top = C6) for a spectrum: exp(-D / K), D = the dissonance the note adds
  // to a C-major triad (C4 E4 G4), summed over its pairs with each triad note.
  function bandRows(sp, rows = MAP_ROWS) {
    const H = VH.harmony, out = new Float32Array(rows), tri = TRIAD.map(hz);
    for (let i = 0; i < rows; i++) {
      const f = hz(MAP_LO + (MAP_HI - MAP_LO) * i / (rows - 1));
      let d = 0;
      for (const t of tri) d += H.dissonanceSpectra([t, f], sp);
      out[i] = Math.exp(-d / CONS_K);
    }
    return out;
  }

  function open(opts) {
    const o = opts || {}, Y = VH.synth, ui = VH.ui, h = ui.h;
    if (current) current.close();
    const base = o.soundId ? VH.sounds.get(o.soundId) : null;
    const editId = base && Y.isV2(base) ? base.id : null;
    const orig = editId ? JSON.parse(JSON.stringify(base)) : null;
    let model = Y.normalize(editId ? base.synth : o.model || Y.preset('warm-pad'));
    let name = editId ? base.name : o.name || 'My synth';
    let loud = editId && base.loud > 0 ? base.loud : null, loudFor = null;   // loud of the model JSON loudFor
    let tab = 0, spec = Y.spectrum(model), rows = bandRows(spec), saving = false;
    const pad = () => { while (model.oscs.length < 3) model.oscs.push(Y.normOsc({ wave: 'saw', level: 0 })); while (model.lfos.length < 2) model.lfos.push({ rate: 5, shape: 'sine', target: 'pitch', depth: 0 }); };
    pad();

    const D = ui.modal('vh-synthed', editId ? 'Edit synth' : 'New synth');
    D.box.dataset.synthed = '1';
    const binds = [], timers = {};
    const later = (k, ms, fn) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };

    // ---------- small controls ----------
    function slider(parent, label, c) {
      const d = h('label', 'vh-se-sl', '<span class="n"></span><input type="range"><span class="v"></span>');
      const inp = d.querySelector('input'), out = d.querySelector('.v');
      d.firstChild.textContent = label; inp.setAttribute('aria-label', label);
      const lg = c.log, to = (v) => (lg ? 1000 * Math.log(v / c.min) / Math.log(c.max / c.min) : v);
      const from = (x) => (lg ? c.min * (c.max / c.min) ** (x / 1000) : x);
      Object.assign(inp, lg ? { min: 0, max: 1000, step: 1 } : { min: c.min, max: c.max, step: c.step || 0.01 });
      const fmt = c.fmt || ((v) => String(+(+v).toPrecision(3)));
      const sync = () => { const v = c.get(); inp.value = to(v); out.textContent = fmt(v); };
      inp.addEventListener('input', () => { c.set(from(+inp.value)); out.textContent = fmt(c.get()); changed(); });
      sync(); binds.push(sync); parent.append(d);
      return d;
    }
    function seg(parent, label, list, c) {
      const d = h('div', 'vh-se-seg'); d.setAttribute('role', 'group'); d.setAttribute('aria-label', label);
      const bs = list.map(([v, t]) => {
        const b = h('button', 'vh-se-chip'); b.type = 'button'; b.textContent = t; b.dataset.v = v;
        b.addEventListener('click', () => { c.set(v); sync(); changed(); });
        d.append(b); return b;
      });
      const sync = () => bs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(c.get()))));
      sync(); binds.push(sync); parent.append(d);
      return d;
    }
    function selectBox(parent, label, list, c) {
      const s = h('select', 'vh-select vh-se-select'); s.setAttribute('aria-label', label);
      for (const [v, t] of list) { const e = h('option'); e.value = v; e.textContent = t; s.append(e); }
      s.addEventListener('change', () => { c.set(s.value); changed(); });
      binds.push(() => { s.value = c.get(); }); s.value = c.get(); parent.append(s);
      return s;
    }
    const sect = (parent, title, cls) => { const s = h('section', 'vh-se-sec ' + (cls || '')); s.append(h('h3', '', ui.esc(title))); parent.append(s); return s; };
    function canvas(parent, cls, label) {
      const cv = h('canvas', cls); cv.setAttribute('aria-label', label); cv.setAttribute('role', 'img'); parent.append(cv); return cv;
    }
    function fit(cv) {
      const r = ui.dpr(), w = Math.max(1, Math.round(cv.clientWidth * r)), hh = Math.max(1, Math.round(cv.clientHeight * r));
      if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
      const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0);
      return { g, w: cv.clientWidth, h: cv.clientHeight };
    }

    // ---------- layout ----------
    const top = h('div', 'vh-se-top'), grid = h('div', 'vh-se-grid'), main = h('div', 'vh-se-main'), side = h('div', 'vh-se-side');
    grid.append(main, side); D.body.append(top, grid);
    // top bar: preset, name, randomize
    const pre = h('select', 'vh-select vh-se-preset'); pre.setAttribute('aria-label', 'Start from a preset');
    pre.innerHTML = '<option value="">Presets…</option>';
    for (const p of Y.PRESETS) { const e = h('option'); e.value = p.id; e.textContent = p.name; pre.append(e); }
    pre.addEventListener('change', () => { if (!pre.value) return; const p = Y.PRESETS.find((x) => x.id === pre.value); setModel(Y.preset(p.id)); if (!editId && (/^My synth$|^Random /.test(name) || nameIsPreset())) setName(p.name); pre.value = ''; });
    const nameIn = h('input', 'vh-se-name'); nameIn.type = 'text'; nameIn.maxLength = 40; nameIn.value = name; nameIn.setAttribute('aria-label', 'Instrument name');
    nameIn.addEventListener('input', () => { name = nameIn.value.trim() || 'My synth'; if (editId) later('live', 400, commitLive); });
    const nameIsPreset = () => Y.PRESETS.some((p) => p.name === name);
    const setName = (n) => { name = n; nameIn.value = n; };
    const rnd = h('button', 'vh-btn vh-se-rnd'); rnd.type = 'button'; rnd.textContent = '🎲 Randomize'; rnd.title = 'A random, musical synth';
    let rndN = 0;
    rnd.addEventListener('click', () => { api.randomize(); });
    top.append(pre, nameIn, rnd);

    // ---- oscillators ----
    const so = sect(main, 'Oscillators', 'vh-se-osc');
    const tabs = h('div', 'vh-se-tabs'); tabs.setAttribute('role', 'tablist'); so.append(tabs);
    const tabBtns = [0, 1, 2].map((i) => {
      const b = h('button', 'vh-se-tab'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.i = i;
      b.addEventListener('click', () => { tab = i; syncAll(); });
      tabs.append(b); return b;
    });
    binds.push(() => tabBtns.forEach((b, i) => {
      const x = model.oscs[i]; b.setAttribute('aria-selected', String(i === tab));
      b.textContent = 'Osc ' + (i + 1) + (x.level > 0 ? ' · ' + WAVE_LABEL[x.wave] : ' · off');
      b.classList.toggle('off', !(x.level > 0));
    }));
    const O = () => model.oscs[tab];
    seg(so, 'Wave', Y.WAVES.map((w) => [w, WAVE_LABEL[w]]), { get: () => O().wave, set: (w) => {
      const x = O();
      if (w === 'partials' && !x.partials) x.partials = (Y.waveHarmonics(x.wave === 'noise' ? { wave: 'saw' } : x, 16).slice(0, 16)).map((p) => [p[0], +p[1].toFixed(3)]);
      x.wave = w; if (!(x.level > 0)) x.level = 0.6;
    } });
    // drawable partials (16 bars; a bar keeps its ratio, empty slots are harmonics)
    const pwrap = h('div', 'vh-se-pwrap'); so.append(pwrap);
    const pcv = canvas(pwrap, 'vh-se-partials', 'Partials: draw with the mouse or a finger');
    pwrap.append(h('div', 'vh-se-hint', 'Draw the overtone amounts (1 = fundamental).'));
    const slots = () => { const ps = O().partials || []; return Array.from({ length: 16 }, (_, k) => (ps[k] ? ps[k].slice() : [k + 1, 0])); };
    function drawPartials() {
      pwrap.hidden = O().wave !== 'partials';
      if (pwrap.hidden) return;
      const { g, w, h: hh } = fit(pcv), sl = slots(), bw = w / 16;
      g.clearRect(0, 0, w, hh);
      g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(0, 0, w, hh);
      sl.forEach(([r, a], k) => {
        g.fillStyle = k === 0 ? '#9ff' : '#6fa3ff'; g.globalAlpha = 0.35 + 0.65 * a;
        g.fillRect(k * bw + 2, hh - 14 - a * (hh - 18), bw - 4, a * (hh - 18));
        g.globalAlpha = 1; g.fillStyle = '#7a8194'; g.font = '9px system-ui'; g.textAlign = 'center';
        g.fillText(+r.toFixed(2), k * bw + bw / 2, hh - 3);
      });
    }
    binds.push(drawPartials);
    let drawing = false, lastK = -1;
    function paint(e) {
      const r = pcv.getBoundingClientRect(), k = Math.max(0, Math.min(15, Math.floor((e.clientX - r.left) / r.width * 16)));
      const a = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - 4) / (r.height - 18)));
      const sl = slots(), from = lastK < 0 ? k : lastK;
      for (let j = Math.min(from, k); j <= Math.max(from, k); j++) sl[j][1] = +a.toFixed(3);   // fill skipped bars
      if (!sl.some((p) => p[1] > 0)) sl[0][1] = 0.01;
      lastK = k; O().partials = sl; drawPartials(); changed();
    }
    pcv.addEventListener('pointerdown', (e) => { drawing = true; lastK = -1; pcv.setPointerCapture(e.pointerId); paint(e); e.preventDefault(); });
    pcv.addEventListener('pointermove', (e) => { if (drawing) paint(e); });
    const endDraw = () => { drawing = false; lastK = -1; };
    pcv.addEventListener('pointerup', endDraw); pcv.addEventListener('pointercancel', endDraw);
    const og = h('div', 'vh-se-sliders'); so.append(og);
    const oscSl = (label, k, c) => slider(og, label, Object.assign({ get: () => O()[k], set: (v) => { O()[k] = c.int ? Math.round(v) : v; } }, c));
    oscSl('Level', 'level', { min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + ' %' });
    oscSl('Octave', 'oct', { min: -3, max: 3, step: 1, int: true, fmt: (v) => (v > 0 ? '+' : '') + v });
    oscSl('Semitone', 'semi', { min: -12, max: 12, step: 1, int: true, fmt: (v) => (v > 0 ? '+' : '') + v });
    oscSl('Detune', 'detune', { min: -50, max: 50, step: 1, fmt: (v) => Math.round(v) + ' ¢' });
    oscSl('Unison', 'unison', { min: 1, max: 7, step: 1, int: true, fmt: (v) => '×' + v });
    oscSl('Spread', 'spread', { min: 0, max: 100, step: 1, fmt: (v) => Math.round(v) + ' ¢' });
    oscSl('Stretch', 'stretch', { min: 0.9, max: 1.1, step: 0.001, fmt: (v) => v.toFixed(3) });

    // ---- filter ----
    const sf = sect(main, 'Filter', 'vh-se-filter');
    const frow = h('div', 'vh-se-row'); sf.append(frow);
    const fl = h('div', 'vh-se-col'); frow.append(fl);
    seg(fl, 'Filter type', [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass']], { get: () => model.filter.type, set: (v) => { model.filter.type = v; } });
    const fsl = h('div', 'vh-se-sliders'); fl.append(fsl);
    slider(fsl, 'Cutoff', { min: 30, max: 18000, log: true, get: () => model.filter.cutoff, set: (v) => { model.filter.cutoff = Math.round(v); }, fmt: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz') });
    slider(fsl, 'Resonance', { min: 0.5, max: 18, log: true, get: () => model.filter.q, set: (v) => { model.filter.q = +v.toFixed(2); }, fmt: (v) => v.toFixed(1) });
    slider(fsl, 'Env amount', { min: -4, max: 6, step: 0.05, get: () => model.filter.envAmt, set: (v) => { model.filter.envAmt = v; }, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' oct' });
    slider(fsl, 'Key tracking', { min: 0, max: 1, step: 0.01, get: () => model.filter.keyTrack, set: (v) => { model.filter.keyTrack = v; }, fmt: (v) => Math.round(v * 100) + ' %' });
    const fcv = canvas(frow, 'vh-se-fresp', 'Filter response at the sustain level');
    function drawFilter() {
      const { g, w, h: hh } = fit(fcv), fc = Y.sustainCutoff(model), lx = (f) => Math.log(f / 20) / Math.log(1000) * w, dbY = (db) => hh * (18 - db) / 60;
      g.clearRect(0, 0, w, hh);
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
      for (const f of [100, 1000, 10000]) { g.beginPath(); g.moveTo(lx(f), 0); g.lineTo(lx(f), hh); g.stroke(); }
      g.beginPath(); g.moveTo(0, dbY(0)); g.lineTo(w, dbY(0)); g.stroke();
      g.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const f = 20 * 1000 ** (x / w), m = Y.filterMag(model.filter, f, fc), db = 20 * Math.log10(Math.max(1e-6, m));
        const y = Math.max(0, Math.min(hh, dbY(db)));
        if (x) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = '#6fa3ff'; g.lineWidth = 2; g.stroke();
      g.lineTo(w, hh); g.lineTo(0, hh); g.closePath(); g.fillStyle = 'rgba(111,163,255,0.12)'; g.fill();
      g.fillStyle = '#7a8194'; g.font = '10px system-ui'; g.fillText('100', lx(100) + 2, hh - 3); g.fillText('1k', lx(1000) + 2, hh - 3); g.fillText('10k', lx(10000) + 2, hh - 3);
      g.fillStyle = '#9ff'; g.fillText((fc >= 1000 ? (fc / 1000).toFixed(1) + ' kHz' : Math.round(fc) + ' Hz') + ' (held)', 4, 11);
    }
    binds.push(drawFilter);

    // ---- envelopes: draggable ADSR ----
    const se = sect(main, 'Envelopes', 'vh-se-envs');
    const erow = h('div', 'vh-se-row'); se.append(erow);
    function adsr(label, key) {
      const col = h('div', 'vh-se-col vh-se-envbox'); col.append(h('div', 'vh-se-sub', ui.esc(label))); erow.append(col);
      const cv = canvas(col, 'vh-se-adsr', label + ' envelope: drag the points');
      const val = h('div', 'vh-se-envval'); col.append(val);
      const ZA = 0.3, ZD = 0.3, ZH = 0.12, ZR = 0.25, TMAX = 8;
      const tx = (t, z, w) => z * w * Math.sqrt(Math.min(TMAX, t) / TMAX), xt = (x, z, w) => TMAX * Math.max(0, Math.min(1, x / (z * w))) ** 2;
      const pts = (w, hh) => {
        const e = model[key], x1 = tx(e.a, ZA, w), x2 = x1 + tx(e.d, ZD, w), x3 = x2 + ZH * w, x4 = x3 + tx(e.r, ZR, w), top = 6, bot = hh - 4;
        return { x1, x2, x3, x4, top, bot, ys: bot - e.s * (bot - top) };
      };
      function draw() {
        const { g, w, h: hh } = fit(cv), p = pts(w, hh), e = model[key];
        g.clearRect(0, 0, w, hh);
        g.beginPath(); g.moveTo(0, p.bot); g.lineTo(p.x1, p.top); g.lineTo(p.x2, p.ys); g.lineTo(p.x3, p.ys); g.lineTo(p.x4, p.bot);
        g.strokeStyle = key === 'ampEnv' ? '#9ff' : '#c48bff'; g.lineWidth = 2; g.stroke();
        g.lineTo(0, p.bot); g.fillStyle = key === 'ampEnv' ? 'rgba(0,191,220,0.12)' : 'rgba(97,26,140,0.25)'; g.fill();
        g.fillStyle = '#fff';
        for (const [x, y] of [[p.x1, p.top], [p.x2, p.ys], [p.x4, p.bot]]) { g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.fill(); }
        const f = (t) => (t < 1 ? Math.round(t * 1000) + ' ms' : t.toFixed(2) + ' s');
        val.textContent = 'A ' + f(e.a) + ' · D ' + f(e.d) + ' · S ' + Math.round(e.s * 100) + ' % · R ' + f(e.r);
      }
      binds.push(draw);
      let drag = null;
      cv.addEventListener('pointerdown', (ev) => {
        const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, p = pts(r.width, r.height);
        const cands = [['a', p.x1, p.top], ['ds', p.x2, p.ys], ['r', p.x4, p.bot]].map(([k, px, py]) => [k, Math.hypot(px - x, py - y)]);
        cands.sort((u, v) => u[1] - v[1]);
        drag = cands[0][0]; cv.setPointerCapture(ev.pointerId); ev.preventDefault();
      });
      cv.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, p = pts(r.width, r.height), e = model[key];
        if (drag === 'a') e.a = Math.max(0.001, +xt(x, ZA, r.width).toPrecision(3));
        if (drag === 'ds') { e.d = Math.max(0.01, +xt(x - p.x1, ZD, r.width).toPrecision(3)); e.s = +Math.max(0, Math.min(1, (p.bot - y) / (p.bot - p.top))).toFixed(2); }
        if (drag === 'r') e.r = Math.max(0.01, +xt(x - p.x3, ZR, r.width).toPrecision(3));
        draw(); changed();
      });
      const up = () => { drag = null; };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    }
    adsr('Amp', 'ampEnv'); adsr('Filter', 'filtEnv');

    // ---- LFOs ----
    const sl = sect(main, 'LFOs', 'vh-se-lfos');
    model.lfos.forEach((_, i) => {
      const row = h('div', 'vh-se-lfo'); row.append(h('span', 'vh-se-sub', 'LFO ' + (i + 1))); sl.append(row);
      const L = () => model.lfos[i];
      selectBox(row, 'LFO ' + (i + 1) + ' target', Y.TARGETS.map((t) => [t, { pitch: '→ Pitch', cutoff: '→ Cutoff', amp: '→ Volume', pan: '→ Pan' }[t]]), { get: () => L().target, set: (v) => { L().target = v; } });
      selectBox(row, 'LFO ' + (i + 1) + ' shape', Y.SHAPES.map((t) => [t, { sine: '∿ Sine', triangle: '⋀ Triangle', square: '⊓ Square', sawtooth: '⩘ Saw' }[t]]), { get: () => L().shape, set: (v) => { L().shape = v; } });
      slider(row, 'Rate', { min: 0.05, max: 20, log: true, get: () => L().rate, set: (v) => { L().rate = +v.toPrecision(3); }, fmt: (v) => v.toFixed(v < 1 ? 2 : 1) + ' Hz' });
      slider(row, 'Depth', { min: 0, max: 1, step: 0.01, get: () => L().depth, set: (v) => { L().depth = v; }, fmt: (v) => Math.round(v * 100) + ' %' });
    });

    // ---- glide + gain ----
    const sg = sect(main, 'Output', 'vh-se-out');
    const gsl = h('div', 'vh-se-sliders'); sg.append(gsl);
    slider(gsl, 'Glide', { min: 0, max: 1, step: 0.005, get: () => model.glide, set: (v) => { model.glide = v; }, fmt: (v) => (v ? Math.round(v * 1000) + ' ms' : 'off') });
    slider(gsl, 'Gain', { min: 0, max: 2, step: 0.01, get: () => model.gain, set: (v) => { model.gain = v; }, fmt: (v) => (v > 0 ? (20 * Math.log10(v) >= 0 ? '+' : '') + (20 * Math.log10(v)).toFixed(1) + ' dB' : '−∞') });

    // ---- harmony preview (side) ----
    side.append(h('h3', '', 'Harmony preview'));
    const scv = canvas(side, 'vh-se-spec', 'Overtone spectrum');
    side.append(h('div', 'vh-se-hint', 'Overtones (held, at C4) · what the harmony maps use'));
    const mapBox = h('div', 'vh-se-mapbox'); side.append(mapBox);
    const mcv = canvas(mapBox, 'vh-se-map', 'Band map C3 to C6 against a C-major chord: click to hear');
    const legend = h('div', 'vh-se-maplegend', '<b>Bands vs. C major</b><span>bright = blends in<br>dark = clashes</span><span>Click to hear it with the chord.</span><span class="vh-se-keys">Keys <kbd>A</kbd>–<kbd>K</kbd> play C4–C5</span>');
    mapBox.append(legend);
    function drawSpec() {
      const { g, w, h: hh } = fit(scv), lo = Math.log2(0.24), hi = Math.log2(17), x = (r) => 8 + (w - 16) * (Math.log2(r) - lo) / (hi - lo);
      g.clearRect(0, 0, w, hh);
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.fillStyle = '#7a8194'; g.font = '9px system-ui'; g.textAlign = 'center';
      for (const r of [0.25, 0.5, 1, 2, 4, 8, 16]) { g.beginPath(); g.moveTo(x(r), 0); g.lineTo(x(r), hh - 11); g.stroke(); g.fillText(r < 1 ? '1/' + 1 / r : r, x(r), hh - 1); }
      for (const [r, a] of spec) {
        const bh = Math.sqrt(a) * (hh - 16);
        g.fillStyle = Math.abs(r - Math.round(r)) < 0.01 ? '#00bfdc' : '#c48bff';
        g.fillRect(x(r) - 2, hh - 12 - bh, 4, bh);
      }
    }
    const lerp = (a, b, t) => a + (b - a) * t;
    function colorOf(c) {   // navy -> violet -> cyan -> white (design ramp)
      const st = [[8, 10, 40], [97, 26, 140], [0, 191, 220], [255, 255, 255]], t = Math.max(0, Math.min(1, c)) * 3, i = Math.min(2, Math.floor(t)), f = t - i;
      return 'rgb(' + [0, 1, 2].map((k) => Math.round(lerp(st[i][k], st[i + 1][k], f))).join(',') + ')';
    }
    function drawMap() {
      const { g, w, h: hh } = fit(mcv), lab = 30, rh = hh / MAP_ROWS;
      g.clearRect(0, 0, w, hh);
      for (let i = 0; i < MAP_ROWS; i++) { g.fillStyle = colorOf(rows[i]); g.fillRect(lab, hh - (i + 1) * rh, w - lab, rh + 0.6); }
      g.font = '10px system-ui'; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let m = MAP_LO; m <= MAP_HI; m++) {
        const y = hh - (m - MAP_LO) / (MAP_HI - MAP_LO) * (hh - rh) - rh / 2, c = m % 12 === 0, tri = TRIAD.includes(m);
        g.fillStyle = tri ? '#9ff' : c ? '#d8dce6' : 'rgba(122,129,148,0.6)';
        if (c || tri) g.fillText(NAMES[m % 12] + (Math.floor(m / 12) - 1), lab - 4, y);
        g.fillRect(lab - (c ? 3 : 2), y, c ? 3 : 2, 1);
        if (tri) { g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(w - 6, y - 1, 6, 2); }
      }
    }
    // Recompute the analytic spectrum and the band map, then redraw (coalesced, ~30 ms after a change).
    function preview() {
      spec = Y.spectrum(model);
      rows = bandRows(spec);
      syncAll(); drawSpec(); drawMap();
      api.updates++;
    }
    const mapPitch = (ev) => { const r = mcv.getBoundingClientRect(); return MAP_LO + (MAP_HI - MAP_LO) * Math.max(0, Math.min(1, (r.bottom - ev.clientY) / r.height)); };
    mcv.addEventListener('pointerdown', (ev) => {
      if (!VH.audio.ensure()) return;
      const m = Math.round(mapPitch(ev) * 4) / 4, s = sound();
      for (const t of TRIAD) VH.audio.trigger(s, hz(t), 1.1, { gain: 0.12 });
      VH.audio.trigger(s, hz(m), 1.1, { gain: 0.22 });
      api.auditions++;
    });

    // ---------- model plumbing ----------
    function syncAll() { binds.forEach((f) => f()); }
    function changed() {
      later('prev', 30, preview);
      later('loud', 350, measureLoud);
      if (editId) later('live', 450, commitLive);
    }
    function setModel(m) { model = Y.normalize(m); pad(); if (model.oscs[tab].level <= 0) tab = 0; syncAll(); changed(); }
    const lean = () => { const m = Y.normalize(model); m.oscs = m.oscs.filter((x, i) => i === 0 || x.level > 0); m.lfos = m.lfos.filter((l) => l.depth > 0); return m; };
    const key = () => JSON.stringify(lean());
    const sound = () => Y.toSound(lean(), { id: editId || 'synthed-preview', name, loud: loud || undefined });
    function measureLoud() {
      const k = key(), s = Y.toSound(lean(), { id: 'synthed-measure', name });
      return VH.sounds.measure(s).then((r) => { if (r && k === key()) { loud = r.loud; loudFor = k; } return r; });
    }
    function ensureLoud() { return loudFor === key() ? Promise.resolve() : measureLoud(); }
    function commitLive() {
      if (!editId || !VH.sounds.get(editId)) return Promise.resolve(null);
      return ensureLoud().then(() => VH.sounds.save(Y.toSound(lean(), { id: editId, name, loud })));
    }

    // ---------- audition: computer keys ----------
    const held = new Map();
    const typing = (t) => t && (t.tagName === 'INPUT' && t.type === 'text' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    function onKeyDown(e) {
      if (!D.back.isConnected || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const k = KEYS.indexOf(String(e.key).toLowerCase());
      if (k < 0 || e.key.length !== 1) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat || held.has(k)) return;
      if (!VH.audio.ensure()) return;
      held.set(k, VH.audio.voice(sound(), hz(60 + k)));
      api.auditions++;
    }
    function onKeyUp(e) {
      const k = KEYS.indexOf(String(e.key).toLowerCase());
      if (k < 0 || !held.has(k)) return;
      e.stopImmediatePropagation();
      held.get(k).stop(); held.delete(k);
    }
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('keyup', onKeyUp, true);
    D.box.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });   // keep experiment shortcuts quiet
    const onResize = () => later('prev', 30, preview);
    root.addEventListener('resize', onResize);

    // ---------- footer ----------
    const status = h('span', 'vh-se-status'); D.foot.append(status);
    const btn = (label, fn, cls) => { const b = h('button', 'vh-btn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); D.foot.append(b); return b; };
    if (editId) {
      btn('Revert', () => { VH.sounds.save(orig); setModel(orig.synth); setName(orig.name); loud = orig.loud; loudFor = key(); clearTimeout(timers.live); status.textContent = 'Reverted.'; });
      btn('Done', () => { api.save().then(() => D.close()); }, 'vh-se-save');
      status.textContent = 'Changes apply live to every song using it.';
    } else {
      btn('Cancel', () => D.close());
      btn('Save as instrument', () => { api.save().then(() => D.close()); }, 'vh-se-save');
    }

    D.onClose = () => {
      Object.values(timers).forEach(clearTimeout);
      if (editId && timers.live) commitLive();   // flush a pending live change
      held.forEach((v) => v.stop(0.05)); held.clear();
      root.removeEventListener('keydown', onKeyDown, true); root.removeEventListener('keyup', onKeyUp, true);
      root.removeEventListener('resize', onResize);
      if (current === api) current = null;
      if (o.onClose) o.onClose();
    };

    const api = {
      el: D.box, dialog: D, editId, updates: 0, auditions: 0,
      get model() { return lean(); }, get name() { return name; }, get spectrum() { return spec; }, get rows() { return rows; },
      get loud() { return loud; },
      brightRows: (th = BRIGHT) => rows.reduce((n, c) => n + (c > th ? 1 : 0), 0),
      setModel, setName, sound, preview,
      set(path, v) {   // e.g. set('filter.cutoff', 400), set('oscs.0.wave', 'square')
        const ks = path.split('.'), last = ks.pop(); let t = model;
        for (const k of ks) t = t[k];
        t[last] = v; syncAll(); changed();
      },
      tab(i) { tab = i; syncAll(); },
      loadPreset(id) { setModel(Y.preset(id)); const p = Y.PRESETS.find((x) => x.id === id); if (p && !editId) setName(p.name); },
      randomize(rng) { setModel(Y.randomize(rng)); rndN++; if (!editId) setName('Random ' + rndN); },
      // Measure loudness, save as an instrument (source 'custom'), call onSave. Resolves to the saved sound.
      save() {
        if (saving) return Promise.resolve(null);
        saving = true; status.textContent = 'Saving…';
        clearTimeout(timers.live);
        return ensureLoud().then(() => {
          const s = VH.sounds.save(Y.toSound(lean(), { id: editId || undefined, name, loud, source: 'custom' }));
          status.textContent = 'Saved “' + s.name + '”.'; saving = false;
          if (o.onSave) o.onSave(s);
          return s;
        }, (err) => { saving = false; status.textContent = 'Could not save.'; throw err; });
      },
      close() { D.close(); },
    };
    current = api;
    syncAll();
    preview();
    if (!loud) measureLoud();
    else loudFor = key();
    // the first layout pass may not have sized the canvases yet
    root.requestAnimationFrame(() => { if (D.back.isConnected) { syncAll(); preview(); } });
    return api;
  }

  VH.synthEditor = { open, bandRows, MAP_LO, MAP_HI, MAP_ROWS, BRIGHT, get current() { return current; }, get isOpen() { return !!current; } };
})(this);
