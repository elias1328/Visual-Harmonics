// melody/export.js - part: MIDI / WAV / MP3 export. See MELODY.md.
// Pure helpers (Node-testable): songToMidi(song, opts) -> Uint8Array (Standard MIDI File), encodeWav(channels, sr),
// drumHits(drums, bars), gmProgram(sound). In the browser the part adds a Settings section "Export" with a dialog.
// Audio is rendered offline (OfflineAudioContext) through the real voices via VH.audio.withContext; MP3 uses the
// vendored lamejs (js/vendor/lamejs, LGPL), loaded lazily with a <script> tag only when MP3 is chosen.
(function (root) {
  'use strict';
  const LPB = 48, SPB = 16, PPQ = 960;
  const T16 = PPQ / 4, TLINE = PPQ * 4 / LPB, TBEND = PPQ / 64;   // ticks per sixteenth / line sample / bend step
  const QI = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
    7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };
  const chordMidisLocal = (ch) => (QI[ch[1]] || QI.maj).map((i) => 48 + ch[0] + i);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Time signatures (see model.js TS): sixteenths per bar, and the MIDI meta (numerator, log2 denominator, clocks/click).
  const TSI = { '2/4': [8, 2, 2, 24], '3/4': [12, 3, 2, 24], '4/4': [16, 4, 2, 24], '5/4': [20, 5, 2, 24], '6/8': [12, 6, 3, 36], '7/8': [14, 7, 3, 12], '12/8': [24, 12, 3, 36] };
  const spbOf = (S) => (TSI[S && S.ts] || TSI['4/4'])[0];
  const totOf = (S) => (S.flat ? S.flat.tot : S.bars * spbOf(S));
  // Chord regions of a song: [{ at, z, chord }]. Accepts chord events ({ at, chord }) and the older one-per-bar arrays.
  function chordRegions(S) {
    const c = Array.isArray(S.chords) ? S.chords : [], tot = totOf(S), n = spbOf(S);
    if (c.some((e) => e && !Array.isArray(e) && typeof e === 'object' && 'at' in e)) {
      const ev = c.filter((e) => e && typeof e === 'object').slice().sort((x, y) => x.at - y.at);
      return ev.map((e, i) => ({ at: e.at, z: i + 1 < ev.length ? ev[i + 1].at : tot, chord: e.chord || null }));
    }
    return c.map((ch, b) => ({ at: b * n, z: (b + 1) * n, chord: Array.isArray(ch) ? ch : null }));
  }

  // Bars [a, b) of a (runtime) song as a song of its own, for "Export loop region only": chords, lines, notes starting
  // in the range, per-bar drum patterns and vibrato (song.ext.edit.vib) shifted to start at bar 0.
  function sliceSong(S, a, b) {
    const N = spbOf(S), n = b - a, o = Object.assign({}, S), l0 = a * N * 3, l1 = b * N * 3, s0 = a * N, s1 = b * N;
    const copy = (x) => (x && typeof x === 'object' ? JSON.parse(JSON.stringify(x)) : {});
    o.bars = n; o.loopRegion = null; delete o.flat; o.arpOff = s0;
    o.chords = chordRegions(S).filter((e) => e.at >= s0 && e.at < s1).map((e) => ({ at: e.at - s0, chord: e.chord ? e.chord.slice() : null }));
    o.layers = S.layers.map((l) => Object.assign({}, l, {
      lines: strokesOf(l).map((st) => ({ id: st.id, v: st.v.slice(l0, l1) })).filter((st) => st.v.some((v) => !isNaN(v))),
      notes: l.notes.filter((x) => x.s >= s0 && x.s < s1).map((x) => ({ s: x.s - s0, d: Math.min(x.d, s1 - x.s), m: x.m })),
    }));
    o.drums = copy(S.drums);
    if (o.drums.bars && typeof o.drums.bars === 'object') {
      const nb = {};
      Object.keys(o.drums.bars).forEach((k) => { const i = +k - a; if (i >= 0 && i < n) nb[i] = o.drums.bars[k]; });
      o.drums.bars = nb;
    }
    o.auto = AUTO.slice(S.auto, s0, s1); delete o.flatAuto;
    o.ext = copy(S.ext);
    const vib = o.ext.edit && o.ext.edit.vib;
    if (vib && typeof vib === 'object') {
      Object.keys(vib).forEach((k) => {
        const x = vib[k] || {};
        const cut = (rs) => (Array.isArray(rs) ? rs : []).map((r) => [Math.max(0, r[0] - l0), Math.min(l1, r[1]) - l0, r[2], r[3]]).filter((r) => r[1] > r[0]);
        if (Array.isArray(x.l)) x.l = cut(x.l);
        if (x.s && typeof x.s === 'object') Object.keys(x.s).forEach((q) => { x.s[q] = cut(x.s[q]); });
        x.n = (Array.isArray(x.n) ? x.n : []).filter((r) => r[0] >= s0 && r[0] < s1).map((r) => [r[0] - s0, r[1], r[2], r[3]]);
      });
    }
    return o;
  }

  // ---------- GM helpers ----------
  const GM = [[/piano|keys|rhodes/, 0], [/celesta/, 8], [/glock/, 9], [/kalimba/, 108], [/marimba/, 12], [/xylo/, 13],
    [/bell|chime/, 14], [/organ/, 19], [/harpsi/, 6], [/guitar|lute/, 24], [/harp/, 46], [/pizz/, 45], [/pluck/, 24],
    [/cello/, 42], [/viol|fiddle/, 40], [/trem/, 44], [/string/, 48], [/choir|vowel|voice/, 52], [/trumpet/, 56], [/horn/, 60],
    [/brass/, 61], [/oboe/, 68], [/bassoon/, 70], [/clarinet/, 71], [/flute|whistle|recorder/, 73], [/glass/, 92],
    [/pad|drone/, 89], [/sine|pure/, 80], [/wind|wood/, 73]];
  function gmProgram(s) {
    const t = s ? [s.id, s.name, s.family].join(' ').toLowerCase() : '';
    for (const [re, p] of GM) if (re.test(t)) return p;
    return 48;
  }
  const DRUM_MAP = [[/kick|bass ?drum|^bd$/, 36], [/rim/, 37], [/snare|^sd$/, 38], [/clap/, 39], [/open|^oh$/, 46],
    [/hat|^hh$|closed/, 42], [/high ?tom|hi ?tom/, 50], [/mid ?tom/, 47], [/tom/, 45], [/crash|cymbal/, 49], [/ride/, 51],
    [/cowbell/, 56], [/tamb/, 54], [/shak/, 70], [/wood|block/, 76], [/perc|click|stick/, 37]];
  function drumNote(name) {
    if (typeof name === 'number' && name >= 27 && name <= 87) return name | 0;
    const n = String(name || '').toLowerCase();
    if (/^\d+$/.test(n) && +n >= 27 && +n <= 87) return +n;
    for (const [re, v] of DRUM_MAP) if (re.test(n)) return v;
    return 0;
  }
  function stepVel(v) {
    if (v === true) return 100;
    if (typeof v === 'number' && v > 0) return v <= 1 ? Math.max(1, Math.round(v * 120)) : clamp(Math.round(v), 1, 127);
    if (v && typeof v === 'object') return stepVel(v.v ?? v.vel ?? v.on ?? 1);
    return 0;
  }
  // Read a drum pattern defensively (B2 owns the format). Accepts { on, pattern|steps|tracks|lanes|rows|grid: ... }
  // where the lanes are { name: [steps] } or [{ name|id|type|sound|note, steps|pattern|hits }]. A lane of n steps
  // spans one bar (n <= 16), n / 16 bars (n % 16 == 0) or the whole song. -> [{ t16, note, vel, name }] sorted.
  function drumHits(drums, bars) {
    if (!drums || typeof drums !== 'object' || drums.on === false || drums.enabled === false || drums.mute === true) return [];
    if (drums.pat && typeof drums.pat === 'object') {   // B2: { on, pat: { len, kick: 'x...o...', ... }, vary, bars: { b: pat } }
      if (drums.on !== true) return [];
      const out = [];
      for (let b = 0; b < bars; b++) {
        const p = drums.vary && drums.bars && drums.bars[b] ? drums.bars[b] : drums.pat, len = p.len > 0 ? p.len : 16;
        for (const k of Object.keys(p)) {
          if (typeof p[k] !== 'string') continue;
          const note = k === 'perc' ? 76 : drumNote(k);
          if (!note) continue;
          for (let j = 0; j < len; j++) { const c = p[k][j]; if (c === 'x' || c === 'o') out.push({ t16: b * SPB + j * SPB / len, note, vel: c === 'x' ? 110 : 55, name: k }); }
        }
      }
      return out.sort((a, b) => a.t16 - b.t16 || a.note - b.note);
    }
    let src = drums.pattern || drums.steps || drums.tracks || drums.lanes || drums.rows || drums.grid || drums.parts || drums;
    if (src && !Array.isArray(src) && typeof src === 'object' && src.lanes) src = src.lanes;
    const lanes = [];
    if (Array.isArray(src)) {
      for (const l of src) {
        if (!l || typeof l !== 'object' || Array.isArray(l)) continue;
        const steps = l.steps || l.pattern || l.hits || l.grid;
        if ((Array.isArray(steps) || typeof steps === 'string') && l.on !== false && !l.mute) lanes.push([l.note ?? l.name ?? l.id ?? l.type ?? l.sound, steps]);
      }
    } else if (src && typeof src === 'object') {
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (Array.isArray(v) || (typeof v === 'string' && /^[xo.\-_ 01]+$/i.test(v))) lanes.push([k, v]);
        else if (v && typeof v === 'object' && Array.isArray(v.steps || v.pattern) && v.on !== false && !v.mute) lanes.push([v.note ?? k, v.steps || v.pattern]);
      }
    }
    const out = [], tot = bars * SPB;
    for (const [name, raw] of lanes) {
      const steps = typeof raw === 'string' ? Array.from(raw, (c) => (c === 'x' || c === 'X' || c === '1' ? 1 : c === 'o' ? 0.5 : 0)) : raw;
      const note = drumNote(name), n = steps.length;
      if (!note || !n || !steps.some((x) => stepVel(x) > 0)) continue;
      let span;   // sixteenths covered by the lane before it repeats
      if (n <= SPB) span = SPB; else if (n === tot) span = tot; else if (n % SPB === 0) span = n; else span = SPB * Math.ceil(n / SPB);
      const unit = span / n;
      for (let base = 0; base < tot; base += span) {
        for (let i = 0; i < n; i++) {
          const vel = stepVel(steps[i]), t16 = base + i * unit;
          if (vel > 0 && t16 < tot) out.push({ t16, note, vel, name: String(name) });
        }
      }
    }
    return out.sort((a, b) => a.t16 - b.t16 || a.note - b.note);
  }

  // ---------- Standard MIDI File writer ----------
  function vlq(n) {
    n = Math.max(0, Math.round(n));
    const b = [n & 0x7f];
    while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80);
    return b;
  }
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  const txt = (s) => { const e = unescape(encodeURIComponent(String(s))); return Array.from(e, (c) => c.charCodeAt(0)); };
  const meta = (type, data) => [0xff, type].concat(vlq(data.length), data);
  // events: [{ t (ticks), o (order at equal t), b (bytes) }]
  function chunk(events) {
    const ev = events.slice().sort((a, b) => a.t - b.t || a.o - b.o);
    const end = ev.length ? ev[ev.length - 1].t : 0, bytes = [];
    let last = 0;
    for (const e of ev) { bytes.push(...vlq(e.t - last), ...e.b); last = e.t; }
    bytes.push(...vlq(0), 0xff, 0x2f, 0x00);
    void end;
    return [0x4d, 0x54, 0x72, 0x6b].concat(u32(bytes.length), bytes);
  }
  // Order at equal ticks: setup 0, note-off 1, bend 2, note-on 3 (so a re-struck note's off comes first).
  const O = { setup: 0, off: 1, bend: 2, on: 3 };
  function bendEv(t, ch, v) { v = clamp(Math.round(v), 0, 16383); return { t, o: O.bend, b: [0xe0 | ch, v & 0x7f, v >> 7], bend: v }; }
  const bendOf = (semis) => 8192 + semis / 12 * 8191;
  function setupEvents(ch, program, vol, name, withPrefix) {
    const b = [];
    const add = (bytes) => b.push({ t: 0, o: O.setup, b: bytes });
    if (withPrefix && name) { add(meta(0x20, [ch])); add(meta(0x04, txt(name))); }
    if (ch !== 9) {
      add([0xb0 | ch, 101, 0]); add([0xb0 | ch, 100, 0]); add([0xb0 | ch, 6, 12]); add([0xb0 | ch, 38, 0]);   // RPN 0: bend range ±12
      add([0xb0 | ch, 101, 127]); add([0xb0 | ch, 100, 127]);   // RPN null
      add([0xc0 | ch, program & 127]);
    }
    add([0xb0 | ch, 7, clamp(Math.round(vol * 127), 0, 127)]);
    return b;
  }
  // Vibrato parameters stored by B1 (read defensively): { rate Hz, depth semitones | cents }.
  function vibOf(o) {
    const v = o && (o.vib || o.vibrato);
    if (!v || typeof v !== 'object') return null;
    const rate = +(v.rate ?? v.hz ?? v.speed), depthRaw = +(v.depth ?? v.amount ?? v.semis ?? (v.cents != null ? v.cents / 100 : NaN));
    if (!(rate > 0) || !(depthRaw > 0)) return null;
    const depth = depthRaw > 3 ? depthRaw / 100 : depthRaw;   // > 3 means cents
    return { rate, depth };
  }

  // A layer's line strokes [{ id, v }]: runtime songs have `lines`; plain objects with one `line` array (older callers,
  // tests) count as stroke 's1'.
  function strokesOf(l) {
    if (!l) return [];
    if (Array.isArray(l.lines)) return l.lines.filter((st) => st && st.v && st.v.length != null);
    return l.line && l.line.length != null ? [{ id: 's1', v: l.line }] : [];
  }
  // Vibrato of layer L. B1 stores it in song.ext.edit.vib[L] = { s: { <stroke id>: [[from, to (exclusive), cents, hz]] }
  // (line sample ranges per stroke), n: [[s, m, cents, hz]] (notes by start + pitch) }; cents = sine amplitude. The
  // older { l: ranges } (one line) counts as stroke 's1'. Also accepts note.vib / vibrato.
  // -> { line(i, strokeId = 's1') -> { depth (semitones), rate } | null, note(n) -> same }
  function vibReader(song, L) {
    const v = song && song.ext && song.ext.edit && song.ext.edit.vib, x = v && v[L];
    const sr = Object.assign({}, x && x.s && typeof x.s === 'object' ? x.s : {});
    if (x && Array.isArray(x.l) && x.l.length) sr.s1 = (Array.isArray(sr.s1) ? sr.s1 : []).concat(x.l);
    const nr = x && Array.isArray(x.n) ? x.n : [];
    const mk = (r) => (r && r[2] > 0 ? { depth: r[2] / 100, rate: r[3] > 0 ? r[3] : 5.5 } : null);
    return {
      line(i, k) { const lr = sr[k || 's1']; if (Array.isArray(lr)) for (const r of lr) if (i >= r[0] && i < r[1]) return mk(r); return null; },
      note(n) { for (const r of nr) if (r[0] === n.s && Math.abs(r[1] - n.m) < 0.006) return mk(r); return vibOf(n); },
    };
  }
  // Line runs -> note + bend events on channel ch, offset by off16 sixteenths. `line` = the stroke's samples; `runs`
  // (optional, [[i, j]] inclusive) limits it to those runs (default: every run); k = the stroke id (vibrato).
  function lineEvents(line, ch, off16, secPer16, vr, vel, runs, k) {
    const ev = [], n = line.length, base0 = off16 * T16;
    if (!runs) {
      runs = [];
      for (let i = 0; i < n; i++) { if (isNaN(line[i])) continue; let j = i; while (j + 1 < n && !isNaN(line[j + 1])) j++; runs.push([i, j]); i = j; }
    }
    for (const [i, j] of runs) {
      // segment i..j; value at tick t (relative to i*TLINE) linear between samples, last sample held
      const t0 = i * TLINE, t1 = (j + 1) * TLINE;
      const at = (t) => {   // vibrato phase runs on song time, like the live hook
        const f = t / TLINE, q = Math.min(j, Math.floor(f)), u = f - q, v = vr ? vr.line(q, k) : null;
        let m = q >= j ? line[j] : line[q] * (1 - u) + line[q + 1] * u;
        if (v) m += v.depth * Math.sin(2 * Math.PI * v.rate * (t / T16) * secPer16);
        return m;
      };
      let note = Math.round(line[i]), lastBend = -1;
      const on = (t, m) => {
        note = clamp(Math.round(m), 0, 127);
        const b = bendEv(base0 + t, ch, bendOf(m - note)); ev.push(b); lastBend = b.bend;
        ev.push({ t: base0 + t, o: O.on, b: [0x90 | ch, note, vel] });
      };
      on(t0, at(t0));
      for (let t = t0 + TBEND; t < t1; t += TBEND) {
        const m = at(t);
        if (Math.abs(m - note) > 12) {   // left the ±12 bend range: restart the note
          ev.push({ t: base0 + t, o: O.off, b: [0x80 | ch, note, 0] });
          on(t, m);
          continue;
        }
        const bv = clamp(Math.round(bendOf(m - note)), 0, 16383);
        if (bv !== lastBend) { ev.push(bendEv(base0 + t, ch, bv)); lastBend = bv; }
      }
      ev.push({ t: base0 + t1, o: O.off, b: [0x80 | ch, note, 0] });
    }
    return ev;
  }
  // Line voices of a layer: every run of every stroke, packed greedily into voices so that runs sharing a voice never
  // overlap in time (pitch bends are per MIDI channel, so overlapping glides need channels of their own).
  // -> [[{ st, a, b }, ...], ...] (one list per voice)
  function lineVoices(l) {
    const runs = [];
    for (const st of strokesOf(l)) {
      const v = st.v;
      for (let i = 0; i < v.length; i++) { if (isNaN(v[i])) continue; let j = i; while (j + 1 < v.length && !isNaN(v[j + 1])) j++; runs.push({ st, a: i, b: j }); i = j; }
    }
    runs.sort((x, y) => x.a - y.a || x.b - y.b);
    const voices = [], ends = [];
    for (const r of runs) {
      let k = ends.findIndex((e) => e < r.a);
      if (k < 0) { k = voices.length; voices.push([]); ends.push(-1); }
      voices[k].push(r); ends[k] = r.b;
    }
    return voices;
  }
  // Non-overlapping voices of timed items [{ a, z, ... }] (greedy, in start order): a tuned song (non-12 tuning) gives
  // every simultaneous note its own MIDI channel, since pitch bend is per channel (same idea as lineVoices).
  function packVoices(items) {
    const voices = [], ends = [];
    items.slice().sort((x, y) => x.a - y.a || x.z - y.z).forEach((it) => {
      let k = ends.findIndex((e) => e <= it.a);
      if (k < 0) { k = voices.length; voices.push([]); ends.push(-Infinity); }
      voices[k].push(it); ends[k] = it.z;
    });
    return voices;
  }
  function noteEvents(notes, ch, off16, secPer16, vel, vr) {
    const ev = [];
    for (const nt of notes.slice().sort((a, b) => a.s - b.s)) {
      const t0 = (off16 + nt.s) * T16, t1 = (off16 + nt.s + nt.d) * T16, k = clamp(Math.round(nt.m), 0, 127);
      ev.push(bendEv(t0, ch, bendOf(nt.m - k)));
      ev.push({ t: t0, o: O.on, b: [0x90 | ch, k, vel] });
      const v = vr ? vr.note(nt) : vibOf(nt);
      if (v) for (let t = t0 + TBEND; t < t1; t += TBEND) {
        ev.push(bendEv(t, ch, bendOf(nt.m - k + v.depth * Math.sin(2 * Math.PI * v.rate * ((t - t0) / T16) * secPer16))));
      }
      ev.push({ t: t1, o: O.off, b: [0x80 | ch, k, 0] });
    }
    return ev;
  }

  // song: { bars, bpm, chords, layers: [{ name, sound, vol, line, notes }], backing: { sound, vol }, drums }
  // opts: { mode: 'mixed'|'separate', layers: [indices], backing: bool, drums: bool, loops: 1|2,
  //         soundOf(i) -> Sound, backingSound -> Sound, chordMidis(ch) }
  // Returns Uint8Array. Mixed = format 0 (one track, one channel per part), Separate = format 1 (conductor + a track per
  // layer / backing / drums). A layer whose line strokes overlap gets one channel per simultaneous voice (channel 10 is
  // skipped), each with its own pitch bends; in Separate mode those channels share the layer's track.
  // Arpeggio layers (layer.arp, model.js arpEvents) play as separate short notes in place of their held notes / lines.
  const mdl = () => (typeof window !== 'undefined' && window.VH && window.VH.melody && window.VH.melody.model) || null;
  function arpLayer(song, i, peaksFor) {
    const l = song.layers[i], md = mdl();
    if (!l || !l.arp || !md || !md.arpEvents) return l;
    const ev = md.arpEvents(song, i, 0, totOf(song), l.arp.from === 'bands' && peaksFor ? peaksFor(i) : null);
    return Object.assign({}, l, { lines: [], notes: ev.map((e) => ({ s: e.t, d: e.d, m: e.m })) });
  }
  function songToMidi(song, opts) {
    const o = opts || {}, loops = Math.max(1, o.loops | 0 || 1), bars = song.bars, tot = totOf(song);
    const secPer16 = 15 / song.bpm, cm = o.chordMidis || chordMidisLocal, tuned = !!o.tuned;   // tuned: per-voice channels with bends
    const soundOf = o.soundOf || ((i) => ({ id: song.layers[i].sound, name: song.layers[i].sound }));
    const chosen = (o.layers || song.layers.map((_, i) => i)).filter((i) => song.layers[i]);
    const parts = [];   // { name, ch, program, vol, events }
    const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    const takeCh = (pref) => (free.length ? free.shift() : pref);
    const vel = 100;
    for (const i of chosen) {
      const l = arpLayer(song, i, o.arpPeaks), snd = soundOf(i) || {}, label = l.name + ' – ' + (snd.name || l.sound);
      const voices = lineVoices(l), hasLine = voices.length > 0, hasNotes = l.notes && l.notes.length > 0;
      if (!hasLine && !hasNotes) continue;
      const vr = vibReader(song, i), prog = gmProgram(snd), vol = l.vol ?? 0.8;
      const chs = voices.map((_, k) => takeCh(k ? -1 : 0)).map((c, k, a) => (c < 0 ? a[0] : c));
      const chL = hasLine ? chs[0] : takeCh(0), chN = hasLine && hasNotes ? takeCh(chL) : chL;
      const evV = voices.map(() => []), evN = [];
      // tuned: overlapping notes (chords in a notes layer) each get a channel of their own (extra parts below)
      const nv = tuned && hasNotes ? packVoices(l.notes.map((n) => ({ a: n.s, z: n.s + n.d, n }))) : null;
      const chX = nv ? nv.slice(1).map(() => takeCh(chN)) : [], evX = chX.map(() => []);
      for (let r = 0; r < loops; r++) {
        voices.forEach((runs, k) => {
          for (const x of runs) evV[k].push(...lineEvents(x.st.v, chs[k], r * tot, secPer16, vr, vel, [[x.a, x.b]], x.st.id));
        });
        if (nv) nv.forEach((vs, k) => (k ? evX[k - 1] : evN).push(...noteEvents(vs.map((x) => x.n), k ? chX[k - 1] : chN, r * tot, secPer16, vel, vr)));
        else if (hasNotes) evN.push(...noteEvents(l.notes, chN, r * tot, secPer16, vel, vr));
      }
      chX.forEach((c, k) => parts.push({ name: label + ' (notes ' + (k + 2) + ')', ch: c, program: prog, vol, track: i, own: l.id, events: evX[k] }));
      const many = voices.length > 1;
      voices.forEach((_, k) => {
        const same = chs[k] === chN && k === 0;   // a layer with one line voice and notes on the same channel
        parts.push({ name: label + (many ? ' (line ' + (k + 1) + ')' : ''), ch: chs[k], program: prog, vol, track: i, own: l.id, events: same ? evV[k].concat(evN) : evV[k] });
      });
      if (hasNotes && !(hasLine && chN === chs[0])) parts.push({ name: label + (hasLine ? ' (notes)' : ''), ch: chN, program: prog, vol, track: i, own: l.id, events: evN });
    }
    const regs = chordRegions(song);
    if (o.backing && regs.some((e) => e.chord)) {
      const ch = takeCh(8), snd0 = o.backingSound || { id: song.backing && song.backing.sound };
      // per-section backing instrument (section.back): the section of a flattened song's bar, its sound -> GM program (changes sent at the region start)
      const fb = song.flat && song.flat.bars, secOf = (t16) => { if (!fb) return null; let q = null; for (const b of fb) { if (b.a <= t16 + 1e-9) q = b.sec; else break; } return q; };
      const sndOf2 = (k) => (o.backingSoundOf ? o.backingSoundOf(k) : null) || snd0;
      const firstR = regs.find((e) => e.chord), snd = firstR ? sndOf2(secOf(firstR.at)) : snd0, prog = gmProgram(snd);
      const pcs = [];   // program changes [tick, program]
      let curProg = prog;
      let ev = [];
      const notes = [];   // tuned: { a, z (ticks), m (midi float), v }, written below with one channel per voice
      for (let r = 0; r < loops; r++) {
        regs.forEach((R, b) => {
          const c = R.chord;
          if (!c) return;
          const t0 = (r * tot + R.at) * T16, t1 = (r * tot + R.z) * T16;
          if (fb && o.backingSoundOf) { const pg = gmProgram(sndOf2(secOf(R.at))); if (pg !== curProg) { curProg = pg; pcs.push([Math.max(0, Math.round(t0) - 1), pg]); } }
          // the backing style + its sub-settings (B2's events per chord region: p = sixteenth from the region start,
          // dt / dur in seconds, g = gain)
          const bev = o.backingEvents ? o.backingEvents(b, c) : null;
          if (bev && bev.length) {
            const tk = T16 / secPer16;
            for (const e of bev) {
              const a = Math.max(0, Math.round(t0 + e.p * T16 + (e.dt || 0) * tk)), z = Math.max(a + 1, Math.round(a + e.dur * tk));
              const k = clamp(Math.round(e.m), 0, 127), v = clamp(Math.round(72 * (e.g || 0.25) / 0.25), 1, 127);
              if (tuned) { notes.push({ a, z, m: e.m, v }); continue; }
              ev.push({ t: a, o: O.on, b: [0x90 | ch, k, v] }); ev.push({ t: z, o: O.off, b: [0x80 | ch, k, 0] });
            }
            return;
          }
          for (const m of cm(c)) {
            if (tuned) { notes.push({ a: t0, z: t1, m, v: 72 }); continue; }
            ev.push({ t: t0, o: O.on, b: [0x90 | ch, m, 72] }); ev.push({ t: t1, o: O.off, b: [0x80 | ch, m, 0] });
          }
        });
      }
      const name = 'Backing chords – ' + (snd.name || snd.id || 'chords'), bvol = song.backing ? song.backing.vol : 0.4;
      const tone = (x, c) => { const k = clamp(Math.round(x.m), 0, 127); return [bendEv(x.a, c, bendOf(x.m - k)), { t: x.a, o: O.on, b: [0x90 | c, k, x.v] }, { t: x.z, o: O.off, b: [0x80 | c, k, 0] }]; };
      if (tuned) packVoices(notes).forEach((vs, k) => {
        const c = k ? takeCh(ch) : ch;
        const evk = pcs.map(([t, pg]) => ({ t, o: O.setup, b: [0xc0 | c, pg & 127] })).concat(...vs.map((x) => tone(x, c)));
        if (!k) ev = evk; else parts.push({ name: name + ' (voice ' + (k + 1) + ')', ch: c, program: prog, vol: bvol, track: 'backing', own: 'backing', events: evk });
      });
      if (!tuned) ev = pcs.map(([t, pg]) => ({ t, o: O.setup, b: [0xc0 | ch, pg & 127] })).concat(ev);
      parts.push({ name, ch, program: prog, vol: bvol, track: tuned ? 'backing' : undefined, own: 'backing', events: ev });
    }
    if (o.drums) {
      const hits = o.drumHits || drumHits(song.drums, bars);
      if (hits.length) {
        const ev = [];
        for (let r = 0; r < loops; r++) for (const h of hits) {
          const t0 = (r * tot + h.t16) * T16;
          ev.push({ t: t0, o: O.on, b: [0x99, h.note, h.vel] }); ev.push({ t: t0 + T16 / 2, o: O.off, b: [0x89, h.note, 0] });
        }
        parts.push({ name: 'Drums', ch: 9, program: 0, vol: (song.drums && typeof song.drums.vol === 'number') ? song.drums.vol : 0.8, own: 'drums', events: ev });
      }
    }
    const usPerQ = Math.round(60e6 / song.bpm);
    const conductor = [{ t: 0, o: O.setup, b: meta(0x03, txt(o.title || 'Visual Harmonics')) },
      { t: 0, o: O.setup, b: meta(0x51, [(usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255]) }];
    // time signature(s): one at the start, and one at every change (sections in other meters)
    const tsl = song.flat && song.flat.ts && song.flat.ts.length ? song.flat.ts : [{ at: 0, ts: song.ts || '4/4' }];
    let lastTs = '';
    for (let r = 0; r < loops; r++) for (const x of tsl) {
      if (x.ts === lastTs) continue;
      lastTs = x.ts;
      const q = TSI[x.ts] || TSI['4/4'], t = (r * tot + x.at) * T16;
      conductor.push({ t, o: O.setup, b: meta(0x58, [q[1], q[2], q[3], 8]) });
    }
    autoMidi(song, parts, conductor, tot, loops);
    const endT = loops * tot * T16;
    const tail = (ch) => [bendEv(endT, ch, 8192)];
    let tracks;
    if (o.mode === 'separate') {   // one track per layer (all its channels), backing, drums
      const groups = [];
      parts.forEach((p) => {
        const g = p.track != null ? groups.find((x) => x.track === p.track) : null;
        if (g) g.parts.push(p); else groups.push({ track: p.track, parts: [p] });
      });
      tracks = [conductor].concat(groups.map((g) => {
        const nm = g.parts.length > 1 ? g.parts[0].name.replace(/ \((line 1|notes)\)$/, '') : g.parts[0].name;
        let ev = [{ t: 0, o: -1, b: meta(0x03, txt(nm)) }];
        const done = new Set();
        g.parts.forEach((p) => { if (!done.has(p.ch)) { done.add(p.ch); ev = ev.concat(setupEvents(p.ch, p.program, p.vol, '', false)); } });
        g.parts.forEach((p) => { ev = ev.concat(p.events); });
        done.forEach((ch) => { if (ch !== 9) ev = ev.concat(tail(ch)); });
        return ev;
      }));
    } else {
      let ev = conductor.slice();
      for (const p of parts) ev = ev.concat(setupEvents(p.ch, p.program, p.vol, p.name, true), p.events, p.ch === 9 ? [] : tail(p.ch));
      tracks = [ev];
    }
    const head = [0x4d, 0x54, 0x68, 0x64].concat(u32(6), u16(o.mode === 'separate' ? 1 : 0), u16(tracks.length), u16(PPQ));
    const bytes = head.concat(...tracks.map(chunk));
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
  }

  // Automation lanes -> controller events on each automated part's channel(s): CC7 volume (x the fader), CC10 pan,
  // CC74 cutoff, CC91 reverb send, CC93 delay send; master volume as a Universal SysEx Master Volume in the conductor.
  // Sampled every 1/32 note (only value changes are written), after the channel setup at equal ticks.
  function autoMidi(song, parts, conductor, tot, loops) {
    const A = AUTO, tg = A.targets(song);
    if (!tg.length) return;
    const f = song.fx && typeof song.fx === 'object' ? song.fx : {};
    const send = (own, k) => {
      const r = own === 'backing' ? f.backing : own === 'drums' ? f.drums : (f.layers || [])[song.layers.findIndex((l) => l.id === own)];
      return r && typeof r === 'object' ? clamp(+r[k] || 0, 0, 1) : 0;
    };
    const done = new Set();
    for (const p of parts) {
      if (!p.own) continue;
      for (const t of tg) {
        const q = A.parseTarget(t);
        if (!q || q.own !== p.own || done.has(p.ch + ':' + t)) continue;
        done.add(p.ch + ':' + t);
        const neutral = q.kind === 'vol' || q.kind === 'cut' ? 1 : q.kind === 'pan' ? 0.5 : send(p.own, q.kind), cc = A.ccOf(q.kind);
        let last = -1;
        for (const [t16, v] of A.ccPoints(A.pieces(song, t), tot, loops, neutral)) {
          const val = A.ccValue(q.kind, v, p.vol);
          if (val === last) continue;
          last = val;
          p.events.push({ t: Math.round(t16 * T16), o: 0.5, b: [0xb0 | p.ch, cc, val] });
        }
      }
    }
    if (tg.includes('master.vol')) {
      let last = -1;
      for (const [t16, v] of A.ccPoints(A.pieces(song, 'master.vol'), tot, loops, 1)) {
        const x = clamp(Math.round(v * 16383), 0, 16383);
        if (x === last) continue;
        last = x;
        conductor.push({ t: Math.round(t16 * T16), o: 0.5, b: [0xf0, 0x07, 0x7f, 0x7f, 0x04, 0x01, x & 0x7f, x >> 7, 0xf7] });
      }
    }
  }

  // ---------- WAV (16-bit PCM) ----------
  function encodeWav(channels, sr) {
    const nc = channels.length, n = channels[0].length, data = n * nc * 2, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, data, true);
    let p = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      const s = clamp(channels[c][i], -1, 1);
      v.setInt16(p, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true); p += 2;
    }
    return new Uint8Array(buf);
  }

  // ---------- automation (pure): lane values, curves, playback ramps, MIDI CC ----------
  // A lane (model.js, per section): { id, target, points: [[t16, v 0..1, smooth?]] }. Targets: '<layer id>.<kind>' with
  // kind vol | pan | cut | rev | dly, or 'backing.vol' | 'drums.vol' | 'master.vol'. Values are 0..1 on the lane:
  //   vol: a gain multiplier on the channel's fader (1 = the fader level), shown in dB
  //   pan: -1..1 (StereoPanner), cut: lowpass cutoff CUT_LO..CUT_HI Hz on a log scale, rev / dly: the send level.
  // Between two points the curve is linear, or smooth (cosine ease) when the left point has p[2] = 1. Before the first
  // point it holds the first value, after the last the last. A section without a lane for a target is neutral there
  // (vol 1, pan centre, cutoff open, sends at the mixer's level).
  const AUTO = (function () {
    const CUT_LO = 40, CUT_HI = 20000;
    const KINDS = {
      vol: { label: 'Volume', cc: 7, def: 1 }, pan: { label: 'Pan', cc: 10, def: 0.5 }, cut: { label: 'Filter cutoff', cc: 74, def: 1 },
      rev: { label: 'Reverb send', cc: 91, def: 0.3 }, dly: { label: 'Delay send', cc: 93, def: 0.3 },
    };
    const RE = /^(?:(l\d{1,3})\.(vol|pan|cut|rev|dly)|(backing|drums|master)\.vol)$/;
    function parseTarget(t) {
      const m = RE.exec(String(t || ''));
      if (!m) return null;
      return m[1] ? { own: m[1], layer: m[1], kind: m[2], chan: null } : { own: m[3], layer: null, kind: 'vol', chan: m[3] };
    }
    // lane value -> the AudioParam value
    function real(kind, v) {
      v = clamp(+v || 0, 0, 1);
      if (kind === 'pan') return v * 2 - 1;
      if (kind === 'cut') return CUT_LO * Math.pow(CUT_HI / CUT_LO, v);
      return v;
    }
    const norm = (kind, x) => (kind === 'pan' ? clamp((x + 1) / 2, 0, 1) : kind === 'cut' ? clamp(Math.log(x / CUT_LO) / Math.log(CUT_HI / CUT_LO), 0, 1) : clamp(x, 0, 1));
    // value in real units for the hover readout
    function fmt(kind, v) {
      v = clamp(+v || 0, 0, 1);
      if (kind === 'vol') return v < 0.0005 ? '−∞ dB' : (20 * Math.log10(v) >= -0.05 ? '0.0' : (20 * Math.log10(v)).toFixed(1).replace('-', '−')) + ' dB';
      if (kind === 'pan') { const p = Math.round((v * 2 - 1) * 100); return p === 0 ? 'C' : (p < 0 ? 'L ' : 'R ') + Math.abs(p); }
      if (kind === 'cut') { const f = real('cut', v); return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz'; }
      return Math.round(v * 100) + '%';
    }
    const ease = (u) => (1 - Math.cos(Math.PI * u)) / 2;
    // Curve value at t16 (pts sorted by time); NaN without points.
    function valueAt(pts, t) {
      const n = pts ? pts.length : 0;
      if (!n) return NaN;
      if (t < pts[0][0]) return pts[0][1];
      if (t >= pts[n - 1][0]) return pts[n - 1][1];
      let i = 0;
      while (i < n - 2 && pts[i + 1][0] <= t) i++;
      const p = pts[i], q = pts[i + 1], d = q[0] - p[0];
      if (!(d > 0)) return q[1];
      const u = (t - p[0]) / d;
      return p[1] + (q[1] - p[1]) * (p[2] ? ease(u) : u);
    }
    // The pieces of a song for target: [{ a, n, pts }] (song time). A flattened song (md.flatten) carries them per
    // section pass in S.flatAuto; otherwise the song's (section's) own lane covers the whole song.
    function pieces(S, target) {
      if (S && S.flatAuto) return (S.flatAuto[target] || []).filter((p) => p.pts && p.pts.length);
      const ln = (S && S.auto || []).find((x) => x.target === target);
      return ln && ln.points.length ? [{ a: 0, n: totOf(S), pts: ln.points }] : [];
    }
    // Every target with a lane anywhere in the song (any section), whose owner exists. Nodes are built for these.
    function targets(S) {
      const set = new Set(), ids = new Set((S.layers || []).map((l) => l.id));
      const add = (a) => (a || []).forEach((x) => set.add(x.target));
      if (S.flatAuto) Object.keys(S.flatAuto).forEach((t) => set.add(t));
      else { add(S.auto); (S.sections || []).forEach((x, k) => { if (k !== S.cur && x && x.data) add(x.data.auto); }); }
      return [...set].filter((t) => { const p = parseTarget(t); return p && (!p.layer || ids.has(p.layer)); }).sort();
    }
    // Channel keys of sound.js's FxGraph ('L<i>', 'backing', 'drums') -> Set of automated kinds; master separately.
    function chanKinds(S) {
      const out = {};
      for (const t of targets(S)) {
        const p = parseTarget(t);
        if (p.own === 'master') continue;
        const key = p.layer ? 'L' + S.layers.findIndex((l) => l.id === p.layer) : p.own;
        (out[key] = out[key] || new Set()).add(p.kind);
      }
      return out;
    }
    const hasMaster = (S) => targets(S).includes('master.vol');
    // Breakpoints of the curve over song time [s0, s1] in real (param) units: [[t16, value, jump]]. The first point is at
    // s0 (jump = set there), the last at s1; between them every lane point, piece edges (jumps) and, where the param is
    // not linear in time (smooth segments, the log cutoff), steps of `step` sixteenths. `neutral` (real units) fills
    // time without a piece.
    function ramp(pcs, s0, s1, kind, neutral, step) {
      step = step || 0.25;
      const out = [], at = (t) => { for (const p of pcs) if (t >= p.a - 1e-9 && t < p.a + p.n - 1e-9) return p; return null; };
      const val = (p, t) => (p ? real(kind, valueAt(p.pts, t - p.a)) : neutral);
      const dense = (p, t) => {   // does the curve bend right after t?
        if (!p) return false;
        if (kind === 'cut' || kind === 'raw') return true;
        const rel = t - p.a, pts = p.pts;
        let i = -1;
        for (let k = 0; k < pts.length; k++) if (pts[k][0] <= rel + 1e-9) i = k;
        return i >= 0 && i < pts.length - 1 && !!pts[i][2];
      };
      let p = at(s0);
      out.push([s0, val(p, s0), true]);
      // break times: lane points and piece edges inside (s0, s1)
      const br = new Set();
      for (const q of pcs) {
        if (q.a > s0 && q.a < s1) br.add(q.a);
        if (q.a + q.n > s0 && q.a + q.n < s1) br.add(q.a + q.n);
        for (const x of q.pts) { const t = q.a + x[0]; if (t > s0 && t < s1 && x[0] < q.n) br.add(t); }
      }
      const bl = [...br].sort((a, b) => a - b).concat([s1]);
      let t = s0;
      for (const b of bl) {
        if (dense(p, t)) for (let u = Math.floor(t / step + 1e-9) * step + step; u < b - 1e-9; u += step) out.push([u, val(p, u), false]);
        const q = at(b);
        if (b >= s1) { out.push([s1, p ? val(p, s1) : neutral, false]); break; }
        if (q !== p) { out.push([b, p ? val(p, b) : neutral, false]); out.push([b, val(q, b), true]); p = q; } else out.push([b, val(p, b), false]);
        t = b;
      }
      return out;
    }
    // MIDI CC points of a target over loops passes: [[t16, v 0..1]] where the CC value changes (caller scales + dedupes).
    function ccPoints(pcs, tot, loops, neutralV) {
      const out = [];
      for (let r = 0; r < loops; r++) {
        const off = r * tot;
        for (const [t, v] of ramp(pcs, 0, tot, 'raw', neutralV, 0.5)) out.push([off + t, v]);
      }
      return out;
    }
    // CC number + value (0..127) for a lane value; vol scales the channel's fader (fv).
    const ccOf = (kind) => (KINDS[kind] ? KINDS[kind].cc : null);
    const ccValue = (kind, v, fv) => clamp(Math.round((kind === 'vol' ? v * (fv == null ? 1 : fv) : v) * 127), 0, 127);
    // A slice [s0, s1) of a lane list (loop-region export): values at the edges become points.
    function slice(lanes, s0, s1) {
      return (lanes || []).map((ln) => {
        const P = ln.points, out = { id: ln.id, target: ln.target, points: [] };
        if (!P.length) return out;
        const ts = new Set([s0, s1]);
        P.forEach((p) => { if (p[0] > s0 && p[0] < s1) ts.add(p[0]); });
        if (P.some((p) => p[2])) for (let t = s0; t < s1; t += 0.25) ts.add(t);   // smooth parts: sampled (linear between)
        out.points = [...ts].sort((x, y) => x - y).map((t) => [Math.round((t - s0) * 1000) / 1000, Math.round(valueAt(P, t) * 1000) / 1000]);
        return out;
      });
    }
    return { KINDS, CUT_LO, CUT_HI, RE, parseTarget, real, norm, fmt, ease, valueAt, pieces, targets, chanKinds, hasMaster, ramp, ccPoints, ccOf, ccValue, slice };
  })();

  const X = { auto: AUTO, packVoices, bendOf, songToMidi, sliceSong, chordRegions, encodeWav, drumHits, drumNote, gmProgram, arpLayer, vibReader, strokesOf, lineVoices, vlq, PPQ, T16, TBEND, TLINE, TSI };
  if (typeof module !== 'undefined' && module.exports) module.exports = X;
  const VH = root && root.VH;
  if (!VH || !VH.melody || !root.document) return;
  VH.melody.exportLib = X;

  // =====================================================================================================
  // Browser part
  // =====================================================================================================
  const CSS = `
.mx-dlg { position: absolute; z-index: 30; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(380px, calc(100% - 24px));
  max-height: calc(100% - 24px); overflow-y: auto; background: rgba(20, 24, 36, 0.98); border: 1px solid var(--line, #262b3a);
  border-radius: 12px; padding: 12px 14px 14px; box-shadow: 0 16px 50px rgba(0, 0, 0, 0.6); color: var(--text, #d8dce6); font-size: 14px; }
.mx-dlg h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.mx-dlg .mx-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
.mx-dlg .mx-lbl { color: var(--muted, #7a8194); min-width: 64px; font-size: 13px; }
.mx-dlg .mx-checks { display: grid; grid-template-columns: 1fr; gap: 3px; margin: 4px 0 4px 2px; }
.mx-dlg label.mx-ck { display: flex; gap: 8px; align-items: center; cursor: pointer; font-size: 13px; }
.mx-dlg label.mx-ck input { accent-color: var(--accent, #6fa3ff); width: 16px; height: 16px; }
.mx-dlg label.mx-ck.off { opacity: 0.45; cursor: default; }
.mx-dlg .mx-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.mx-dlg .mx-bar { height: 6px; border-radius: 3px; background: var(--line, #262b3a); overflow: hidden; margin-top: 10px; }
.mx-dlg .mx-bar i { display: block; height: 100%; width: 0; background: var(--accent, #6fa3ff); transition: width 120ms linear; }
.mx-dlg .mx-note { font-size: 12px; color: var(--muted, #7a8194); margin: 2px 0 0 2px; }
.mx-dlg .mx-status { min-height: 18px; font-size: 12px; color: var(--muted, #7a8194); margin-top: 6px; }
.mx-dlg .mx-go { background: var(--accent, #6fa3ff); color: #0b0d12; font-weight: 600; }
.mx-dlg .mx-x { background: none; border: 0; color: var(--muted, #7a8194); font-size: 18px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.mx-dlg .mx-x:focus-visible { outline: 2px solid var(--accent, #6fa3ff); }
`;
  function injectCss() {
    if (document.getElementById('mx-export-css')) return;
    const st = document.createElement('style'); st.id = 'mx-export-css'; st.textContent = CSS;
    document.head.append(st);
  }

  // lamejs, lazily
  let lamePromise = null;
  function loadLame() {
    if (root.lamejs && root.lamejs.Mp3Encoder) return Promise.resolve(root.lamejs);
    if (!lamePromise) {
      lamePromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/vendor/lamejs/lame.min.js'; s.async = true;
        s.onload = () => (root.lamejs && root.lamejs.Mp3Encoder ? resolve(root.lamejs) : reject(new Error('lamejs did not load')));
        s.onerror = () => reject(new Error('Could not load the MP3 encoder'));
        document.head.append(s);
      });
      lamePromise.catch(() => { lamePromise = null; });
    }
    return lamePromise;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function encodeMp3(channels, sr, kbps, onProgress, isAlive) {
    const lame = await loadLame();
    const nc = channels.length, enc = new lame.Mp3Encoder(nc, sr, kbps || 192), n = channels[0].length, B = 1152, out = [];
    const toI16 = (a, s, e) => { const r = new Int16Array(e - s); for (let i = s; i < e; i++) { const v = clamp(a[i], -1, 1); r[i - s] = v < 0 ? v * 32768 : v * 32767; } return r; };
    for (let i = 0, k = 0; i < n; i += B, k++) {
      const e = Math.min(n, i + B), L = toI16(channels[0], i, e), R = nc > 1 ? toI16(channels[1], i, e) : null;
      const d = R ? enc.encodeBuffer(L, R) : enc.encodeBuffer(L);
      if (d.length) out.push(new Uint8Array(d.buffer, d.byteOffset, d.length).slice());
      if (k % 200 === 0) { onProgress(i / n); await tick(); if (isAlive && !isAlive()) throw new Error('cancelled'); }
    }
    const f = enc.flush();
    if (f.length) out.push(new Uint8Array(f.buffer, f.byteOffset, f.length).slice());
    return new Blob(out, { type: 'audio/mpeg' });
  }

  function download(blob, name) {
    if (VH.track) VH.track('export-' + name.split('.').pop());   // export-mid / -wav / -mp3
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  };

  // ---------- offline drum synth (used when B2 exposes no renderer) ----------
  function drumVoice(c, dest, note, when, vel, noise) {
    const g = c.createGain(), amp = (vel / 127) * 0.9;
    g.connect(dest);
    const env = (peak, dec) => { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(peak, when + 0.002); g.gain.setTargetAtTime(0, when + 0.004, dec / 4); };
    const noiseSrc = (type, f, q) => {
      const n = c.createBufferSource(), fl = c.createBiquadFilter();
      n.buffer = noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q || 0.7;
      n.connect(fl); fl.connect(g); n.start(when); n.stop(when + 1.2);
    };
    const tone = (f0, f1, dec, type) => {
      const o = c.createOscillator(); o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1, when + dec);
      o.connect(g); o.start(when); o.stop(when + dec * 4 + 0.05);
    };
    if (note === 36 || note === 35) { env(amp * 1.4, 0.35); tone(150, 45, 0.12); }
    else if (note === 38 || note === 40 || note === 37) { env(amp * 0.7, 0.18); noiseSrc('bandpass', 1900, 0.8); tone(190, 150, 0.08, 'triangle'); }
    else if (note === 39) { env(amp * 0.7, 0.16); noiseSrc('bandpass', 1200, 1.2); }
    else if (note === 42 || note === 44 || note === 70 || note === 54) { env(amp * 0.35, 0.05); noiseSrc('highpass', 7500, 0.7); }
    else if (note === 46) { env(amp * 0.35, 0.3); noiseSrc('highpass', 7000, 0.7); }
    else if (note === 49 || note === 51 || note === 57) { env(amp * 0.3, note === 51 ? 0.5 : 1.0); noiseSrc('highpass', 5000, 0.5); }
    else if (note >= 41 && note <= 50) { env(amp, 0.3); tone(note >= 48 ? 200 : note >= 47 ? 150 : 110, 70, 0.2); }
    else { env(amp * 0.5, 0.08); tone(800, 600, 0.05, 'square'); }
  }

  VH.melody.parts.push((M) => {
    const ui = VH.ui, md = M.model, H = VH.harmony, NS = VH.melody;
    injectCss();
    let alive = true, dlg = null, busy = false;
    const st = { fmt: 'midi', midiMode: 'mixed', scope: 'song', loops: 1, pick: null, backing: true, drums: true, track: true, region: false, section: false, normalize: true };
    // The song to export: the whole arrangement (every section and repeat, md.flatten), one pass of the current section
    // ("Current section only"), or that section's loop region ("Export loop region only").
    const arpPeaksOf = (src, L) => { const g = VH.melody.generatePart; return g && g.arpPeaks ? g.arpPeaks(src, L) : null; };
    const songOf = () => {
      const S = M.song, r = md.regionOf(S);
      if (st.region && r) return sliceSong(S, r[0], r[1]);
      return md.flatten(S, st.section ? { only: S.cur } : {});
    };

    // ---------- Settings section ----------
    const sec = M.ui.addPanelSection('Export', 70, { group: 'export' });
    const row = ui.h('div', 'vh-row'); sec.append(row);
    const openBtn = ui.button(row, { label: '⤓ Export…', onClick: () => open() });
    openBtn.title = 'Download the song as MIDI, WAV or MP3';
    openBtn.classList.add('mx-open');
    sec.append(ui.h('div', 'vh-desc', 'MIDI (lines become pitch bends), or the rendered audio as WAV / MP3.'));

    // Drum hits of the song: B2's own reader when present (exact), else the defensive pure reader.
    const GMD = { kick: 36, snare: 38, hat: 42, perc: 76 };
    function drumList() {
      const S = songOf(), B = NS.sound;
      if (B && typeof B.drumEvents === 'function') {
        const out = [];
        // The kit decides the note: each row's General MIDI note by position (e.gm: kick, snare, hat, then other percussion).
        for (const bl of md.barsOf(S)) for (const e of B.drumEvents({ drums: bl.drums || S.drums, ts: bl.ts, bars: 1, ext: S.ext }, bl.b)) out.push({ t16: bl.a + e.p, note: e.gm || GMD[e.drum] || drumNote(e.drum) || 37, vel: clamp(Math.round(e.vel * 110), 1, 127) });
        return out;
      }
      return drumHits(S.drums, S.bars);
    }
    const hasDrums = () => drumList().length > 0;

    // ---------- dialog ----------
    function close() { if (dlg) { dlg.remove(); dlg = null; openBtn.focus({ preventScroll: true }); } }
    function open() {
      if (dlg) { close(); return; }
      const S = M.song;
      if (!st.pick || st.pick.length !== S.layers.length) st.pick = S.layers.map((_, i) => md.layerGain(S, i) > 0);
      dlg = ui.h('div', 'mx-dlg'); dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-label', 'Export');
      dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) close(); } });
      dlg.addEventListener('pointerdown', (e) => e.stopPropagation());
      M.el.append(dlg);
      render();
      const first = dlg.querySelector('button[aria-pressed="true"]') || dlg.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    }
    function seg(parent, label, vals, cur, on) {
      const r = ui.h('div', 'mx-row'); r.append(ui.h('span', 'mx-lbl', label));
      vals.forEach(([v, lb]) => { const b = ui.button(r, { label: lb, pressed: v === cur, onClick: () => { on(v); render(); } }); b.dataset.v = v; });
      parent.append(r);
      return r;
    }
    function check(parent, label, on, enabled, color, onChange, cls) {
      const l = ui.h('label', 'mx-ck' + (enabled ? '' : ' off') + (cls ? ' ' + cls : ''));
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = on && enabled; c.disabled = !enabled;
      c.addEventListener('change', () => onChange(c.checked));
      l.append(c);
      if (color) { const d = ui.h('span', 'mx-dot'); d.style.background = color; l.append(d); }
      l.append(document.createTextNode(label));
      parent.append(l);
      return c;
    }
    function render() {
      if (!dlg) return;
      const S = M.song, audio = st.fmt !== 'midi', whole = audio && st.scope === 'song';
      dlg.innerHTML = '';
      const h = ui.h('h3', '', 'Export');
      const x = ui.h('button', 'mx-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close export'); x.addEventListener('click', () => { if (!busy) close(); });
      h.append(x); dlg.append(h);
      seg(dlg, 'Format', [['midi', 'MIDI'], ['wav', 'WAV'], ['mp3', 'MP3']], st.fmt, (v) => { st.fmt = v; }).classList.add('mx-fmt');
      if (!audio) seg(dlg, 'Tracks', [['mixed', 'Mixed'], ['separate', 'Separate']], st.midiMode, (v) => { st.midiMode = v; }).classList.add('mx-mode');
      else seg(dlg, 'Render', [['song', 'Whole song'], ['pick', 'Chosen parts']], st.scope, (v) => { st.scope = v; }).classList.add('mx-scope');
      seg(dlg, 'Loops', [[1, '1×'], [2, '2×']], st.loops, (v) => { st.loops = v; }).classList.add('mx-loops');
      if (S.sections.length > 1) {
        const sr = ui.h('div', 'mx-row'); dlg.append(sr);
        check(sr, 'Current section only (' + S.sections[S.cur].name + ')', st.section, true, '', (v) => { st.section = v; if (v) st.region = false; render(); }, 'mx-section');
      }
      const reg = md.regionOf(S);
      if (reg) {
        const rr = ui.h('div', 'mx-row'); dlg.append(rr);
        check(rr, 'Export loop region only (bar' + (reg[1] - reg[0] > 1 ? 's ' + (reg[0] + 1) + '–' + reg[1] : ' ' + (reg[0] + 1)) + ')', st.region, true, '',
          (v) => { st.region = v; if (v) st.section = false; render(); }, 'mx-region');
      }
      if (audio) {
        const nr = ui.h('div', 'mx-row'); dlg.append(nr);
        check(nr, 'Normalize (peak −1 dBFS)', st.normalize, true, '', (v) => { st.normalize = v; }, 'mx-normalize');
      }
      const box = ui.h('div', 'mx-checks'); dlg.append(box);
      S.layers.forEach((l, i) => {
        const audible = md.layerGain(S, i) > 0;
        check(box, l.name + ' – ' + (M.soundOf(i) || {}).name, whole ? audible : st.pick[i], !whole, l.color, (v) => { st.pick[i] = v; }, 'mx-layer');
      });
      const dOk = hasDrums();
      check(box, 'Backing chords', whole ? S.backing.on : st.backing, !whole, '', (v) => { st.backing = v; }, 'mx-backing');
      check(box, 'Drums' + (dOk ? '' : ' (no pattern)'), whole ? dOk : st.drums && dOk, dOk && !whole, '', (v) => { st.drums = v; }, 'mx-drums');
      if (S.track) {   // the backing track (track.js): audio only
        if (audio) check(box, 'Backing track · ' + S.track.name, whole ? !S.track.mute : st.track, !whole, '', (v) => { st.track = v; }, 'mx-track');
        else box.append(ui.h('div', 'mx-note', 'MIDI leaves out the backing track audio; turn on Backing chords to include its detected chords.'));
      }
      const r = ui.h('div', 'mx-row'); dlg.append(r);
      const go = ui.button(r, { label: '⤓ Download ' + st.fmt.toUpperCase(), onClick: () => run() });
      go.classList.add('mx-go'); go.disabled = busy;
      const bar = ui.h('div', 'mx-bar', '<i></i>'); bar.hidden = !busy; dlg.append(bar);
      dlg.append(ui.h('div', 'mx-status'));
    }
    function progress(f, msg) {
      if (!dlg) return;
      const bar = dlg.querySelector('.mx-bar'), s = dlg.querySelector('.mx-status');
      if (bar) { bar.hidden = f == null; bar.firstChild.style.width = Math.round(clamp(f || 0, 0, 1) * 100) + '%'; }
      if (s && msg != null) s.textContent = msg;
    }
    function selection() {
      const S = M.song, whole = st.fmt !== 'midi' && st.scope === 'song';
      const tr = !!S.track && st.fmt !== 'midi';
      if (whole) return { layers: S.layers.map((_, i) => i).filter((i) => md.layerGain(S, i) > 0), backing: S.backing.on, drums: hasDrums(), track: tr && !S.track.mute, whole };
      return { layers: S.layers.map((_, i) => i).filter((i) => st.pick[i]), backing: st.backing, drums: st.drums && hasDrums(), track: tr && st.track, whole };
    }

    async function run() {
      if (busy) return;
      const sel = selection(), name = 'visual-harmonics-' + stamp();
      if (!sel.layers.length && !sel.backing && !sel.drums && !sel.track) { progress(null, 'Choose at least one part.'); return; }
      busy = true; render(); progress(0, st.fmt === 'midi' ? 'Writing MIDI…' : 'Preparing instruments…');
      try {
        if (st.fmt === 'midi') {
          const src = songOf();
          const bytes = songToMidi(src, { mode: st.midiMode, layers: sel.layers, backing: sel.backing, drums: sel.drums, loops: st.loops,
            soundOf: (i) => M.soundOf(i), backingSound: M.backingSound(), backingSoundOf: (k) => M.backingSoundOf(k), chordMidis: (ch) => md.chordMidis(ch, src), drumHits: sel.drums ? drumList() : null,
            tuned: md.tuningOf(src) !== '12tet', arpPeaks: (L) => arpPeaksOf(src, L),
            backingEvents: NS.sound && NS.sound.regionEvents ? (r) => NS.sound.regionEvents(src, r) : null });
          download(new Blob([bytes], { type: 'audio/midi' }), name + '.mid');
          progress(1, 'Saved ' + name + '.mid (' + (st.midiMode === 'mixed' ? 'one track' : 'one track per part') + ').' + (M.song.track ? ' The backing track audio is not in MIDI.' : ''));
        } else {
          const rendered = await renderAudio(sel, st.loops, (f) => progress(f * (st.fmt === 'mp3' ? 0.7 : 0.95), 'Rendering… ' + Math.round(f * 100) + '%'));
          if (!alive) return;
          if (st.normalize) normalizePeak(rendered.channels, NORM_PEAK_DB);
          let blob;
          if (st.fmt === 'wav') blob = new Blob([encodeWav(rendered.channels, rendered.sr)], { type: 'audio/wav' });
          else {
            progress(0.7, 'Encoding MP3…');
            blob = await encodeMp3(rendered.channels, rendered.sr, 192, (f) => progress(0.7 + 0.3 * f, 'Encoding MP3… ' + Math.round(f * 100) + '%'), () => alive);
          }
          if (!alive) return;
          download(blob, name + '.' + st.fmt);
          api.last = { fmt: st.fmt, seconds: rendered.seconds, songSeconds: rendered.songSeconds, fx: rendered.fx, drums: rendered.drums, bytes: blob.size };
          progress(1, 'Saved ' + name + '.' + st.fmt + ' · ' + rendered.seconds.toFixed(1) + ' s' + (rendered.fx ? ' · with effects' : '') + '.');
        }
      } catch (err) {
        if (!alive) return;
        if (String(err && err.message) !== 'cancelled') {
          console.warn('[melody] export failed', err);
          progress(null, st.fmt === 'mp3' && /encoder|lamejs/i.test(String(err && err.message))
            ? 'MP3 needs js/vendor/lamejs/lame.min.js, which could not be loaded here. Try WAV.' : 'Export failed: ' + (err && err.message));
        }
      } finally {
        busy = false;
        if (alive && dlg) { const g = dlg.querySelector('.mx-go'); if (g) g.disabled = false; }
      }
    }

    // Peak-normalize rendered channels in place to peakDb dBFS (sample peak; silence is left alone). Returns the gain.
    const NORM_PEAK_DB = -1;
    function normalizePeak(chs, peakDb) {
      let pk = 0;
      for (const ch of chs) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > pk) pk = v; }
      if (!(pk > 1e-6)) return 1;
      const k = 10 ** (peakDb / 20) / pk;
      for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i] *= k;
      return k;
    }

    // ---------- offline render through the real voices ----------
    const G_LINE = md.GAIN.LINE, G_NOTE = md.GAIN.NOTE, G_BACK = md.GAIN.BACK, MIN_GAP = 0.07, TAIL = 2, VIB_DT = 0.012;
    const B2 = () => (NS.sound && typeof NS.sound.offline === 'function' ? NS.sound : null);
    function fxSpecs(fx) {   // fallback without B2: song.fx -> VH.fx.chain specs (read defensively)
      if (!fx || typeof fx !== 'object' || fx.on === false || fx.bypass) return [];
      const T = ['reverb', 'delay', 'chorus', 'drive', 'lofi', 'filter'];
      let list = fx.chain || fx.list || fx.items || fx.effects;
      if (Array.isArray(list)) list = list.map((e) => (typeof e === 'string' ? { type: e, params: {} } : e));
      else list = Object.keys(fx).filter((k) => T.includes(k) && fx[k] && typeof fx[k] === 'object').map((k) => ({ type: k, params: fx[k] }));
      return list.filter((e) => e && T.includes(e.type) && e.on !== false).map((e) => ({ type: e.type, params: Object.assign({}, e.params) }));
    }
    async function renderAudio(sel, loops, onProgress) {
      const S = songOf(), sr = 44100, tot = md.tot16(S), sec16 = md.secPer16(S), songSec = loops * tot * sec16;
      const seconds = songSec + TAIL;
      const ids = new Set(sel.layers.map((i) => M.soundOf(i).id));   // samplers must be decoded first
      if (sel.backing) { ids.add(M.backingSound().id); S.sections.forEach((x, k) => { if (x.back && x.back.sound) ids.add(M.backingSoundOf(k).id); }); }
      if (sel.drums && NS.sound && NS.sound.kitSoundIds) NS.sound.kitSoundIds(S).forEach((id) => ids.add(id));   // the kit's sampled rows
      await Promise.all([...ids].map((id) => (VH.sounds.prepare ? VH.sounds.prepare(id).catch(() => null) : null)));
      if (!alive) throw new Error('cancelled');
      const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      if (!OAC) throw new Error('This browser cannot render audio offline');
      const c = new OAC(2, Math.ceil(seconds * sr), sr);
      let fxUsed = false, drumsUsed = false, b2 = null;
      const sounds = S.layers.map((_, i) => M.soundOf(i)), back = M.backingSound();
      const plays = sounds.map((s) => (M.engine.playOf ? M.engine.playOf(s) : VH.sounds.playOf(s)));
      const jobs = new Map(), Q = 128 / sr;   // render quantum -> [fn] (setFreq needs currentTime == its time)
      const at = (t, fn) => { const k = Math.max(1, Math.round(t / Q)); if (!jobs.has(k)) jobs.set(k, []); jobs.get(k).push(fn); };
      const hz = (m) => H.midiToHz(m);
      VH.audio.withContext(c, (ctx, out) => {
        const master = ctx.createGain();
        master.gain.value = S.master; master.connect(out);
        let layerIn;
        const B = B2();
        if (B) {   // B2's graph: per-channel insert FX + sends, drums, backing styles (incl. the held drone)
          const S2 = Object.assign({}, S, {
            backing: Object.assign({}, S.backing, { on: sel.whole ? S.backing.on : !!sel.backing }),
            drums: Object.assign({}, S.drums, { on: !!sel.drums }),
          });
          b2 = B.offline(ctx, S2, master, { loops, backingSound: back, backingSoundOf: (k) => M.backingSoundOf(k), backing: !!sel.backing, drums: !!sel.drums });
          layerIn = (i) => b2.layerIn(i);
          if (!sel.whole) S.layers.forEach((l, i) => { const n = b2.layerIn(i); if (n) n.gain.value = l.vol; });
          fxUsed = true; drumsUsed = !!sel.drums;
        } else {   // fallback: own buses, VH.fx chain from song.fx, held chords, a small drum synth
          const sum = ctx.createGain(), backBus = ctx.createGain(), drumBus = ctx.createGain();
          backBus.gain.value = S.backing.vol; drumBus.gain.value = typeof (S.drums || {}).vol === 'number' ? S.drums.vol * md.GAIN.DRUMS : 0.7 * md.GAIN.DRUMS;
          backBus.connect(sum); drumBus.connect(sum);
          let chain = null;
          try { const sp = VH.fx && VH.fx.chain ? fxSpecs(S.fx) : []; if (sp.length) chain = VH.fx.chain(ctx, sp); } catch (err) { console.warn('[melody] export: effects skipped', err); }
          if (chain && chain.input && chain.output) { sum.connect(chain.input); chain.output.connect(master); fxUsed = true; } else sum.connect(master);
          const buses = S.layers.map((l, i) => { const g = ctx.createGain(); g.gain.value = sel.whole ? md.layerGain(S, i) : l.vol; g.connect(sum); return g; });
          layerIn = (i) => buses[i];
          const hits = sel.drums ? drumList() : [];
          let noise = null;
          if (hits.length) {
            drumsUsed = true;
            noise = ctx.createBuffer(1, sr, sr); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
          }
          for (let r = 0; r < loops; r++) {
            const off = r * tot * sec16;
            if (sel.backing) md.regions(S).forEach((R) => {
              if (!R.chord) return;
              const t0 = off + R.a * sec16;
              md.chordMidis(R.chord, S).forEach((m) => VH.audio.voice(back, hz(m), { gain: G_BACK, dest: backBus, when: t0 }).stop(0.12, off + R.z * sec16));
            });
            for (const h of hits) drumVoice(ctx, drumBus, h.note, off + h.t16 * sec16 + 0.003, h.vel, noise);
          }
        }
        // automation lanes (X.auto): the same curves as live playback, scheduled up front on B2's channel nodes
        const tg = AUTO.targets(S);
        if (tg.length) {
          const tot16 = md.tot16(S);
          for (const t of tg) {
            const q = AUTO.parseTarget(t);
            let p = null, neutral = 1;
            if (q.own === 'master') { const am = ctx.createGain(); master.disconnect(); master.connect(am); am.connect(out); p = am.gain; }
            else if (b2) {
              const ch = b2.graph.chans.get(q.layer ? 'L' + S.layers.findIndex((l) => l.id === q.layer) : q.own);
              if (ch) { p = ch.params()[q.kind]; neutral = ch.neutral(q.kind); }
            }
            if (!p) continue;
            const pcs = AUTO.pieces(S, t);
            for (let r = 0; r < loops; r++) {
              const off = r * tot * sec16;
              for (const [t16, v, jump] of AUTO.ramp(pcs, 0, tot16, q.kind, neutral)) {
                if (jump) p.setValueAtTime(v, off + t16 * sec16); else p.linearRampToValueAtTime(v, off + t16 * sec16);
              }
            }
          }
        }
        // parts that render their own audio (track.js: the backing track) get the context, the master input and the
        // song's bars as { t16, n, k (section), b (bar in the section) }
        if (sel.track) {
          const bars = S.flat ? S.flat.bars.map((x) => ({ t16: x.a, n: x.n, k: x.sec, b: x.b }))
            : md.barsOf(S).map((x, i) => ({ t16: x.a, n: x.n, k: M.song.cur, b: (st.region && md.regionOf(M.song) ? md.regionOf(M.song)[0] : 0) + i }));
          M.emit('renderAudio', { ctx, dest: master, bars, loops, sec16, tot16: tot, song: S });
        }
        // layers: the engine's playback rules (glide = one legato voice per run, hit = re-strike per semitone)
        for (let r = 0; r < loops; r++) {
          const off = r * tot * sec16;
          for (const L of sel.layers) {
            const l = S.layers[L], snd = sounds[L], bus = layerIn(L), vr = vibReader(S, L);
            if (l.arp) {   // arpeggio layer: short steps instead of held notes / lines
              for (const e of arpLayer(S, L, (q) => arpPeaksOf(S, q)).notes) {
                const t0 = off + e.s * sec16, v = VH.audio.voice(snd, hz(e.m), { gain: G_NOTE, dest: bus, when: t0 });
                v.stop(undefined, t0 + e.d * sec16);
              }
              continue;
            }
            for (const n of l.notes) {
              const t0 = off + n.s * sec16, t1 = t0 + n.d * sec16, v = VH.audio.voice(snd, hz(n.m), { gain: G_NOTE, dest: bus, when: t0 });
              v.stop(undefined, t1);
              const vb = vr.note(n);
              if (vb) for (let t = t0 + VIB_DT; t < t1; t += VIB_DT) { const f = hz(n.m + vb.depth * Math.sin(2 * Math.PI * vb.rate * (t - t0))); at(t, () => v.setFreq(f, 0.01, t)); }
            }
            const dtL = sec16 / 3, hit = plays[L] === 'hit';
            for (const st of strokesOf(l)) {   // one voice per stroke (strokes may overlap)
            const line = st.v, sk = st.id;
            let cur = null, lastHit = -1e9;
            const vibSteps = (x, i, m) => {   // vibrato between this sample and the next
              const vb = vr.line(i, sk);
              if (!vb) return;
              const m1 = i + 1 < line.length && !isNaN(line[i + 1]) ? line[i + 1] : m;
              for (let k = 0; k < 4; k++) {
                const t = off + (i + k / 4) * dtL, mm = m + (m1 - m) * k / 4 + vb.depth * Math.sin(2 * Math.PI * vb.rate * (t - off));
                const tt = t + (k ? 0 : 1e-4);
                at(tt, () => x.v && x.v.setFreq(hz(mm), 0.01, tt));
              }
            };
            for (let i = 0; i <= line.length; i++) {
              const m = i < line.length ? line[i] : NaN, t = off + i * dtL;
              if (isNaN(m)) { if (cur) { const x = cur; at(t, () => x.v && x.v.stop(hit ? 0.25 : 0.03, t)); cur = null; } continue; }
              if (!hit) {
                if (!cur) { const x = cur = { v: null }; at(t, () => { x.v = VH.audio.voice(snd, hz(m), { gain: G_LINE, dest: bus, when: t }); }); } else { const x = cur; at(t, () => x.v && x.v.setFreq(hz(m), 0.045, t)); }
                vibSteps(cur, i, m);
                continue;
              }
              const semi = Math.round(m);
              if ((!cur || semi !== cur.semi) && t - lastHit >= MIN_GAP) {
                const old = cur, x = cur = { v: null, semi };
                at(t, () => { if (old && old.v) old.v.stop(0.12, t); x.v = VH.audio.voice(snd, hz(m), { gain: G_LINE, dest: bus, when: t }); });
                lastHit = t;
              } else if (cur) { const x = cur; at(t, () => x.v && x.v.setFreq(hz(m), 0.03, t)); }
              vibSteps(cur, i, m);
            }
            }
          }
        }
      });
      const keys = [...jobs.keys()].sort((a, b) => a - b);
      let done = 0;
      // Firefox (and older Safari) can't suspend an OfflineAudioContext. Every job passes its own time,
      // so there we simply schedule them all up front, in time order.
      if (typeof c.suspend !== 'function') {
        VH.audio.withContext(c, () => { for (const k of keys) for (const fn of jobs.get(k)) { try { fn(); } catch (err) { console.warn('[melody] export voice', err); } } });
        keys.length = 0;
      }
      for (const k of keys) {
        c.suspend((k + 0.5) * Q).then(() => {
          VH.audio.withContext(c, () => { for (const fn of jobs.get(k)) { try { fn(); } catch (err) { console.warn('[melody] export voice', err); } } });
          done++;
          if (done % 24 === 0) onProgress(c.currentTime / seconds);
          c.resume();
        }, (err) => console.warn('[melody] export: a render step was skipped', err));
      }
      let buf;
      try { buf = await (VH.audio.render ? VH.audio.render(c) : c.startRendering()); } finally { if (b2 && b2.dispose) { try { b2.dispose(); } catch (_) { /* ignore */ } } }
      onProgress(1);
      return { channels: [buf.getChannelData(0), buf.getChannelData(1)], sr, seconds: buf.duration, songSeconds: songSec, fx: fxUsed, viaB2: !!b2, drums: drumsUsed };
    }

    const api = { open, close, render: renderAudio, normalizePeak, last: null, state: st, songOf, sliceSong, drumList };
    VH.melody.exportPart = api;
    return {
      destroy() {
        alive = false; close();
        if (VH.melody.exportPart === api) VH.melody.exportPart = null;
      },
    };
  });
})(this);

