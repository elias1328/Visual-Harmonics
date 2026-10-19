// spiral.js - play the pitch spiral; overtones of different notes that line up glow.
// Chords, latch, arpeggio and a harmony meter. Overtones come from the selected instrument's spectrum.
(function () {
  'use strict';
  const VH = window.VH, H = VH.harmony, ui = VH.ui;
  const C2 = H.midiToHz(36), C7 = H.midiToHz(96), TURNS = 5, TOL = 12, MAXPTR = 6, VG = 0.25;   // VG: voice gain (sounds are loudness-matched; level matched to Melody/Babel)
  VH.spiralGain = VG;
  const FADE = 200, TRAIL = 420, FLOOR = 0.3;
  const KEYS = 'awsedftgyhujk';   // C4 … C5
  const DEF_CUSTOM = { n: 12, stretch: 1, roll: 0.88 };
  const CHORDS = [['single', 'Single', [0]], ['maj', 'Maj', [0, 4, 7]], ['min', 'Min', [0, 3, 7]],
    ['7', '7', [0, 4, 7, 10]], ['sus4', 'Sus4', [0, 5, 7]], ['dim', 'Dim', [0, 3, 6]]];
  const PATTERNS = [['up', 'Up'], ['down', 'Down'], ['updown', 'Up-down']];
  // Reference set for the meter's display curve: the 12 dyads (m2 … octave) plus common triads / tetrads.
  const REFS = [...Array.from({ length: 12 }, (_, i) => ['dyad ' + (i + 1), [0, i + 1]]),
    ['maj', [0, 4, 7]], ['min', [0, 3, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['sus4', [0, 5, 7]], ['7', [0, 4, 7, 10]]];
  const METER_STOPS = [[0, [97, 26, 140]], [0.55, [0, 191, 220]], [1, [235, 255, 255]]];
  const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const pcOf = (f) => ((Math.round(hzToMidi(f)) % 12) + 12) % 12;
  const hueOf = (f) => pcOf(f) * 30;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  function meterColor(c) {
    for (let i = 1; i < METER_STOPS.length; i++) {
      const [p0, a] = METER_STOPS[i - 1], [p1, b] = METER_STOPS[i];
      if (c <= p1) { const t = clamp01((c - p0) / (p1 - p0)); return a.map((x, k) => Math.round(x + (b[k] - x) * t)); }
    }
    return METER_STOPS[METER_STOPS.length - 1][1];
  }
  // Melody's chord qualities (same ids, suffixes and intervals as js/exp/melody/model.js QUALS; song.chords = [rootPc, quality]).
  const QUALS = [['maj', '', [0, 4, 7]], ['min', 'm', [0, 3, 7]], ['dim', 'dim', [0, 3, 6]], ['aug', 'aug', [0, 4, 8]],
    ['sus2', 'sus2', [0, 2, 7]], ['sus4', 'sus4', [0, 5, 7]], ['7', '7', [0, 4, 7, 10]], ['maj7', 'maj7', [0, 4, 7, 11]], ['m7', 'm7', [0, 3, 7, 10]]];
  const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Name the chord a set of MIDI notes forms (octaves and doublings ignored): { root: 0..11, quality, name } or null.
  // The lowest note wins as root when several readings fit (aug is symmetric; Csus2 = Gsus4).
  function identifyChord(midis) {
    const ms = (midis || []).filter((m) => typeof m === 'number' && isFinite(m)).map((m) => Math.round(m)).sort((a, b) => a - b);
    if (ms.length < 2) return null;
    const pcs = [...new Set(ms.map((m) => ((m % 12) + 12) % 12))];
    if (pcs.length < 3) return null;
    const bass = ((ms[0] % 12) + 12) % 12, roots = [bass, ...pcs.filter((p) => p !== bass)], key = pcs.slice().sort((a, b) => a - b).join();
    for (const r of roots) for (const [q, suf, iv] of QUALS) {
      if (iv.length === pcs.length && iv.map((i) => (r + i) % 12).sort((a, b) => a - b).join() === key) return { root: r, quality: q, name: PC_NAMES[r] + suf };
    }
    return null;
  }
  // Cross-experiment inbox (Melody consumes it): append, never overwrite.
  function sendToMelody(items) {
    const cur = VH.store.get('melody.inbox', []);
    VH.store.set('melody.inbox', (Array.isArray(cur) ? cur : []).concat(items));
    location.hash = '#melody';
  }
  // keys format (VH.ui.shortcuts): '+' joins a combo, ' / ' separates alternatives.
  const SHORTCUTS = [
    { keys: 'A W S E D F T G Y H U J K', label: 'Play C4 … C5 (hold)' },
    { keys: '1 … 6', label: 'Chord: Single, Maj, Min, 7, Sus4, Dim' },
    { keys: 'Shift+Click', label: 'Hold a note or chord (click it again to release)' },
    { keys: 'Drag', label: 'Play and bend; several fingers play several notes' },
    { keys: 'Esc', label: 'Close the chord picker or Settings' },
  ];
  if (ui.shortcuts && typeof ui.shortcuts.register === 'function') ui.shortcuts.register('spiral', SHORTCUTS);
  let inst = null;

  function create(el) {
    const P = Object.assign({ snap: true, latch: false, chord: 'single', rate: 6, pat: 'up', ov: 'all', keys: false },
      VH.store.get('spiral.prefs', {}));
    const save = () => VH.store.set('spiral.prefs', { snap: P.snap, latch: P.latch, chord: P.chord, rate: P.rate, pat: P.pat, ov: P.ov, keys: P.keys });
    let soundOn = true, arp = false, raf = 0, last = 0, psVer = 0, seq = 0;
    let soundId = VH.store.get('spiral.sound', 'string');
    let sound = VH.sounds.get(soundId) || VH.sounds.get('string');
    let PS = VH.sounds.spectrumOf(sound);
    const cleanups = [];
    const partials = (f) => PS.map(([r, a], i) => ({ f: f * r, a, i, k: Math.abs(r - 1) < 1e-3 ? 0 : i + 1 }));
    el.classList.add('sp');

    // ---------- layout + dock ----------
    const { box, caption, dock } = ui.layout(el);
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    const bg = document.createElement('canvas'), bctx = bg.getContext('2d');
    cv.style.cursor = 'crosshair'; cv.setAttribute('aria-label', 'Pitch spiral instrument');
    box.append(cv);
    // Unified picker, same groups as Melody's line instrument (Synths / Instruments / Your sounds / Local, glide vs notes).
    const picker = ui.soundPicker(dock, { title: 'Instrument', value: sound.id, mode: 'line', onChange: (id) => selectSound(id) });
    cleanups.push(picker.destroy);
    const chordBtn = ui.dockButton(dock, { icon: '△', label: 'Single', title: 'Chord: what one click places (1–6)', pressed: false,
      onClick: () => togglePop() });
    chordBtn.setAttribute('aria-haspopup', 'true'); chordBtn.setAttribute('aria-expanded', 'false');
    const latchBtn = ui.dockButton(dock, { icon: '⚲', label: 'Latch', title: 'Hold notes after release (or Shift+click)', pressed: P.latch,
      onClick: () => { P.latch = !P.latch; showLatch(); save(); } });
    latchBtn.classList.add('sp-latch');
    const latchNote = ui.h('div', 'sp-latchnote', 'Latch on: notes hold'); latchNote.setAttribute('role', 'status');
    el.append(latchNote);
    function showLatch() { latchBtn.set({ label: P.latch ? 'Latch on' : 'Latch', pressed: P.latch }); latchNote.hidden = !P.latch; }
    showLatch();
    const arpBtn = ui.dockButton(dock, { icon: '⋰', label: 'Arpeggio', title: 'Play held notes one after another', pressed: false,
      onClick: () => setArp(!arp) });
    ui.dockButton(dock, { icon: '⌫', label: 'Clear', title: 'Release all notes',
      onClick: () => { [...voices.keys()].forEach(removeVoice); ptrs.clear(); changed(); } });
    const dr = ui.drawer(el, dock, { title: 'Spiral' });

    // "→ Melody": appears while two or more notes sound; sends the named chord (and optionally this instrument).
    const sendBox = ui.h('div', 'sp-send');
    sendBox.setAttribute('role', 'group'); sendBox.setAttribute('aria-label', 'Send to Melody'); sendBox.hidden = true;
    sendBox.innerHTML = '<button type="button" class="sp-send-btn">→ Melody</button>' +
      '<label class="sp-send-inst"><input type="checkbox"> also use this instrument</label>';
    const sendBtn = sendBox.firstChild, sendInst = sendBox.querySelector('input');
    let sendChord = null, sendKey = '';
    sendBtn.addEventListener('click', () => {
      if (!sendChord) return;
      const items = [{ type: 'chord', chord: [sendChord.root, sendChord.quality] }];
      if (sendInst.checked) items.push({ type: 'sound', soundId });
      sendToMelody(items);
    });
    el.append(sendBox);
    function updateSend(vs) {
      const ms = vs.map((v) => hzToMidi(v.f)), key = ms.map((m) => Math.round(m)).sort((a, b) => a - b).join();
      if (key === sendKey) return;
      sendKey = key;
      sendBox.hidden = vs.length < 2; el.classList.toggle('sp-sending', !sendBox.hidden);
      sendChord = identifyChord(ms);
      sendBtn.setAttribute('aria-disabled', String(!sendChord));
      sendBtn.textContent = sendChord ? '→ Melody · ' + sendChord.name : '→ Melody';
      sendBtn.title = sendChord ? 'Add ' + sendChord.name + ' to Melody’s chords' : 'Not a chord Melody knows';
    }

    // chord popover (six buttons above the dock)
    const pop = ui.h('div', 'sp-pop');
    pop.setAttribute('role', 'group'); pop.setAttribute('aria-label', 'Chord'); pop.hidden = true;
    const chordBtns = CHORDS.map(([id, name, iv], i) => {
      const b = ui.h('button', 'sp-chip'); b.type = 'button'; b.dataset.chord = id;
      b.innerHTML = '<b></b><small></small>';
      b.firstChild.textContent = name; b.lastChild.textContent = iv.length > 1 ? iv.length + ' notes' : 'one note';
      b.title = name + ' (' + (i + 1) + ')';
      b.addEventListener('click', () => { setChord(id); togglePop(false); chordBtn.focus(); });
      pop.append(b);
      return b;
    });
    el.append(pop);
    function togglePop(open) {
      open = open == null ? pop.hidden : open;
      pop.hidden = !open; chordBtn.setAttribute('aria-expanded', String(open));
      if (open) { const b = chordBtns.find((x) => x.dataset.chord === P.chord); if (b) b.focus(); }
    }
    el.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !chordBtn.contains(e.target)) togglePop(false); });
    function setChord(id) {
      if (!CHORDS.some((c) => c[0] === id)) id = 'single';
      P.chord = id; save();
      const c = CHORDS.find((x) => x[0] === id);
      chordBtn.set({ label: c[1], pressed: id !== 'single' });
      chordBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chord === id)));
    }
    setChord(P.chord);
    const chordIv = () => CHORDS.find((c) => c[0] === P.chord)[2];

    // ---------- drawer ----------
    const sPlay = ui.section(dr.body, 'Play');
    const r1 = ui.h('div', 'vh-row'); sPlay.append(r1);
    const snapB = ui.button(r1, { label: 'Snap to notes', pressed: P.snap, onClick: () => { P.snap = !P.snap; snapB.set({ pressed: P.snap }); save(); } });
    ui.slider(sPlay, { label: 'Arpeggio rate', min: 2, max: 16, step: 1, value: P.rate, fmt: (v) => v + ' notes/s',
      onInput: (v) => { P.rate = v; save(); } });
    const r2 = ui.h('div', 'vh-row'); sPlay.append(r2);
    const patB = PATTERNS.map(([id, name]) => ui.button(r2, { label: name, pressed: P.pat === id,
      onClick: () => { P.pat = id; save(); patB.forEach((b, i) => b.set({ pressed: PATTERNS[i][0] === id })); } }));
    const sView = ui.section(dr.body, 'View');
    const r3 = ui.h('div', 'vh-row'); sView.append(ui.h('div', 'vh-desc', 'Overtones'), r3);
    const ovB = [['all', 'All'], ['shared', 'Shared only']].map(([id, name]) => ui.button(r3, { label: name, pressed: P.ov === id,
      onClick: () => { P.ov = id; save(); ovB.forEach((b, i) => b.set({ pressed: (i ? 'shared' : 'all') === id })); changed(); } }));
    const r4 = ui.h('div', 'vh-row'); sView.append(r4);
    const keyB = ui.button(r4, { label: 'Show computer keys', pressed: P.keys,
      onClick: () => { P.keys = !P.keys; keyB.set({ pressed: P.keys }); save(); drawBg(); changed(); } });
    const sInfo = ui.section(dr.body, 'What you hear');
    const sharedEl = ui.h('div', 'sp-shared', 'shared overtones: 0');
    const infoEl = ui.h('div', 'vh-mono');
    sInfo.append(sharedEl, infoEl);
    const r5 = ui.h('div', 'vh-row'); sInfo.append(r5);
    const sBtn = ui.button(r5, { label: 'Sound on', pressed: true, onClick: () => {
      soundOn = !soundOn; sBtn.set({ label: soundOn ? 'Sound on' : 'Sound off', pressed: soundOn });
      if (soundOn) VH.audio.ensure();
      rebuildTones();
    } });
    const sCustom = ui.section(dr.body, 'Custom sound');
    sCustom.append(ui.h('div', 'vh-desc', 'Shape your own tone. Moving a slider switches the instrument to “Custom”.'));
    const cs = VH.sounds.get('custom'), C = Object.assign({}, DEF_CUSTOM, cs && cs.params);
    let baseId = soundId && soundId !== 'custom' ? soundId : 'string';
    const sl = {};
    function baseParams() {   // the selected instrument's own values, read from its spectrum
      const b = VH.sounds.get(baseId), sp = b && VH.sounds.spectrumOf(b);
      if (!sp || !sp.length) return Object.assign({}, DEF_CUSTOM);
      const n = Math.max(1, Math.min(16, sp.length)), last = sp[sp.length - 1][1];
      const roll = n > 1 && last > 0 ? Math.max(0.3, Math.min(1, Math.pow(last, 1 / (n - 1)))) : DEF_CUSTOM.roll;
      return { n, stretch: 1, roll: Math.round(roll * 100) / 100 };
    }
    function resetCustom(only) {
      const d = baseParams();
      for (const k of only ? [only] : ['n', 'stretch', 'roll']) { C[k] = d[k]; sl[k].set(d[k]); }
      VH.sounds.save(VH.sounds.custom(C)); if (soundId !== 'custom') selectSound('custom'); picker.set('custom');
    }
    const editCustom = (k, v) => { C[k] = v; VH.sounds.save(VH.sounds.custom(C)); if (soundId !== 'custom') selectSound('custom'); picker.set('custom'); };
    sl.n = ui.slider(sCustom, { label: 'Overtones', min: 1, max: 16, step: 1, value: C.n, desc: 'how many overtones each note has', onInput: (v) => editCustom('n', v) });
    sl.stretch = ui.slider(sCustom, { label: 'Stretch', min: 0.9, max: 1.1, step: 0.001, value: C.stretch, fmt: (v) => 'k^' + v.toFixed(3),
      desc: 'bends overtones away from perfect ×2, ×3, ×4…', onInput: (v) => editCustom('stretch', v) });
    sl.roll = ui.slider(sCustom, { label: 'Brightness', min: 0.3, max: 1, step: 0.01, value: C.roll, fmt: (v) => v.toFixed(2),
      desc: 'how loud the higher overtones are', onInput: (v) => editCustom('roll', v) });
    const rs = ui.h('button', 'sp-reset', '↺'); rs.type = 'button'; rs.title = 'Reset stretch to 1.000'; rs.setAttribute('aria-label', 'Reset stretch');
    rs.addEventListener('click', () => resetCustom('stretch'));
    sl.stretch.input.parentNode.querySelector('.n').append(rs);
    const rr = ui.h('div', 'vh-row'); sCustom.append(rr);
    ui.button(rr, { label: 'Reset', onClick: () => resetCustom() }).title = 'Restore the instrument’s original Overtones, Stretch and Brightness';
    ui.samplesNote(dr.body);
    ui.section(dr.body, 'How to play').append(ui.h('div', 'vh-desc',
      'Drag on the spiral to play (multi-touch works). Pick a chord to place a whole chord with one click; it sounds while you hold. ' +
      'With a chord sounding, → Melody adds it to Melody’s chords (tick “also use this instrument” to send the sound too). ' +
      'Latch or Shift+click holds notes (or whole chords) until you click them again. Keys A W S E D F T G Y H U J K play C4…C5, 1–6 pick a chord. ' +
      'Glowing rings = overtones of different notes within 12 cents of each other. The ring in the middle shows how consonant the notes are for this sound.'));

    // ---------- sounds ----------
    function selectSound(id) {
      const s = VH.sounds.get(id);
      if (!s) return;
      soundId = id; sound = s; if (id !== 'custom') baseId = id; VH.store.set('spiral.sound', id);
      PS = VH.sounds.spectrumOf(s); psVer++;
      rebuildTones(); changed();
      if (s.kind === 'sampler') VH.sounds.prepare(id).then(refresh).catch(() => {});
    }
    function refresh() {
      if (!inst) return;
      picker.refresh(); picker.set(soundId);
      const s = VH.sounds.get(soundId);
      if (!s) { selectSound('string'); picker.set('string'); return; }
      const sp = VH.sounds.spectrumOf(s);
      if (s !== sound || JSON.stringify(sp) !== JSON.stringify(PS)) { sound = s; PS = sp; psVer++; changed(); }
    }
    cleanups.push(VH.sounds.onChange(refresh));

    // Visual loudness envelope of a sample zone: sqrt(RMS / peak) per 20 ms hop.
    const envs = new Map();
    function zoneOf(f) {
      const zs = (sound.sampler && sound.sampler.zones) || [], m = hzToMidi(f);
      return zs.reduce((b, z) => (!b || Math.abs(z.rootMidi - m) < Math.abs(b.rootMidi - m) ? z : b), null);
    }
    function envOf(zone) {
      if (envs.has(zone)) return envs.get(zone);
      envs.set(zone, null);
      const make = (buf) => {
        const d = buf.getChannelData(0), hop = Math.max(1, Math.round(buf.sampleRate * 0.02)), n = Math.ceil(d.length / hop);
        const e = new Float32Array(n);
        let peak = 1e-9;
        for (let i = 0; i < n; i++) {
          let s = 0, c = 0;
          for (let j = i * hop; j < Math.min(d.length, (i + 1) * hop); j++) { s += d[j] * d[j]; c++; }
          e[i] = Math.sqrt(s / Math.max(1, c)); peak = Math.max(peak, e[i]);
        }
        for (let i = 0; i < n; i++) e[i] = Math.sqrt(e[i] / peak);
        envs.set(zone, { env: e, hop: hop / buf.sampleRate, dur: d.length / buf.sampleRate });
      };
      const p = VH.audio.load(zone);
      if (p.buffer) make(p.buffer); else p.then(make).catch(() => {});
      return envs.get(zone);
    }
    // 0..1 visual level of a voice t seconds after it was struck.
    function envAt(v, t) {
      if (sound.kind === 'sampler') {
        const z = zoneOf(v.f), e = z && envOf(z);
        if (!e) return 1;
        const i = Math.floor(t * (v.f / H.midiToHz(z.rootMidi)) / e.hop);
        return i < e.env.length ? e.env[i] : 0;
      }
      const s = sound.synth || {}, A = Math.max(0.002, s.attack ?? 0.01), D = Math.max(0.01, s.decay ?? 0.3);
      if (t < A) return t / A;
      return (s.sustain ?? 0.8) > 0 ? 1 : Math.pow(clamp01(1 - (t - A) / D), 1.5);
    }
    function ampOf(v, now) {
      const t = (now - v.t0) / 1000;
      let a = envAt(v, t);
      if (arp && v.latched) {   // one-shot: hold for the step, then release
        const d = 0.9 / P.rate, rel = sound.kind === 'sampler' ? ((sound.sampler || {}).release ?? 0.3) : ((sound.synth || {}).release ?? 0.2);
        if (v.t0 === 0) a = 0; else if (t > d) a *= clamp01(1 - (t - d) / Math.max(0.05, rel));
      }
      return a;
    }

    // ---------- voices ----------
    const voices = new Map();   // id -> { id, f, group, latched, tone, t0, vis, amp, alive, trail }
    const fading = new Set();
    const ptrs = new Map();     // pointerId -> { group, latch }
    const sustains = (v) => !(arp && v.latched);
    const makeTone = (v) => (soundOn && VH.audio.ctx && sustains(v) ? VH.audio.voice(sound, v.f, { gain: VG }) : null);
    const quant = (f) => (P.snap ? H.midiToHz(Math.round(hzToMidi(f))) : f);
    function addVoice(id, f, group, latched) {
      const v = { id, f, group, latched, tone: null, t0: performance.now(), vis: 0, amp: 1, alive: true, trail: [] };
      v.tone = makeTone(v);
      voices.set(id, v); changed();
      return v;
    }
    function setVoice(v, f, rawF) {
      v.trail.push({ f: rawF, t: performance.now() });
      if (Math.abs(v.f - f) < 1e-6) { changed(); return; }
      v.f = f; if (v.tone) v.tone.setFreq(f, 0.045);
      changed();
    }
    function removeVoice(id) {
      const v = voices.get(id);
      if (!v) return;
      if (v.tone) v.tone.stop(sound.kind === 'sampler' ? 0.25 : 0.15);
      v.tone = null; v.alive = false;
      voices.delete(id); fading.add(v);
      changed();
    }
    const groupVoices = (g) => [...voices.values()].filter((v) => v.group === g);
    function rebuildTones() {
      const now = performance.now();
      voices.forEach((v) => { if (v.tone) v.tone.stop(0.1); v.tone = makeTone(v); if (v.tone) v.t0 = now; });
    }
    const chordFreqs = (root) => chordIv().map((s) => root * 2 ** (s / 12)).filter((f) => f <= C7 * 1.001);
    function placeGroup(g, root, latched) {
      chordFreqs(root).forEach((f, k) => addVoice(g + ':' + k, f, g, latched));
    }
    function latchGroup(g) {   // a held chord becomes latched (renamed), dropping duplicates of held notes
      const ng = 'L' + (++seq);
      for (const v of groupVoices(g)) {
        const dup = [...voices.values()].some((o) => o.latched && Math.abs(1200 * Math.log2(o.f / v.f)) < 1);
        if (dup) { removeVoice(v.id); continue; }
        voices.delete(v.id);
        v.id = ng + v.id.slice(v.id.indexOf(':')); v.group = ng; v.latched = true;
        if (!sustains(v) && v.tone) { v.tone.stop(); v.tone = null; }
        voices.set(v.id, v);
      }
      changed();
    }
    function setArp(on) {
      arp = on; arpBtn.set({ pressed: on });
      clearInterval(arpTimer); arpTimer = 0; arpCur = null; arpStep = 0;
      const now = performance.now();
      voices.forEach((v) => {
        if (!v.latched) return;
        if (v.tone) { v.tone.stop(); v.tone = null; }
        v.t0 = on ? 0 : now; v.tone = makeTone(v);
      });
      if (on) { arpNext = now; arpTimer = setInterval(arpTick, 4); arpTick(); }
      changed();
    }
    let arpTimer = 0, arpNext = 0, arpStep = 0, arpCur = null;
    const arpLog = [];
    function arpOrder(n) {
      const up = Array.from({ length: n }, (_, i) => i);
      if (P.pat === 'down') return up.reverse();
      if (P.pat === 'updown') return n > 2 ? up.concat(up.slice(1, -1).reverse()) : up;
      return up;
    }
    function arpTick() {
      const now = performance.now();
      if (now < arpNext) return;
      const period = 1000 / P.rate;
      arpNext = now - arpNext > period ? now + period : arpNext + period;
      const notes = [...voices.values()].filter((v) => v.latched).sort((a, b) => a.f - b.f);
      if (!notes.length) { arpCur = null; return; }
      const order = arpOrder(notes.length), v = notes[order[arpStep++ % order.length]];
      v.t0 = now; arpCur = v;
      if (soundOn && VH.audio.ctx) VH.audio.trigger(sound, v.f, 0.9 / P.rate, { gain: VG });
      arpLog.push([Math.round(now), Math.round(hzToMidi(v.f) * 100) / 100]);
      if (arpLog.length > 64) arpLog.shift();
      changed();
    }

    // ---------- geometry ----------
    let S = 600;
    cleanups.push(ui.fit(box, (w, h) => {
      S = Math.max(220, Math.min(900, w, h));
      cv.width = cv.height = bg.width = bg.height = Math.round(S * ui.dpr()); cv.style.width = cv.style.height = S + 'px';
      drawBg(); changed();
    }));
    function geom() { const R = S / 2 - (P.keys ? 38 : 26), r0 = R * 0.13; return { cx: S / 2, cy: S / 2, R, r0, per: (R - r0) / TURNS }; }
    function pos(f) {
      const g = geom(), o = Math.log2(f / C2), a = 2 * Math.PI * o, rad = g.r0 + o * g.per;
      return [g.cx + rad * Math.sin(a), g.cy - rad * Math.cos(a)];
    }
    const inRange = (f) => f >= C2 * 0.999 && f <= C7 * 1.001;
    function rawAt(px, py) {   // angle -> place in octave, radius -> nearest turn
      const g = geom(), dx = px - g.cx, dy = py - g.cy;
      const frac = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1, oEst = (Math.hypot(dx, dy) - g.r0) / g.per;
      return C2 * 2 ** Math.max(0, Math.min(TURNS, Math.round(oEst - frac) + frac));
    }

    // ---------- input ----------
    const xy = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * S / r.width, (e.clientY - r.top) * S / r.height]; };
    cv.addEventListener('pointerdown', (e) => {
      VH.audio.ensure();
      e.preventDefault();
      const [px, py] = xy(e), latch = e.shiftKey || P.latch;
      if (latch) {
        let hit = null, best = 16;
        for (const v of voices.values()) {
          if (!v.latched) continue;
          const [x, y] = pos(v.f), d = Math.hypot(x - px, y - py);
          if (d < best) { best = d; hit = v; }
        }
        if (hit) { groupVoices(hit.group).forEach((v) => removeVoice(v.id)); return; }
      }
      if (ptrs.size >= MAXPTR) return;
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const g = 'p' + e.pointerId, raw = rawAt(px, py);
      groupVoices(g).forEach((v) => removeVoice(v.id));
      ptrs.set(e.pointerId, { group: g, latch });
      placeGroup(g, quant(raw), false);
      groupVoices(g).forEach((v, k) => v.trail.push({ f: raw * 2 ** (chordIv()[k] / 12), t: performance.now() }));
    });
    cv.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const raw = rawAt(...xy(e)), root = quant(raw), iv = chordIv();
      groupVoices(p.group).forEach((v) => { const k = +v.id.slice(v.id.indexOf(':') + 1); setVoice(v, root * 2 ** (iv[k] / 12), raw * 2 ** (iv[k] / 12)); });
    });
    const onUp = (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      ptrs.delete(e.pointerId);
      if (p.latch && e.type === 'pointerup') latchGroup(p.group);
      else groupVoices(p.group).forEach((v) => removeVoice(v.id));
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) cv.addEventListener(t, onUp);
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target && /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox')) return;
      if (e.key === 'Escape' && !pop.hidden) { togglePop(false); return; }
      if (e.repeat || e.key.length !== 1) return;
      const n = '123456'.indexOf(e.key);
      if (n >= 0) { setChord(CHORDS[n][0]); return; }
      const i = KEYS.indexOf(e.key.toLowerCase());
      if (i < 0) return;
      VH.audio.ensure();
      e.preventDefault();
      const g = 'k' + i;
      if (P.latch) { placeGroup(g, H.midiToHz(60 + i), false); latchGroup(g); return; }
      if (!groupVoices(g).length) placeGroup(g, H.midiToHz(60 + i), false);
    };
    const onKeyUp = (e) => { const i = KEYS.indexOf(e.key.toLowerCase()); if (i >= 0 && e.key.length === 1) groupVoices('k' + i).forEach((v) => removeVoice(v.id)); };
    const onBlur = () => {
      voices.forEach((v) => { if (!v.latched && v.group[0] === 'k') removeVoice(v.id); });
      for (const [pid, p] of [...ptrs]) { ptrs.delete(pid); groupVoices(p.group).forEach((v) => removeVoice(v.id)); }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    cleanups.push(() => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); });

    // ---------- harmony ----------
    // Consonance 0..1 for this sound: each pair's dissonance placed between an octave (1) and the
    // roughest small interval (0) at the same register, then averaged.
    let cKey = '', cVal = null;
    function consonance(fs) {
      const u = [];
      for (const f of fs.slice().sort((a, b) => a - b)) if (!u.length || 1200 * Math.log2(f / u[u.length - 1]) > 1) u.push(f);
      if (u.length < 2) return null;
      const key = psVer + '|' + u.map((f) => f.toFixed(2)).join(',');
      if (key === cKey) return cVal;
      const raw = rawCons(u), c = raw.c;
      cKey = key; cVal = { c: displayOf(c), raw: c, dis: raw.dis };
      return cVal;
    }
    function rawCons(u) {
      let d = 0, lo = 0, hi = 0;
      for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
        const a = u[i];
        d += H.dissonanceSpectra([a, u[j]], PS); lo += H.dissonanceSpectra([a, a * 2], PS);
        let w = 0;
        for (const c of [0.5, 1, 1.5, 2, 3]) w = Math.max(w, H.dissonanceSpectra([a, a * 2 ** (c / 12)], PS));
        hi += w;
      }
      return { c: hi > lo ? clamp01(1 - (d - lo) / (hi - lo)) : 1, dis: d };
    }
    // Display curve (display only): the raw consonance's percentile rank among the reference chords played on
    // this sound at C4, linearly interpolated between neighbours. Raw values stay in the tooltip and drawer.
    let calVer = -1, cal = null;
    function calib() {
      if (calVer === psVer && cal) return cal;
      const r = H.midiToHz(60);
      const refs = REFS.map(([name, iv]) => ({ name, c: rawCons(iv.map((s) => r * 2 ** (s / 12))).c }));
      cal = { refs, sorted: refs.map((x) => x.c).sort((a, b) => a - b) }; calVer = psVer;
      return cal;
    }
    function displayOf(c) {
      const v = calib().sorted, n = v.length;
      if (c <= v[0]) return v[0] > 0 ? 0.04 * c / v[0] : 0;
      if (c >= v[n - 1]) return v[n - 1] < 1 ? 0.96 + 0.04 * (c - v[n - 1]) / (1 - v[n - 1]) : 1;
      let i = 0;
      while (i < n - 2 && c > v[i + 1]) i++;
      const t = v[i + 1] > v[i] ? (c - v[i]) / (v[i + 1] - v[i]) : 0.5;
      return 0.04 + 0.92 * (i + t) / (n - 1);
    }
    const M = { v: 0, a: 0, target: null };
    const rings = new Map();   // key -> { f, s, a, seen }
    function updateRings(vs, dt) {
      for (const r of rings.values()) r.seen = false;
      const ps = vs.map((v) => partials(v.f));
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        const lv = Math.sqrt((FLOOR + (1 - FLOOR) * vs[i].amp) * (FLOOR + (1 - FLOOR) * vs[j].amp));
        for (const a of ps[i]) for (const b of ps[j]) {
          const c = Math.abs(1200 * Math.log2(a.f / b.f));
          if (c >= TOL) continue;
          const [x, y] = vs[i].id < vs[j].id ? [vs[i].id + '.' + a.i, vs[j].id + '.' + b.i] : [vs[j].id + '.' + b.i, vs[i].id + '.' + a.i];
          const k = x + '|' + y, f = Math.sqrt(a.f * b.f), s = (1 - c / TOL) * Math.sqrt(a.a * b.a) * lv;
          const r = rings.get(k);
          if (r) Object.assign(r, { f, s, seen: true }); else rings.set(k, { f, s, a: 0, seen: true });
        }
      }
      for (const [k, r] of rings) {
        const t = r.seen ? r.s : 0, step = dt / FADE;
        r.a = r.a < t ? Math.min(t, r.a + step) : Math.max(t, r.a - step);
        if (!r.seen && r.a <= 0.003) rings.delete(k);
      }
    }

    // ---------- drawing ----------
    function label(c, t, x, y, color, align, font) {
      c.font = font || '11px system-ui, sans-serif'; c.textAlign = align || 'left';
      c.fillStyle = color || '#e6eaf5'; c.fillText(t, x, y);
    }
    function noteText(f) {
      const m = hzToMidi(f), r = Math.round(m), c = Math.round((m - r) * 100);
      return H.noteName(r) + (c ? (c > 0 ? ' +' : ' ') + c + '¢' : '');
    }
    function drawBg() {   // static layer: backdrop, spokes, names, spiral
      const c = bctx;
      c.setTransform(bg.width / S, 0, 0, bg.height / S, 0, 0);
      const { cx, cy, R, r0 } = geom();
      const gr = c.createRadialGradient(cx, cy, 0, cx, cy, S * 0.7);
      gr.addColorStop(0, '#0c0f1a'); gr.addColorStop(1, '#05060a');
      c.fillStyle = gr; c.fillRect(0, 0, S, S);
      c.lineWidth = 1;
      for (let pc = 0; pc < 12; pc++) {
        const a = (pc / 12) * 2 * Math.PI, s = Math.sin(a), co = Math.cos(a);
        c.strokeStyle = 'hsla(' + pc * 30 + ',55%,60%,0.13)';
        c.beginPath(); c.moveTo(cx + r0 * s, cy - r0 * co); c.lineTo(cx + R * s, cy - R * co); c.stroke();
        label(c, H.noteName(pc + 60).replace(/\d+$/, ''), cx + (R + 13) * s, cy - (R + 13) * co + 4, 'hsla(' + pc * 30 + ',70%,72%,0.85)', 'center');
        if (P.keys) {   // keycap with the computer key that plays this note
          const kx = cx + (R + 29) * s, ky = cy - (R + 29) * co;
          c.strokeStyle = 'rgba(122,129,148,0.55)'; c.beginPath();
          if (c.roundRect) c.roundRect(kx - 7, ky - 7, 14, 14, 3); else c.rect(kx - 7, ky - 7, 14, 14);
          c.stroke();
          label(c, KEYS[pc].toUpperCase(), kx, ky + 3.5, '#9aa2b6', 'center', '9px ui-monospace, Consolas, monospace');
        }
      }
      c.strokeStyle = 'rgba(160,170,200,0.32)'; c.lineWidth = 1.2;
      c.beginPath();
      for (let i = 0; i <= 600; i++) { const [x, y] = pos(C2 * 2 ** (i / 120)); if (i) c.lineTo(x, y); else c.moveTo(x, y); }
      c.stroke();
      for (let o = 0; o <= TURNS; o++) { const [x, y] = pos(C2 * 2 ** o); label(c, 'C' + (o + 2), x - 6, y + 13, 'rgba(122,129,148,0.8)', 'right', '10px system-ui, sans-serif'); }
    }
    function draw(now, dt) {
      ctx.setTransform(cv.width / S, 0, 0, cv.height / S, 0, 0);
      ctx.drawImage(bg, 0, 0, S, S);
      const { cx, cy, r0 } = geom();
      const all = [...voices.values(), ...fading];
      for (const v of all) {
        v.vis = v.alive ? Math.min(1, v.vis + dt / FADE) : Math.max(0, v.vis - dt / FADE);
        v.amp = v.alive ? ampOf(v, now) : v.amp;
        v.trail = v.trail.filter((p) => now - p.t < TRAIL);
        if (!v.alive && v.vis <= 0 && !v.trail.length) fading.delete(v);
      }
      const vs = [...voices.values()].sort((a, b) => a.f - b.f);
      updateRings(vs, dt);
      // harmony meter: thin ring around the center
      const h = consonance(vs.map((v) => v.f));
      M.target = h ? h.c : null;
      const k = 1 - Math.exp(-dt / 160);
      if (h) M.v += (h.c - M.v) * k;
      M.a += ((h ? 1 : 0) - M.a) * k;
      const mr = r0 * 0.62, col = meterColor(M.v).join(',');
      ctx.globalCompositeOperation = 'lighter';
      if (M.a > 0.01) {
        const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r0 * 3);
        gr.addColorStop(0, 'rgba(' + col + ',' + (0.16 * M.a * M.v).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(' + col + ',0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r0 * 3, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(38,43,58,0.9)'; ctx.beginPath(); ctx.arc(cx, cy, mr, 0, 2 * Math.PI); ctx.stroke();
      if (M.a > 0.01) {
        ctx.strokeStyle = 'rgba(' + col + ',' + (0.95 * M.a).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(cx, cy, mr, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.005, M.v)); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      // chord shape
      if (vs.length >= 2) {
        ctx.beginPath();
        vs.forEach((v, i) => { const [x, y] = pos(v.f); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,0.045)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.stroke();
      }
      // trails
      ctx.lineCap = 'round';
      for (const v of all) for (let i = 1; i < v.trail.length; i++) {
        const p = v.trail[i - 1], q = v.trail[i], age = clamp01((now - q.t) / TRAIL);
        if (!inRange(p.f) || !inRange(q.f)) continue;
        const [x0, y0] = pos(p.f), [x1, y1] = pos(q.f);
        ctx.strokeStyle = 'hsla(' + hueOf(v.f) + ',90%,70%,' + (0.5 * (1 - age)).toFixed(3) + ')';
        ctx.lineWidth = 1 + 5 * (1 - age);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      // overtone dots
      if (P.ov === 'all') for (const v of all) {
        const lv = v.vis * (0.45 + 0.55 * v.amp);
        if (lv < 0.01) continue;
        for (const p of partials(v.f)) {
          if (!p.k || !inRange(p.f)) continue;
          const [x, y] = pos(p.f);
          ctx.beginPath(); ctx.arc(x, y, 1.5 + 2.5 * Math.sqrt(p.a), 0, 2 * Math.PI);
          ctx.fillStyle = 'hsla(' + hueOf(v.f) + ',80%,62%,' + ((0.25 + 0.55 * p.a) * lv).toFixed(3) + ')'; ctx.fill();
        }
      }
      // shared-overtone rings (bloom)
      const pulse = 1 + 0.08 * Math.sin(now / 300);
      ctx.globalCompositeOperation = 'lighter';
      for (const r of rings.values()) {
        if (!inRange(r.f) || r.a < 0.005) continue;
        const [x, y] = pos(r.f), rad = (12 + 26 * r.a) * pulse;
        const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'rgba(255,240,200,' + (0.5 * r.a).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(255,200,130,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = 'rgba(255,245,215,' + (0.85 * r.a).toFixed(3) + ')'; ctx.lineWidth = 0.8 + 1.6 * r.a;
        ctx.beginPath(); ctx.arc(x, y, 5 + 4 * r.a * pulse, 0, 2 * Math.PI); ctx.stroke();
      }
      // voices: halo (follows the sound's loudness), then the dot
      for (const v of all) {
        if (v.vis < 0.01) continue;
        const [x, y] = pos(v.f), hue = hueOf(v.f), hitAge = v === arpCur ? (now - v.t0) / 1000 : 9;
        const beat = Math.exp(-hitAge * 6), rad = 14 + 22 * v.amp + 14 * beat;
        const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'hsla(' + hue + ',95%,65%,' + (v.vis * (0.15 + 0.45 * v.amp)).toFixed(3) + ')'); gr.addColorStop(1, 'hsla(' + hue + ',95%,60%,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      for (const v of all) {
        if (v.vis < 0.01) continue;
        const [x, y] = pos(v.f), lv = FLOOR + (1 - FLOOR) * v.amp, beat = v === arpCur ? Math.exp(-(now - v.t0) / 160) : 0;
        ctx.globalAlpha = v.vis;
        ctx.beginPath(); ctx.arc(x, y, 7 + 2 * v.vis + 3 * beat, 0, 2 * Math.PI);
        ctx.fillStyle = 'hsla(' + hueOf(v.f) + ',90%,' + (30 + 32 * lv) + '%,' + (0.4 + 0.6 * lv).toFixed(3) + ')'; ctx.fill();
        if (v.latched) { ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 + 0.5 * lv).toFixed(3) + ')'; ctx.stroke(); }
        if (v.alive) label(ctx, noteText(v.f), x + 13, y - 9, 'rgba(240,244,255,0.9)');
        ctx.globalAlpha = 1;
      }
      updateInfo(vs, h);
      const meterBusy = (h && Math.abs(M.v - h.c) > 0.002) || (M.a > 0.003 && M.a < 0.997);
      return voices.size || fading.size || rings.size || meterBusy || arp;
    }
    function chordName(vs) {
      const c = identifyChord(vs.map((v) => hzToMidi(v.f)));
      return c ? PC_NAMES[c.root] + ' ' + c.quality : '';
    }
    let lastInfo = '';
    function meterTip(h) {
      return 'Harmony meter ' + Math.round(h.c * 100) + '%: where this chord ranks among ' + REFS.length +
        ' reference chords (12 intervals + maj, min, dim, aug, sus4, 7) played on this sound. ' +
        'Raw consonance ' + h.raw.toFixed(3) + ' (0 = roughest small interval, 1 = octave) · dissonance ' + h.dis.toFixed(3);
    }
    function updateInfo(vs, h) {
      updateSend(vs);
      const lines = [];
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        const nr = H.nearestRatio(vs[j].f / vs[i].f);
        lines.push(noteText(vs[i].f) + '–' + noteText(vs[j].f) + ': ' +
          (nr ? nr.p + '/' + nr.q + ' (' + (nr.cents >= 0 ? '+' : '') + nr.cents.toFixed(1) + '¢)' : 'no simple ratio'));
      }
      if (h) lines.push('harmony meter: ' + Math.round(h.c * 100) + '% (rank among ' + REFS.length + ' reference chords on this sound)',
        'raw consonance: ' + h.raw.toFixed(3) + ' · dissonance: ' + h.dis.toFixed(3));
      const nRings = [...rings.values()].filter((r) => r.seen).length, name = vs.length > 2 ? chordName(vs) : '';
      const cap = vs.length ? '<b>' + ui.esc(vs.map((v) => noteText(v.f)).join(' ')) + '</b>' + (name ? ' · ' + ui.esc(name) : '') +
        ' · shared overtones ' + nRings + (h ? ' · <span class="sp-meter" title="' + ui.esc(meterTip(h)) + '">harmony ' + Math.round(h.c * 100) + '%</span>' : '') : 'no notes playing';
      const txt = cap + '\n' + lines.join('\n');
      if (txt === lastInfo) return;
      lastInfo = txt;
      caption.innerHTML = cap;
      sharedEl.textContent = 'shared overtones: ' + nRings;
      infoEl.textContent = vs.length ? lines.join('\n') || 'one note' : 'no notes playing';
    }

    // ---------- loop: animate only while something is moving ----------
    function frame(now) {
      raf = 0;
      const dt = last ? Math.min(100, now - last) : 16;
      last = now;
      if (draw(performance.now(), dt)) changed(); else last = 0;
    }
    function changed() { if (!raf && inst !== null) raf = requestAnimationFrame(frame); }
    if (sound.kind === 'sampler') VH.sounds.prepare(sound.id).then(refresh).catch(() => {});
    return {
      start() { changed(); },
      debug() {
        const hc = cVal;
        return { meter: { target: M.target, shown: M.v, alpha: M.a, raw: hc ? hc.raw : null, dis: hc ? hc.dis : null },
          calib: calib().refs.map((r) => r.name + '=' + r.c.toFixed(3)).join(' '), sound: sound.id, chord: P.chord, arp, rate: P.rate, pat: P.pat,
          notes: [...voices.values()].map((v) => ({ id: v.id, midi: Math.round(hzToMidi(v.f) * 100) / 100, latched: v.latched, vis: v.vis, amp: v.amp })),
          fading: fading.size, fadingVis: [...fading].map((v) => v.vis), rings: rings.size, arpLog: arpLog.slice() };
      },
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        raf = -1;   // blocks further scheduling
        clearInterval(arpTimer); arpTimer = 0;
        voices.forEach((v) => { if (v.tone) v.tone.stop(0.05); });
        voices.clear(); fading.clear(); rings.clear(); ptrs.clear();
        cleanups.forEach((f) => f());
      },
    };
  }

  VH.registerExperiment({
    id: 'spiral', title: 'Spiral', icon: '◎',
    hint: 'Drag on the spiral to play. Pick a chord to place one with a click; where overtones meet, they glow.',
    mount(el) { inst = create(el); inst.start(); },
    unmount() { if (inst) inst.destroy(); inst = null; },
    debug() { return inst ? inst.debug() : null; },
    identifyChord, shortcuts: SHORTCUTS,
  });
})();
