// synth.js - the subtractive synth model, "synth.v2" (window.VH.synth). Pure: no audio nodes here.
// A v2 sound is { kind: 'synth', synth: { v: 2, oscs, filter, ampEnv, filtEnv, lfos, glide, gain, ...compat } }.
//   oscs (1..3): { wave: sine|saw|square|triangle|noise|partials, partials?: [[ratio, amp]], oct, semi, detune (cents),
//                  level 0..1, unison 1..7, spread (cents, total width), stretch (ratio r -> r^stretch) }
//   filter: { type: lowpass|highpass|bandpass, cutoff Hz, q (linear resonance), envAmt (octaves), keyTrack 0..1 }
//           24 dB/oct: two cascaded biquads, stage A with q, stage B with Q 0.5 (lowpass/highpass) or q (bandpass).
//   ampEnv / filtEnv: { a, d, s, r } (seconds, sustain 0..1)
//   lfos (0..2): { rate Hz, shape: sine|triangle|square|sawtooth, target: pitch|cutoff|amp|pan, depth 0..1 }
//                depth scales: pitch 1 semitone, cutoff 3 octaves, amp 100 %, pan full width.
//   glide: portamento seconds (setFreq default); gain: output trim (on top of the loudness match).
// Compat fields kept on every v2 synth: partials (= the analytic spectrum), attack/decay/sustain/release (= ampEnv).
// The audio engine (VH.audio) builds v2 voices; spectrumOf (VH.sounds) uses spectrum() below.
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  const WAVES = ['sine', 'saw', 'square', 'triangle', 'noise', 'partials'];
  const FTYPES = ['lowpass', 'highpass', 'bandpass'];
  const SHAPES = ['sine', 'triangle', 'square', 'sawtooth'];
  const TARGETS = ['pitch', 'cutoff', 'amp', 'pan'];
  const NOMINAL_ROOT = 262, SR = 48000;
  const LFO_SCALE = { pitch: 100, cutoff: 3600, amp: 1, pan: 1 };   // depth 1 -> cents / cents / gain / pan

  const r4 = (x) => +(+x).toPrecision(4);
  const num = (v, lo, hi, def) => { v = +v; if (!isFinite(v)) v = def; return r4(Math.max(lo, Math.min(hi, v))); };
  const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
  const pick = (v, list, def) => (list.includes(v) ? v : def);

  // ---------- normalisation (also the defaults) ----------
  function normOsc(o) {
    o = o || {};
    const out = {
      wave: pick(o.wave, WAVES, 'saw'), oct: int(o.oct, -3, 3, 0), semi: int(o.semi, -12, 12, 0), detune: num(o.detune, -100, 100, 0),
      level: num(o.level, 0, 1, 1), unison: int(o.unison, 1, 7, 1), spread: num(o.spread, 0, 100, 0), stretch: num(o.stretch, 0.8, 1.2, 1),
    };
    if (out.wave === 'partials') {
      const ps = (Array.isArray(o.partials) ? o.partials : []).filter((p) => Array.isArray(p) && p[0] > 0 && p[1] >= 0 && isFinite(p[0]) && isFinite(p[1]))
        .slice(0, 32).map((p) => [num(p[0], 0.0625, 64, 1), num(p[1], 0, 1, 0)]);
      out.partials = ps.length ? ps : [[1, 1]];
    }
    return out;
  }
  const normEnv = (e, d) => {
    e = e || {};
    return { a: num(e.a, 0.001, 8, d.a), d: num(e.d, 0.01, 8, d.d), s: num(e.s, 0, 1, d.s), r: num(e.r, 0.01, 8, d.r) };
  };
  function normalize(m) {
    m = m || {};
    const oscs = (Array.isArray(m.oscs) && m.oscs.length ? m.oscs : [{}]).slice(0, 3).map(normOsc);
    const f = m.filter || {};
    return {
      v: 2, oscs,
      filter: { type: pick(f.type, FTYPES, 'lowpass'), cutoff: num(f.cutoff, 30, 18000, 2400), q: num(f.q, 0.5, 18, 0.7),
        envAmt: num(f.envAmt, -4, 6, 0), keyTrack: num(f.keyTrack, 0, 1, 0.5) },
      ampEnv: normEnv(m.ampEnv, { a: 0.01, d: 0.3, s: 0.8, r: 0.3 }),
      filtEnv: normEnv(m.filtEnv, { a: 0.01, d: 0.4, s: 0.4, r: 0.3 }),
      lfos: (Array.isArray(m.lfos) ? m.lfos : []).slice(0, 2).map((l) => ({
        rate: num(l && l.rate, 0.05, 20, 5), shape: pick(l && l.shape, SHAPES, 'sine'), target: pick(l && l.target, TARGETS, 'pitch'), depth: num(l && l.depth, 0, 1, 0) })),
      glide: num(m.glide, 0, 2, 0), gain: num(m.gain, 0, 2, 1),
    };
  }
  const isV2 = (s) => !!(s && s.kind === 'synth' && s.synth && s.synth.v === 2);

  // ---------- waves ----------
  // The harmonic series of a wave as [[ratio, amp]] (before stretch), up to n harmonics.
  function waveHarmonics(o, n = 32) {
    switch (o.wave) {
      case 'sine': return [[1, 1]];
      case 'saw': return Array.from({ length: n }, (_, k) => [k + 1, 1 / (k + 1)]);
      case 'square': return Array.from({ length: Math.ceil(n / 2) }, (_, k) => [2 * k + 1, 1 / (2 * k + 1)]);
      case 'triangle': return Array.from({ length: Math.ceil(n / 2) }, (_, k) => [2 * k + 1, 1 / (2 * k + 1) ** 2]);
      case 'partials': return (o.partials || [[1, 1]]).filter((p) => p[1] > 0).map((p) => [p[0], p[1]]);
      default: return [];   // noise
    }
  }
  const oscMul = (o) => 2 ** (o.oct + o.semi / 12 + o.detune / 1200);
  // Does this oscillator need an additive bank (stretched or inharmonic partials) instead of one oscillator?
  function additive(o) {
    if (o.wave === 'noise' || o.wave === 'sine') return false;
    if (Math.abs(o.stretch - 1) > 1e-4) return true;
    return o.wave === 'partials' && (o.partials || []).some((p) => Math.abs(p[0] - Math.round(p[0])) > 1e-3 || p[0] > 64 || p[0] < 1);
  }

  // ---------- filter response (Web Audio biquads, Audio EQ Cookbook) ----------
  function coeffs(type, f0, q, sr) {
    const w0 = 2 * Math.PI * Math.min(f0, sr / 2 - 1) / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    let b0, b1, b2;
    if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; }
    else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    const a0 = 1 + al;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  }
  function mag(k, hz, sr) {
    const w = 2 * Math.PI * hz / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = k.b0 + k.b1 * c1 + k.b2 * c2, ni = -(k.b1 * s1 + k.b2 * s2), dr = 1 + k.a1 * c1 + k.a2 * c2, di = -(k.a1 * s1 + k.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  // The two stages' Q (linear) for a filter.
  const stageQ = (f) => [f.q, f.type === 'bandpass' ? f.q : 0.5];
  // The Q AudioParam value of a stage: lowpass/highpass take dB (alpha = sin / (2 * 10^(Q/20))), bandpass is linear.
  const nodeQ = (type, q) => (type === 'bandpass' ? q : 20 * Math.log10(q));
  // Cutoff while the note is held at freq: keytracked around C4, plus the filter envelope at its sustain level.
  function sustainCutoff(m, freq = NOMINAL_ROOT) {
    const f = m.filter;
    return f.cutoff * (freq / NOMINAL_ROOT) ** f.keyTrack * 2 ** (f.envAmt * m.filtEnv.s);
  }
  // |H(hz)| of the whole (two-stage) filter at cutoff fc.
  function filterMag(filter, hz, fc, sr = SR) {
    if (!(hz > 0) || hz >= sr / 2) return 0;
    const fcc = Math.max(10, Math.min(sr / 2 - 1, fc || filter.cutoff)), [qa, qb] = stageQ(filter);
    return mag(coeffs(filter.type, fcc, qa, sr), hz, sr) * mag(coeffs(filter.type, fcc, qb, sr), hz, sr);
  }

  // ---------- analytic spectrum (for harmony math): no rendering ----------
  // Every oscillator's harmonic series (stretched, shifted by oct/semi/detune, scaled by its level and the filter's
  // magnitude at the sustain cutoff), merged, at a nominal C4 root. Noise is ignored. <= 16 entries, max 1.
  function spectrum(model, root0 = NOMINAL_ROOT) {
    const m = model && model.v === 2 ? model : normalize(model);
    const fc = sustainCutoff(m, root0), raw = [];
    for (const o of m.oscs) {
      if (o.wave === 'noise' || !(o.level > 0)) continue;
      const mul = oscMul(o), hs = waveHarmonics(o, 32);
      for (const [r, a] of hs) {
        const ratio = r ** o.stretch * mul, hz = ratio * root0;
        if (hz >= 20000) continue;
        const amp = a * o.level * filterMag(m.filter, hz, fc);
        if (amp > 1e-5) raw.push([ratio, amp]);
      }
    }
    raw.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const p of raw) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(p[0] / last[0] - 1) < 0.003) { last[1] += p[1]; continue; }
      merged.push(p.slice());
    }
    if (!merged.length) return [[1, 1]];
    const top = merged.sort((a, b) => b[1] - a[1]).slice(0, 16), max = top[0][1];
    return top.filter((p) => p[1] / max > 1e-3).map(([r, a]) => [r4(r), r4(a / max)]).sort((a, b) => a[0] - b[0]);
  }

  // Envelope -> play type: a short decay into silence is a 'hit', anything that holds is 'glide'.
  const playOf = (m) => { const e = (m && m.ampEnv) || {}; return (e.s ?? 1) <= 0.02 && (e.d ?? 1) <= 3 ? 'hit' : 'glide'; };

  // The full synth object stored on a sound: the model plus the v1 compat fields.
  function toSynth(model) {
    const m = normalize(model);
    return Object.assign(m, { partials: spectrum(m), attack: m.ampEnv.a, decay: m.ampEnv.d, sustain: m.ampEnv.s, release: m.ampEnv.r });
  }
  // A sound from a model. meta: { id, name, source = 'custom', loud }.
  function toSound(model, meta) {
    const o = meta || {}, synth = toSynth(model);
    const s = { id: o.id, name: o.name || 'My synth', family: 'synth', source: o.source || 'custom', kind: 'synth',
      play: playOf(synth), synth, spectrum: synth.partials.map((p) => p.slice()) };
    if (o.loud > 0) s.loud = o.loud;
    if (!s.id) delete s.id;
    return s;
  }
  // The bare model (no compat fields) of a v2 sound or synth object.
  const modelOf = (x) => normalize(x && x.synth ? x.synth : x);

  // ---------- portable definitions (share links) ----------
  const WCODE = { sine: 's', saw: 'w', square: 'q', triangle: 't', noise: 'n', partials: 'p' };
  const WDEC = Object.fromEntries(Object.entries(WCODE).map(([k, v]) => [v, k]));
  const FCODE = { lowpass: 'l', highpass: 'h', bandpass: 'b' }, FDEC = { l: 'lowpass', h: 'highpass', b: 'bandpass' };
  const SCODE = { sine: 's', triangle: 't', square: 'q', sawtooth: 'w' }, SDEC = { s: 'sine', t: 'triangle', q: 'square', w: 'sawtooth' };
  const TCODE = { pitch: 'p', cutoff: 'c', amp: 'a', pan: 'n' }, TDEC = { p: 'pitch', c: 'cutoff', a: 'amp', n: 'pan' };
  const env4 = (e) => [e.a, e.d, e.s, e.r];
  const envOf = (a) => ({ a: a[0], d: a[1], s: a[2], r: a[3] });
  // portable(sound) -> compact JSON-able definition ({ v: 2, n: name, o, f, ae, fe, l, g, G, L }); null if not v2.
  function portable(sound) {
    if (!isV2(sound)) return null;
    const m = modelOf(sound), f = m.filter;
    const d = {
      v: 2, n: String(sound.name || 'Synth').slice(0, 40),
      o: m.oscs.map((o) => { const a = [WCODE[o.wave], o.oct, o.semi, o.detune, o.level, o.unison, o.spread, o.stretch]; if (o.partials) a.push(o.partials); return a; }),
      f: [FCODE[f.type], f.cutoff, f.q, f.envAmt, f.keyTrack], ae: env4(m.ampEnv), fe: env4(m.filtEnv),
      l: m.lfos.map((l) => [l.rate, SCODE[l.shape], TCODE[l.target], l.depth]), g: m.glide, G: m.gain,
    };
    if (sound.loud > 0) d.L = r4(sound.loud);
    return d;
  }
  function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
  // fromPortable(def) -> a v2 sound (not saved). Its id is a hash of the definition, so the same synth keeps one id.
  function fromPortable(def) {
    if (!def || def.v !== 2 || !Array.isArray(def.o)) return null;
    const model = {
      oscs: def.o.map((a) => ({ wave: WDEC[a[0]], oct: a[1], semi: a[2], detune: a[3], level: a[4], unison: a[5], spread: a[6], stretch: a[7], partials: a[8] })),
      filter: Array.isArray(def.f) ? { type: FDEC[def.f[0]], cutoff: def.f[1], q: def.f[2], envAmt: def.f[3], keyTrack: def.f[4] } : {},
      ampEnv: Array.isArray(def.ae) ? envOf(def.ae) : null, filtEnv: Array.isArray(def.fe) ? envOf(def.fe) : null,
      lfos: (def.l || []).map((a) => ({ rate: a[0], shape: SDEC[a[1]], target: TDEC[a[2]], depth: a[3] })), glide: def.g, gain: def.G,
    };
    const norm = normalize(model);
    return toSound(norm, { id: 'syn-' + hash(JSON.stringify(norm)), name: String(def.n || 'Shared synth').slice(0, 40), source: 'custom', loud: def.L });
  }

  // ---------- presets ----------
  const O = (wave, o) => Object.assign({ wave }, o);
  const E = (a, d, s, r) => ({ a, d, s, r });
  const L = (rate, target, depth, shape = 'sine') => ({ rate, shape, target, depth });
  const F = (type, cutoff, q, envAmt, keyTrack = 0.5) => ({ type, cutoff, q, envAmt, keyTrack });
  const P = (id, name, m) => ({ id, name, model: normalize(m) });
  const PRESETS = [
    P('warm-pad', 'Warm pad', { oscs: [O('saw', { unison: 3, spread: 18 }), O('saw', { oct: -1, detune: 6, level: 0.6 })], filter: F('lowpass', 900, 0.9, 1.2),
      ampEnv: E(0.6, 0.8, 0.85, 1.2), filtEnv: E(0.9, 1.5, 0.5, 1), lfos: [L(0.25, 'cutoff', 0.12)] }),
    P('saw-lead', 'Saw lead', { oscs: [O('saw'), O('saw', { detune: 9, level: 0.8 })], filter: F('lowpass', 2200, 2.2, 1.2),
      ampEnv: E(0.005, 0.2, 0.9, 0.15), filtEnv: E(0.005, 0.3, 0.4, 0.2), glide: 0.06 }),
    P('square-bass', 'Square bass', { oscs: [O('square', { oct: -1 }), O('sine', { oct: -1, level: 0.6 })], filter: F('lowpass', 500, 3, 2.2, 0.3),
      ampEnv: E(0.003, 0.3, 0.7, 0.08), filtEnv: E(0.002, 0.25, 0.1, 0.1) }),
    P('pluck', 'Pluck', { oscs: [O('saw'), O('square', { level: 0.5, detune: -5 })], filter: F('lowpass', 700, 1.5, 3.5, 0.7),
      ampEnv: E(0.002, 0.7, 0, 0.2), filtEnv: E(0.001, 0.25, 0, 0.2) }),
    P('bell', 'Bell', { oscs: [O('partials', { partials: [[1, 1], [2.76, 0.5], [5.4, 0.3], [8.93, 0.15]] }), O('sine', { oct: 1, level: 0.25 })],
      filter: F('lowpass', 9000, 0.7, 0), ampEnv: E(0.002, 2.5, 0, 1) }),
    P('organ', 'Organ', { oscs: [O('partials', { partials: [[1, 1], [2, 0.8], [3, 0.5], [4, 0.5], [6, 0.3], [8, 0.35]] })], filter: F('lowpass', 9000, 0.7, 0),
      ampEnv: E(0.01, 0.05, 1, 0.08), lfos: [L(6.5, 'amp', 0.08)] }),
    P('strings', 'Strings', { oscs: [O('saw', { unison: 5, spread: 22 }), O('saw', { oct: 1, level: 0.25, unison: 2, spread: 10 })], filter: F('lowpass', 2600, 0.7, 0.5),
      ampEnv: E(0.25, 0.5, 0.85, 0.5), filtEnv: E(0.3, 0.6, 0.5, 0.5), lfos: [L(5, 'pitch', 0.08)] }),
    P('brass', 'Brass', { oscs: [O('saw'), O('saw', { detune: -7 })], filter: F('lowpass', 800, 1.2, 2.2),
      ampEnv: E(0.05, 0.3, 0.85, 0.2), filtEnv: E(0.08, 0.4, 0.55, 0.2), lfos: [L(5.5, 'pitch', 0.05)] }),
    P('wobble-bass', 'Wobble bass', { oscs: [O('saw', { oct: -1 }), O('square', { oct: -1, detune: 8, level: 0.7 })], filter: F('lowpass', 500, 5, 0, 0.3),
      ampEnv: E(0.005, 0.2, 0.9, 0.1), lfos: [L(3, 'cutoff', 0.8)] }),
    P('chiptune', 'Chiptune', { oscs: [O('square'), O('square', { oct: 1, level: 0.25 })], filter: F('lowpass', 12000, 0.7, 0, 0),
      ampEnv: E(0.002, 0.1, 0.7, 0.05), lfos: [L(7, 'pitch', 0.06, 'square')] }),
    P('glass', 'Glass', { oscs: [O('triangle'), O('partials', { partials: [[1, 1], [2.32, 0.42], [4.25, 0.25], [6.63, 0.12]], level: 0.7 })],
      filter: F('lowpass', 7000, 1, 0), ampEnv: E(0.03, 1.5, 0.3, 0.9) }),
    P('sub-bass', 'Sub bass', { oscs: [O('sine', { oct: -1 }), O('triangle', { oct: -1, level: 0.3 })], filter: F('lowpass', 400, 0.7, 0, 0.5),
      ampEnv: E(0.005, 0.2, 0.95, 0.12) }),
    P('supersaw', 'Supersaw', { oscs: [O('saw', { unison: 7, spread: 35 }), O('saw', { oct: -1, unison: 3, spread: 20, level: 0.5 })], filter: F('lowpass', 4500, 0.8, 0.5),
      ampEnv: E(0.01, 0.3, 0.9, 0.3), filtEnv: E(0.01, 0.4, 0.6, 0.3) }),
    P('breathy-flute', 'Breathy flute', { oscs: [O('sine'), O('noise', { level: 0.12 }), O('triangle', { oct: 1, level: 0.1 })], filter: F('lowpass', 2600, 1, 0.4),
      ampEnv: E(0.08, 0.2, 0.85, 0.2), filtEnv: E(0.08, 0.3, 0.5, 0.2), lfos: [L(5, 'pitch', 0.06)] }),
    P('vibrato-lead', 'Vibrato lead', { oscs: [O('square'), O('saw', { detune: 6, level: 0.6 })], filter: F('lowpass', 2400, 2, 0.5),
      ampEnv: E(0.01, 0.2, 0.85, 0.2), lfos: [L(5.5, 'pitch', 0.35), L(5.5, 'amp', 0.1)], glide: 0.08 }),
    P('retro-keys', 'Retro keys', { oscs: [O('triangle'), O('square', { oct: 1, level: 0.3 })], filter: F('lowpass', 1800, 1, 1.5),
      ampEnv: E(0.003, 1.2, 0.3, 0.3), filtEnv: E(0.002, 0.6, 0.2, 0.3) }),
  ];
  const preset = (id) => { const p = PRESETS.find((x) => x.id === id); return p ? normalize(p.model) : null; };

  // ---------- randomize (musical: always audible, never piercing) ----------
  // Fraction of the (unfiltered) harmonic power that passes the held filter at C4 (0..1+).
  function passRatio(m) {
    const fc = sustainCutoff(m);
    let p0 = 0, p1 = 0;
    for (const o of m.oscs) {
      if (o.wave === 'noise' || !(o.level > 0)) continue;
      const mul = oscMul(o);
      for (const [r, a] of waveHarmonics(o, 32)) {
        const hz = r ** o.stretch * mul * NOMINAL_ROOT;
        if (hz >= 20000) continue;
        const e = (a * o.level) ** 2;
        p0 += e; p1 += e * filterMag(m.filter, hz, fc) ** 2;
      }
    }
    return p0 > 0 ? p1 / p0 : 0;
  }
  function randomize(rng) {
    for (let i = 0; i < 20; i++) { const m = randomOnce(rng); if (passRatio(m) > 0.1) return m; }
    return preset('saw-lead');
  }
  function randomOnce(rng) {
    const R = rng || Math.random, rr = (a, b) => a + (b - a) * R(), ch = (a) => a[Math.floor(R() * a.length)], lg = (a, b) => a * (b / a) ** R();
    const n = R() < 0.4 ? 1 : R() < 0.7 ? 2 : 3, oscs = [];
    for (let i = 0; i < n; i++) {
      const wave = i === 2 && R() < 0.3 ? 'noise' : ch(['saw', 'saw', 'square', 'triangle', 'sine', 'partials']);
      const o = { wave, oct: i === 0 ? ch([0, 0, 0, -1]) : ch([-1, 0, 0, 1]), semi: i > 0 && R() < 0.2 ? ch([7, -5, 12]) : 0,
        detune: i > 0 ? Math.round(rr(-12, 12)) : 0, level: i === 0 ? 1 : wave === 'noise' ? rr(0.05, 0.15) : rr(0.3, 0.8),
        unison: R() < 0.3 ? ch([2, 3, 5]) : 1, spread: Math.round(rr(8, 30)), stretch: R() < 0.15 ? r4(rr(0.97, 1.03)) : 1 };
      if (wave === 'partials') o.partials = Array.from({ length: 4 + Math.floor(R() * 8) }, (_, k) => [k + 1, k === 0 ? 1 : r4(rr(0, 1) / (k + 1) ** 0.5)]);
      oscs.push(o);
    }
    const t = R();
    const filter = t < 0.75 ? F('lowpass', Math.round(lg(500, 6000)), r4(lg(0.6, 6)), r4(rr(0, 3)), r4(rr(0, 1)))
      : t < 0.9 ? F('bandpass', Math.round(lg(300, 1500)), r4(rr(0.6, 2)), r4(rr(0, 1.5)), 0.5)
        : F('highpass', Math.round(lg(80, 200)), r4(rr(0.6, 2)), 0, 0.5);
    const hit = R() < 0.35;
    const ampEnv = hit ? E(r4(rr(0.001, 0.01)), r4(rr(0.35, 1.5)), 0, r4(rr(0.1, 0.6))) : E(r4(lg(0.002, 0.6)), r4(rr(0.1, 1)), r4(rr(0.5, 1)), r4(lg(0.05, 1.2)));
    const filtEnv = E(r4(lg(0.002, 0.5)), r4(rr(0.1, 1.2)), r4(rr(0, 0.8)), r4(rr(0.1, 0.8)));
    const lfos = R() < 0.5 ? [] : [R() < 0.5 ? L(r4(rr(4.5, 6.5)), 'pitch', r4(rr(0.03, 0.2))) : L(r4(lg(0.2, 6)), ch(['cutoff', 'amp', 'pan']), r4(rr(0.1, 0.5)), ch(SHAPES))];
    return normalize({ oscs, filter, ampEnv, filtEnv, lfos, glide: R() < 0.3 ? r4(rr(0.02, 0.15)) : 0, gain: 1 });
  }

  const api = { WAVES, FTYPES, SHAPES, TARGETS, LFO_SCALE, NOMINAL_ROOT, PRESETS, normalize, normOsc, isV2, waveHarmonics, oscMul, additive,
    coeffs, nodeQ, stageQ, passRatio, filterMag, sustainCutoff, spectrum, playOf, toSynth, toSound, modelOf, portable, fromPortable, preset, randomize };
  VH.synth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);
