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
  // Scales (VH.harmony.SCALES): the key is root + scale, per section (S.key + S.mode; 'major' / 'minor' = Ionian /
  // Aeolian, so old songs load unchanged). q / rn: the chords on each degree (see harmony.scaleChords).
  const HM = VH.harmony || (typeof require === 'function' ? require('../../core/harmony.js') : null), SCALE = {}, SCALE_GROUPS = ['Common', 'Modes', 'Exotic'];
  HM.SCALES.forEach((x) => {
    const cs = HM.scaleChords(0, x);
    SCALE[x.id] = Object.assign({}, x, { q: cs.map((c) => c.q), rn: cs.map((c) => c.rn),
      // flat spelling: keys whose parent major (minor-third scales: the relative major) is a flat key
      flat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((k) => [5, 10, 3, 8, 1, 6].includes(x.steps.includes(3) && !x.steps.includes(4) ? (k + 3) % 12 : k)) });
  });
  // Tunings (VH.harmony.TUNINGS), song-wide S.tuning: '12tet' (default) | 'ji' | 'pyth' | '19tet' | '24tet' | '31tet' | 'slendro' | 'pelog'.
  const TUNINGS = HM.TUNINGS, tuningOf = (S) => (S && HM.tuningById(S.tuning).id) || '12tet';
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

  function newLayer(i, o, bars, ts) {
    o = o || {};
    return withLegacyLine({
      id: validId(o.id) ? o.id : null,   // null until assignIds / M.addLayer gives it one
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 24) : 'Layer ' + (i + 1),
      color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : COLORS[i % COLORS.length],
      sound: typeof o.sound === 'string' && o.sound ? o.sound : 'string',
      mode: o.mode === 'notes' ? 'notes' : 'line',
      vol: num(o.vol, 0, VOL_MAX, 0.8), mute: !!o.mute, solo: !!o.solo,
      lines: [], notes: [],
    }, bars * ((TS[ts] || TS['4/4']).spb * 3));
  }

  // ---------- line strokes ----------
  // A layer's line is a list of strokes { id 's1'|'s2'|.., v: Float32Array(bars*LPB) of midi or NaN }. Strokes may overlap
  // in time (polyphonic within the layer); each one may hold several runs. Ids are stable (vibrato is keyed by them).
  // layer.line is a legacy accessor (not enumerable, not serialized): stroke #1's samples (created when missing);
  // assigning an array replaces all strokes with that one.
  const MAX_STROKES = 8;
  function withLegacyLine(l, len) {
    Object.defineProperty(l, 'line', {
      configurable: true, enumerable: false,
      get() { if (!this.lines.length) this.lines.push({ id: 's1', v: new Float32Array(len).fill(NaN) }); return this.lines[0].v; },
      set(a) { this.lines = [{ id: 's1', v: a instanceof Float32Array ? a : Float32Array.from(a || []) }]; },
    });
    return l;
  }
  const strokes = (l) => (!l ? [] : Array.isArray(l.lines) ? l.lines : l.line && l.line.length != null ? [{ id: 's1', v: l.line }] : []);
  function nextStrokeId(l) {
    let n = 0;
    for (const st of strokes(l)) { const m = /^s(\d{1,6})$/.exec(st.id || ''); if (m) n = Math.max(n, +m[1]); }
    return 's' + (n + 1);
  }
  function addStroke(l, len) {
    const st = { id: nextStrokeId(l), v: new Float32Array(len).fill(NaN) };
    l.lines.push(st);
    return st;
  }
  const strokeEmpty = (st) => { for (let i = 0; i < st.v.length; i++) if (!isNaN(st.v[i])) return false; return true; };
  function pruneStrokes(l) { if (Array.isArray(l.lines)) l.lines = l.lines.filter((st) => !strokeEmpty(st)); return l; }
  // Every line value at sample i: [{ id, m }]
  function lineAt(l, i) {
    const out = [];
    for (const st of strokes(l)) { const m = st.v[i]; if (m === m && m != null) out.push({ id: st.id, m }); }
    return out;
  }
  const hasLine = (l) => strokes(l).some((st) => !strokeEmpty(st));
  // Each stroke's contiguous runs [[a, b]] (b inclusive), with its stroke: [{ st, a, b }] in start order.
  function lineRuns(l) {
    const out = [];
    for (const st of strokes(l)) {
      const v = st.v;
      for (let i = 0; i < v.length; i++) {
        if (isNaN(v[i])) continue;
        let j = i; while (j + 1 < v.length && !isNaN(v[j + 1])) j++;
        out.push({ st, a: i, b: j }); i = j;
      }
    }
    return out.sort((x, y) => x.a - y.a || x.b - y.b);
  }

  function defaultSong() {
    return { v: 3, key: 0, mode: 'major', bars: 4, chords: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']],
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

  // ---------- time signatures ----------
  // spb = sixteenths per bar, beats = beat starts within the bar (sixteenths), half = the Shift snap step (half-beats).
  // The tempo (bpm) always counts quarter notes; 6/8 and 12/8 beat in dotted quarters, 7/8 groups 2+2+3 eighths.
  const TS = {
    '2/4': { n: 2, d: 4, spb: 8, beats: [0, 4], half: 2 },
    '3/4': { n: 3, d: 4, spb: 12, beats: [0, 4, 8], half: 2 },
    '4/4': { n: 4, d: 4, spb: 16, beats: [0, 4, 8, 12], half: 2 },
    '5/4': { n: 5, d: 4, spb: 20, beats: [0, 4, 8, 12, 16], half: 2 },
    '6/8': { n: 6, d: 8, spb: 12, beats: [0, 6], half: 3, compound: true },
    '7/8': { n: 7, d: 8, spb: 14, beats: [0, 4, 8], half: 2 },
    '12/8': { n: 12, d: 8, spb: 24, beats: [0, 6, 12, 18], half: 3, compound: true },
  };
  const TS_LIST = Object.keys(TS);
  const tsOf = (S) => TS[S && S.ts] || TS['4/4'];
  const spb = (S) => tsOf(S).spb;                  // sixteenths per bar of a (section) song
  const lpb = (S) => tsOf(S).spb * 3;              // line samples per bar (3 per sixteenth)
  const tot16 = (S) => (S && S.flat ? S.flat.tot : S.bars * spb(S));
  // Bars of a song: [{ a (start t16), n (length), b (bar index within its section), ts, drums?, sec? }]. A flattened
  // arrangement (flatten) lists every bar of every section pass.
  function barsOf(S) {
    if (S.flat) return S.flat.bars;
    const n = spb(S);
    return Array.from({ length: S.bars }, (_, b) => ({ a: b * n, n, b, ts: S.ts || '4/4' }));
  }
  const barAt = (S, t16) => clamp(Math.floor(t16 / spb(S)), 0, S.bars - 1);
  // Beat grid inside a bar (sixteenths): beats, or with half = true also the half-beats.
  function beatGrid(S, half) {
    const T = tsOf(S), out = new Set(T.beats);
    if (half) for (let p = 0; p < T.spb; p += T.half) out.add(p);
    return [...out].sort((a, b) => a - b);
  }

  // ---------- chord events (regions) ----------
  // S.chords = [{ at: t16 within the section, chord: [root, quality] | null }], sorted, unique `at`, with an event at
  // every bar start; more events split a bar. Region i runs from chords[i].at to the next event (or the section end), so
  // a region never crosses a bar line. Region index == bar index while no bar is split. Bands, auto-fit, backing and
  // the readout all work per region.
  function normChords(S) {
    const n = spb(S), tot = S.bars * n;
    const src = (Array.isArray(S.chords) ? S.chords : []).filter((e) => e && typeof e === 'object' && isFinite(e.at))
      .map((e) => ({ at: Math.round(e.at), chord: Array.isArray(e.chord) && QI[e.chord[1]] != null ? [e.chord[0] | 0, e.chord[1]] : null }))
      .filter((e) => e.at >= 0 && e.at < tot).sort((x, y) => x.at - y.at);
    const out = [];
    let k = 0, last = null;
    for (let b = 0; b < S.bars; b++) {
      const a = b * n, z = a + n;
      if (!(k < src.length && src[k].at === a)) out.push({ at: a, chord: last ? last.slice() : null });
      while (k < src.length && src[k].at < z) {
        const e = src[k++];
        if (out.length && out[out.length - 1].at === e.at) out[out.length - 1] = e; else out.push(e);
      }
      last = out[out.length - 1].chord;
    }
    S.chords = out;
    return out;
  }
  function regionAt(S, t16) {
    const c = S.chords;
    let i = 0;
    while (i + 1 < c.length && c[i + 1].at <= t16 + 1e-9) i++;
    return i;
  }
  const regionEnd = (S, i) => (S.chords[i + 1] ? S.chords[i + 1].at : tot16(S));
  const chordAt = (S, t16) => { const e = S.chords[regionAt(S, t16)]; return e ? e.chord : null; };
  const regionChord = (S, i) => (S.chords[i] ? S.chords[i].chord : null);
  function regions(S) {
    return S.chords.map((e, i) => ({ i, a: e.at, z: regionEnd(S, i), chord: e.chord, bar: S.flat ? -1 : Math.floor(e.at / spb(S)) }));
  }
  // The chord at each bar start (one per bar: the per-bar view of older code and tests).
  const barChords = (S) => Array.from({ length: S.bars }, (_, b) => chordAt(S, b * spb(S)));
  const isBarStart = (S, t16) => t16 % spb(S) === 0;
  // Split the region at t16 (a new event with the chord sounding there). Returns the new region index, or -1.
  function splitAt(S, t16) {
    t16 = Math.round(t16);
    if (t16 <= 0 || t16 >= tot16(S) || S.chords.some((e) => e.at === t16)) return -1;
    const ch = chordAt(S, t16);
    S.chords.push({ at: t16, chord: ch ? ch.slice() : null });
    S.chords.sort((x, y) => x.at - y.at);
    return regionAt(S, t16);
  }
  // Merge region i into the one before it (removes its event). Bar starts never merge. Returns true when merged.
  function mergeAt(S, i) {
    const e = S.chords[i];
    if (!e || i === 0 || isBarStart(S, e.at)) return false;
    S.chords.splice(i, 1);
    return true;
  }
  const serChords = (list) => list.map((e) => (e.chord ? [e.at, e.chord[0], e.chord[1]] : [e.at]));
  // v4: [[at, root, q] | [at]]; older songs: one [root, q] | null per bar (4/4).
  function parseChords(raw, v4, bars, ts) {
    const n = (TS[ts] || TS['4/4']).spb, S = { bars, ts, chords: [] };
    const okCh = (r, q) => (QI[q] != null ? [num(r, 0, 11, 0) | 0, q] : null);
    if (v4) S.chords = (Array.isArray(raw) ? raw : []).filter((x) => Array.isArray(x) && isFinite(x[0])).map((x) => ({ at: x[0], chord: x.length >= 3 ? okCh(x[1], x[2]) : null }));
    else S.chords = Array.from({ length: bars }, (_, b) => { const c = raw[b]; return { at: b * n, chord: Array.isArray(c) ? okCh(c[0], c[1]) : null }; });
    return normChords(S);
  }

  // ---------- sections + arrangement ----------
  // S.sections = [{ id, name, color, rep 1..8, data }] in song order; S.cur = the section shown in the graph. The live
  // song fields (bars, ts, chords, loopRegion, drums minus vol, ext.edit.vib, each layer's lines + notes) ARE the current
  // section's content; `data` holds the content of every other section (by reference, never read for the current one).
  // Tempo, key, instruments, mixer and fx are song-wide.
  const MAX_SECTIONS = 16, MAX_BARS = 16, MAX_REP = 8;
  const SEC_COLORS = ['#6fa3ff', '#ffb35c', '#7ddc8a', '#d78bff', '#ff7a8a', '#5fd4d0', '#e6d36a', '#b0b8c8'];
  const SEC_NAMES = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'];
  function nextSecId(list) {
    let n = 1;
    for (const x of list) { const m = /^S(\d{1,4})$/.exec(x.id || ''); if (m) n = Math.max(n, +m[1]); }
    return 'S' + (n + 1);
  }
  const secMeta = (x) => ({ id: x.id, name: x.name, color: x.color, rep: x.rep });
  function liveContent(S) {   // the current section's content, by reference
    const dr = Object.assign({}, S.drums); delete dr.vol;
    const ed = S.ext && S.ext.edit, layers = {};
    S.layers.forEach((l) => { layers[l.id] = { lines: l.lines, notes: l.notes }; });
    return { bars: S.bars, ts: S.ts || '4/4', key: S.key, mode: S.mode, chords: S.chords, loopRegion: S.loopRegion || null, tension: S.tension || 0, drums: dr, vib: ed && ed.vib ? ed.vib : null, auto: S.auto || [], layers };
  }
  function copyContent(d) {
    const layers = {};
    Object.keys(d.layers).forEach((id) => {
      const c = d.layers[id];
      layers[id] = { lines: c.lines.map((st) => ({ id: st.id, v: new Float32Array(st.v) })), notes: c.notes.map((n) => ({ s: n.s, d: n.d, m: n.m })) };
    });
    return { bars: d.bars, ts: d.ts, key: d.key, mode: d.mode, chords: d.chords.map((e) => ({ at: e.at, chord: e.chord ? e.chord.slice() : null })),
      loopRegion: d.loopRegion ? d.loopRegion.slice() : null, tension: d.tension || 0, drums: plain(d.drums), vib: d.vib ? plain(d.vib) : null, auto: autoCopy(d.auto), layers };
  }
  const contentOf = (S, k) => (k === S.cur ? liveContent(S) : S.sections[k].data);
  function applyContent(S, d) {
    S.bars = d.bars; S.ts = d.ts; S.chords = d.chords;
    if (d.key != null) { S.key = d.key; S.mode = d.mode; } S.loopRegion = d.loopRegion || null; S.tension = d.tension || 0; S.auto = d.auto || [];
    const vol = S.drums && typeof S.drums.vol === 'number' ? { vol: S.drums.vol } : {};
    S.drums = Object.assign({}, d.drums, vol);
    if (!S.ext || typeof S.ext !== 'object') S.ext = {};
    if (d.vib) { S.ext.edit = S.ext.edit && typeof S.ext.edit === 'object' ? S.ext.edit : {}; S.ext.edit.vib = d.vib; } else if (S.ext.edit) delete S.ext.edit.vib;
    S.layers.forEach((l) => { const c = d.layers[l.id]; l.lines = c ? c.lines : []; l.notes = c ? c.notes : []; });
  }
  // Show section k in the live fields (stores the current one first). No undo step by itself.
  function selectSection(S, k) {
    if (k === S.cur || !S.sections[k]) return false;
    S.sections[S.cur].data = liveContent(S);
    S.cur = k;
    applyContent(S, S.sections[k].data);
    S.sections[k].data = null;
    return true;
  }
  function emptyContent(S, bars, ts) {
    const c = { bars, ts, key: S.key, mode: S.mode, chords: [], loopRegion: null, tension: 0, drums: {}, vib: null, auto: [], layers: {} };
    const tonic = diatonic(S)[0];
    c.chords = normChords({ bars, ts, chords: [{ at: 0, chord: tonic }] });
    return c;
  }
  const secTot = (d) => d.bars * (TS[d.ts] || TS['4/4']).spb;
  // A section as a standalone (section) song: the live song for the current one, else a shallow copy with its content.
  function sectionSong(S, k) {
    if (k === S.cur) return S;
    const d = S.sections[k].data, ed = Object.assign({}, S.ext && S.ext.edit);
    if (d.vib) ed.vib = d.vib; else delete ed.vib;
    return Object.assign({}, S, { bars: d.bars, ts: d.ts, key: d.key != null ? d.key : S.key, mode: d.mode || S.mode, chords: d.chords, loopRegion: d.loopRegion, tension: d.tension || 0, auto: d.auto || [], cur: k,
      drums: Object.assign({}, d.drums, S.drums && typeof S.drums.vol === 'number' ? { vol: S.drums.vol } : {}),
      ext: Object.assign({}, S.ext, { edit: ed }),
      layers: S.layers.map((l) => { const c = d.layers[l.id]; return Object.assign({}, l, { lines: c ? c.lines : [], notes: c ? c.notes : [] }); }) });
  }
  // Song order: one item per pass { k (section), r (repeat 0..), a (start t16 in the song), n (length) }.
  function arrangement(S) {
    const out = [];
    let a = 0;
    S.sections.forEach((x, k) => {
      const n = k === S.cur ? S.bars * spb(S) : secTot(x.data);
      for (let r = 0; r < x.rep; r++) { out.push({ k, r, a, n }); a += n; }
    });
    return out;
  }
  const songTot = (S) => arrangement(S).reduce((s, it) => s + it.n, 0);
  // The whole arrangement (or o.only = one pass of section k) as one flat song for export: chords, lines, notes and
  // vibrato laid end to end; S.flat = { tot, bars: [{ a, n, b, ts, drums }], items, ts: [{ at, ts }] }. Read it with
  // tot16 / barsOf / regions (the bar length varies). Shares sounds + mix with S.
  function flatten(S, o) {
    o = o || {};
    const items = o.only != null ? [{ k: o.only, r: 0, a: 0, n: k16(S, o.only) }] : arrangement(S);
    const tot = items.reduce((s, it) => s + it.n, 0), F = Object.assign({}, S, { loopRegion: null });
    const bars = [], chords = [], tsl = [], vib = {}, fa = {};
    const layers = S.layers.map((l) => Object.assign({}, l, { lines: [], notes: [] }));
    items.forEach((it) => {
      const s = sectionSong(S, it.k), n = spb(s);
      for (let b = 0; b < s.bars; b++) bars.push({ a: it.a + b * n, n, b, ts: s.ts || '4/4', drums: s.drums, sec: it.k });
      // kp: the section's key root, so tuned chords (chordMidis(ch, F)) follow modulations in the flat song
      s.chords.forEach((e) => { const c = e.chord ? e.chord.slice() : null; if (c) c.kp = s.key; chords.push({ at: it.a + e.at, chord: c }); });
      if (!tsl.length || tsl[tsl.length - 1].ts !== (s.ts || '4/4')) tsl.push({ at: it.a, ts: s.ts || '4/4' });
      // automation lanes: pieces per target ({ a, n, pts }); time not covered by a piece is neutral
      (s.auto || []).forEach((ln) => { (fa[ln.target] = fa[ln.target] || []).push({ a: it.a, n: it.n, pts: ln.points }); });
      s.layers.forEach((l, L) => {
        const F1 = layers[L];
        l.notes.forEach((x) => F1.notes.push({ s: x.s + it.a, d: x.d, m: x.m }));
        strokes(l).forEach((st) => {
          let fs = F1.lines.find((q) => q.id === st.id);
          if (!fs) { fs = { id: st.id, v: new Float32Array(tot * 3).fill(NaN) }; F1.lines.push(fs); }
          fs.v.set(st.v.subarray(0, Math.min(st.v.length, it.n * 3)), it.a * 3);
        });
        const xv = s.ext && s.ext.edit && s.ext.edit.vib && s.ext.edit.vib[L];
        if (xv && typeof xv === 'object') {
          const dst = vib[L] || (vib[L] = { s: {}, n: [] });
          if (xv.s && typeof xv.s === 'object') Object.keys(xv.s).forEach((q) => {
            (dst.s[q] = dst.s[q] || []).push(...(Array.isArray(xv.s[q]) ? xv.s[q] : []).map((r) => [r[0] + it.a * 3, r[1] + it.a * 3, r[2], r[3]]));
          });
          if (Array.isArray(xv.n)) xv.n.forEach((r) => dst.n.push([r[0] + it.a, r[1], r[2], r[3]]));
        }
      });
    });
    F.layers = layers; F.chords = chords; F.bars = bars.length; F.ts = tsl.length ? tsl[0].ts : '4/4';
    F.ext = Object.assign({}, S.ext, { edit: Object.assign({}, S.ext && S.ext.edit, { vib }) });
    F.flat = { tot, bars, items, ts: tsl };
    F.auto = []; F.flatAuto = fa;
    return F;
  }
  const k16 = (S, k) => (k === S.cur ? S.bars * spb(S) : secTot(S.sections[k].data));

  function serLayerContent(l) {
    return { lines: strokes(l).map((st) => ({ id: st.id, segs: segs(st.v) })).filter((x) => x.segs.length),
      notes: l.notes.slice().sort((a, b) => a.s - b.s || a.m - b.m).map((n) => [n.s, n.d, r2(n.m)]) };
  }
  function serContent(d, layers) {
    const o = { bars: d.bars, ts: d.ts, key: d.key, mode: d.mode, chords: serChords(d.chords), drums: plain(d.drums),
      layers: layers.filter((l) => d.layers[l.id]).map((l) => Object.assign({ id: l.id }, serLayerContent(d.layers[l.id]))) };
    const lr = regionOf({ loopRegion: d.loopRegion, bars: d.bars });
    if (lr) o.loopRegion = lr;
    if (d.tension > 0) o.tension = r3(d.tension);   // written only when set
    if (d.vib) o.vib = plain(d.vib);
    if (d.auto && d.auto.length) o.auto = autoOut(d.auto);   // automation lanes: written only when set
    return o;
  }

  // full = also the view/session prefs (grid, loop, snap) that undo does not touch.
  // v4: chords are events [at, root, q], a time signature, and `sections` (+ `cur`): the top-level content is the
  // current section's; the other sections carry their own content.
  // v5: key + scale (mode) per section (top level = the shown section's), any scale id; song-wide `tuning` (only when not 12-TET).
  function serialize(S, full) {
    const o = { v: 5, key: S.key, mode: S.mode, bars: S.bars, ts: S.ts || '4/4', bpm: S.bpm, chords: serChords(S.chords),
      layers: S.layers.map((l) => Object.assign({ id: l.id, name: l.name, color: l.color, sound: l.sound, mode: l.mode, vol: r3(l.vol), mute: l.mute, solo: l.solo },
        serLayerContent(l))),
      backing: backingOut(S.backing),
      master: r3(S.master), bandsOthers: S.bandsOthers, fx: plain(S.fx), drums: plain(S.drums), ext: plain(S.ext) };
    const lr = regionOf(S);
    if (lr) o.loopRegion = lr;   // written only when set, so songs without one serialize unchanged
    if (S.tension > 0) o.tension = r3(S.tension);   // Tension dial (0..1) of the shown section; only when set
    if (tuningOf(S) !== '12tet') o.tuning = tuningOf(S);
    if (S.auto && S.auto.length) o.auto = autoOut(S.auto);   // automation lanes of the shown section; only when set
    o.sections = (S.sections || []).map((x, k) => (k === S.cur ? secMeta(x) : Object.assign(secMeta(x), serContent(x.data, S.layers))));
    o.cur = S.cur | 0;
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
    const v4 = o.v >= 4, bars = barsIn(o.bars, v4), ts = TS[o.ts] ? o.ts : '4/4', v1 = !(o.v >= 2);
    const bpm = typeof o.bpm === 'number' ? o.bpm : typeof o.tempo === 'number' && o.tempo > 0 ? 240 / o.tempo : 120;
    const S = { key: num(o.key, 0, 11, 0) | 0, mode: modeIn(o.mode, 'major'), tuning: HM.tuningById(o.tuning).id, bars, ts,
      bpm: Math.round(num(bpm, BPM_MIN, BPM_MAX, 120)), grid: o.grid === 16 ? 16 : 8, loop: o.loop !== false, snap: !!o.snap,
      master: num(o.master, 0, VOL_MAX, 1), bandsOthers: !!o.bandsOthers, fx: plain(o.fx), drums: plain(o.drums), ext: plain(o.ext) };
    S.chords = parseChords(o.chords, v4, bars, ts);
    const src = (v1 ? o.layers.slice(0, 3) : o.layers.slice(0, MAX_LAYERS)).filter((l) => l && typeof l === 'object');
    if (!src.length) src.push({});
    const mig = { lines: 0 };
    S.layers = src.map((l, L) => {
      const lay = newLayer(L, l, bars, ts);
      fillContent(lay, l, bars, ts, mig);
      return lay;
    });
    const migratedLines = mig.lines;
    S.loopRegion = regionOf({ loopRegion: o.loopRegion, bars });
    S.tension = tensionOf(o.tension);
    S.migratedIds = assignIds(S.layers);   // > 0 for songs saved before layer ids (runtime info, not serialized)
    S.auto = autoIn(o.auto, S.layers);     // automation lanes of the shown section
    S.migratedLines = migratedLines;       // > 0 for songs saved before strokes (v < 3)
    // vibrato (B1, ext.edit.vib[L]) was keyed by line sample of the one line: { l: ranges } -> { s: { s1: ranges } }
    const vib = S.ext.edit && S.ext.edit.vib;
    if (vib && typeof vib === 'object') {
      Object.keys(vib).forEach((k) => {
        const x = vib[k];
        if (!x || typeof x !== 'object' || !Array.isArray(x.l)) return;
        if (x.l.length) { x.s = x.s && typeof x.s === 'object' ? x.s : {}; x.s.s1 = (x.s.s1 || []).concat(x.l); }
        delete x.l;
      });
    }
    const b = o.backing && typeof o.backing === 'object' ? o.backing : null;
    S.backing = b
      ? { sound: typeof b.sound === 'string' && b.sound ? b.sound : 'string', vol: num(b.vol, 0, VOL_MAX, 0.36), on: b.on !== false,
        style: typeof b.style === 'string' ? b.style : 'drone', styleOpts: plain(b.styleOpts) }
      : { sound: S.layers[0].sound, vol: r3(num(o.droneVol, 0, 0.25, 0.09) / 0.25), on: o.drone !== false, style: 'drone', styleOpts: {} };   // v1
    // sections (v4); older songs become one section "A" holding everything
    const secs = Array.isArray(o.sections) ? o.sections.filter((x) => x && typeof x === 'object').slice(0, MAX_SECTIONS) : [];
    const cur = secs.length ? clamp(o.cur | 0, 0, secs.length - 1) : 0, ids = new Set();
    S.sections = (secs.length ? secs : [{ id: 'A', name: 'A' }]).map((x, k) => {
      const id = validId(x.id) && !ids.has(x.id) ? x.id : nextSecId([...ids].map((q) => ({ id: q })));
      ids.add(id);
      const m = { id, name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 20) : 'Section ' + (k + 1),
        color: typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : SEC_COLORS[k % SEC_COLORS.length],
        rep: clamp(Math.round(+x.rep) || 1, 1, MAX_REP), data: null };
      if (k !== cur) m.data = parseContent(x, S);
      return m;
    });
    S.cur = cur;
    S.migratedSections = secs.length ? 0 : 1;
    return S;
  }
  // ---------- automation lanes (per section): [{ id, target, points: [[t16, v 0..1, smooth?]] }] ----------
  // target: '<layer id>.vol|pan|cut|rev|dly' or 'backing.vol' | 'drums.vol' | 'master.vol'. A point's 3rd value 1 = the
  // segment after it is smooth (eased), else linear. See export.js (X.auto) for values, curves, playback and MIDI CC.
  const AUTO_RE = /^(?:(l\d{1,3})\.(vol|pan|cut|rev|dly)|(backing|drums|master)\.vol)$/, MAX_AUTO = 16, MAX_PTS = 400;
  function autoIn(a, layers) {
    if (!Array.isArray(a)) return [];
    const out = [], seen = new Set();
    for (const x of a) {
      if (!x || typeof x !== 'object' || typeof x.target !== 'string' || out.length >= MAX_AUTO) continue;
      const m = AUTO_RE.exec(x.target);
      if (!m || seen.has(x.target) || (m[1] && layers && !layers.some((l) => l.id === m[1]))) continue;
      seen.add(x.target);
      const pts = (Array.isArray(x.points) ? x.points : []).filter((p) => Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1])).slice(0, MAX_PTS)
        .map((p) => (p[2] ? [Math.max(0, r3(+p[0])), r3(clamp(+p[1], 0, 1)), 1] : [Math.max(0, r3(+p[0])), r3(clamp(+p[1], 0, 1))]))
        .sort((p, q) => p[0] - q[0]);
      out.push({ id: typeof x.id === 'string' && /^a\d{1,4}$/.test(x.id) ? x.id : 'a' + (out.length + 1), target: x.target, points: pts });
    }
    return out;
  }
  const autoOut = (a) => a.map((x) => ({ id: x.id, target: x.target, points: x.points.map((p) => (p[2] ? [r3(p[0]), r3(p[1]), 1] : [r3(p[0]), r3(p[1])])) }));
  const autoCopy = (a) => (Array.isArray(a) ? a.map((x) => ({ id: x.id, target: x.target, points: x.points.map((p) => p.slice()) })) : []);
  const tensionOf = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(clamp(v, 0, 1) * 1000) / 1000 : 0);

  // ---------- Tension dial (0..1, per section) ----------
  // The map highlights h(c, T) instead of the consonance c: T = 0 is c itself (Calm); higher T blends in a Gaussian around
  // target = 1 - T (Color ~0.5 = mid-consonance "spicy" notes, Tense 1 = the roughest). Applied at draw / fit time to the cached columns.
  const TENSION_W = 0.15;
  const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  function tensionH(c, T) {
    if (!(T > 0)) return c;
    const g = Math.exp(-(((c - (1 - T)) / TENSION_W) ** 2)), b = sstep(0, 0.4, T);
    return (1 - b) * c + b * g;
  }
  const tensionName = (T) => (T < 0.2 ? 'Calm' : T < 0.75 ? 'Color' : 'Tense');
  // Palette stops for the bright bands: cyan (Calm) -> amber (Color) -> red (Tense); null at 0 = the calm palette untouched.
  function tensionTint(T) {
    if (!(T > 0)) return null;
    const A = { c1: [0.38, 0.10, 0.55], c2: [0.0, 0.75, 0.86], c3: [1, 1, 1], G: [0.55, 0.95, 1] };
    const B = { c1: [0.45, 0.10, 0.36], c2: [1, 0.72, 0.2], c3: [1, 0.95, 0.8], G: [1, 0.85, 0.5] };
    const C = { c1: [0.5, 0.06, 0.15], c2: [1, 0.25, 0.18], c3: [1, 0.8, 0.75], G: [1, 0.5, 0.4] };
    const lo = T < 0.5 ? A : B, hi = T < 0.5 ? B : C, u = T < 0.5 ? T / 0.5 : (T - 0.5) / 0.5, o = {};
    for (const k of ['c1', 'c2', 'c3', 'G']) o[k] = lo[k].map((v, i) => v + (hi[k][i] - v) * u);
    return o;
  }

  // ---------- Map look (a view preference, VH.store 'melody.look'; never part of the song) ----------
  const LOOK_DEFAULTS = { clarity: 0, theme: 'aurora', thick: 50, glow: 50, dark: 50, grid: 100, regions: true, piano: true, labels: true };
  const LOOK_THEMES = {   // palette stops of the band gradient: c0 (background) -> c1 -> c2 -> c3 (peak), G = the glow colour
    aurora: { name: 'Aurora', c0: [0.03, 0.04, 0.16], c1: [0.38, 0.10, 0.55], c2: [0.0, 0.75, 0.86], c3: [1, 1, 1], G: [0.55, 0.95, 1] },
    ember: { name: 'Ember', c0: [0.06, 0.02, 0.02], c1: [0.5, 0.1, 0.05], c2: [0.95, 0.45, 0.1], c3: [1, 0.95, 0.7], G: [1, 0.6, 0.2],
      hot: { c1: [0.45, 0.02, 0.25], c2: [1, 0.12, 0.45], c3: [1, 0.8, 0.9], G: [1, 0.4, 0.6] } },   // Tension: toward crimson
    ocean: { name: 'Ocean', c0: [0.01, 0.04, 0.12], c1: [0.02, 0.2, 0.45], c2: [0.15, 0.6, 0.95], c3: [0.85, 0.97, 1], G: [0.4, 0.8, 1] },
    forest: { name: 'Forest', c0: [0.02, 0.06, 0.04], c1: [0.08, 0.3, 0.15], c2: [0.45, 0.8, 0.3], c3: [0.95, 1, 0.8], G: [0.7, 1, 0.5] },
    mono: { name: 'Mono', c0: [0.04, 0.04, 0.04], c1: [0.25, 0.25, 0.25], c2: [0.65, 0.65, 0.65], c3: [1, 1, 1], G: [0.9, 0.9, 0.9],
      hot: { c1: [0.4, 0.22, 0.1], c2: [1, 0.6, 0.1], c3: [1, 0.95, 0.8], G: [1, 0.7, 0.3] } },   // Tension: an orange accent
    contrast: { name: 'High contrast', c0: [0, 0, 0], c1: [0.0, 0.25, 1], c2: [1, 1, 0], c3: [1, 1, 1], G: [1, 1, 0.5] },
    cvd: { name: 'Colour-blind safe', c0: [0.267, 0.005, 0.329], c1: [0.165, 0.44, 0.56], c2: [0.37, 0.79, 0.38], c3: [0.99, 0.91, 0.14], G: [0.9, 0.95, 0.5] }
  };
  function lookIn(o) {   // validate a stored look
    const d = LOOK_DEFAULTS, r = Object.assign({}, d);
    if (o && typeof o === 'object') {
      for (const k of ['clarity', 'thick', 'glow', 'dark', 'grid']) if (typeof o[k] === 'number' && isFinite(o[k])) r[k] = clamp(Math.round(o[k]), 0, 100);
      for (const k of ['regions', 'piano', 'labels']) if (typeof o[k] === 'boolean') r[k] = o[k];
      if (LOOK_THEMES[o.theme]) r.theme = o.theme;
    }
    return r;
  }
  // The clarity + thickness curve on one column's highlight values t (0..1 per row, 1 = brightest). Clarity 0 and the
  // default thickness return t itself (identity). Rising clarity turns the map into clean lines: every meaningful local
  // maximum (prominence over its +-6 row neighbourhood >= 0.04, so no absolute floor) is kept as a thin line that is
  // lifted toward at least 35% brightness while still following its own strength; everything between the lines fades
  // to the background (a stays * (1 - c)^2). The thickness slider above its middle widens the lines. Non-line rows
  // never get brighter with more clarity and lines never get dimmer.
  const LOOK_PROM = 0.04, LOOK_WIN = 6, LOOK_MIN = 0.35;
  function lookCurve(t, o) {
    const c = clamp((o.clarity || 0) / 100, 0, 1), th = o.thick == null ? 50 : o.thick, n = t.length;
    if (c <= 0 && th === 50) return t;
    const p = th === 50 ? 1 : Math.pow(2, (50 - th) / 40), a = p === 1 ? t : Float32Array.from(t, (v) => Math.pow(v, p));
    if (c <= 0) return a;
    const rad = Math.round(Math.max(0, th - 50) / 50 * 3), k = (1 - c) * (1 - c), out = new Float32Array(n), line = new Uint8Array(n);
    for (let r = 0; r < n; r++) out[r] = a[r] * k;
    for (let r = 0; r < n; r++) {
      if (!((r === 0 || a[r] >= a[r - 1]) && (r === n - 1 || a[r] > a[r + 1]))) continue;
      let lo = a[r];
      for (let q = Math.max(0, r - LOOK_WIN); q <= Math.min(n - 1, r + LOOK_WIN); q++) lo = Math.min(lo, a[q]);
      if (a[r] - lo < LOOK_PROM) continue;
      const pv = (1 - c) * a[r] + c * (LOOK_MIN + (1 - LOOK_MIN) * a[r]);
      for (let q = Math.max(0, r - rad); q <= Math.min(n - 1, r + rad); q++) {
        const v = pv * (1 - Math.abs(q - r) / (rad + 1));
        if (v > out[q]) { out[q] = v; if (q === r) line[r] = 1; }
      }
    }
    return out;
  }
  // Palette stops for a theme, with the Tension tint blended in theme-aware: the tint's change from Aurora is added to
  // the theme's own stops (Aurora itself = the tint exactly; others turn toward warm; Mono gains an orange accent).
  function lookStops(theme, tint, dark) {
    const th = LOOK_THEMES[theme] || LOOK_THEMES.aurora, A = LOOK_THEMES.aurora, o = { c0: th.c0.slice(), c1: th.c1, c2: th.c2, c3: th.c3, G: th.G };
    if (tint && th.hot) {   // already warm / colourless themes: blend toward their own hot stops by how far the tint has moved
      const w = clamp(Math.hypot(...tint.c2.map((v, i) => v - A.c2[i])) / 1.2, 0, 1);
      for (const k of ['c1', 'c2', 'c3', 'G']) o[k] = th[k].map((v, i) => v + (th.hot[k][i] - v) * w);
    } else if (tint && th !== A) for (const k of ['c1', 'c2', 'c3', 'G']) o[k] = th[k].map((v, i) => clamp(v + tint[k][i] - A[k][i], 0, 1));
    else if (tint) for (const k of ['c1', 'c2', 'c3', 'G']) o[k] = tint[k];
    const d = dark == null ? 50 : dark;
    if (d !== 50) o.c0 = o.c0.map((v) => clamp(d > 50 ? v * (1 - (d - 50) / 50) : v + (50 - d) / 50 * 0.16, 0, 1));
    return o;
  }
  function barsIn(b, v4) {
    const n = Math.round(+b);
    if (!v4) return [4, 8, 16].includes(n) ? n : isFinite(n) && n >= 1 && n <= MAX_BARS ? n : 4;
    return isFinite(n) ? clamp(n, 1, MAX_BARS) : 4;
  }
  // A layer's content (strokes + notes) from its serialized form into lay (lines / notes). mig counts v1 / v2 lines.
  function fillContent(lay, l, bars, ts, mig) {
    const n16 = (TS[ts] || TS['4/4']).spb, len = bars * n16 * 3, tot = bars * n16;
    const fill = (v, list) => {
      for (const sg of Array.isArray(list) ? list : []) {
        if (!Array.isArray(sg)) continue;
        for (let k = 1; k < sg.length; k++) {
          const i = (sg[0] | 0) + k - 1;
          if (i >= 0 && i < len && typeof sg[k] === 'number' && isFinite(sg[k])) v[i] = clamp(sg[k], LO, HI);
        }
      }
    };
    // v3: strokes [{ id, segs }]; v1 / v2: one `line` (segments) -> stroke s1
    const src2 = Array.isArray(l.lines) ? l.lines.filter((x) => x && typeof x === 'object').slice(0, MAX_STROKES)
      : Array.isArray(l.line) && l.line.length ? (mig && mig.lines++, [{ id: 's1', segs: l.line }]) : [];
    const seen = new Set();
    lay.lines = [];
    src2.forEach((x) => {
      const id = typeof x.id === 'string' && /^s\d{1,6}$/.test(x.id) && !seen.has(x.id) ? x.id : nextStrokeId(lay);
      seen.add(id);
      const st = { id, v: new Float32Array(len).fill(NaN) };
      fill(st.v, x.segs); lay.lines.push(st);
    });
    pruneStrokes(lay);
    lay.notes = (Array.isArray(l.notes) ? l.notes : []).filter((n) => Array.isArray(n) && n.length >= 3)
      .map((n) => ({ s: n[0] | 0, d: n[1] | 0, m: num(n[2], LO, HI, 60) }))
      .filter((n) => n.s >= 0 && n.d > 0 && n.s < tot);
    lay.notes.forEach((n) => { n.d = Math.min(n.d, tot - n.s); });
    return lay;
  }
  // A non-current section's serialized content -> runtime data (layers keyed by the song's layer ids).
  function parseContent(x, S) {
    const bars = barsIn(x.bars, true), ts = TS[x.ts] ? x.ts : '4/4', layers = {};
    (Array.isArray(x.layers) ? x.layers : []).forEach((l) => {
      if (!l || typeof l !== 'object' || !S.layers.some((q) => q.id === l.id) || layers[l.id]) return;
      const c = { lines: [], notes: [] };
      fillContent(c, l, bars, ts, null);
      layers[l.id] = c;
    });
    const dr = plain(x.drums); delete dr.vol;
    return { bars, ts, key: typeof x.key === 'number' ? num(x.key, 0, 11, 0) | 0 : S.key, mode: modeIn(x.mode, S.mode), chords: parseChords(x.chords || [], true, bars, ts), loopRegion: regionOf({ loopRegion: x.loopRegion, bars }), tension: tensionOf(x.tension), auto: autoIn(x.auto, S.layers),
      drums: dr, vib: x.vib && typeof x.vib === 'object' ? plain(x.vib) : null, layers };
  }

  const modeIn = (m, d) => (typeof m === 'string' && SCALE[m] ? m : d);
  // Chord tones as midis from LO. With a song S in a non-12 tuning: tuned (harmony.tunedChord, grid anchored at the
  // key root: ch.kp in flattened songs, else S.key). Without S (names, the header): the plain equal-tempered midis.
  const chordMidis = (ch, S) => {
    const iv = QUALS[QI[ch[1]]][2];
    if (!S || tuningOf(S) === '12tet') return iv.map((i) => LO + ch[0] + i);
    return HM.tunedChord(tuningOf(S), ch.kp != null ? ch.kp : S.key, ch[0], iv, LO);
  };
  const scaleOf = (S) => SCALE[S.mode] || SCALE.major;
  const namesOf = (S) => (scaleOf(S).flat.includes(S.key) ? FLAT : SHARP);
  const chordName = (ch, names) => (ch ? names[ch[0]] + QUALS[QI[ch[1]]][1] : 'No chord');
  // Chords of the key's scale (harmony.scaleChords): one triad per degree for seven-note scales, else every fitting
  // triad / 7th. diatonic(S) -> [[root, q]] (first = the tonic chord); scaleChords(S) -> [{ r, q, deg, k, rn }].
  const scaleChords = (S) => HM.scaleChords(S.key, scaleOf(S));
  const diatonic = (S) => scaleChords(S).map((c) => [c.r, c.q]);
  // "D Dorian", "A minor", "C major"
  const scaleLabel = (S) => namesOf(S)[S.key] + ' ' + (S.mode === 'major' ? 'major' : S.mode === 'minor' ? 'minor' : scaleOf(S).name);
  // The tuning grid of the shown section: every pitch of the song's tuning in LO..HI (anchored at the key root), its step
  // class, and the scale's classes. 12-TET: the integer midis. Cached per tuning + key + scale.
  const gridMemo = new Map();
  function gridOf(S) {
    const tn = tuningOf(S), k = tn + '|' + S.key + '|' + S.mode;
    let G = gridMemo.get(k);
    if (G) return G;
    const g = HM.tuningGrid(tn, S.key, LO, HI), pts = g.pts, cls = g.cls, sc = new Set(HM.scaleClasses(tn, scaleOf(S).steps));
    const idx = (m) => {   // nearest grid index (ties go up, like Math.round)
      let lo = 0, hi = pts.length - 1;
      if (m <= pts[0]) return 0;
      if (m >= pts[hi]) return hi;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid] <= m) lo = mid; else hi = mid; }
      return m - pts[lo] < pts[hi] - m - 1e-9 ? lo : hi;
    };
    G = { tuning: tn, et12: tn === '12tet', N: g.N, cents: g.cents, root: S.key, pts, cls, scaleCls: sc, idx,
      snap: (m) => pts[idx(m)], inScale: (m) => sc.has(cls[idx(m)]) };
    if (gridMemo.size > 64) gridMemo.clear();
    gridMemo.set(k, G);
    return G;
  }
  const gridSnap = (S, m) => clamp(gridOf(S).snap(clamp(m, LO, HI)), LO, HI);
  const secPerBar = (S) => spb(S) * 15 / S.bpm;   // the bar's sixteenths (bpm counts quarter notes)
  const secPer16 = (S) => 15 / S.bpm;
  // Effective layer gain from vol / mute / solo (solo affects layers only, not the backing).
  const layerGain = (S, L) => {
    const l = S.layers[L];
    if (!l || l.mute) return 0;
    if (S.layers.some((x) => x.solo) && !l.solo) return 0;
    return l.vol;
  };

  NS.model = { LOOK_DEFAULTS, LOOK_THEMES, lookIn, lookCurve, lookStops, tensionH, tensionName, tensionTint, TENSION_W, LO, HI, SPAN, LPB, SPB, MAX_LAYERS, BPM_MIN, BPM_MAX, SHARP, FLAT, QUALS, QI, SCALE, NATURAL, COLORS,
    GAIN, VOL_MAX, MAX_STROKES, strokes, nextStrokeId, addStroke, strokeEmpty, pruneStrokes, lineAt, hasLine, lineRuns, withLegacyLine, volDb, volLabel, clamp, r2, regionOf, newLayer, nextLayerId, assignIds, defaultSong, segs, serialize, parse, chordMidis, scaleOf, namesOf, chordName, diatonic,
    scaleChords, scaleLabel, SCALE_GROUPS, TUNINGS, tuningOf, gridOf, gridSnap, modeIn,
    secPerBar, secPer16, layerGain,
    TS, TS_LIST, tsOf, spb, lpb, tot16, barsOf, barAt, beatGrid,
    normChords, regionAt, regionEnd, chordAt, regionChord, regions, barChords, isBarStart, splitAt, mergeAt, serChords, parseChords,
    MAX_SECTIONS, MAX_BARS, MAX_REP, SEC_COLORS, SEC_NAMES, nextSecId, liveContent, copyContent, contentOf, applyContent, selectSection,
    emptyContent, sectionSong, arrangement, songTot, flatten, autoIn, autoOut, autoCopy, AUTO_RE, MAX_AUTO };
})();