// =====================================================================================================
// Automation lanes (part): "Automation" lanes under the drum lane (M.view.addLane), one per target, breakpoints drawn
// on the bar grid; the live look-ahead scheduler that plays them on sound.js's channel nodes (X.auto has the curves).
// Data: M.song.auto (per section, see model.js); offline export + MIDI CC read the same data (renderAudio, autoMidi).
// =====================================================================================================
(function (root) {
  'use strict';
  const VH = root && root.VH;
  if (!VH || !VH.melody || !root.document || !VH.melody.parts) return;
  const NS = VH.melody;
  NS.parts.push((M) => {
    const ui = VH.ui, md = M.model, E = M.engine, A = NS.exportLib.auto, clamp = md.clamp;
    const LA = 0.12, ROW_H = 36, PAD = 5, HIT = 9, NARROW = 600;
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    let alive = true;

    // ---------- data ----------
    const lanes = () => { const S = M.song; if (!Array.isArray(S.auto)) S.auto = []; return S.auto; };
    function nameOf(target) {
      const q = A.parseTarget(target);
      if (!q) return target;
      const k = A.KINDS[q.kind].label;
      if (q.layer) { const L = M.song.layers.find((l) => l.id === q.layer); return (L ? L.name : q.layer) + ' · ' + k; }
      return { backing: 'Backing', drums: 'Drums', master: 'Master' }[q.own] + ' · ' + k;
    }
    function colorOf(target) {
      const q = A.parseTarget(target), L = q && q.layer ? M.song.layers.find((l) => l.id === q.layer) : null;
      return L ? L.color : q && q.own === 'master' ? '#e8ecf4' : q && q.own === 'drums' ? '#ffb86b' : '#9fb4d8';
    }
    // the lane's flat line (no points): the neutral value, as a lane value
    function neutralV(target) {
      const q = A.parseTarget(target);
      if (!q) return 1;
      if (q.kind === 'pan') return 0.5;
      if (q.kind === 'rev' || q.kind === 'dly') {
        const i = q.layer ? M.song.layers.findIndex((l) => l.id === q.layer) : -1, r = NS.sound && NS.sound.recOf ? NS.sound.recOf(M.song, 'L' + i) : null;
        return r ? clamp(+r[q.kind] || 0, 0, 1) : 0;
      }
      return 1;
    }
    function targetList() {
      const S = M.song, out = [];
      S.layers.forEach((l) => ['vol', 'pan', 'cut', 'rev', 'dly'].forEach((k) => out.push({ t: l.id + '.' + k, group: l.name })));
      ['backing', 'drums', 'master'].forEach((o) => out.push({ t: o + '.vol', group: 'Mix' }));
      return out;
    }
    let openState = null;   // null = default: open, collapsed on narrow stages (<= 600 px)
    function addLane(target) {
      const L = lanes();
      if (!A.parseTarget(target) || L.some((x) => x.target === target) || L.length >= md.MAX_AUTO) return false;
      let n = 0;
      L.forEach((x) => { const m = /^a(\d+)$/.exec(x.id); if (m) n = Math.max(n, +m[1]); });
      L.push({ id: 'a' + (n + 1), target, points: [] });
      openState = true;
      M.commit('Add lane: ' + nameOf(target));
      return true;
    }
    function removeLane(id) {
      const L = lanes(), i = L.findIndex((x) => x.id === id);
      if (i < 0) return;
      const nm = nameOf(L[i].target);
      L.splice(i, 1);
      M.commit('Remove lane: ' + nm);
    }
    // a removed layer takes its lanes along (every section; same undo step)
    M.on('layerRemoved', (id) => {
      const S = M.song, drop = (a) => (Array.isArray(a) ? a.filter((x) => (A.parseTarget(x.target) || {}).layer !== id) : a);
      S.auto = drop(S.auto || []);
      (S.sections || []).forEach((x, k) => { if (k !== S.cur && x.data) x.data.auto = drop(x.data.auto); });
    });

    // ---------- DOM ----------
    const rootEl = ui.h('div', 'mel-auto');
    rootEl.setAttribute('role', 'group'); rootEl.setAttribute('aria-label', 'Automation lanes');
    const head = ui.h('div', 'mel-au-head'), body = ui.h('div', 'mel-au-body');
    const tog = ui.h('button', 'mel-au-tog'); tog.type = 'button';
    tog.title = 'Show or hide the automation lanes';
    const addSel = document.createElement('select'); addSel.className = 'mel-au-add'; addSel.setAttribute('aria-label', 'Add an automation lane');
    addSel.title = 'Add a lane: draw how a setting changes over time';
    const hint = ui.h('span', 'mel-au-hint', 'Draw how volume, pan or filter change over time');
    const pasteLaneBtn = ui.h('button', 'mel-au-tog', 'Paste lane'); pasteLaneBtn.type = 'button'; pasteLaneBtn.hidden = true;
    head.append(tog, addSel, pasteLaneBtn, hint);
    rootEl.append(head, body);
    const tip = ui.h('div', 'mel-au-tip'); tip.hidden = true; tip.setAttribute('aria-hidden', 'true');
    rootEl.append(tip);
    const isOpen = () => (openState != null ? openState : !((M.el.clientWidth || root.innerWidth || 1000) <= NARROW));
    tog.addEventListener('click', () => { openState = !isOpen(); render(); });
    addSel.addEventListener('change', () => { const v = addSel.value; addSel.value = ''; if (v) addLane(v); });

    let show = VH.store.get('melody.showAuto', true) !== false, slot = null;
    function mountLane() {
      if (show && !slot) slot = M.view.addLane(rootEl);
      else if (!show && slot) { slot.remove(); slot = null; }
    }

    // Settings > Mix: "Show automation"
    const sec = M.ui.addPanelSection('Automation', 40, { group: 'mix' });
    const showBtn = ui.button(sec, { label: 'Show automation', pressed: show, onClick: () => {
      show = !show; VH.store.set('melody.showAuto', show); showBtn.set({ pressed: show }); mountLane(); render();
    } });
    showBtn.classList.add('mel-au-show');
    sec.append(ui.h('div', 'vh-desc', 'Lanes under the drums: draw how volume, pan, filter or the effect sends change over time (per section).'));

    // rows: one per lane of the shown section
    const rows = new Map();   // lane id -> { el, cv, lbl, x, sm, id }
    let sel = null, drag = null, hoverRow = null, lastTap = null;
    // multi-selection (marquee / Shift-click): point refs of ONE lane (msLane); active = the last press was in a lane (so Ctrl+C/X/V/A act on points, not notes)
    const ms = new Set();
    let msLane = null, lastLane = null, active = false;
    const r3 = (v) => Math.round(v * 1000) / 1000, MAXP = 400;
    const msPts = () => { const ln = lanes().find((x) => x.id === msLane); return ln ? ln.points.filter((p) => ms.has(p)) : []; };
    const curLane = () => lanes().find((x) => x.id === lastLane) || null;
    const clipOf = () => NS.autoClip || null;   // { target, pts: [[t16, v, smooth?]], len (source section t16), whole } survives section switches
    const nextId = (L) => { let n = 0; L.forEach((x) => { const m = /^a(\d+)$/.exec(x.id); if (m) n = Math.max(n, +m[1]); }); return 'a' + (n + 1); };
    const laneOf = (r) => lanes().find((x) => x.id === r.id) || null;
    function makeRow(ln) {
      const el = ui.h('div', 'mel-au-row'), cv = document.createElement('canvas'), lbl = ui.h('span', 'mel-au-lbl', '<i></i><span></span>');
      const x = ui.h('button', 'mel-au-x', '✕'), sm = ui.h('button', 'mel-au-sm', '∿'), mo = ui.h('button', 'mel-au-more', '⋯');
      x.type = 'button'; sm.type = 'button'; mo.type = 'button'; sm.hidden = true;
      mo.title = 'Lane menu: copy this lane to other sections'; mo.setAttribute('aria-label', 'Lane menu');
      sm.title = 'Smooth curve after the selected point (Alt+click a point)';
      cv.className = 'mel-au-cv';
      el.style.height = ROW_H + 'px';
      el.dataset.target = ln.target;
      el.append(cv, lbl, mo, sm, x);
      const r = { el, cv, lbl, x, sm, mo, id: ln.id };
      mo.addEventListener('click', () => openMenu(r));
      x.addEventListener('click', () => removeLane(r.id));
      sm.addEventListener('click', () => { if (sel && sel.lane === r.id) toggleSmooth(sel.pt); });
      cv.addEventListener('pointerdown', (e) => onDown(r, e));
      cv.addEventListener('pointermove', (e) => onMove(r, e));
      cv.addEventListener('pointerup', () => onUp(r));
      cv.addEventListener('pointercancel', () => { if (drag) { drag = null; M.revert(); render(); } });
      cv.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; hoverRow = null; } });
      cv.addEventListener('dblclick', (e) => { const ln2 = laneOf(r), h = hitPt(r, ln2, e); if (h) delPoint(ln2, h); });
      cv.addEventListener('contextmenu', (e) => { e.preventDefault(); const ln2 = laneOf(r), h = hitPt(r, ln2, e); if (h) delPoint(ln2, h); });
      return r;
    }

    function render() {
      if (!alive) return;
      const L = lanes(), open = isOpen();
      tog.textContent = (open ? '▾ ' : '▸ ') + 'Automation (' + L.length + ')';
      tog.setAttribute('aria-expanded', String(open));
      hint.hidden = !open || L.length > 0;
      addSel.hidden = !open;
      body.hidden = !open;
      // + Lane options (targets without a lane in this section)
      const have = new Set(L.map((x) => x.target)), groups = new Map();
      targetList().forEach((o) => { if (!groups.has(o.group)) groups.set(o.group, []); groups.get(o.group).push(o); });
      let html = '<option value="">+ Lane</option>';
      groups.forEach((list, g) => {
        html += '<optgroup label="' + esc(g) + '">' + list.map((o) => '<option value="' + o.t + '"' + (have.has(o.t) ? ' disabled' : '') + '>' +
          esc(o.group === 'Mix' ? nameOf(o.t) : A.KINDS[A.parseTarget(o.t).kind].label) + '</option>').join('') + '</optgroup>';
      });
      if (addSel.dataset.html !== html) { addSel.innerHTML = html; addSel.dataset.html = html; }
      addSel.disabled = L.length >= md.MAX_AUTO;
      // rows
      const ids = new Set(L.map((x) => x.id));
      for (const [id, r] of rows) if (!ids.has(id) || r.el.dataset.target !== (L.find((x) => x.id === id) || {}).target) { r.el.remove(); rows.delete(id); }
      L.forEach((ln, i) => {
        let r = rows.get(ln.id);
        if (!r) { r = makeRow(ln); rows.set(ln.id, r); }
        if (body.children[i] !== r.el) body.insertBefore(r.el, body.children[i] || null);
        const nm = nameOf(ln.target);
        r.lbl.lastChild.textContent = nm; r.lbl.firstChild.style.background = colorOf(ln.target);
        r.x.setAttribute('aria-label', 'Remove lane ' + nm); r.x.title = 'Remove this lane';
        r.cv.setAttribute('aria-label', nm + ' automation: click to add a point, drag to move, double-click or right-click to delete');
        if (sel && sel.lane === ln.id && !ln.points.includes(sel.pt)) sel = null;
        r.sm.hidden = !(sel && sel.lane === ln.id) || ms.size > 1;
        r.sm.setAttribute('aria-pressed', String(!!(sel && sel.lane === ln.id && sel.pt[2])));
      });
      for (const p of [...ms]) if (!L.some((x) => x.id === msLane && x.points.includes(p))) ms.delete(p);
      const cl = clipOf();
      pasteLaneBtn.hidden = !open || !cl || !cl.whole;
      if (cl) pasteLaneBtn.title = 'Paste the copied lane (' + nameOf(cl.target) + ') into this section, stretched to its length';
      drawAll();
    }

    // ---------- geometry: lane px <-> song time, aligned with the canvas (and the drum lane) ----------
    function geo(r) {
      const V = M.view, cr = V.cv.getBoundingClientRect(), rr = r.cv.getBoundingClientRect(), k = cr.width / V.VW || 1, off = cr.left - rr.left;
      return { V, k, off, rr, x0: off + V.X0 * k, xOf: (t16) => off + V.sx(V.xOf(t16)) * k, tOf: (px) => V.t16Of((px - off) / k - V.X0 + V.scrollX),
        // the canvas's own grid line (view.js draws them at Math.round(x) + 0.5 in content px) -> the nearest lane pixel centre
        gridX: (t16) => Math.round(off + (Math.round(V.xOf(t16)) + 0.5 + V.X0 - V.scrollX) * k - 0.5) + 0.5 };
    }
    const yOf = (v) => PAD + (1 - v) * (ROW_H - 2 * PAD);
    const vOf = (y) => clamp(1 - (y - PAD) / (ROW_H - 2 * PAD), 0, 1);

    function drawAll() { for (const r of rows.values()) draw(r); }
    function draw(r) {
      const ln = laneOf(r);
      if (!ln || body.hidden || !r.el.isConnected) return;
      const g = geo(r), w = Math.max(1, Math.round(g.rr.width)), dpr = root.devicePixelRatio || 1, cv = r.cv;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(ROW_H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(ROW_H * dpr); }
      const c = cv.getContext('2d'), S = M.song, tot = md.tot16(S), col = colorOf(ln.target);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, ROW_H);
      c.save();
      c.beginPath(); c.rect(g.x0, 0, w - g.x0, ROW_H); c.clip();
      const xEnd = g.xOf(tot);
      if (xEnd < w) { c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(xEnd, 0, w - xEnd, ROW_H); }
      // grid: beats faint, bars brighter (where the canvas draws them)
      const spb = md.spb(S);
      c.lineWidth = 1;
      for (let b = 0; b <= S.bars; b++) {
        const x = g.gridX(b * spb);
        if (x < g.x0 - 1 || x > w + 1) continue;
        c.strokeStyle = 'rgba(255,255,255,0.2)';
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, ROW_H); c.stroke();
      }
      const P = ln.points;
      if (!P.length) {   // no points yet: the neutral level, dashed
        const y = Math.round(yOf(neutralV(ln.target))) + 0.5;
        c.setLineDash([4, 4]); c.strokeStyle = 'rgba(200,210,230,0.45)';
        c.beginPath(); c.moveTo(g.x0, y); c.lineTo(Math.min(w, xEnd), y); c.stroke(); c.setLineDash([]);
      } else {
        const xa = Math.max(g.x0, 0), xb = Math.min(w, xEnd);
        if (xb > xa) {
          c.beginPath();
          for (let x = xa; x <= xb; x += 1) { const y = yOf(A.valueAt(P, g.tOf(x))); if (x === xa) c.moveTo(x, y); else c.lineTo(x, y); }
          c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
          c.lineTo(xb, ROW_H); c.lineTo(xa, ROW_H); c.closePath();
          c.globalAlpha = 0.16; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
        }
        for (const p of P) {
          const x = g.xOf(p[0]), y = yOf(p[1]), on = (sel && sel.pt === p) || ms.has(p);
          if (x < g.x0 - 6 || x > w + 6) continue;
          c.beginPath();
          if (p[2]) { c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.closePath(); } else c.arc(x, y, 4, 0, Math.PI * 2);
          c.fillStyle = on ? '#fff' : col; c.fill();
          c.lineWidth = 1.5; c.strokeStyle = on ? col : 'rgba(10,12,18,0.9)'; c.stroke();
          if (ms.has(p)) { c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke(); }
        }
      }
      if (drag && drag.mq && drag.r === r) {   // marquee
        const mx = Math.min(drag.x0, drag.x), my = Math.min(drag.y0, drag.y);
        c.fillStyle = 'rgba(255,255,255,0.12)'; c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 1;
        c.fillRect(mx, my, Math.abs(drag.x - drag.x0), Math.abs(drag.y - drag.y0)); c.strokeRect(mx + 0.5, my + 0.5, Math.abs(drag.x - drag.x0), Math.abs(drag.y - drag.y0));
      }
      if (E.playing) {   // playhead
        const x = Math.round(g.xOf(E.pos16)) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, ROW_H); c.stroke();
      }
      c.restore();
    }

    // ---------- gestures: click = add, drag = move (1/16 snap, Shift = free), double / right click = delete, Alt+click = smooth ----------
    function local(r, e) { const rr = r.cv.getBoundingClientRect(); return [e.clientX - rr.left, e.clientY - rr.top]; }
    function hitPt(r, ln, e) {
      if (!ln) return null;
      const g = geo(r), [x, y] = local(r, e);
      let best = null, bd = HIT;
      for (const p of ln.points) { const d = Math.hypot(g.xOf(p[0]) - x, yOf(p[1]) - y); if (d <= bd) { bd = d; best = p; } }
      return best;
    }
    const sortPts = (ln) => ln.points.sort((p, q) => p[0] - q[0]);
    function readout(r, ln, x, y, p) {
      const q = A.parseTarget(ln.target), g = geo(r), S = M.song;
      const t = p ? p[0] : clamp(g.tOf(x), 0, md.tot16(S)), v = p ? p[1] : ln.points.length ? A.valueAt(ln.points, t) : neutralV(ln.target);
      const spb = md.spb(S), bar = Math.floor(t / spb), st = t - bar * spb;
      tip.textContent = A.fmt(q.kind, v) + ' · bar ' + (bar + 1) + '.' + (Math.round(st * 100) / 100 + 1);
      tip.hidden = false;
      const rr = rootEl.getBoundingClientRect(), cr = r.cv.getBoundingClientRect();
      tip.style.left = Math.round(clamp(cr.left - rr.left + x + 12, 0, Math.max(0, rr.width - 130))) + 'px';
      tip.style.top = Math.round(cr.top - rr.top + Math.max(0, y - 26)) + 'px';
    }
    const snapT = (t, e) => clamp(e.shiftKey ? Math.round(t * 1000) / 1000 : Math.round(t), 0, md.tot16(M.song));
    function onDown(r, e) {
      const ln = laneOf(r);
      if (!ln || e.button !== 0) return;
      const g = geo(r), [x, y] = local(r, e);
      if (x < g.x0) return;
      e.preventDefault();
      const h = hitPt(r, ln, e), multi = e.shiftKey || e.ctrlKey || e.metaKey;
      lastLane = ln.id; active = true;
      if (h && e.altKey) { sel = { lane: ln.id, pt: h }; toggleSmooth(h); return; }
      if (!h && multi) {   // Shift / Ctrl + drag on empty space = marquee
        drag = { r, ln, mq: true, add: multi, x0: x, y0: y, x, y };
        try { r.cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        return;
      }
      if (h && multi) {   // Shift-click toggles a point in the selection
        if (msLane !== ln.id) ms.clear();
        msLane = ln.id;
        if (ms.has(h)) ms.delete(h); else ms.add(h);
      } else if (!(h && ms.has(h) && msLane === ln.id)) ms.clear();
      // a second press on the same point within 400 ms = double-click / double-tap: delete it
      if (h && lastTap && lastTap.pt === h && e.timeStamp - lastTap.t < 400) { lastTap = null; delPoint(ln, h); return; }
      lastTap = h ? { pt: h, t: e.timeStamp } : null;
      let pt = h, added = false;
      if (!pt) { pt = [snapT(g.tOf(x), e), Math.round(vOf(y) * 1000) / 1000]; ln.points.push(pt); sortPts(ln); added = true; }
      sel = { lane: ln.id, pt };
      const group = !added && ms.has(pt) && msLane === ln.id && ms.size > 1 ? [...ms].map((p) => ({ p, t: p[0], v: p[1] })) : null;
      drag = { r, ln, pt, added, moved: false, x0: x, y0: y, group };
      try { r.cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      readout(r, ln, x, y, pt);
      render();
    }
    function onMove(r, e) {
      const [x, y] = local(r, e);
      if (drag && drag.r === r && drag.mq) { drag.x = x; drag.y = y; draw(r); return; }
      if (drag && drag.r === r) {
        if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 3) return;
        drag.moved = true; lastTap = null;
        const g = geo(r);
        const nt = snapT(g.tOf(x), e), nv = Math.round(vOf(y) * 1000) / 1000;
        if (drag.group) {
          const G = drag.group, o = G.find((q) => q.p === drag.pt), tot = md.tot16(M.song);
          const dt = clamp(nt - o.t, -Math.min(...G.map((q) => q.t)), tot - Math.max(...G.map((q) => q.t)));
          const dv = clamp(nv - o.v, -Math.min(...G.map((q) => q.v)), 1 - Math.max(...G.map((q) => q.v)));
          for (const q of G) { q.p[0] = r3(q.t + dt); q.p[1] = r3(q.v + dv); }
        } else { drag.pt[0] = nt; drag.pt[1] = nv; }
        sortPts(drag.ln);
        readout(r, drag.ln, x, y, drag.pt);
        draw(r);
        return;
      }
      const ln = laneOf(r);
      if (!ln) return;
      hoverRow = r;
      const h = hitPt(r, ln, e);
      r.cv.style.cursor = h ? 'grab' : 'crosshair';
      readout(r, ln, x, y, h);
    }
    function onUp(r) {
      if (!drag || drag.r !== r) return;
      const d = drag;
      drag = null;
      if (d.mq) {
        const g = geo(r), mx = Math.min(d.x0, d.x), Mx = Math.max(d.x0, d.x), my = Math.min(d.y0, d.y), My = Math.max(d.y0, d.y);
        if (!d.add || msLane !== d.ln.id) ms.clear();
        msLane = d.ln.id;
        if (Mx - mx >= 3 || My - my >= 3) for (const p of d.ln.points) { const px = g.xOf(p[0]), py = yOf(p[1]); if (px >= mx && px <= Mx && py >= my && py <= My) ms.add(p); }
        sel = ms.size === 1 ? { lane: d.ln.id, pt: [...ms][0] } : null;
        render();
        return;
      }
      if (d.added) M.commit('Add automation point');
      else if (d.moved) M.commit(d.group ? 'Move automation points' : 'Move automation point');
      render();
    }
    function delPoint(ln, p) {
      const i = ln.points.indexOf(p);
      if (i < 0) return;
      ln.points.splice(i, 1);
      if (sel && sel.pt === p) sel = null;
      tip.hidden = true;
      M.commit('Delete automation point');
    }
    function toggleSmooth(p) {
      if (p[2]) p.length = 2; else p[2] = 1;
      M.commit(p[2] ? 'Smooth automation' : 'Linear automation');
    }
    // ---------- select / copy / paste (points of the lane last pressed; otherwise the keys fall through to the graph's notes) ----------
    function copyPts(cut) {
      const ln = curLane(), P = msPts();
      if (!ln || !P.length) return false;
      NS.autoClip = { target: ln.target, pts: P.map((p) => p.slice()), len: md.tot16(M.song), whole: false };
      if (cut) { ln.points = ln.points.filter((p) => !ms.has(p)); ms.clear(); sel = null; M.commit('Cut automation points'); } else M.toast('Copied ' + P.length + ' point' + (P.length > 1 ? 's' : ''));
      render(); return true;
    }
    function pasteHere() {
      const cl = clipOf(), ln = curLane();
      if (!cl || !cl.pts.length || !ln) return false;
      const S = M.song, tot = md.tot16(S), at = E.playing ? E.pos16 : (E.cue != null ? E.cue : E.pos16), t0 = Math.min(...cl.pts.map((p) => p[0]));
      const add = cl.pts.map((p) => { const q = p.slice(); q[0] = r3(p[0] - t0 + at); return q; }).filter((p) => p[0] <= tot).slice(0, Math.max(0, MAXP - ln.points.length));
      if (!add.length) { M.toast('Nothing to paste here (past the end of the section)'); return true; }
      ln.points.push(...add); sortPts(ln);
      ms.clear(); msLane = ln.id; add.forEach((p) => ms.add(p)); sel = null;
      M.commit('Paste automation points');
      render(); return true;
    }
    function selectAllPts() {
      const ln = curLane();
      if (!ln) return false;
      ms.clear(); msLane = ln.id; ln.points.forEach((p) => ms.add(p)); sel = null; render(); return true;
    }
    function delSelPts() {
      const ln = lanes().find((x) => x.id === msLane), P = msPts();
      if (!ln || !P.length) return false;
      ln.points = ln.points.filter((p) => !ms.has(p)); ms.clear(); sel = null; tip.hidden = true;
      M.commit('Delete automation point' + (P.length > 1 ? 's' : ''));
      render(); return true;
    }
    // Paste lane: the copied lane replaces the lane of its target in this section (made if missing), times stretched to this section's length
    function pasteLane() {
      const cl = clipOf();
      if (!cl || !cl.whole) return;
      const L = lanes(), S = M.song;
      let ln = L.find((x) => x.target === cl.target);
      if (!ln) {
        const q = A.parseTarget(cl.target);
        if (!q || (q.layer && !S.layers.some((l) => l.id === q.layer)) || L.length >= md.MAX_AUTO) { M.toast('Cannot paste that lane here'); return; }
        ln = { id: nextId(L), target: cl.target, points: [] }; L.push(ln);
      }
      const f = md.tot16(S) / (cl.len || 1);
      ln.points = cl.pts.map((p) => { const q = p.slice(); q[0] = r3(p[0] * f); return q; });
      ms.clear(); openState = true;
      M.commit('Paste lane: ' + nameOf(cl.target));
      render();
    }
    pasteLaneBtn.addEventListener('click', pasteLane);
    // Copy to sections: times are scaled proportionally to each target section's length; an existing lane of the same target is replaced
    function copyToSections(ln, ks) {
      const S = M.song, t0 = md.tot16(S) || 1;
      let n = 0;
      ks.forEach((k) => {
        const x = S.sections[k];
        if (!x || k === S.cur || !x.data) return;
        const d = x.data, f = md.tot16(md.sectionSong(S, k)) / t0;
        if (!Array.isArray(d.auto)) d.auto = [];
        let dst = d.auto.find((a) => a.target === ln.target);
        if (!dst) { if (d.auto.length >= md.MAX_AUTO) return; dst = { id: nextId(d.auto), target: ln.target, points: [] }; d.auto.push(dst); }
        dst.points = ln.points.map((p) => { const q = p.slice(); q[0] = r3(p[0] * f); return q; });
        n++;
      });
      if (n) { M.commit('Copy lane to ' + n + ' section' + (n > 1 ? 's' : '')); M.toast('Copied "' + nameOf(ln.target) + '" to ' + n + ' section' + (n > 1 ? 's' : '')); }
      return n;
    }
    // lane menu (fixed pop-over): Copy lane, Copy to sections (checklist)
    let menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu(r) {
      closeMenu();
      const ln = laneOf(r);
      if (!ln) return;
      const S = M.song, m = ui.h('div', 'mel-au-menu');
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', 'Lane menu: ' + nameOf(ln.target));
      const b1 = ui.h('button', 'mel-au-mi', 'Copy lane'); b1.type = 'button'; b1.title = 'Copy the whole lane; use Paste lane in another section';
      b1.addEventListener('click', () => { NS.autoClip = { target: ln.target, pts: ln.points.map((p) => p.slice()), len: md.tot16(S), whole: true }; closeMenu(); M.toast('Lane copied: switch section, then "Paste lane"'); render(); });
      const hd = ui.h('div', 'mel-au-mh', 'Copy to sections (times stretch to each length)');
      const list = ui.h('div', 'mel-au-ml'), boxes = [];
      S.sections.forEach((x, k) => {
        if (k === S.cur) return;
        const lb = ui.h('label', 'mel-au-mc'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = k;
        lb.append(cb, document.createTextNode(' ' + (x.name || 'Section ' + (k + 1)))); list.append(lb); boxes.push(cb);
      });
      const all = ui.h('button', 'mel-au-mi', 'All other sections'); all.type = 'button';
      all.addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); });
      const go = ui.h('button', 'mel-au-mi mel-au-go', 'Copy'); go.type = 'button';
      go.addEventListener('click', () => { const ks = boxes.filter((b) => b.checked).map((b) => +b.value); if (ks.length) copyToSections(ln, ks); closeMenu(); render(); });
      m.append(b1, hd);
      if (boxes.length) m.append(all, list, go); else m.append(ui.h('div', 'mel-au-mh', 'Add another section first.'));
      document.body.appendChild(m); menu = m;
      const br = r.mo.getBoundingClientRect();
      m.style.top = Math.round(Math.max(0, Math.min(br.bottom + 2, root.innerHeight - m.offsetHeight - 4))) + 'px';
      m.style.left = Math.round(Math.max(4, Math.min(br.right - m.offsetWidth, root.innerWidth - m.offsetWidth - 4))) + 'px';
    }
    const onDocDown = (e) => {
      if (menu && !menu.contains(e.target) && !(e.target.classList && e.target.classList.contains('mel-au-more'))) closeMenu();
      if (!rootEl.contains(e.target)) active = false;
    };
    document.addEventListener('pointerdown', onDocDown, true);
    M.cleanups.push(() => { document.removeEventListener('pointerdown', onDocDown, true); closeMenu(); });

    // Ctrl+C / X / V / A act on points while a lane is the active context; Delete / Backspace remove the selected points
    const onKey = (e) => {
      if (!alive) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'TEXTAREA' || (t && t.isContentEditable) || (tag === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type))) return;
      const k = (e.key || '').toLowerCase();
      if (e.key === 'Escape' && menu) { closeMenu(); return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (!active || !curLane()) return;
        let did = false;
        if (k === 'a') did = selectAllPts();
        else if (k === 'c') did = copyPts(false);
        else if (k === 'x') did = copyPts(true);
        else if (k === 'v') did = pasteHere();
        if (did) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (ms.size && (active || hoverRow) && delSelPts()) { e.preventDefault(); e.stopPropagation(); return; }
      if (!sel || !hoverRow) return;
      const ln = lanes().find((x) => x.id === sel.lane);
      if (!ln) return;
      e.preventDefault(); e.stopPropagation();
      delPoint(ln, sel.pt);
    };
    document.addEventListener('keydown', onKey, true);
    M.cleanups.push(() => document.removeEventListener('keydown', onKey, true));

    // ---------- live playback: look-ahead scheduler on the channel nodes (same curves as the export) ----------
    // Positions are the engine's continuous play time (t.cont16) mapped to song positions with E.segments, so loop
    // regions, song loops, seeks and Song-mode section switches (a new seekId) play the right part of the curve.
    const sch = { seekId: -1, upTo: 0, anchor: null, sec: 0, lastCont: 0, dirty: true, ps: [], master: false };
    function resolve(S) {
      const tg = A.targets(S), out = [], graph = NS.sound && NS.sound.debug && NS.sound.debug.graph;
      const wantM = tg.includes('master.vol');
      if (wantM !== sch.master && VH.audio.ctx) { sch.master = wantM; if (!wantM) E.autoMaster(false); }
      for (const t of tg) {
        const q = A.parseTarget(t);
        let p = null, neutral = 1;
        if (q.own === 'master') p = VH.audio.ctx ? E.autoMaster(true) : null;
        else if (graph) {
          const ch = graph.chans.get(q.layer ? 'L' + S.layers.findIndex((l) => l.id === q.layer) : q.own);
          if (ch) { p = ch.params()[q.kind]; neutral = ch.neutral(q.kind); }
        }
        if (p) out.push({ t, kind: q.kind, p, neutral, pcs: A.pieces(S, t) });
      }
      return out;
    }
    const valAt = (x, pos) => { const pc = x.pcs[0]; return pc ? A.real(x.kind, A.valueAt(pc.pts, pos)) : x.neutral; };
    function holdAll(list, pos) {
      const c = VH.audio.ctx;
      if (!c) return;
      const now = c.currentTime;
      for (const x of list) {
        try { if (x.p.cancelAndHoldAtTime) x.p.cancelAndHoldAtTime(now); else x.p.cancelScheduledValues(now); } catch (_) { x.p.cancelScheduledValues(now); }
        x.p.setValueAtTime(valAt(x, pos), now);
      }
    }
    function idle() {   // stopped: the params sit at the curve value of the cue / playhead
      if (!VH.audio.ctx || E.playing) return;
      const list = resolve(M.song);
      holdAll(list, E.cue != null ? E.cue : E.pos16);
      sch.ps = list.map((x) => x.p);
    }
    const unTick = M.onPlayTick((t) => {
      const c = VH.audio.ctx;
      if (!c || !alive) return;
      const S = M.song, list = resolve(S), sec = t.secPer16, cont = t.cont16;
      if (!list.length) { sch.ps = []; sch.seekId = t.seekId; return; }
      const same = list.length === sch.ps.length && list.every((x, i) => x.p === sch.ps[i]);
      if (sch.dirty || !same || t.seekId !== sch.seekId) {   // play, seek, section switch, an edit: restart from here
        holdAll(list, t.pos16);
        sch.ps = list.map((x) => x.p); sch.dirty = false; sch.seekId = t.seekId; sch.upTo = cont; sch.anchor = null;
      }
      if (sch.anchor == null || sec !== sch.sec || Math.abs(sch.anchor + cont * sec - t.ctxTime) > 0.025 || cont < sch.lastCont - 0.01) {
        sch.anchor = t.ctxTime - cont * sec; sch.sec = sec;
      }
      const horizon = cont + (LA + (E.bgAhead || 0)) / sec, now = c.currentTime;
      if (horizon > sch.upTo) {
        for (const g of E.segments(sch.upTo, horizon)) {
          for (const x of list) {
            for (const [p16, v, jump] of A.ramp(x.pcs, g.s, g.s + g.n, x.kind, x.neutral)) {
              const tm = Math.max(now, sch.anchor + (g.c + p16 - g.s) * sec);
              if (jump) x.p.setValueAtTime(v, tm); else x.p.linearRampToValueAtTime(v, tm);
            }
          }
        }
        sch.upTo = horizon;
      }
      sch.lastCont = cont;
      if (rows.size && !body.hidden) drawAll();
    });
    M.on('stop', () => { sch.dirty = true; idle(); drawAll(); });
    M.on('seek', () => { if (!E.playing) idle(); });
    M.on('song', () => { sch.dirty = true; idle(); render(); });
    M.on('section', () => { sch.dirty = true; ms.clear(); lastLane = null; closeMenu(); render(); });
    M.on('layout', () => render()); M.on('scroll', drawAll);
    M.on('layer', render);

    // debug / tests
    NS.autoPart = { M, render, addLane, removeLane, rows, sch, isOpen, el: rootEl, ms, copyToSections, pasteLane, laneOf: (id) => lanes().find((x) => x.id === id),
      get open() { return openState; }, set open(v) { openState = v; render(); }, geo: (id) => (rows.get(id) ? geo(rows.get(id)) : null) };
    mountLane();
    render();
    return {
      destroy() {
        alive = false; unTick();
        try { if (sch.master) E.autoMaster(false); } catch (_) { /* ignore */ }
        if (slot) slot.remove();
        if (NS.autoPart && NS.autoPart.M === M) NS.autoPart = null;
      },
    };
  });
})(this);
