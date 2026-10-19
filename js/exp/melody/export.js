// melody/export.js - Wave B part (B3): MIDI / WAV / MP3 export. See MELODY.md.
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

  // Bars [a, b) of a (runtime) song as a song of its own, for "Export loop region only": chords, lines, notes starting
  // in the range, per-bar drum patterns and vibrato (song.ext.edit.vib) shifted to start at bar 0.
  function sliceSong(S, a, b) {
    const n = b - a, o = Object.assign({}, S), l0 = a * LPB, l1 = b * LPB, s0 = a * SPB, s1 = b * SPB;
    const copy = (x) => (x && typeof x === 'object' ? JSON.parse(JSON.stringify(x)) : {});
    o.bars = n; o.loopRegion = null;
    o.chords = S.chords.slice(a, b).map((c) => (c ? c.slice() : null));
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
  function songToMidi(song, opts) {
    const o = opts || {}, loops = Math.max(1, o.loops | 0 || 1), bars = song.bars, tot = bars * SPB;
    const secPer16 = 15 / song.bpm, cm = o.chordMidis || chordMidisLocal;
    const soundOf = o.soundOf || ((i) => ({ id: song.layers[i].sound, name: song.layers[i].sound }));
    const chosen = (o.layers || song.layers.map((_, i) => i)).filter((i) => song.layers[i]);
    const parts = [];   // { name, ch, program, vol, events }
    const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    const takeCh = (pref) => (free.length ? free.shift() : pref);
    const vel = 100;
    for (const i of chosen) {
      const l = song.layers[i], snd = soundOf(i) || {}, label = l.name + ' – ' + (snd.name || l.sound);
      const voices = lineVoices(l), hasLine = voices.length > 0, hasNotes = l.notes && l.notes.length > 0;
      if (!hasLine && !hasNotes) continue;
      const vr = vibReader(song, i), prog = gmProgram(snd), vol = l.vol ?? 0.8;
      const chs = voices.map((_, k) => takeCh(k ? -1 : 0)).map((c, k, a) => (c < 0 ? a[0] : c));
      const chL = hasLine ? chs[0] : takeCh(0), chN = hasLine && hasNotes ? takeCh(chL) : chL;
      const evV = voices.map(() => []), evN = [];
      for (let r = 0; r < loops; r++) {
        voices.forEach((runs, k) => {
          for (const x of runs) evV[k].push(...lineEvents(x.st.v, chs[k], r * tot, secPer16, vr, vel, [[x.a, x.b]], x.st.id));
        });
        if (hasNotes) evN.push(...noteEvents(l.notes, chN, r * tot, secPer16, vel, vr));
      }
      const many = voices.length > 1;
      voices.forEach((_, k) => {
        const same = chs[k] === chN && k === 0;   // a layer with one line voice and notes on the same channel
        parts.push({ name: label + (many ? ' (line ' + (k + 1) + ')' : ''), ch: chs[k], program: prog, vol, track: i, events: same ? evV[k].concat(evN) : evV[k] });
      });
      if (hasNotes && !(hasLine && chN === chs[0])) parts.push({ name: label + (hasLine ? ' (notes)' : ''), ch: chN, program: prog, vol, track: i, events: evN });
    }
    if (o.backing && song.chords && song.chords.some(Boolean)) {
      const ch = takeCh(8), ev = [], snd = o.backingSound || { id: song.backing && song.backing.sound };
      for (let r = 0; r < loops; r++) {
        song.chords.forEach((c, b) => {
          if (!c) return;
          const t0 = (r * tot + b * SPB) * T16, t1 = t0 + SPB * T16;
          // the backing style + its sub-settings (B2's events: p = sixteenth in the bar, dt / dur in seconds, g = gain)
          const bev = o.backingEvents ? o.backingEvents(b, c) : null;
          if (bev && bev.length) {
            const tk = T16 / secPer16;
            for (const e of bev) {
              const a = Math.max(0, Math.round(t0 + e.p * T16 + (e.dt || 0) * tk)), z = Math.max(a + 1, Math.round(a + e.dur * tk));
              const k = clamp(Math.round(e.m), 0, 127), v = clamp(Math.round(72 * (e.g || 0.25) / 0.25), 1, 127);
              ev.push({ t: a, o: O.on, b: [0x90 | ch, k, v] }); ev.push({ t: z, o: O.off, b: [0x80 | ch, k, 0] });
            }
            return;
          }
          for (const m of cm(c)) { ev.push({ t: t0, o: O.on, b: [0x90 | ch, m, 72] }); ev.push({ t: t1, o: O.off, b: [0x80 | ch, m, 0] }); }
        });
      }
      parts.push({ name: 'Backing chords – ' + (snd.name || snd.id || 'chords'), ch, program: gmProgram(snd), vol: song.backing ? song.backing.vol : 0.4, events: ev });
    }
    if (o.drums) {
      const hits = o.drumHits || drumHits(song.drums, bars);
      if (hits.length) {
        const ev = [];
        for (let r = 0; r < loops; r++) for (const h of hits) {
          const t0 = (r * tot + h.t16) * T16;
          ev.push({ t: t0, o: O.on, b: [0x99, h.note, h.vel] }); ev.push({ t: t0 + T16 / 2, o: O.off, b: [0x89, h.note, 0] });
        }
        parts.push({ name: 'Drums', ch: 9, program: 0, vol: (song.drums && typeof song.drums.vol === 'number') ? song.drums.vol : 0.8, events: ev });
      }
    }
    const usPerQ = Math.round(60e6 / song.bpm);
    const conductor = [{ t: 0, o: O.setup, b: meta(0x03, txt(o.title || 'Visual Harmonics')) },
      { t: 0, o: O.setup, b: meta(0x51, [(usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255]) },
      { t: 0, o: O.setup, b: meta(0x58, [4, 2, 24, 8]) }];
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

  const X = { songToMidi, sliceSong, encodeWav, drumHits, drumNote, gmProgram, vibReader, strokesOf, lineVoices, vlq, PPQ, T16, TBEND, TLINE };
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
    const st = { fmt: 'midi', midiMode: 'mixed', scope: 'song', loops: 1, pick: null, backing: true, drums: true, region: false, normalize: true };
    // The song to export: the whole song, or (with "Export loop region only" checked and a region set) just its bars.
    const songOf = () => { const r = md.regionOf(M.song); return st.region && r ? sliceSong(M.song, r[0], r[1]) : M.song; };

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
        for (let b = 0; b < S.bars; b++) for (const e of B.drumEvents(S, b)) out.push({ t16: b * SPB + e.p, note: GMD[e.drum] || drumNote(e.drum) || 37, vel: clamp(Math.round(e.vel * 110), 1, 127) });
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
      const reg = md.regionOf(S);
      if (reg) {
        const rr = ui.h('div', 'mx-row'); dlg.append(rr);
        check(rr, 'Export loop region only (bar' + (reg[1] - reg[0] > 1 ? 's ' + (reg[0] + 1) + '–' + reg[1] : ' ' + (reg[0] + 1)) + ')', st.region, true, '',
          (v) => { st.region = v; }, 'mx-region');
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
      if (whole) return { layers: S.layers.map((_, i) => i).filter((i) => md.layerGain(S, i) > 0), backing: S.backing.on, drums: hasDrums(), whole };
      return { layers: S.layers.map((_, i) => i).filter((i) => st.pick[i]), backing: st.backing, drums: st.drums && hasDrums(), whole };
    }

    async function run() {
      if (busy) return;
      const sel = selection(), name = 'visual-harmonics-' + stamp();
      if (!sel.layers.length && !sel.backing && !sel.drums) { progress(null, 'Choose at least one part.'); return; }
      busy = true; render(); progress(0, st.fmt === 'midi' ? 'Writing MIDI…' : 'Preparing instruments…');
      try {
        if (st.fmt === 'midi') {
          const src = songOf();
          const bytes = songToMidi(src, { mode: st.midiMode, layers: sel.layers, backing: sel.backing, drums: sel.drums, loops: st.loops,
            soundOf: (i) => M.soundOf(i), backingSound: M.backingSound(), chordMidis: md.chordMidis, drumHits: sel.drums ? drumList() : null,
            backingEvents: NS.sound && NS.sound.barEvents ? (b) => NS.sound.barEvents(src, b) : null });
          download(new Blob([bytes], { type: 'audio/midi' }), name + '.mid');
          progress(1, 'Saved ' + name + '.mid (' + (st.midiMode === 'mixed' ? 'one track' : 'one track per part') + ').');
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
      const S = songOf(), sr = 44100, bars = S.bars, tot = bars * SPB, sec16 = md.secPer16(S), songSec = loops * tot * sec16;
      const seconds = songSec + TAIL;
      const ids = new Set(sel.layers.map((i) => M.soundOf(i).id));   // samplers must be decoded first
      if (sel.backing) ids.add(M.backingSound().id);
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
          b2 = B.offline(ctx, S2, master, { bars: loops * bars, backingSound: back, backing: !!sel.backing, drums: !!sel.drums });
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
          const hits = sel.drums ? drumHits(S.drums, bars) : [];
          let noise = null;
          if (hits.length) {
            drumsUsed = true;
            noise = ctx.createBuffer(1, sr, sr); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
          }
          for (let r = 0; r < loops; r++) {
            const off = r * tot * sec16;
            if (sel.backing) S.chords.forEach((ch, b) => {
              if (!ch) return;
              const t0 = off + b * SPB * sec16;
              md.chordMidis(ch).forEach((m) => VH.audio.voice(back, hz(m), { gain: G_BACK, dest: backBus, when: t0 }).stop(0.12, t0 + SPB * sec16));
            });
            for (const h of hits) drumVoice(ctx, drumBus, h.note, off + h.t16 * sec16 + 0.003, h.vel, noise);
          }
        }
        // layers: the engine's playback rules (glide = one legato voice per run, hit = re-strike per semitone)
        for (let r = 0; r < loops; r++) {
          const off = r * tot * sec16;
          for (const L of sel.layers) {
            const l = S.layers[L], snd = sounds[L], bus = layerIn(L), vr = vibReader(S, L);
            for (const n of l.notes) {
              const t0 = off + n.s * sec16, t1 = t0 + n.d * sec16, v = VH.audio.voice(snd, hz(n.m), { gain: G_NOTE, dest: bus, when: t0 });
              v.stop(undefined, t1);
              const vb = vr.note(n);
              if (vb) for (let t = t0 + VIB_DT; t < t1; t += VIB_DT) { const f = hz(n.m + vb.depth * Math.sin(2 * Math.PI * vb.rate * (t - t0))); at(t, () => v.setFreq(f, 0.01, t)); }
            }
            const dtL = sec16 * SPB / LPB, hit = plays[L] === 'hit';
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
      try { buf = await c.startRendering(); } finally { if (b2 && b2.dispose) { try { b2.dispose(); } catch (_) { /* ignore */ } } }
      onProgress(1);
      return { channels: [buf.getChannelData(0), buf.getChannelData(1)], sr, seconds: buf.duration, songSeconds: songSec, fx: fxUsed, viaB2: !!b2, drums: drumsUsed };
    }

    const api = { open, close, render: renderAudio, normalizePeak, last: null, state: st, songOf, sliceSong };
    VH.melody.exportPart = api;
    return {
      destroy() {
        alive = false; close();
        if (VH.melody.exportPart === api) VH.melody.exportPart = null;
      },
    };
  });
})(this);
