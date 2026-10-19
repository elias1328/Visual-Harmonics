// melody/model.js - song model: constants, chords/scales, defaults, serialize <-> parse (autosave + share format),
// migration of v1 songs (3 fixed layers, tempo in s/bar, drone/droneVol) and of songs saved before layers had ids.
// Pure data, no DOM. See MELODY.md.
(function () {
  'use strict';
  const VH = window.VH;
  const NS = VH.melody = VH.melody || {};
  NS.parts = NS.parts || [];   // Wave B parts: VH.melody.parts.push((M) => ({ ... }))

  const LO = 48, HI = 84, SPAN = HI - LO, LPB = 48, SPB = 16, MAX_LAYERS = 8, BPM_MIN = 40, BPM_MAX = 200;
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const QUALS = [['maj', '', [0, 4, 7]], ['min', 'm', [0, 3, 7]], ['dim', 'dim', [0, 3, 6]], ['aug', 'aug', [0, 4, 8]],
    ['sus2', 'sus2', [0, 2, 7]], ['sus4', 'sus4', [0, 5, 7]], ['7', '7', [0, 4, 7, 10]], ['maj7', 'maj7', [0, 4, 7, 11]], ['m7', 'm7', [0, 3, 7, 10]]];
  const QI = {}; QUALS.forEach((q, i) => { QI[q[0]] = i; });
  const SCALE = {
    major: { steps: [0, 2, 4, 5, 7, 9, 11], q: ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'], rn: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'], flat: [5, 10, 3, 8, 1, 6] },
    minor: { steps: [0, 2, 3, 5, 7, 8, 10], q: ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'], rn: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'], flat: [2, 7, 0, 5, 10, 3] },
  };
  const NATURAL = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
  const COLORS = ['#ff6b6b', '#ffc93c', '#7dff8a', '#5ad1ff', '#c58bff', '#ff8fd0', '#ffa45c', '#c9f06a'];
  // Base voice gains of the mix (before layer / backing / drum / master volumes). Every sound is loudness-matched
  // (VH.sounds loud), so a line and a notes layer at the same volume sound about equally loud; the backing sits ~4 dB
  // under one layer, the drums (DRUMS scales the drum bus) a little lower still. VH.audio's master sets the overall level.
  const GAIN = { LINE: 0.55, NOTE: 0.55, BACK: 0.25, PREVIEW_CHORD: 0.14, PREVIEW_NOTE: 0.3, DRUMS: 0.45 };
  // Mixer volumes (layers, backing, drums, master) are linear gains, 0..VOL_MAX, 1 = unity (100 %). Songs saved when the
  // range was 0..1 load unchanged: the same numbers are the same gains.
  const VOL_MAX = 1.5;
  const volDb = (v) => (v > 0 ? (20 * Math.log10(v) >= 0 ? '+' : '') + (20 * Math.log10(v)).toFixed(1) + ' dB' : '-inf dB');
  const volLabel = (v) => Math.round(v * 100) + '% (' + volDb(v) + ')';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r2 = (v) => Math.round(v * 100) / 100;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : d);
  const plain = (o) => {   // deep copy of a JSON-able plain object, else {}
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    try { return JSON.parse(JSON.stringify(o)); } catch (_) { return {}; }
  };

  // Stable layer ids: 'l1', 'l2', ... unique within a song. They survive undo, autosave and share links; parts key
  // per-layer data by id (or react to M.on('layerRemoved' / 'layerAdded')). Songs saved before ids get l1..lN in order.
  const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
  const validId = (id) => typeof id === 'string' && ID_RE.test(id);
  function nextLayerId(layers) {
    let n = 0;
    for (const l of layers) { const m = /^l(\d{1,6})$/.exec((l && l.id) || ''); if (m) n = Math.max(n, +m[1]); }
    return 'l' + (n + 1);
  }
  // Keep valid unique ids, give every other layer the next free one (in order). Returns the number of ids assigned.
  function assignIds(layers) {
    const seen = new Set();
    let added = 0;
    layers.forEach((l) => { if (validId(l.id) && !seen.has(l.id)) seen.add(l.id); else l.id = null; });
    layers.forEach((l) => { if (!l.id) { l.id = nextLayerId(layers); added++; } });
    return added;
  }

  function newLayer(i, o, bars) {
    o = o || {};
    return {
      id: validId(o.id) ? o.id : null,   // null until assignIds / M.addLayer gives it one
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 24) : 'Layer ' + (i + 1),
      color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : COLORS[i % COLORS.length],
      sound: typeof o.sound === 'string' && o.sound ? o.sound : 'string',
      mode: o.mode === 'notes' ? 'notes' : 'line',
      vol: num(o.vol, 0, VOL_MAX, 0.8), mute: !!o.mute, solo: !!o.solo,
      line: new Float32Array(bars * LPB).fill(NaN), notes: [],
    };
  }

  function defaultSong() {
    return { v: 2, key: 0, mode: 'major', bars: 4, chords: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']],
      layers: [{ sound: VH.store.get('melody.sound', 'string'), mode: 'line' }, { sound: 'pluck', mode: 'notes' }, { sound: 'string', mode: 'line' }],
      bpm: VH.store.get('melody.bpm', 120), grid: 8, loop: true, snap: false,
      backing: { sound: 'string', vol: 0.36, on: true, style: 'drone' }, master: 1, bandsOthers: false, fx: {}, drums: {}, ext: {} };
  }

  function segs(line) {   // contiguous runs: [[startIndex, v, v, ...], ...]
    const out = [];
    let cur = null;
    for (let i = 0; i < line.length; i++) {
      if (isNaN(line[i])) { cur = null; continue; }
      if (!cur) { cur = [i]; out.push(cur); }
      cur.push(r2(line[i]));
    }
    return out;
  }

  // full = also the view/session prefs (grid, loop, snap) that undo does not touch.
  function serialize(S, full) {
    const o = { v: 2, key: S.key, mode: S.mode, bars: S.bars, bpm: S.bpm, chords: S.chords.map((c) => (c ? [c[0], c[1]] : null)),
      layers: S.layers.map((l) => ({ id: l.id, name: l.name, color: l.color, sound: l.sound, mode: l.mode, vol: r3(l.vol), mute: l.mute, solo: l.solo,
        line: segs(l.line), notes: l.notes.slice().sort((a, b) => a.s - b.s || a.m - b.m).map((n) => [n.s, n.d, r2(n.m)]) })),
      backing: backingOut(S.backing),
      master: r3(S.master), bandsOthers: S.bandsOthers, fx: plain(S.fx), drums: plain(S.drums), ext: plain(S.ext) };
    const lr = regionOf(S);
    if (lr) o.loopRegion = lr;   // written only when set, so songs without one serialize unchanged
    if (full) Object.assign(o, { grid: S.grid, loop: S.loop, snap: S.snap });
    return o;
  }

  // Loop region: [firstBar, endBar) in whole bars (0 <= a < b <= bars), or null. Playback loops only those bars.
  function regionOf(S) {
    const r = S && S.loopRegion;
    if (!Array.isArray(r) || r.length !== 2) return null;
    const a = Math.round(+r[0]), b = Math.round(+r[1]), n = S.bars;
    if (!isFinite(a) || !isFinite(b)) return null;
    const lo = clamp(Math.min(a, b), 0, n), hi = clamp(Math.max(a, b), 0, n);
    return hi > lo ? [lo, hi] : null;
  }

  // backing.styleOpts (per-style sub-settings, see sound.js) is written only when set, so older songs serialize unchanged.
  function backingOut(B) {
    const o = { sound: B.sound, vol: r3(B.vol), on: B.on, style: B.style };
    const so = plain(B.styleOpts);
    if (Object.keys(so).length) o.styleOpts = so;
    return o;
  }

  // Accepts v2 and migrates v1 (tempo s/bar -> bpm, drone/droneVol -> backing, 3 fixed layers -> named layers).
  function parse(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.chords) || !Array.isArray(o.layers)) return null;
    const bars = [4, 8, 16].includes(o.bars) ? o.bars : 4, tot = bars * SPB, v1 = !(o.v >= 2);
    const bpm = typeof o.bpm === 'number' ? o.bpm : typeof o.tempo === 'number' && o.tempo > 0 ? 240 / o.tempo : 120;
    const S = { key: num(o.key, 0, 11, 0) | 0, mode: o.mode === 'minor' ? 'minor' : 'major', bars,
      bpm: Math.round(num(bpm, BPM_MIN, BPM_MAX, 120)), grid: o.grid === 16 ? 16 : 8, loop: o.loop !== false, snap: !!o.snap,
      master: num(o.master, 0, VOL_MAX, 1), bandsOthers: !!o.bandsOthers, fx: plain(o.fx), drums: plain(o.drums), ext: plain(o.ext) };
    S.chords = Array.from({ length: bars }, (_, b) => {
      const c = o.chords[b];
      return Array.isArray(c) && QI[c[1]] != null ? [num(c[0], 0, 11, 0) | 0, c[1]] : null;
    });
    const src = (v1 ? o.layers.slice(0, 3) : o.layers.slice(0, MAX_LAYERS)).filter((l) => l && typeof l === 'object');
    if (!src.length) src.push({});
    S.layers = src.map((l, L) => {
      const lay = newLayer(L, l, bars), line = lay.line;
      for (const sg of Array.isArray(l.line) ? l.line : []) {
        if (!Array.isArray(sg)) continue;
        for (let k = 1; k < sg.length; k++) {
          const i = (sg[0] | 0) + k - 1;
          if (i >= 0 && i < line.length && typeof sg[k] === 'number' && isFinite(sg[k])) line[i] = clamp(sg[k], LO, HI);
        }
      }
      lay.notes = (Array.isArray(l.notes) ? l.notes : []).filter((n) => Array.isArray(n) && n.length >= 3)
        .map((n) => ({ s: n[0] | 0, d: n[1] | 0, m: num(n[2], LO, HI, 60) }))
        .filter((n) => n.s >= 0 && n.d > 0 && n.s < tot);
      lay.notes.forEach((n) => { n.d = Math.min(n.d, tot - n.s); });
      return lay;
    });
    S.loopRegion = regionOf({ loopRegion: o.loopRegion, bars });
    S.migratedIds = assignIds(S.layers);   // > 0 for songs saved before layer ids (runtime info, not serialized)
    const b = o.backing && typeof o.backing === 'object' ? o.backing : null;
    S.backing = b
      ? { sound: typeof b.sound === 'string' && b.sound ? b.sound : 'string', vol: num(b.vol, 0, VOL_MAX, 0.36), on: b.on !== false,
        style: typeof b.style === 'string' ? b.style : 'drone', styleOpts: plain(b.styleOpts) }
      : { sound: S.layers[0].sound, vol: r3(num(o.droneVol, 0, 0.25, 0.09) / 0.25), on: o.drone !== false, style: 'drone', styleOpts: {} };   // v1
    return S;
  }

  const chordMidis = (ch) => QUALS[QI[ch[1]]][2].map((i) => LO + ch[0] + i);
  const scaleOf = (S) => SCALE[S.mode];
  const namesOf = (S) => (scaleOf(S).flat.includes(S.key) ? FLAT : SHARP);
  const chordName = (ch, names) => (ch ? names[ch[0]] + QUALS[QI[ch[1]]][1] : 'No chord');
  const diatonic = (S) => scaleOf(S).steps.map((st, k) => [(S.key + st) % 12, scaleOf(S).q[k]]);
  const secPerBar = (S) => 240 / S.bpm;          // 4/4: a bar = 4 beats
  const secPer16 = (S) => 15 / S.bpm;
  // Effective layer gain from vol / mute / solo (solo affects layers only, not the backing).
  const layerGain = (S, L) => {
    const l = S.layers[L];
    if (!l || l.mute) return 0;
    if (S.layers.some((x) => x.solo) && !l.solo) return 0;
    return l.vol;
  };

  NS.model = { LO, HI, SPAN, LPB, SPB, MAX_LAYERS, BPM_MIN, BPM_MAX, SHARP, FLAT, QUALS, QI, SCALE, NATURAL, COLORS,
    GAIN, VOL_MAX, volDb, volLabel, clamp, r2, regionOf, newLayer, nextLayerId, assignIds, defaultSong, segs, serialize, parse, chordMidis, scaleOf, namesOf, chordName, diatonic,
    secPerBar, secPer16, layerGain };
})();
