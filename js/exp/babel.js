// babel.js - Babel v3: an infinite, zoomable map of sounds.
// The plane is split into 8 large biomes (Strings, Metal, Wood, Air, Voice, Machine, Nature, Texture), each with its
// own synthesis engines; finer noise varies their parameters, and borders blend two biomes into hybrids.
// Rarity has a meaning: common = one sound, uncommon = a border hybrid, rare = a pattern (arpeggio / rhythm / echo),
// epic = a hidden phrase, legendary = one of 16 hand-made named Gems hidden at sparse points (found with the Detector).
// All audio is rendered in plain JS into buffers (deterministic per coordinate; identical live and for ★ Save).
(function () {
  'use strict';
  const VH = window.VH, ui = VH.ui;
  const TAU = Math.PI * 2;
  // Playback gain of rendered sounds (buffers levelled to RMS ~0.14) into VH.audio.out; matched to Melody/Spiral levels.
  const PLAY_GAIN = 0.35;

  // ---------- deterministic value noise + fbm ----------
  function hash(ix, iy, seed) {
    let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const fade = (t) => t * t * (3 - 2 * t);
  function vnoise(x, y, seed) {
    const fx = Math.floor(x), fy = Math.floor(y), u = fade(x - fx), v = fade(y - fy);
    const a = hash(fx, fy, seed), b = hash(fx + 1, fy, seed), c = hash(fx, fy + 1, seed), d = hash(fx + 1, fy + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  // 5 base octaves + "deep" octaves faded in as the zoom resolves them: new detail forever. Returns ~0..1 (raw).
  const OCTAVES = 5, NORM = 1 / (2 - 2 * 0.5 ** OCTAVES), DEEP = 0.16;
  // Each octave is rotated (~37 deg) so the value-noise lattice never shows as squares.
  function fbmRaw(x, y, seed, depth) {
    let s = 0, amp = 1, t;
    for (let o = 0; o < OCTAVES; o++) { s += amp * vnoise(x, y, seed * 131 + o); amp *= 0.5; t = 1.6 * x - 1.2 * y; y = 1.2 * x + 1.6 * y; x = t; }
    let v = s * NORM;
    for (let o = OCTAVES; o < depth; o++) {
      const w = Math.min(1, depth - o);
      v = 0.5 + (v - 0.5) * (1 - 0.07 * w) + DEEP * w * (vnoise(x, y, seed * 131 + o) - 0.5);
      t = 1.6 * x - 1.2 * y; y = 1.2 * x + 1.6 * y; x = t;
    }
    return v;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = (v) => clamp(v, 0, 1);
  const fbm = (x, y, seed, depth, k) => clamp01((fbmRaw(x, y, seed, depth) - 0.5) * (k || 2.2) + 0.5);
  const depthAt = (zoom) => Math.log2(zoom) + 4.3;
  function rng(seed) {   // mulberry32
    let s = seed | 0;
    return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const expMap = (lo, hi, u) => lo * (hi / lo) ** u;
  const pick = (arr, u) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(u * arr.length)))];
  const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
  const noteName = (f) => (VH.harmony && VH.harmony.noteName ? VH.harmony.noteName(Math.round(69 + 12 * Math.log2(f / 440))) : '');

  // ======================================================================================================
  // DSP toolkit (pure JS, mono Float32Array)
  // ======================================================================================================
  // TPT state-variable filter. run(x) returns band-pass (peak gain = Q); .lp/.hp/.bpn (unity peak) after each run.
  function svf(sr) {
    let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, k = 1;
    const F = {
      lp: 0, hp: 0, bpn: 0,
      set(fc, q) {
        const g = Math.tan(Math.PI * clamp(fc, 10, sr * 0.45) / sr);
        k = 1 / Math.max(0.1, q); a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
        return F;
      },
      run(v0) {
        const v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        F.lp = v2; F.hp = v0 - k * v1 - v2; F.bpn = k * v1;
        return v1;
      },
    };
    return F;
  }
  // Modal synthesis: add exponentially decaying sines. ms: [[ratio, amp, t60, detuneHz?], ...]
  function modes(o, i0, f, sr, ms, amp) {
    for (const [r, a, t60, det] of ms) {
      const fr = f * r + (det || 0);
      if (fr >= sr * 0.45 || fr <= 20 || !a) continue;
      const w = TAU * fr / sr, dec = Math.exp(-6.91 / (Math.max(0.005, t60) * sr)), cw = Math.cos(w) * dec, sw = Math.sin(w) * dec;
      let re = a * amp, im = 0;
      for (let i = Math.max(0, i0); i < o.length; i++) {
        o[i] += im;
        const nr = re * cw - im * sw; im = re * sw + im * cw; re = nr;
        if ((i & 255) === 0 && Math.abs(re) + Math.abs(im) < 1e-5 * amp) break;
      }
    }
  }
  // Short band-passed noise burst (mallet strike, chiff, click).
  function burst(o, i0, sr, fc, q, len, amp, rnd) {
    const F = svf(sr).set(fc, q), n = Math.round(len * sr);
    for (let i = 0; i < n && i0 + i < o.length; i++) { F.run(rnd() * 2 - 1); if (i0 + i >= 0) o[i0 + i] += amp * F.bpn * Math.exp(-5 * i / n); }
  }
  // Delay-loop string (Karplus-Strong family). s: { pluck, t60, bright, pos, buzz, bend, vib, vibD, att }.
  function stringLoop(o, f, sr, s, rnd) {
    const B = 16384, M = B - 1, buf = new Float32Array(B), n = o.length, P = sr / f;
    const damp = 0.22 + 0.76 * s.bright, comp = (1 - damp) / damp;
    const fb = s.pluck ? Math.pow(0.001, 1 / (s.t60 * f)) : 0.9985;
    const exN = Math.max(2, Math.round(P)), ex = new Float32Array(exN);
    let e = 0, w = 0, lp = 0;
    if (s.pluck) {
      for (let i = 0; i < exN; i++) { e += (0.12 + 0.88 * s.bright) * ((rnd() * 2 - 1) - e); ex[i] = e; }
      const k = Math.max(1, Math.round((s.pos || 0.2) * exN));
      for (let i = exN - 1; i >= k; i--) ex[i] -= ex[i - k];
    }
    const nf = svf(sr).set(f * 2, 0.7), att = (s.att || 0.1) * sr, rel = Math.min(0.3 * sr, n * 0.3);
    for (let i = 0; i < n; i++) {
      let D = P;
      if (s.vib) D /= 1 + s.vibD * Math.sin(TAU * s.vib * i / sr) * Math.min(1, i / (0.3 * sr));
      if (s.bend) D /= 1 + s.bend * Math.exp(-i / (0.09 * sr));
      const r = w - (D - comp), ri = Math.floor(r), fr = r - ri;
      const d = buf[ri & M] * (1 - fr) + buf[(ri + 1) & M] * fr;
      lp += damp * (d - lp);
      let x;
      if (s.pluck) x = i < exN ? ex[i] : 0;
      else {   // bowed: filtered noise excites the loop for the whole note
        nf.run(rnd() * 2 - 1);
        const env = Math.min(1, i / att) * (i > n - rel ? (n - i) / rel : 1);
        x = 0.05 * env * nf.lp;
      }
      let y = x + fb * lp;
      if (s.buzz) y = Math.tanh(y * s.buzz * 4) / (s.buzz * 4);
      buf[w & M] = y; w++;
      o[i] = y;
    }
  }
  // Band-limited sawtooth (polyBLEP).
  function blep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }
  // Freeverb-lite in place; the caller leaves room for the tail.
  function reverb(o, sr, mix, size, damp) {
    const sc = sr / 44100 * (size || 1);
    const cs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => ({ b: new Float32Array(Math.max(8, Math.round(d * sc))), i: 0, lp: 0 }));
    const as = [556, 441, 341, 225].map((d) => ({ b: new Float32Array(Math.max(8, Math.round(d * sr / 44100))), i: 0 }));
    const fb = 0.84, dm = damp == null ? 0.3 : damp;
    for (let n = 0; n < o.length; n++) {
      const x = o[n] * 0.1;
      let y = 0;
      for (const c of cs) { const v = c.b[c.i]; c.lp = v + (c.lp - v) * dm; c.b[c.i] = x + c.lp * fb; if (++c.i >= c.b.length) c.i = 0; y += v; }
      for (const a of as) { const v = a.b[a.i], out = v - y; a.b[a.i] = y + v * 0.5; if (++a.i >= a.b.length) a.i = 0; y = out; }
      o[n] = o[n] * (1 - mix * 0.5) + y * mix * 1.6;
    }
  }
  function echo(o, sr, time, fbk, mix) {
    const d = Math.round(time * sr);
    for (let i = d; i < o.length; i++) o[i] += o[i - d] * fbk * (i < 2 * d ? mix / fbk : 1);
  }
  function peakOf(o) { let m = 0; for (let i = 0; i < o.length; i++) { const v = Math.abs(o[i]); if (v > m) m = v; } return m; }
  function normalize(o, peak) { const m = peakOf(o); if (m > 0 && isFinite(m)) { const k = peak / m; for (let i = 0; i < o.length; i++) o[i] *= k; } return o; }
  function finish(o, sr) {   // DC block, NaN guard, 10 ms fades, peak 0.9
    let x1 = 0, y1 = 0;
    const R = 1 - TAU * 18 / sr;
    for (let i = 0; i < o.length; i++) { const x = isFinite(o[i]) ? o[i] : 0; const y = x - x1 + R * y1; x1 = x; y1 = y; o[i] = y; }
    const fi = Math.min(o.length >> 1, Math.round(0.002 * sr)), fo = Math.min(o.length >> 1, Math.round(0.012 * sr));
    for (let i = 0; i < fi; i++) o[i] *= i / fi;
    for (let i = 0; i < fo; i++) o[o.length - 1 - i] *= i / fo;
    // loudness levelling: lift very transient sounds (plucks, gongs) toward a common RMS, soft-clipping the peaks
    let pk = 0, ss = 0;
    for (let i = 0; i < o.length; i++) { const v = Math.abs(o[i]); if (v > pk) pk = v; ss += v * v; }
    if (!(pk > 0)) return o;
    const rms = Math.sqrt(ss / o.length), k = clamp(0.14 / rms, 0.9 * 0.55 / pk, 0.9 * 1.8 / pk);
    for (let i = 0; i < o.length; i++) {
      const v = o[i] * k, a = Math.abs(v);
      o[i] = a < 0.7 ? v : Math.sign(v) * (0.7 + 0.22 * Math.tanh((a - 0.7) / 0.22));
    }
    return o;
  }
  const ar = (i, n, a, r) => Math.min(1, i / Math.max(1, a)) * (i > n - r ? Math.max(0, (n - i) / Math.max(1, r)) : 1);

  // A sine "chirp" helper: freq(t) given as a function of normalized time 0..1; amplitude window sin^p.
  function chirp(o, i0, sr, len, fnF, amp, h2) {
    const n = Math.round(len * sr);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const j = i0 + i;
      if (j >= o.length) break;
      const t = i / n;
      ph += fnF(t) / sr;
      const w = Math.sin(Math.PI * t);
      if (j >= 0) o[j] += amp * w * w * (Math.sin(TAU * ph) + (h2 || 0) * Math.sin(2 * TAU * ph));
    }
  }

  // ======================================================================================================
  // Engines: map(u) -> q; len(q) seconds; fn(o, f, sr, q, rnd, src) fills o; info(q) text; spec(q) optional
  // ======================================================================================================
  const VOW = { a: [800, 1150, 2900], e: [400, 1700, 2600], i: [290, 2250, 3000], o: [450, 800, 2830], u: [325, 700, 2530] };
  const VK = 'aeiou';
  const FMR = [0.5, 1, 1.414, 2, 2.76, 3.5, 5.19, 7.13];
  const PATS = [0b10101010, 0b11011010, 0b10010010, 0b11101110, 0b10110110, 0b11001100, 0b10001000, 0b11111010];
  const BELL = [[0.5, 0.45, 1.3], [1, 1, 1], [1.183, 0.55, 0.8], [1.506, 0.45, 0.6], [2, 0.5, 0.55], [2.514, 0.25, 0.4], [2.662, 0.22, 0.35], [3.011, 0.18, 0.3], [4.166, 0.12, 0.22], [5.433, 0.08, 0.16]];

  function formantVoice(o, f, sr, rnd, opts) {   // glottal saw -> 3 formants; opts: { vowels(t)->[f1,f2,f3], vib, jit, att, gate(t) }
    const n = o.length, F = [svf(sr), svf(sr), svf(sr)], G = [1, 0.55, 0.28];
    let ph = rnd(), cur = opts.vowels(0).slice(), drift = 0;
    const a = (opts.att || 0.06) * sr, r = Math.min(0.12 * sr, n * 0.3);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 31) === 0) {
        const tg = opts.vowels(t);
        for (let k = 0; k < 3; k++) { cur[k] += (tg[k] - cur[k]) * 0.25; F[k].set(cur[k], cur[k] / (70 + 30 * k)); }
        drift += (rnd() - 0.5) * 0.002; drift *= 0.97;
      }
      const ff = (opts.pitch ? opts.pitch(t) : f) * (1 + (opts.vib || 0.012) * Math.sin(TAU * 5.4 * t) * Math.min(1, t / 0.35) + drift * (opts.jit || 1));
      const dt = ff / sr;
      ph += dt; if (ph >= 1) ph -= 1;
      const src = 2 * ph - 1 - blep(ph, dt) + 0.08 * (rnd() * 2 - 1);
      let y = 0;
      for (let k = 0; k < 3; k++) { F[k].run(src); y += G[k] * F[k].bpn; }
      o[i] += y * ar(i, n, a, r) * (opts.gate ? opts.gate(t) : 1);
    }
  }
  const vowelLerp = (a, b, t) => VOW[a].map((v, k) => v + (VOW[b][k] - v) * t);

  // Grain source: { data: Float32Array, sr, rootF }. Without samples: a synthetic tone+noise "sample".
  function fallbackSrc(f, rnd) {
    const sr = 22050, n = Math.round(sr * 1.4), d = new Float32Array(n), F = svf(sr).set(f * 3, 4);
    for (let i = 0; i < n; i++) {
      const t = i / sr, e = Math.exp(-t * 1.6);
      F.run(rnd() * 2 - 1);
      d[i] = e * (0.5 * Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t + 1) + 0.12 * Math.sin(TAU * 3.01 * f * t) + 0.6 * F.bpn);
    }
    return { data: d, sr, rootF: f, synthetic: true };
  }
  function granular(o, f, sr, q, rnd, src) {
    const S = src || fallbackSrc(f, rnd), D = S.data, L = D.length, n = o.length;
    const baseRate = f / S.rootF * S.sr / sr;
    const count = Math.max(4, Math.round(q.dens * n / sr)), gl = Math.round(q.glen * sr);
    const live = Math.min(L, Math.round(S.sr * 1.2));   // the attack + body of the sample
    for (let g = 0; g < count; g++) {
      const t0 = Math.floor((q.mode === 'freeze' ? g / count : rnd()) * Math.max(1, n - gl));
      const rate = baseRate * 2 ** (((rnd() * 2 - 1) * q.spread) / 12) * (q.mode === 'cloud' && rnd() < 0.25 ? 2 : 1);
      let pos;
      if (q.mode === 'freeze') pos = q.pos * live + (rnd() - 0.5) * 0.02 * S.sr;
      else if (q.mode === 'stretch') pos = (0.02 + q.travel * t0 / n) * live;
      else pos = (0.03 + 0.6 * rnd()) * live;
      const dir = q.mode === 'reverse' ? -1 : 1;
      if (dir < 0) pos += gl * rate;
      const env = q.mode === 'reverse' ? (t0 / n) ** 1.5 : q.mode === 'cloud' ? 0.6 + 0.4 * rnd() : 1;
      for (let i = 0; i < gl && t0 + i < n; i++) {
        const p = pos + dir * i * rate, pi = Math.floor(p), fr = p - pi;
        if (pi < 0 || pi + 1 >= L) continue;
        const w = 0.5 - 0.5 * Math.cos(TAU * i / gl);
        o[t0 + i] += env * w * (D[pi] * (1 - fr) + D[pi + 1] * fr);
      }
    }
    const a = q.mode === 'reverse' ? 0.02 * sr : 0.15 * sr, r = q.mode === 'reverse' ? 0.04 * sr : 0.4 * sr;
    for (let i = 0; i < n; i++) o[i] *= ar(i, n, a, r);
  }

  const ENG = {
    // ---- Strings ----
    pluck: { label: 'pluck', map: (u) => ({ t60: expMap(0.7, 4, u[1]), bright: 0.2 + 0.75 * u[2], pos: 0.08 + 0.4 * u[3] }),
      len: (q) => Math.min(3, 0.15 + q.t60 * 0.7), info: (q) => 'decay ' + q.t60.toFixed(1) + ' s · brightness ' + q.bright.toFixed(2),
      fn: (o, f, sr, q, rnd) => stringLoop(o, f, sr, { pluck: true, t60: q.t60, bright: q.bright, pos: q.pos }, rnd) },
    bowed: { label: 'bowed string', sus: true, map: (u) => ({ att: 0.08 + 0.45 * u[1], bright: 0.15 + 0.55 * u[2], vib: 4 + 2.5 * u[3], len: 1.2 + 1.6 * u[4] }),
      len: (q) => q.len, info: (q) => 'bow ' + Math.round(q.att * 1000) + ' ms · vibrato ' + q.vib.toFixed(1) + ' Hz',
      fn: (o, f, sr, q, rnd) => stringLoop(o, f, sr, { pluck: false, bright: q.bright, att: q.att, vib: q.vib, vibD: 0.006 }, rnd) },
    sitar: { label: 'sitar', map: (u) => ({ t60: expMap(1.5, 5, u[1]), bright: 0.5 + 0.45 * u[2], buzz: 0.4 + 1.2 * u[3], bend: 0.01 + 0.04 * u[4] }),
      len: (q) => Math.min(3.2, 0.2 + q.t60 * 0.6), info: (q) => 'buzz ' + q.buzz.toFixed(1) + ' · bend ' + (q.bend * 100).toFixed(1) + ' %',
      fn: (o, f, sr, q, rnd) => stringLoop(o, f, sr, { pluck: true, t60: q.t60, bright: q.bright, pos: 0.13, buzz: q.buzz, bend: q.bend }, rnd) },
    // ---- Metal ----
    bell: { label: 'bell', map: (u) => ({ t60: expMap(1.2, 4.5, u[1]), bright: 0.3 + 0.7 * u[2], str: 0.97 + 0.06 * u[3] }),
      len: (q) => Math.min(3.4, q.t60 * 0.75), info: (q) => 'ring ' + q.t60.toFixed(1) + ' s · stretch ' + q.str.toFixed(3),
      spec: () => BELL.map(([r, a]) => [r, a]),
      fn(o, f, sr, q, rnd) { modes(o, 0, f, sr, BELL.map(([r, a, t], k) => [r ** q.str, a * q.bright ** (k * 0.4), t * q.t60]), 1); burst(o, 0, sr, f * 6, 2, 0.01, 0.3, rnd); } },
    bowl: { label: 'singing bowl', map: (u) => ({ t60: expMap(3, 8, u[1]), beat: 0.5 + 2.5 * u[2], hi: 0.2 + 0.6 * u[3] }),
      len: (q) => 3.4, info: (q) => 'beating ' + q.beat.toFixed(1) + ' Hz',
      spec: () => [[1, 1], [2.71, 0.5], [5.15, 0.25], [8.43, 0.1]],
      fn(o, f, sr, q) {
        const m = [[1, 1, q.t60], [2.71, 0.5 * q.hi, q.t60 * 0.6], [5.15, 0.25 * q.hi, q.t60 * 0.4], [8.43, 0.1 * q.hi, q.t60 * 0.25]];
        modes(o, 0, f, sr, m.concat(m.map(([r, a, t], k) => [r, a * 0.8, t, q.beat * (1 + k * 0.6)])), 1);
      } },
    gong: { label: 'gong', map: (u) => ({ t60: expMap(2, 6, u[1]), spread: 0.5 + 0.5 * u[2], wash: 0.2 + 0.6 * u[3], seed: Math.floor(u[4] * 9999) }),
      len: () => 3.4, info: (q) => 'wash ' + q.wash.toFixed(2),
      fn(o, f, sr, q, rnd) {
        const r2 = rng(q.seed), ms = [];
        for (let k = 0; k < 16; k++) ms.push([0.5 + k * q.spread * (0.5 + r2()), 0.9 / (1 + k * 0.35), q.t60 * (0.4 + 0.6 * r2())]);
        modes(o, 0, f * 0.5, sr, ms, 1);
        const F = svf(sr).set(f * 3, 1.2), n = o.length;   // shimmering noise wash that blooms after the hit
        for (let i = 0; i < n; i++) { F.run(rnd() * 2 - 1); const t = i / sr; o[i] += q.wash * 0.25 * F.bpn * (1 - Math.exp(-t * 3)) * Math.exp(-t * 1.1); }
        burst(o, 0, sr, 900, 1, 0.03, 0.6, rnd);
      } },
    fmbell: { label: 'FM metal', map: (u) => ({ ratio: pick(FMR, u[1]), index: 0.5 + 9 * u[2] ** 1.5, t60: expMap(0.5, 3.5, u[3]) }),
      len: (q) => Math.min(3, q.t60 * 0.8), info: (q) => 'ratio ' + q.ratio + ' · index ' + q.index.toFixed(1),
      fn(o, f, sr, q) { fmTone(o, f, sr, q.ratio, q.index, q.t60, 0.002, 0); } },
    // ---- Wood ----
    marimba: { label: 'marimba', map: (u) => ({ t60: expMap(0.35, 1.6, u[1]), hard: 0.2 + 0.8 * u[2], ov: 0.15 + 0.4 * u[3] }),
      len: (q) => Math.min(2, q.t60 * 0.9 + 0.1), info: (q) => 'mallet ' + (q.hard > 0.6 ? 'hard' : 'soft') + ' · ring ' + q.t60.toFixed(2) + ' s',
      spec: (q) => [[1, 1], [3.93, q.ov], [9.2, q.ov * 0.3]],
      fn(o, f, sr, q, rnd) { modes(o, 0, f, sr, [[1, 1, q.t60], [3.93, q.ov, q.t60 * 0.35], [9.2, q.ov * 0.3 * q.hard, q.t60 * 0.15]], 1); burst(o, 0, sr, f * 4, 1.5, 0.006, 0.4 * q.hard, rnd); } },
    block: { label: 'wood block', map: (u) => ({ t60: expMap(0.06, 0.3, u[1]), hollow: 0.3 + 0.7 * u[2], click: 0.3 + 0.7 * u[3] }),
      len: (q) => 0.12 + q.t60, info: (q) => 'hollow ' + q.hollow.toFixed(2),
      fn(o, f, sr, q, rnd) { modes(o, 0, f * 1.5, sr, [[1, 1, q.t60], [2.32, 0.5 * q.hollow, q.t60 * 0.6], [4.1, 0.3, q.t60 * 0.3]], 1); burst(o, 0, sr, 3000, 1, 0.004, q.click, rnd); } },
    logdrum: { label: 'log drum', map: (u) => ({ t60: expMap(0.3, 1.2, u[1]), tone: 0.3 + 0.7 * u[2], thump: 0.3 + 0.7 * u[3] }),
      len: (q) => q.t60 + 0.1, info: (q) => 'thump ' + q.thump.toFixed(2),
      fn(o, f, sr, q, rnd) {
        modes(o, 0, f * 0.5, sr, [[1, 1, q.t60], [1.47, 0.5 * q.tone, q.t60 * 0.7], [2.09, 0.3 * q.tone, q.t60 * 0.4], [3.1, 0.12, q.t60 * 0.2]], 1);
        burst(o, 0, sr, 180, 0.8, 0.05, q.thump, rnd);
      } },
    // ---- Air ----
    flute: { label: 'flute', sus: true, map: (u) => ({ att: 0.05 + 0.2 * u[1], breath: 0.1 + 0.5 * u[2], vib: 4.5 + 2 * u[3], len: 0.8 + 1.6 * u[4] }),
      len: (q) => q.len, info: (q) => 'breath ' + Math.round(q.breath * 100) + ' % · vibrato ' + q.vib.toFixed(1) + ' Hz',
      spec: () => [[1, 1], [2, 0.3], [3, 0.12]],
      fn(o, f, sr, q, rnd) {
        const n = o.length, B = svf(sr).set(f, 6), H = svf(sr).set(f * 5, 1), a = q.att * sr, r = Math.min(0.15 * sr, n * 0.3);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr, vib = 1 + 0.005 * Math.sin(TAU * q.vib * t) * Math.min(1, t / 0.4), nz = rnd() * 2 - 1;
          ph += f * vib / sr; if (ph >= 1) ph -= 1;
          B.run(nz); H.run(nz);
          const tone = Math.sin(TAU * ph) + 0.3 * Math.sin(2 * TAU * ph) + 0.12 * Math.sin(3 * TAU * ph);
          const chiff = t < 0.06 ? (1 - t / 0.06) : 0;
          o[i] = ar(i, n, a, r) * (tone * (1 + q.breath * 0.6 * B.bpn) * 0.6 + q.breath * (B.bpn * 1.2 + H.bpn * 0.3)) + chiff * 0.5 * H.bpn;
        }
      } },
    pipe: { label: 'pan pipe', map: (u) => ({ t60: expMap(0.4, 1.5, u[1]), chiff: 0.3 + 0.7 * u[2], hollow: 0.1 + 0.4 * u[3] }),
      len: (q) => q.t60 + 0.25, info: (q) => 'chiff ' + q.chiff.toFixed(2),
      spec: (q) => [[1, 1], [3, q.hollow]],
      fn(o, f, sr, q, rnd) {
        const n = o.length, B = svf(sr).set(f, 4), d = Math.exp(-6.91 / (q.t60 * sr));
        let ph = 0, e = 1;
        for (let i = 0; i < n; i++) {
          const t = i / sr; ph += f / sr; if (ph >= 1) ph -= 1; e *= d;
          B.run(rnd() * 2 - 1);
          o[i] = Math.min(1, t / 0.03) * e * (Math.sin(TAU * ph) + q.hollow * Math.sin(3 * TAU * ph) + 0.35 * B.bpn) + (t < 0.05 ? q.chiff * (1 - t / 0.05) * B.bpn : 0);
        }
      } },
    wind: { label: 'wind', sus: true, map: (u) => ({ q: 2 + 10 * u[1], sweep: 0.15 + 0.8 * u[2], gust: 0.3 + 0.7 * u[3], len: 1.6 + 1.4 * u[4] }),
      len: (q) => q.len, info: (q) => 'resonance ' + q.q.toFixed(1) + ' · gusts ' + q.gust.toFixed(2),
      fn(o, f, sr, q, rnd) {
        const n = o.length, F = svf(sr), ph = rnd() * TAU;
        for (let i = 0; i < n; i++) {
          const t = i / sr, s = Math.sin(TAU * q.sweep * t + ph);
          if ((i & 31) === 0) F.set(f * 2 ** (1.3 * s), q.q);
          F.run(rnd() * 2 - 1);
          o[i] = F.bpn * (0.55 + 0.45 * q.gust * (0.5 + 0.5 * s)) * ar(i, n, 0.4 * sr, 0.5 * sr);
        }
      } },
    breath: { label: 'breath', map: (u) => ({ len: 0.35 + 0.7 * u[1], vow: pick(VK, u[2]), voiced: 0.1 + 0.4 * u[3] }),
      len: (q) => q.len, info: (q) => 'exhale on "' + q.vow + '"',
      fn(o, f, sr, q, rnd) {
        const n = o.length, F = VOW[q.vow].map((fc, k) => svf(sr).set(fc, 6 + k * 2));
        for (let i = 0; i < n; i++) {
          const t = i / n, nz = rnd() * 2 - 1, e = Math.sin(Math.PI * Math.min(1, t * 1.6)) ** 2 * (1 - t);
          let y = 0;
          for (let k = 0; k < 3; k++) { F[k].run(nz); y += F[k].bpn / (1 + k); }
          o[i] = e * (y + q.voiced * 0.3 * Math.sin(TAU * f * 0.5 * i / sr));
        }
      } },
    // ---- Voice ----
    vowel: { label: 'vowel', sus: true, map: (u) => ({ v0: pick(VK, u[1]), v1: pick(VK, u[2]), vib: 0.006 + 0.02 * u[3], len: 0.8 + 1.5 * u[4] }),
      len: (q) => q.len, info: (q) => '"' + q.v0 + '" → "' + q.v1 + '"',
      fn(o, f, sr, q, rnd) { const L = o.length / sr; formantVoice(o, f, sr, rnd, { vowels: (t) => vowelLerp(q.v0, q.v1, clamp01(t / L)), vib: q.vib }); } },
    babble: { label: 'babble', map: (u) => ({ rate: 4 + 5 * u[1], range: 1 + 5 * u[2], seed: Math.floor(u[3] * 1e5), len: 1.1 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => q.rate.toFixed(1) + ' syllables/s',
      fn(o, f, sr, q, rnd) {
        const r2 = rng(q.seed), syl = [];
        for (let k = 0; k < 40; k++) syl.push({ v: VK[Math.floor(r2() * 5)], p: Math.round((r2() * 2 - 1) * q.range), gap: r2() < 0.2 });
        const at = (t) => syl[Math.min(39, Math.floor(t * q.rate))];
        formantVoice(o, f, sr, rnd, { vowels: (t) => VOW[at(t).v], pitch: (t) => f * 2 ** (at(t).p / 12) * (1 - 0.04 * t),
          gate: (t) => { const s = at(t), ph = (t * q.rate) % 1; return s.gap ? 0.08 : Math.sin(Math.PI * ph) ** 0.6; }, att: 0.02 });
      } },
    choir: { label: 'choir', sus: true, map: (u) => ({ v: pick('aou', u[1]), spread: 4 + 14 * u[2], len: 1.6 + 1.4 * u[3] }),
      len: (q) => q.len, info: (q) => '3 voices on "' + q.v + '", spread ' + q.spread.toFixed(0) + ' ct',
      fn(o, f, sr, q, rnd) {
        for (const c of [-1, 0, 1]) formantVoice(o, f * 2 ** (c * q.spread / 1200), sr, rnd, { vowels: () => VOW[q.v], att: 0.35, vib: 0.01 + 0.004 * c });
      } },
    // ---- Machine ----
    fm: { label: 'FM tone', map: (u) => ({ ratio: pick(FMR, u[1]), index: 0.5 + 7 * u[2], t60: expMap(0.3, 2.5, u[3]), glide: (u[4] - 0.5) * 24 }),
      len: (q) => Math.min(2.6, q.t60 * 0.8 + 0.1), info: (q) => 'ratio ' + q.ratio + ' · index ' + q.index.toFixed(1) + ' · glide ' + q.glide.toFixed(0) + ' st',
      fn(o, f, sr, q) { fmTone(o, f, sr, q.ratio, q.index, q.t60, 0.005, q.glide); } },
    stutter: { label: 'stutter', map: (u) => ({ rate: 6 + 18 * u[1], pat: pick(PATS, u[2]), ratio: pick(FMR, u[3]), len: 0.9 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => q.rate.toFixed(1) + ' Hz · ' + q.pat.toString(2).padStart(8, '0').replace(/1/g, '■').replace(/0/g, '·'),
      fn(o, f, sr, q) {
        fmTone(o, f, sr, q.ratio, 2, 5, 0.003, 0);
        const step = sr / q.rate;
        let g = 0;
        for (let i = 0; i < o.length; i++) { const k = Math.floor(i / step); g += (((q.pat >> (7 - (k % 8))) & 1 ? 1 : 0.03) - g) * 0.02; o[i] *= g; }
      } },
    laser: { label: 'laser', map: (u) => ({ oct: 1.5 + 3.5 * u[1], sweep: 0.04 + 0.2 * u[2], pews: 1 + Math.floor(u[3] * 3.99), dir: u[4] < 0.5 ? 1 : -1 }),
      len: (q) => q.pews * q.sweep * 1.4 + 0.1, info: (q) => q.pews + '× ' + (q.dir > 0 ? 'down' : 'up') + ' ' + q.oct.toFixed(1) + ' oct',
      fn(o, f, sr, q) {
        const gap = q.sweep * 1.4;
        for (let p = 0; p < q.pews; p++) chirp(o, Math.round(p * gap * sr), sr, q.sweep * 1.3, (t) => Math.min(sr * 0.4, f * 2 ** (q.dir * q.oct * (1 - t) ** 2)), 0.8, 0.3);
      } },
    crush: { label: 'bitcrush', map: (u) => ({ bits: 2 + Math.round(4 * u[1]), hold: 2 + Math.round(14 * u[2]), t60: expMap(0.3, 2, u[3]) }),
      len: (q) => Math.min(2.2, q.t60 * 0.8 + 0.1), info: (q) => q.bits + ' bit · hold ' + q.hold,
      fn(o, f, sr, q) {
        const L = 2 ** (q.bits - 1), d = Math.exp(-6.91 / (q.t60 * sr));
        let ph = 0, e = 1, h = 0;
        for (let i = 0; i < o.length; i++) {
          ph += f / sr; if (ph >= 1) ph -= 1; e *= d;
          if (i % q.hold === 0) h = Math.round((2 * ph - 1) * e * L) / L;
          o[i] = h * Math.min(1, i / (0.003 * sr));
        }
      } },
    ring: { label: 'ring mod', sus: true, map: (u) => ({ ratio: 1.1 + 4 * u[1], lfo: 0.2 + 6 * u[2], len: 0.8 + 1.6 * u[3] }),
      len: (q) => q.len, info: (q) => 'ratio ' + q.ratio.toFixed(2) + ' · wobble ' + q.lfo.toFixed(1) + ' Hz',
      fn(o, f, sr, q) {
        const n = o.length;
        let a = 0, b = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          a += f / sr; b += f * q.ratio * (1 + 0.02 * Math.sin(TAU * q.lfo * t)) / sr;
          o[i] = Math.sin(TAU * a) * Math.sin(TAU * b) * ar(i, n, 0.01 * sr, 0.2 * sr) * (0.7 + 0.3 * Math.sin(TAU * q.lfo * t));
        }
      } },
    // ---- Nature ----
    drops: { label: 'rain drops', map: (u) => ({ dens: 6 + 40 * u[1] ** 1.5, rise: 0.5 + 2 * u[2], spread: 0.3 + 1.2 * u[3], len: 1.2 + 1.3 * u[4] }),
      len: (q) => q.len, info: (q) => Math.round(q.dens) + ' drops/s',
      fn(o, f, sr, q, rnd) {
        const n = o.length, N = Math.max(3, Math.round(q.dens * n / sr));
        for (let k = 0; k < N; k++) {
          const t0 = Math.floor(rnd() * (n - 0.08 * sr)), fd = clamp(f * 2 * 2 ** ((rnd() * 2 - 1) * q.spread), 300, 6000), d = 0.015 + 0.05 * rnd(), a = 0.3 + 0.7 * rnd();
          chirp(o, t0, sr, d, (t) => fd * (1 + q.rise * t), a);
        }
      } },
    birds: { label: 'bird chirps', map: (u) => ({ seed: Math.floor(u[1] * 1e5), n: 3 + Math.floor(5 * u[2]), trill: u[3], len: 1.4 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => q.n + '-chirp song' + (q.trill > 0.6 ? ' with trills' : ''),
      fn(o, f, sr, q) {
        const r2 = rng(q.seed), base = clamp(f * 4, 1800, 5200), motif = [];
        for (let k = 0; k < q.n; k++) motif.push({ d: 0.04 + 0.12 * r2(), a: base * 2 ** ((r2() * 2 - 1) * 0.6), b: base * 2 ** ((r2() * 2 - 1) * 0.9), gap: 0.02 + 0.08 * r2(), tr: r2() < q.trill });
        let t = 0.02;
        const L = o.length / sr;
        for (let rep = 0; rep < 3 && t < L - 0.2; rep++) {
          for (const c of motif) {
            if (t + c.d > L) break;
            chirp(o, Math.round(t * sr), sr, c.d, (x) => (c.a + (c.b - c.a) * x) * (c.tr ? 1 + 0.12 * Math.sin(TAU * 28 * x * c.d) : 1), 0.8, 0.15);
            t += c.d + c.gap;
          }
          t += 0.15 + 0.3 * r2();
        }
      } },
    insects: { label: 'insects', map: (u) => ({ pr: 25 + 40 * u[1], group: 2 + Math.floor(5 * u[2]), cicada: u[3] > 0.62, len: 1.4 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => (q.cicada ? 'cicada drone' : 'cricket, ' + q.group + ' pulses') + ' · ' + q.pr.toFixed(0) + ' Hz',
      fn(o, f, sr, q, rnd) {
        const n = o.length, fc = clamp(f * 6, 2500, 7500), F = svf(sr).set(fc, 8);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          ph += fc / sr; if (ph >= 1) ph -= 1;
          const pulse = Math.max(0, Math.sin(TAU * q.pr * t)) ** 3;
          let g;
          if (q.cicada) { F.run(rnd() * 2 - 1); g = (0.5 + 0.5 * pulse) * Math.min(1, t / 0.3); o[i] = g * (F.bpn * 2 + 0.3 * Math.sin(TAU * ph)) * ar(i, n, 1, 0.3 * sr); continue; }
          const per = q.group / q.pr + 0.25, k = t % per;
          g = k < q.group / q.pr ? pulse : 0;
          o[i] = g * Math.sin(TAU * ph) * ar(i, n, 1, 0.05 * sr);
        }
      } },
    water: { label: 'water', sus: true, map: (u) => ({ bub: 5 + 30 * u[1], flow: 0.2 + 0.7 * u[2], len: 1.5 + 1.2 * u[3] }),
      len: (q) => q.len, info: (q) => Math.round(q.bub) + ' bubbles/s · flow ' + q.flow.toFixed(2),
      fn(o, f, sr, q, rnd) {
        const n = o.length, F = svf(sr).set(500 + f, 0.9);
        let br = 0;
        for (let i = 0; i < n; i++) { br = br * 0.98 + (rnd() * 2 - 1) * 0.2; F.run(br); o[i] = q.flow * 0.6 * F.lp * ar(i, n, 0.3 * sr, 0.4 * sr); }
        const N = Math.round(q.bub * n / sr);
        for (let k = 0; k < N; k++) {
          const fb = clamp(f * 2 ** (rnd() * 2), 250, 3000), d = 0.01 + 0.04 * rnd();
          chirp(o, Math.floor(rnd() * (n - 0.06 * sr)), sr, d, (t) => fb * (1 + 1.5 * t * t), 0.25 + 0.4 * rnd());
        }
      } },
    // ---- Texture (granular, from the sample library when available) ----
    cloud: { label: 'grain cloud', tex: true, sus: true, map: (u) => ({ mode: 'cloud', dens: 15 + 60 * u[1], glen: 0.04 + 0.12 * u[2], spread: 0.1 + 4 * u[3], len: 1.6 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => Math.round(q.dens) + ' grains/s · ' + Math.round(q.glen * 1000) + ' ms', fn: granular },
    reverse: { label: 'reverse swell', tex: true, map: (u) => ({ mode: 'reverse', dens: 20 + 40 * u[1], glen: 0.08 + 0.15 * u[2], spread: 0.05 + 0.5 * u[3], len: 1.2 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => 'reversed grains, ' + Math.round(q.glen * 1000) + ' ms', fn: granular },
    freeze: { label: 'frozen moment', tex: true, sus: true, map: (u) => ({ mode: 'freeze', dens: 25 + 40 * u[1], glen: 0.06 + 0.12 * u[2], pos: 0.1 + 0.5 * u[3], spread: 0.03, len: 1.5 + 1.3 * u[4] }),
      len: (q) => q.len, info: (q) => 'frozen at ' + Math.round(q.pos * 100) + ' %', fn: granular },
    stretch: { label: 'time stretch', tex: true, sus: true, map: (u) => ({ mode: 'stretch', dens: 30 + 30 * u[1], glen: 0.06 + 0.1 * u[2], travel: 0.3 + 0.6 * u[3], spread: 0.02, len: 1.8 + 1.2 * u[4] }),
      len: (q) => q.len, info: (q) => 'stretched ×' + (1.8 / q.travel).toFixed(1), fn: granular },
  };
  for (const k in ENG) ENG[k].id = k;
  function fmTone(o, f, sr, ratio, index, t60, att, glide) {
    const n = o.length, d = Math.exp(-6.91 / (t60 * sr)), gl = 2 ** (glide / 12);
    let pc = 0, pm = 0, e = 1;
    for (let i = 0; i < n; i++) {
      const t = i / n, ff = f * gl ** t;
      e *= d;
      pc += ff / sr; pm += ff * ratio / sr;
      if (pc >= 1) pc -= 1; if (pm >= 1) pm -= 1;
      const I = index * (0.25 + 0.75 * e);
      o[i] = Math.sin(TAU * pc + I * Math.sin(TAU * pm)) * e * Math.min(1, i / (att * sr));
    }
  }

  // ======================================================================================================
  // Biomes + the world
  // ======================================================================================================
  const BIOMES = [
    { id: 'strings', name: 'Strings', lo: 82, hi: 523, eng: ['pluck', 'bowed', 'sitar'], col: '#b39a5c', about: 'plucked and bowed strings (Karplus-Strong)' },
    { id: 'metal', name: 'Metal', lo: 180, hi: 1000, eng: ['bell', 'bowl', 'gong', 'fmbell'], col: '#7d93ad', about: 'bells, bowls, gongs and FM metal (modal synthesis)' },
    { id: 'wood', name: 'Wood', lo: 160, hi: 880, eng: ['marimba', 'block', 'logdrum'], col: '#a3654d', about: 'marimba bars, wood blocks and log drums' },
    { id: 'air', name: 'Air', lo: 240, hi: 1200, eng: ['flute', 'pipe', 'wind', 'breath'], col: '#7fb0b4', about: 'blown noise through resonances: flutes, pipes, wind, breath' },
    { id: 'voice', name: 'Voice', lo: 90, hi: 350, eng: ['vowel', 'babble', 'choir'], col: '#ad7f9a', about: 'formant vowels, babble and little choirs' },
    { id: 'machine', name: 'Machine', lo: 55, hi: 700, eng: ['fm', 'stutter', 'laser', 'crush', 'ring'], col: '#8a7bb5', about: 'FM, stutter, lasers, bitcrush and ring-mod' },
    { id: 'nature', name: 'Nature', lo: 300, hi: 1300, eng: ['drops', 'birds', 'insects', 'water'], col: '#7fa477', about: 'rain, birds, insects and water' },
    { id: 'texture', name: 'Texture', lo: 110, hi: 523, eng: ['cloud', 'reverse', 'freeze', 'stretch'], col: '#9a978a', about: 'granular clouds made from the sample library' },
  ];
  const BC = 7, WARP = 2.6, WB = 0.36;          // biome cell size, domain warp, hybrid border half-width (world units)
  const THR_R = 0.2085, THR_E = 0.3221;         // calibrated: rare ~7 %, epic ~1.5 % of the map
  const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const TIER_INFO = [
    'a single sound of its biome',
    'a hybrid: two biomes blended where they meet',
    'a pattern: arpeggio, rhythm or echo motif',
    'a hidden phrase (never drawn; the Detector shimmers near it)',
    'a Gem: one of 16 unique named sounds',
  ];
  const NB9 = { d: new Float64Array(9), b: new Int8Array(9) };
  const cellOut = { bi: 0, b2: 0, w: 0, gap: 0, ei: 0, ei2: 0, tex: 0, R: 0, E: 0, tier: 0 };
  function cellAt(x, y, depth, out) {
    out = out || cellOut;
    // domain-warped Voronoi: octaves deepen with zoom so coastlines keep their detail
    let ax = 0, ay = 0, amp = 1, f = 0.2;
    const no = 2.2 + depth;
    for (let o = 0; o < no; o++) {
      const w = Math.min(1, no - o) * amp;
      ax += w * (vnoise(x * f, y * f, 900 + o) - 0.5); ay += w * (vnoise(x * f + 31.7, y * f - 17.3, 950 + o) - 0.5);
      amp *= 0.5; f *= 2;
    }
    const gx = (x + WARP * ax) / BC, gy = (y + WARP * ay) / BC, ix = Math.floor(gx), iy = Math.floor(gy);
    const ds = NB9.d, bs = NB9.b;
    let d1 = 1e9, b1 = 0;
    for (let j = -1, n = 0; j <= 1; j++) for (let i = -1; i <= 1; i++, n++) {
      const cx = ix + i, cy = iy + j, px = cx + 0.1 + 0.8 * hash(cx, cy, 11) - gx, py = cy + 0.1 + 0.8 * hash(cx, cy, 12) - gy;
      ds[n] = px * px + py * py; bs[n] = Math.floor(hash(cx, cy, 13) * 8);
      if (ds[n] < d1) { d1 = ds[n]; b1 = bs[n]; }
    }
    let d2 = 1e9, b2 = -1;   // nearest cell of a different biome: hybrids blend continuously toward it
    for (let n = 0; n < 9; n++) if (bs[n] !== b1 && ds[n] < d2) { d2 = ds[n]; b2 = bs[n]; }
    const gap = (Math.sqrt(d2) - Math.sqrt(d1)) * BC * 0.5;
    out.bi = b1; out.b2 = b2; out.gap = gap;
    out.w = b2 >= 0 && gap < WB ? 0.5 * (1 - gap / WB) : 0;
    const eu = (b) => clamp01((vnoise(x * 0.32, y * 0.32, 300 + b) - 0.5) * 2 + 0.5);
    out.ei = Math.min(BIOMES[b1].eng.length - 1, Math.floor(eu(b1) * BIOMES[b1].eng.length));
    out.ei2 = out.b2 >= 0 ? Math.min(BIOMES[out.b2].eng.length - 1, Math.floor(eu(out.b2) * BIOMES[out.b2].eng.length)) : -1;
    out.tex = fbm(x * 1.3, y * 1.3, 77, depth - 1.6, 2);   // finest octave stays above pixel size (no aliasing)
    out.R = ((vnoise(x * 0.55, y * 0.55, 501) - 0.5) + 0.5 * (vnoise(x * 1.1, y * 1.1, 502) - 0.5) + 0.25 * (vnoise(x * 2.2, y * 2.2, 503) - 0.5)) / 1.75;
    out.E = ((vnoise(x * 1.6, y * 1.6, 601) - 0.5) + 0.5 * (vnoise(x * 3.2, y * 3.2, 602) - 0.5)) / 1.5;
    out.tier = out.E > THR_E ? 3 : out.R > THR_R ? 2 : out.w > 0 ? 1 : 0;
    return out;
  }

  // ---------- patterns (rare) + phrases (epic) ----------
  const CHORDS = [['major', [0, 4, 7, 12]], ['minor', [0, 3, 7, 10]], ['sus', [0, 5, 7, 12]], ['maj7', [0, 4, 7, 11]], ['fifths', [0, 7, 12, 19]]];
  const SCALES = [['major pentatonic', [0, 2, 4, 7, 9]], ['minor pentatonic', [0, 3, 5, 7, 10]], ['dorian', [0, 2, 3, 5, 7, 9, 10]],
    ['lydian', [0, 2, 4, 6, 7, 9, 11]], ['phrygian', [0, 1, 3, 5, 7, 8, 10]], ['whole tone', [0, 2, 4, 6, 8, 10]]];
  const PTYPES = ['arpeggio', 'rhythm', 'echo motif'];
  function events(p) {   // -> [{ t, f, v, len }], plus fx
    const r = rng(p.seed ^ 0x51ed), f = p.f, nat = p.natLen;
    if (p.tier === 2) {
      const type = p.pat.type;
      if (type === 'arpeggio') {
        const ch = CHORDS[p.pat.chord][1], step = p.pat.step, N = 6 + Math.floor(r() * 5), dirn = Math.floor(r() * 3), ev = [];
        for (let k = 0; k < N; k++) {
          const j = dirn === 0 ? k % 4 : dirn === 1 ? 3 - (k % 4) : [0, 1, 2, 3, 2, 1][k % 6];
          ev.push({ t: k * step, f: f * 2 ** ((ch[j] + (k >= 4 && dirn === 0 ? 12 : 0)) / 12), v: k === 0 ? 1 : 0.75, len: Math.min(nat, step * 3) });
        }
        ev[ev.length - 1].len = Math.min(nat, 1.2);
        return { ev };
      }
      if (type === 'rhythm') {
        const step = p.pat.step * 0.7, bits = PATS[p.pat.chord % PATS.length] | (PATS[(p.pat.chord + 3) % PATS.length] << 8), ev = [];
        for (let k = 0; k < 16; k++) if ((bits >> (15 - k)) & 1) ev.push({ t: k * step, f: k % 4 === 0 ? f : f * (r() < 0.3 ? 1.5 : r() < 0.5 ? 0.5 : 1), v: k % 4 === 0 ? 1 : 0.6, len: Math.min(nat, step * 1.6) });
        return { ev };
      }
      const sc = SCALES[p.pat.chord % SCALES.length][1], m = [0, 1 + Math.floor(r() * 3), Math.floor(r() * 2) * 2];
      return { ev: m.map((d, k) => ({ t: k * 0.16, f: f * 2 ** (sc[d % sc.length] / 12 + Math.floor(d / sc.length)), v: 1, len: Math.min(nat, 0.5) })), echo: [0.27 + 0.1 * r(), 0.55] };
    }
    // phrase: a short melody from the seed's scale, ends on the root
    const sc = SCALES[p.pat.scale][1], step = p.pat.step, ev = [];
    let t = 0, deg = 0;
    const N = 7 + Math.floor(r() * 6);
    for (let k = 0; k < N; k++) {
      const last = k === N - 1, d = last ? 3 : pick([1, 1, 1, 2, 2, 0.5, 0.5, 3], r());
      if (last) deg = 0; else deg = clamp(deg + pick([-2, -1, -1, 1, 1, 2, 3, -3], r()), -3, sc.length + 3);
      const oc = Math.floor(deg / sc.length), di = ((deg % sc.length) + sc.length) % sc.length;
      ev.push({ t, f: f * 2 ** (sc[di] / 12 + oc), v: k % 4 === 0 ? 1 : 0.8, len: Math.min(nat, step * d * 1.5 + (last ? 0.6 : 0)) });
      t += step * d;
      if (t > 3.6) break;
    }
    return { ev, verb: 0.25 };
  }

  // ---------- describe a point ----------
  function describe(x, y, zoom) {
    zoom = zoom || 1;
    const depth = depthAt(zoom), c = Object.assign({}, cellAt(x, y, depth, {}));
    const u = [];
    for (let k = 0; k < 6; k++) u.push(fbm(x, y, 21 + k, depth));
    const B = BIOMES[c.bi], e1 = ENG[B.eng[c.ei]], q = e1.map(u.slice(0));
    const p = { x, y, zoom, bi: c.bi, b2: c.b2, w: c.w, tier: c.tier, R: c.R, E: c.E, tex: c.tex, u, biome: B.name, eng: e1, q, f: expMap(B.lo, B.hi, u[0]) };
    p.halo = haloAt(x, y);   // near a gem: the pitch leans toward its register (and its signature is mixed in)
    if (p.halo) p.f *= (GEMS[p.halo.k].sig.reg / p.f) ** (HALO_PULL * p.halo.w);
    p.f = Math.round(p.f * 100) / 100;
    p.seed = (hash(Math.floor(x * 65536), Math.floor(y * 65536), 3) * 4294967296) | 0;
    if (c.w > 0) {
      const B2 = BIOMES[c.b2];
      p.eng2 = ENG[B2.eng[c.ei2]]; p.q2 = p.eng2.map(u.map((v) => 1 - v)); p.biome2 = B2.name;
    }
    p.natLen = Math.max(e1.len(q), p.eng2 ? p.eng2.len(p.q2) : 0);
    const r = rng(p.seed);
    if (p.tier === 2) p.pat = { type: pick(PTYPES, clamp01((u[5] - 0.5) * 3 + 0.5)), chord: Math.floor(r() * CHORDS.length), step: 0.11 + 0.1 * r() };
    if (p.tier === 3) p.pat = { scale: Math.floor(r() * SCALES.length), step: 0.16 + 0.12 * r() };
    const adj = u[0] < 0.25 ? 'low ' : u[0] > 0.75 ? 'high ' : '';
    const base = adj + e1.label + (p.eng2 ? ' × ' + p.eng2.label : '');
    p.kind = ['note', 'hybrid', 'pattern', 'phrase'][p.tier];
    p.name = p.tier === 2 ? base + ' ' + p.pat.type : p.tier === 3 ? base + ' phrase in ' + noteName(p.f).replace(/\d+$/, '') + ' ' + SCALES[p.pat.scale][0] : base;
    p.fam = 'babel-' + B.id;
    p.sus = p.tier < 2 && !!e1.sus;
    p.key = p.x + ',' + p.y + ',' + depth.toFixed(3);
    return p;
  }
  const paramsAt = (x, y, depth) => describe(x, y, 2 ** (depth - 4.3));

  // ======================================================================================================
  // Gems: 16 unique, hand-made sounds hidden at sparse points (one per 12x12 cell; each 4x4 block of cells holds
  // all 16 whenever its biomes allow, and the block around the origin spans x,y in [-24, 24]).
  // A gem only spawns inside a biome that fits it (GEM_BIOMES), at least GEM_IN units from any border, and its
  // neighbours within HALO_R drift toward its character (the halo), so nearby sounds stay related.
  // ======================================================================================================
  const G = 12;
  function bellNote(o, t, f, sr, ms, amp) { modes(o, Math.round(t * sr), f, sr, ms, amp); }
  const TUBE = [[1, 1, 3.2], [2.756, 0.5, 2], [5.404, 0.25, 1.2], [8.933, 0.12, 0.7]];
  const GEMS = [
    { id: 'whale', name: 'Whale Song', glyph: '◒', riddle: 'Something enormous sings far below.', len: 7.5, fn(o, sr, rnd) {
      const n = o.length, pts = [[0, 120], [0.8, 300], [1.6, 210], [2.2, 230], [3.6, 0], [3.9, 360], [4.6, 520], [5.2, 260], [6.3, 150]];
      const at = (t) => { for (let k = 1; k < pts.length; k++) if (t < pts[k][0]) { const [t0, a] = pts[k - 1], [t1, b] = pts[k]; return a && b ? a * (b / a) ** fade((t - t0) / (t1 - t0)) : 0; } return 150; };
      let ph = 0;
      const F = svf(sr), N = svf(sr).set(70, 0.8);
      for (let i = 0; i < n; i++) {
        const t = i / sr, ff = at(t), e = t < 3.4 ? Math.sin(Math.PI * clamp01(t / 3.4)) : Math.sin(Math.PI * clamp01((t - 3.8) / 2.9));
        if ((i & 31) === 0) F.set(400 + 300 * Math.sin(t * 1.3), 2);
        if (ff > 0) ph += ff / sr;
        const s = Math.sin(TAU * ph) + 0.5 * Math.sin(2 * TAU * ph) + 0.25 * Math.sin(3 * TAU * ph);
        F.run(s); N.run(rnd() * 2 - 1);
        o[i] = (ff > 0 ? e * (0.6 * s + 0.6 * F.bpn) : 0) + 0.15 * N.lp;
      }
      reverb(o, sr, 0.55, 1.6, 0.4);
    } },
    { id: 'musicbox', name: 'Music Box', glyph: '♫', riddle: 'A tiny tune wound up with a key.', len: 5, fn(o, sr, rnd) {
      const tune = [76, 79, 81, 79, 76, 74, 72, 74, 76, 79, 76, 72, 74];
      tune.forEach((m, k) => { const t = 0.05 + k * 0.3 + (rnd() - 0.5) * 0.02; bellNote(o, t, midiHz(m), sr, [[1, 1, 1.6], [5.4, 0.25, 0.3], [13.3, 0.08, 0.1]], 0.7); burst(o, Math.round(t * sr), sr, 6000, 2, 0.003, 0.15, rnd); });
      reverb(o, sr, 0.25, 0.8);
    } },
    { id: 'bowl', name: 'Singing Bowl', glyph: '◡', riddle: 'Struck once, then circled until it hums.', len: 7, fn(o, sr) {
      const f = 196, n = o.length;
      modes(o, 0, f, sr, [[1, 1, 9], [1, 0.8, 9, 0.9], [2.76, 0.4, 6], [2.76, 0.35, 6, 1.7], [5.04, 0.15, 3], [8.1, 0.06, 2]], 0.8);
      for (let i = 0; i < n; i++) {
        const t = i / sr, sw = clamp01((t - 1.2) / 3) * (t > 5.5 ? Math.max(0, 1 - (t - 5.5) / 1.4) : 1);
        o[i] += sw * 0.55 * (Math.sin(TAU * f * t) + Math.sin(TAU * (f + 1.1) * t) + 0.3 * Math.sin(TAU * f * 2.76 * t)) * (0.85 + 0.15 * Math.sin(TAU * 0.8 * t));
      }
    } },
    { id: 'storm', name: 'Thunderstorm', glyph: 'ϟ', riddle: 'Rain, and then the sky cracks open.', len: 7, fn(o, sr, rnd) {
      const n = o.length, H = svf(sr).set(4000, 0.8), T = svf(sr).set(120, 0.7), C = svf(sr).set(1800, 0.6);
      let br = 0, fl = 1;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        H.run(rnd() * 2 - 1);
        o[i] = 0.18 * H.bpn * Math.min(1, t / 0.8) * ar(i, n, 1, 0.8 * sr);
        br = br * 0.995 + (rnd() * 2 - 1) * 0.1; T.run(br);
        if ((i & 511) === 0) fl = 0.6 + 0.8 * rnd();
        const tt = t - 1.6;
        if (tt > 0) {
          C.run(rnd() * 2 - 1);
          o[i] += C.hp * 1.4 * Math.exp(-tt * 18) + T.lp * 9 * fl * Math.min(1, tt / 0.05) * Math.exp(-tt * 0.7);
        }
      }
      for (let k = 0; k < 160; k++) chirp(o, Math.floor(rnd() * (n - 0.05 * sr)), sr, 0.015 + 0.02 * rnd(), (t) => (1500 + 3000 * rnd()) * (1 + t), 0.12);
    } },
    { id: 'birds', name: 'Bird Chorus', glyph: '⌒', riddle: 'Dawn: many small throats at once.', len: 5.5, fn(o, sr, rnd) {
      const n = o.length, W = svf(sr).set(700, 1);
      for (let i = 0; i < n; i++) { W.run(rnd() * 2 - 1); o[i] = 0.05 * W.bpn; }
      const L = n / sr;
      for (let b = 0; b < 5; b++) {
        const base = 2000 + b * 650, motif = [];
        for (let k = 0; k < 3 + b % 3; k++) motif.push({ d: 0.05 + 0.1 * rnd(), a: base * (0.8 + 0.5 * rnd()), b: base * (0.7 + 0.8 * rnd()), g: 0.03 + 0.06 * rnd() });
        for (let t = 0.1 + b * 0.37; t < L - 0.6;) {
          for (const c of motif) { chirp(o, Math.round(t * sr), sr, c.d, (x) => c.a + (c.b - c.a) * x, 0.35, 0.1); t += c.d + c.g; }
          t += 0.6 + 0.9 * rnd();
        }
      }
    } },
    { id: 'harmonica', name: 'Glass Harmonica', glyph: '◎', riddle: 'Wet fingers on spinning glass.', len: 6.5, fn(o, sr) {
      const n = o.length, ch = [[69, 0, 6], [73, 0.5, 6], [76, 1, 6], [78, 3.2, 3.3], [81, 3.4, 3.1]];
      for (const [m, t0, d] of ch) {
        const f = midiHz(m), i0 = Math.round(t0 * sr), L = Math.round(Math.min(d, n / sr - t0) * sr);
        for (let i = 0; i < L; i++) {
          const t = i / sr, e = Math.min(1, t / 0.6) * Math.min(1, (L - i) / (0.8 * sr)) * (0.85 + 0.15 * Math.sin(TAU * 4.6 * t + m));
          o[i0 + i] += 0.3 * e * (Math.sin(TAU * f * t) + 0.08 * Math.sin(TAU * 2 * f * t) + 0.03 * Math.sin(TAU * 3 * f * t));
        }
      }
      reverb(o, sr, 0.35, 1.2);
    } },
    { id: 'choir', name: 'Cathedral Choir', glyph: '♰', riddle: 'Many voices under a stone ceiling.', len: 6.5, sample: true, fn(o, sr, rnd, src) {
      const chord = [48, 55, 60, 64, 67], n = o.length;
      if (src && !src.synthetic) {
        const D = src.data;
        for (const m of chord) {
          const rate = midiHz(m) / src.rootF * src.sr / sr, L = Math.min(n, Math.floor((D.length - 2) / rate));
          for (let i = 0; i < L; i++) { const p = i * rate, pi = p | 0, fr = p - pi; o[i] += 0.3 * (D[pi] * (1 - fr) + D[pi + 1] * fr) * Math.min(1, i / (0.4 * sr)) * Math.min(1, (L - i) / (0.6 * sr)); }
        }
      } else {
        for (const m of chord) {
          const tmp = new Float32Array(Math.round(5.6 * sr));
          formantVoice(tmp, midiHz(m) * 2 ** ((m % 3 - 1) * 6 / 1200), sr, rnd, { vowels: (t) => vowelLerp('a', 'o', clamp01((t - 2) / 2)), att: 0.8, vib: 0.009 + (m % 5) * 0.002 });
          for (let i = 0; i < tmp.length; i++) o[i] += 0.3 * tmp[i];
        }
      }
      reverb(o, sr, 0.6, 1.8, 0.2);
    } },
    { id: 'theremin', name: 'Theremin', glyph: '∿', riddle: 'A voice drawn out of thin air by a waving hand.', len: 5.5, fn(o, sr) {
      const tune = [[0, 69], [0.9, 76], [1.8, 74], [2.4, 72], [3.1, 69], [3.9, 64]], n = o.length;
      let ph = 0, cur = midiHz(57);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let m = tune[0][1];
        for (const [t0, mm] of tune) if (t >= t0) m = mm;
        cur += (midiHz(m) - cur) * 0.00012 * 48000 / sr;
        const ff = cur * (1 + 0.012 * Math.sin(TAU * 6.3 * t) * Math.min(1, t / 0.6));
        ph += ff / sr;
        o[i] = (Math.sin(TAU * ph) + 0.12 * Math.sin(2 * TAU * ph)) * ar(i, n, 0.3 * sr, 0.8 * sr);
      }
      reverb(o, sr, 0.3, 1);
    } },
    { id: 'heart', name: 'Heartbeat', glyph: '♥', riddle: 'Lub-dub. Something alive, close to your ear.', len: 4.8, fn(o, sr, rnd) {
      for (let b = 0; b < 6; b++) {
        const t = 0.1 + b * 0.8;
        for (const [dt, f, a] of [[0, 55, 1], [0.27, 46, 0.6]]) {
          const i0 = Math.round((t + dt) * sr);
          chirp(o, i0, sr, 0.16, (x) => f * (1 + 0.8 * (1 - x) ** 3), a * 1.4);
          burst(o, i0, sr, 90, 0.8, 0.05, a * 0.5, rnd);
        }
      }
    } },
    { id: 'radio', name: 'Radio Tuning', glyph: '⌁', riddle: 'Static, a whistle, and a station slipping past.', len: 5.5, fn(o, sr, rnd) {
      const n = o.length, F = svf(sr).set(1800, 0.7), V = svf(sr).set(900, 1.2), tune = [72, 76, 79, 76, 74, 71, 72];
      let ph = 0, mp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, dial = Math.sin(t * 0.9) * 0.5 + 0.5, near = Math.exp(-(((t - 2.6) / 0.6) ** 2)), near2 = Math.exp(-(((t - 4.6) / 0.35) ** 2));
        F.run(rnd() * 2 - 1);
        ph += (300 + 2600 * dial) / sr;
        const m = tune[Math.floor(t * 4) % tune.length];
        mp += midiHz(m) / sr;
        V.run((mp % 1 < 0.5 ? 1 : -1) * 0.7 + 0.3 * Math.sin(TAU * mp * 2));
        const crack = rnd() < 0.0008 ? (rnd() * 2 - 1) * 3 : 0;
        o[i] = (0.35 * F.bpn + crack) * (1 - 0.8 * near) + 0.2 * Math.sin(TAU * ph) * (1 - near) + (near + 0.6 * near2) * V.bpn * 1.2;
      }
    } },
    { id: 'chimes', name: 'Wind Chimes', glyph: '⫶', riddle: 'Hollow tubes, knocked by a breeze.', len: 6.5, fn(o, sr, rnd) {
      const pent = [84, 86, 88, 91, 93, 96], W = svf(sr), n = o.length;
      for (let i = 0; i < n; i++) { if ((i & 63) === 0) W.set(500 + 400 * Math.sin(i / sr * 0.7), 1.5); W.run(rnd() * 2 - 1); o[i] = 0.04 * W.bpn; }
      let t = 0.05;
      while (t < n / sr - 1.5) { bellNote(o, t, midiHz(pick(pent, rnd())), sr, TUBE, 0.35 + 0.4 * rnd()); t += rnd() < 0.4 ? 0.06 + 0.08 * rnd() : 0.25 + 0.5 * rnd(); }
    } },
    { id: 'ocean', name: 'Ocean Waves', glyph: '≋', riddle: 'It rolls in, crashes, and draws back.', len: 8, fn(o, sr, rnd) {
      const n = o.length, F = svf(sr), Hh = svf(sr).set(5000, 0.7);
      for (let i = 0; i < n; i++) {
        const t = i / sr, w1 = Math.exp(-(((t - 2) / 1.1) ** 2)) + 0.85 * Math.exp(-(((t - 5.4) / 1.2) ** 2)), s = 0.12 + w1;
        if ((i & 31) === 0) F.set(250 + 2200 * w1, 0.7);
        const nz = rnd() * 2 - 1; F.run(nz); Hh.run(nz);
        o[i] = (F.lp * 0.9 + Hh.hp * 0.15 * w1 * w1) * s * ar(i, n, 0.5 * sr, 0.8 * sr);
      }
    } },
    { id: 'clock', name: 'Clockwork', glyph: '⚙', riddle: 'Tick, tock, a ratchet, and then the hour.', len: 5, fn(o, sr, rnd) {
      for (let k = 0; k < 13; k++) { const t = 0.05 + k * 0.25; bellNote(o, t, k % 2 ? 2300 : 3100, sr, [[1, 0.6, 0.04], [1.7, 0.3, 0.03]], 1); burst(o, Math.round(t * sr), sr, 5000, 2, 0.004, 0.4, rnd); }
      for (let k = 0; k < 18; k++) burst(o, Math.round((3.3 + k * 0.025) * sr), sr, 2500 + 500 * rnd(), 3, 0.006, 0.5, rnd);
      bellNote(o, 3.9, 880, sr, BELL.map(([r, a, t]) => [r, a, t * 1.5]), 0.8);
    } },
    { id: 'aurora', name: 'Aurora', glyph: '✧', riddle: 'Cold light rippling over the pole.', len: 7, fn(o, sr, rnd) {
      const n = o.length, parts = [];
      for (let k = 0; k < 9; k++) parts.push({ f: midiHz(pick([76, 79, 83, 86, 88, 91], rnd())) * (1 + (rnd() - 0.5) * 0.004), lf: 0.1 + 0.4 * rnd(), ph: rnd() * TAU, d: 0.002 * (rnd() - 0.5) });
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let y = 0;
        for (const p of parts) y += Math.sin(TAU * p.f * (1 + p.d * t) * t) * (0.5 + 0.5 * Math.sin(TAU * p.lf * t + p.ph)) ** 2;
        o[i] = y * 0.15 * ar(i, n, 1.2 * sr, 1.5 * sr);
      }
      reverb(o, sr, 0.5, 1.5, 0.15);
    } },
    { id: 'frogs', name: 'Frog Pond', glyph: '⁂', riddle: 'Croaks from the reeds after rain.', len: 5.5, fn(o, sr, rnd) {
      const n = o.length, L = n / sr;
      for (let fr = 0; fr < 4; fr++) {
        const f = 300 + fr * 170, pr = 40 + fr * 12, F = svf(sr).set(f * 1.6, 5);
        for (let t = 0.1 + fr * 0.45; t < L - 0.4; t += 0.9 + 0.8 * rnd()) {
          const i0 = Math.round(t * sr), len = Math.round((0.12 + 0.12 * rnd()) * sr);
          for (let i = 0; i < len && i0 + i < n; i++) {
            const tt = i / sr, pulse = Math.max(0, Math.sin(TAU * pr * tt)) ** 4;
            F.run(pulse * Math.sin(TAU * f * tt));
            o[i0 + i] += 0.8 * F.bpn * Math.sin(Math.PI * i / len);
          }
        }
      }
      for (let i = 0; i < n; i++) o[i] += 0.03 * Math.sin(TAU * 4800 * i / sr) * Math.max(0, Math.sin(TAU * 45 * i / sr)) ** 3 * (Math.sin(TAU * 1.7 * i / sr) > 0.3 ? 1 : 0);
    } },
    { id: 'steelpan', name: 'Steel Pan', glyph: '◉', riddle: 'An oil drum, hammered until it learned to sing.', len: 4.5, fn(o, sr) {
      const tune = [[0, 72], [0.2, 76], [0.4, 79], [0.6, 76], [0.9, 81], [1.2, 79], [1.5, 77], [1.7, 76], [1.9, 74], [2.3, 72], [2.5, 67], [2.7, 72]];
      for (const [t, m] of tune) bellNote(o, t + 0.05, midiHz(m), sr, [[1, 1, 1.1], [2, 0.6, 0.7], [3, 0.3, 0.4], [4.02, 0.12, 0.25]], 0.6);
      reverb(o, sr, 0.2, 0.8);
    } },
  ];
  GEMS.forEach((g, k) => { g.k = k; });

  // ---------- which biomes each gem may spawn in (biome ids from BIOMES) ----------
  const GEM_BIOMES = {
    aurora: ['air', 'texture'],       whale: ['nature', 'voice'],
    musicbox: ['metal', 'wood'],      steelpan: ['metal'],          bowl: ['metal'],      chimes: ['metal'],
    harmonica: ['metal', 'air'],      choir: ['voice'],
    theremin: ['machine', 'strings'], radio: ['machine'],           clock: ['machine', 'wood'],
    storm: ['nature'],                ocean: ['nature'],            birds: ['nature'],    frogs: ['nature'],
    heart: ['nature', 'texture'],
  };
  const GEM_BI = GEMS.map((g) => GEM_BIOMES[g.id].map((id) => BIOMES.findIndex((b) => b.id === id)));
  const BIOME_GEMS = BIOMES.map((_, b) => GEMS.filter((g) => GEM_BI[g.k].includes(b)).map((g) => g.k));

  // ---------- gem signatures: the halo's hint of each gem (its character, never its actual tune) ----------
  // reg: pitch register neighbours are pulled toward; lp / hp: a spectral tilt of the neighbour toward the gem's colour
  // (low-pass for dark gems, high-pass for airy ones); col: the faint map tint; fn(o, sr, rnd) fills a texture layer.
  const SIG = {
    whale: { reg: 160, lp: 900, col: '#5f86c0', fn(o, sr, rnd) {   // slow downward glides through low formants
      const n = o.length, F = svf(sr), a = 170 + 130 * rnd(), b = a * (0.42 + 0.2 * rnd());
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n, ff = a * (b / a) ** fade(t);
        if ((i & 31) === 0) F.set(380 + 220 * Math.sin(TAU * 0.35 * i / sr), 2);
        ph += ff / sr;
        const s = Math.sin(TAU * ph) + 0.5 * Math.sin(2 * TAU * ph) + 0.25 * Math.sin(3 * TAU * ph);
        F.run(s);
        o[i] = Math.sin(Math.PI * t) * (0.5 * s + 0.7 * F.bpn);
      }
      reverb(o, sr, 0.5, 1.6, 0.4);
    } },
    musicbox: { reg: 660, col: '#e3c47a', fn(o, sr, rnd) {   // bright plucked comb teeth, high register
      for (let t = 0.02; t < o.length / sr - 0.12; t += 0.24 + 0.12 * rnd()) {
        bellNote(o, t, midiHz(pick([72, 74, 76, 79, 81, 84], rnd())), sr, [[1, 1, 1.6], [5.4, 0.25, 0.3], [13.3, 0.08, 0.1]], 0.6);
        burst(o, Math.round(t * sr), sr, 6000, 2, 0.003, 0.12, rnd);
      }
      reverb(o, sr, 0.25, 0.8);
    } },
    bowl: { reg: 196, col: '#d2a95e', fn(o, sr, rnd) {   // a slow beating hum
      const n = o.length, f = 196 * (rnd() < 0.5 ? 1 : 1.5), bt = 0.8 + 0.6 * rnd();
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        o[i] = Math.sin(Math.PI * i / n) ** 0.6 * (Math.sin(TAU * f * t) + Math.sin(TAU * (f + bt) * t) + 0.35 * Math.sin(TAU * f * 2.76 * t));
      }
    } },
    storm: { reg: 140, lp: 1500, col: '#7c88b0', fn(o, sr, rnd) {   // rain hiss over a far rumble
      const n = o.length, H = svf(sr).set(4000, 0.8), T = svf(sr).set(110, 0.7);
      let br = 0;
      for (let i = 0; i < n; i++) {
        H.run(rnd() * 2 - 1); br = br * 0.995 + (rnd() * 2 - 1) * 0.1; T.run(br);
        o[i] = (0.25 * H.bpn + 5 * T.lp * Math.sin(Math.PI * i / n) ** 2) * ar(i, n, 0.2 * sr, 0.3 * sr);
      }
      for (let k = 0; k < 30 * n / sr; k++) chirp(o, Math.floor(rnd() * (n - 0.05 * sr)), sr, 0.015 + 0.02 * rnd(), (t) => 2500 * (1 + t), 0.1);
    } },
    birds: { reg: 1400, hp: 1500, col: '#a2c97c', fn(o, sr, rnd) {   // quick high chirps from several directions
      const n = o.length, L = n / sr;
      for (let t = 0.03; t < L - 0.15; t += 0.08 + 0.25 * rnd()) {
        const a = 2000 + 1800 * rnd(), d = 0.04 + 0.08 * rnd();
        chirp(o, Math.round(t * sr), sr, d, (x) => a * (1 + (rnd() < 0.5 ? 0.3 : -0.25) * x), 0.35, 0.1);
      }
    } },
    harmonica: { reg: 554, col: '#a9dbe9', fn(o, sr, rnd) {   // pure glassy sines with a slow tremolo
      const n = o.length, ch = [pick([69, 73, 76], rnd()), pick([78, 81, 76], rnd())];
      for (const m of ch) {
        const f = midiHz(m);
        for (let i = 0; i < n; i++) { const t = i / sr; o[i] += 0.4 * ar(i, n, 0.5 * sr, 0.6 * sr) * (0.85 + 0.15 * Math.sin(TAU * 4.6 * t + m)) * (Math.sin(TAU * f * t) + 0.08 * Math.sin(TAU * 2 * f * t)); }
      }
      reverb(o, sr, 0.35, 1.2);
    } },
    choir: { reg: 196, lp: 2000, col: '#d9b9d2', fn(o, sr, rnd) {   // two distant voices on "a" opening to "o"
      const L = o.length / sr;
      for (const m of [pick([48, 52, 55], rnd()), 60]) formantVoice(o, midiHz(m), sr, rnd, { vowels: (t) => vowelLerp('a', 'o', clamp01(t / L)), att: 0.5, vib: 0.01 });
      reverb(o, sr, 0.55, 1.8, 0.2);
    } },
    theremin: { reg: 440, col: '#b69be2', fn(o, sr, rnd) {   // a sliding sine with a wide vibrato
      const n = o.length, a = midiHz(pick([64, 69, 72], rnd())), b = midiHz(pick([74, 76, 69], rnd()));
      let ph = 0, cur = a;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        cur += ((i < n / 2 ? a : b) - cur) * 0.00012 * 48000 / sr;
        ph += cur * (1 + 0.012 * Math.sin(TAU * 6.3 * t)) / sr;
        o[i] = (Math.sin(TAU * ph) + 0.12 * Math.sin(2 * TAU * ph)) * ar(i, n, 0.2 * sr, 0.3 * sr);
      }
      reverb(o, sr, 0.3, 1);
    } },
    heart: { reg: 55, lp: 250, col: '#c8646e', fn(o, sr, rnd) {   // soft lub-dub thumps
      for (let t = 0.04 + 0.2 * rnd(); t < o.length / sr - 0.3; t += 0.8) {
        for (const [dt, f, a] of [[0, 55, 1], [0.27, 46, 0.6]]) { const i0 = Math.round((t + dt) * sr); chirp(o, i0, sr, 0.16, (x) => f * (1 + 0.8 * (1 - x) ** 3), a); burst(o, i0, sr, 90, 0.8, 0.05, a * 0.4, rnd); }
      }
    } },
    radio: { reg: 900, col: '#a3a3cc', fn(o, sr, rnd) {   // static with a whistle sliding past
      const n = o.length, F = svf(sr).set(1800, 0.7), p0 = rnd() * TAU;
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        F.run(rnd() * 2 - 1); ph += (300 + 2600 * (0.5 + 0.5 * Math.sin(t * 0.9 + p0))) / sr;
        o[i] = (0.4 * F.bpn + 0.2 * Math.sin(TAU * ph) + (rnd() < 0.0008 ? (rnd() * 2 - 1) * 2 : 0)) * ar(i, n, 0.05 * sr, 0.2 * sr);
      }
    } },
    chimes: { reg: 1300, hp: 800, col: '#c3d3e4', fn(o, sr, rnd) {   // hollow tubes in a breeze
      const n = o.length, W = svf(sr);
      for (let i = 0; i < n; i++) { if ((i & 63) === 0) W.set(500 + 400 * Math.sin(i / sr * 0.7), 1.5); W.run(rnd() * 2 - 1); o[i] = 0.05 * W.bpn; }
      for (let t = 0.03; t < n / sr - 0.2; t += rnd() < 0.4 ? 0.07 + 0.08 * rnd() : 0.3 + 0.4 * rnd()) bellNote(o, t, midiHz(pick([84, 86, 88, 91, 93, 96], rnd())), sr, TUBE, 0.3 + 0.3 * rnd());
    } },
    ocean: { reg: 300, lp: 1200, col: '#5ea4bc', fn(o, sr, rnd) {   // a swell rolling in and back
      const n = o.length, F = svf(sr);
      for (let i = 0; i < n; i++) {
        const w = Math.sin(Math.PI * i / n) ** 2;
        if ((i & 31) === 0) F.set(250 + 2000 * w, 0.7);
        F.run(rnd() * 2 - 1);
        o[i] = F.lp * (0.15 + w);
      }
    } },
    clock: { reg: 2600, hp: 1500, col: '#c49d6c', fn(o, sr, rnd) {   // tick, tock
      for (let k = 0, t = 0.03; t < o.length / sr - 0.06; k++, t += 0.25) { bellNote(o, t, k % 2 ? 2300 : 3100, sr, [[1, 0.6, 0.04], [1.7, 0.3, 0.03]], 1); burst(o, Math.round(t * sr), sr, 5000, 2, 0.004, 0.35, rnd); }
    } },
    aurora: { reg: 1000, hp: 700, col: '#84e2b6', fn(o, sr, rnd) {   // slow shimmer of high airy partials, gently detuned
      const n = o.length, parts = [];
      for (let k = 0; k < 6; k++) parts.push({ f: midiHz(pick([76, 79, 83, 86, 88, 91], rnd())) * (1 + (rnd() - 0.5) * 0.006), lf: 0.25 + 0.6 * rnd(), ph: rnd() * TAU, d: 0.003 * (rnd() - 0.5) });
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let y = 0;
        for (const p of parts) y += Math.sin(TAU * p.f * (1 + p.d * t) * t) * (0.5 + 0.5 * Math.sin(TAU * p.lf * t + p.ph)) ** 2;
        o[i] = y * ar(i, n, 0.35 * sr, 0.5 * sr);
      }
      reverb(o, sr, 0.5, 1.5, 0.15);
    } },
    frogs: { reg: 450, col: '#72b25c', fn(o, sr, rnd) {   // pulsed croaks from the reeds
      const n = o.length;
      for (let fr = 0; fr < 2; fr++) {
        const f = 300 + 170 * Math.floor(rnd() * 4), pr = 40 + 12 * fr, F = svf(sr).set(f * 1.6, 5);
        for (let t = 0.05 + fr * 0.3; t < n / sr - 0.2; t += 0.6 + 0.6 * rnd()) {
          const i0 = Math.round(t * sr), len = Math.round((0.12 + 0.1 * rnd()) * sr);
          for (let i = 0; i < len && i0 + i < n; i++) { const tt = i / sr; F.run(Math.max(0, Math.sin(TAU * pr * tt)) ** 4 * Math.sin(TAU * f * tt)); o[i0 + i] += 0.8 * F.bpn * Math.sin(Math.PI * i / len); }
        }
      }
    } },
    steelpan: { reg: 523, col: '#d4b274', fn(o, sr, rnd) {   // round hammered notes, harmonically tuned
      for (let t = 0.03; t < o.length / sr - 0.15; t += 0.18 + 0.14 * rnd()) bellNote(o, t, midiHz(pick([67, 72, 74, 76, 79, 81], rnd())), sr, [[1, 1, 1.1], [2, 0.6, 0.7], [3, 0.3, 0.4], [4.02, 0.12, 0.25]], 0.6);
      reverb(o, sr, 0.2, 0.8);
    } },
  };
  GEMS.forEach((g) => { g.sig = SIG[g.id]; g.biomes = GEM_BIOMES[g.id]; });

  // ---------- placement ----------
  // A cell's candidate points come from a hashed jitter sequence (the first is the old v3 spot). A point is a valid
  // spot for biome b when the reference map (zoom 1) is pure b there and on two rings of radius GEM_IN and GEM_IN/2.
  // Each 4x4 block then matches its 16 cells to the 16 kinds (a cell can host a kind when it has a spot in one of the
  // kind's biomes; augmenting paths, each kind tried first at its old permuted cell). A cell left unmatched still gets
  // a gem, of a kind that fits one of its biomes. Blocks are cached, so every lookup (detector, halo, map) is cheap.
  const GEM_DEPTH = depthAt(1), GEM_IN = 0.6, GEM_TRIES = 28;
  const RING = [];
  for (let a = 0; a < 24; a++) RING.push([GEM_IN * Math.cos(a * TAU / 24), GEM_IN * Math.sin(a * TAU / 24)]);
  for (let a = 0; a < 12; a++) RING.push([0.5 * GEM_IN * Math.cos((a + 0.5) * TAU / 12), 0.5 * GEM_IN * Math.sin((a + 0.5) * TAU / 12)]);
  const spotC = {};
  function cellSpots(ci, cj) {   // Map biome -> [x, y], in candidate order
    const spots = new Map(), c = spotC;
    for (let a = 0; a < GEM_TRIES && spots.size < 8; a++) {
      const x = (ci + 0.12 + 0.76 * hash(ci, cj, 71 + 2 * a)) * G, y = (cj + 0.12 + 0.76 * hash(ci, cj, 72 + 2 * a)) * G;
      cellAt(x, y, GEM_DEPTH, c);
      const b = c.bi;
      if (c.w > 0 || c.gap < GEM_IN * 0.7 || spots.has(b)) continue;
      let ok = true;
      for (const [dx, dy] of RING) if (cellAt(x + dx, y + dy, GEM_DEPTH, c).bi !== b) { ok = false; break; }
      if (ok) spots.set(b, [x, y]);
    }
    return spots;
  }
  const permCache = new Map();
  function blockPerm(bi, bj) {
    const key = bi + ',' + bj;
    let p = permCache.get(key);
    if (!p) {
      const r = rng((hash(bi, bj, 77) * 4294967296) | 0);
      p = Array.from({ length: 16 }, (_, i) => i);
      for (let i = 15; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
      if (permCache.size > 2000) permCache.clear();
      permCache.set(key, p);
    }
    return p;
  }
  const blockCache = new Map();
  function gemBlock(bi, bj) {   // -> 16 gems (or null), index li * 4 + lj
    const key = bi + ',' + bj;
    let out = blockCache.get(key);
    if (out) return out;
    const cells = [];
    for (let li = 0; li < 4; li++) for (let lj = 0; lj < 4; lj++) { const ci = bi * 4 - 2 + li, cj = bj * 4 - 2 + lj; cells.push({ ci, cj, spots: cellSpots(ci, cj) }); }
    const perm = blockPerm(bi, bj), at = new Array(16), owner = new Array(16).fill(-1);
    perm.forEach((k, i) => { at[k] = i; });
    const can = (k, c) => GEM_BI[k].some((b) => c.spots.has(b));
    const aug = (k, seen) => {
      for (let t = 0; t < 16; t++) {
        const i = (at[k] + t) & 15;
        if (seen[i] || !can(k, cells[i])) continue;
        seen[i] = 1;
        if (owner[i] < 0 || aug(owner[i], seen)) { owner[i] = k; return true; }
      }
      return false;
    };
    for (const k of perm) aug(k, new Uint8Array(16));
    out = cells.map((c, i) => {
      let k = owner[i];
      if (k < 0) {   // unmatched: any kind that fits one of this cell's biomes
        const opts = [];
        for (const b of c.spots.keys()) for (const kk of BIOME_GEMS[b]) if (!opts.includes(kk)) opts.push(kk);
        if (!opts.length) return null;
        k = pick(opts.sort((a, b) => a - b), hash(c.ci, c.cj, 79));
      }
      let pt = null, bm = -1;
      for (const [b, p] of c.spots) if (GEM_BI[k].includes(b)) { pt = p; bm = b; break; }
      return Object.freeze({ ci: c.ci, cj: c.cj, k, x: pt[0], y: pt[1], b: bm, id: c.ci + ',' + c.cj });
    });
    if (blockCache.size > 3000) blockCache.clear();
    blockCache.set(key, out);
    return out;
  }
  function gemAt(ci, cj) {   // -> a fresh { ci, cj, k, x, y, b, id } or null
    const bi = Math.floor((ci + 2) / 4), bj = Math.floor((cj + 2) / 4), g = gemBlock(bi, bj)[(ci + 2 - bi * 4) * 4 + (cj + 2 - bj * 4)];
    return g ? Object.assign({}, g) : null;
  }
  // Gems within `range` of (x, y), nearest first. skip(g) -> true excludes.
  function gemsNear(x, y, range, skip) {
    const out = [], c0 = Math.floor((x - range) / G), c1 = Math.floor((x + range) / G), r0 = Math.floor((y - range) / G), r1 = Math.floor((y + range) / G);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 400) return out;
    for (let cj = r0; cj <= r1; cj++) for (let ci = c0; ci <= c1; ci++) {
      const g = gemAt(ci, cj);
      if (!g) continue;
      g.d = Math.hypot(g.x - x, g.y - y);
      if (g.d <= range && !(skip && skip(g))) out.push(g);
    }
    return out.sort((a, b) => a.d - b.d);
  }
  // The nearest gem of kind k to (x, y) (null only if none within ~9 cells).
  function nearestOfKind(k, x, y) {
    for (const r of [2 * G, 4 * G, 6 * G, 9 * G]) { const g = gemsNear(x, y, r, (h) => h.k !== k)[0]; if (g) return g; }
    return null;
  }
  // v3 found-gems store -> v4: one entry per kind found (earliest), moved to the nearest new gem of that kind.
  function migrateFound(old) {
    const byKind = new Map(), out = {};
    for (const f of Object.values(old || {})) {
      if (!f || !Number.isInteger(f.k) || f.k < 0 || f.k >= GEMS.length) continue;
      const b = byKind.get(f.k);
      if (!b || (f.t || 0) < (b.t || 0)) byKind.set(f.k, f);
    }
    for (const [k, f] of byKind) {
      const x = isFinite(f.x) ? f.x : 0, y = isFinite(f.y) ? f.y : 0, g = nearestOfKind(k, x, y) || nearestOfKind(k, 0, 0);
      if (g) out[g.id] = { k, x: g.x, y: g.y, t: f.t || Date.now(), moved: 1 };
    }
    return out;
  }
  // ---------- the halo: neighbours within HALO_R of a gem drift toward its signature (smoothstep of closeness) ----------
  const HALO_R = 2.5, HALO_MIX = 0.62, HALO_PULL = 0.3;
  function haloAt(x, y) {
    const g = gemsNear(x, y, HALO_R)[0];
    if (!g) return null;
    const w = fade(clamp01(1 - g.d / HALO_R)) ** 0.6;   // smoothstep of closeness, eased so the outer ring still carries a trace
    return w > 1e-3 ? { k: g.k, w } : null;
  }
  // Mix the gem's signature layer into a rendered buffer (before finish); may lengthen it so slow textures can bloom.
  const gemBufs = new Map();   // the gems' own renders (dry of samples), the source of the halo's grains
  function gemBuf(k, sr) {
    const key = k + '@' + sr;
    let d = gemBufs.get(key);
    if (!d) { d = renderSync({ kind: 'gem', gem: k }, sr, null); gemBufs.set(key, d); if (gemBufs.size > 4) gemBufs.delete(gemBufs.keys().next().value); }
    return d;
  }
  const rmsOf = (o) => { let s = 0; for (let i = 0; i < o.length; i++) s += o[i] * o[i]; return Math.sqrt(s / Math.max(1, o.length)); };
  // The layer = the gem's signature texture + a scatter of short grains of the gem itself (its timbre, not its tune).
  function haloLayer(k, n, sr, rnd) {
    const L = new Float32Array(n), Q = new Float32Array(n), D = gemBuf(k, sr), gl = Math.round(0.26 * sr);
    GEMS[k].sig.fn(L, sr, rnd);
    for (let c = Math.max(2, Math.round(5 * n / sr)); c > 0; c--) {
      let p0 = 0;
      for (let t = 0; t < 6; t++) { p0 = Math.floor(rnd() * (D.length - gl)); if (Math.abs(D[p0 + (gl >> 1)]) > 0.02) break; }   // prefer audible spots
      const t0 = Math.floor(rnd() * Math.max(1, n - gl)), len = Math.round(gl * (0.7 + 0.6 * rnd()));
      for (let i = 0; i < len && t0 + i < n && p0 + i < D.length; i++) Q[t0 + i] += D[p0 + i] * (0.5 - 0.5 * Math.cos(TAU * i / len));
    }
    const a = rmsOf(L), b = rmsOf(Q);
    for (let i = 0; i < n; i++) L[i] = (a > 0 ? 0.5 * L[i] / a : 0) + (b > 0 ? 0.5 * Q[i] / b : 0);
    return L;
  }
  function applyHalo(o, p, sr) {
    const h = p.halo, a = HALO_MIX * h.w, n = Math.max(o.length, Math.round(Math.min(3.4, 0.8 + 2.2 * h.w) * sr));
    const L = haloLayer(h.k, n, sr, rng(p.seed ^ 0x6a10 ^ (h.k * 977))), sg = GEMS[h.k].sig;
    if (sg.lp || sg.hp) {   // tilt the neighbour itself toward the gem's spectrum
      const F = svf(sr).set(sg.lp || sg.hp, 0.7), tw = h.w;
      for (let i = 0; i < o.length; i++) { F.run(o[i]); o[i] += ((sg.lp ? F.lp : F.hp) - o[i]) * tw; }
    }
    const rl = rmsOf(L), k = rl > 0 ? rmsOf(o) * Math.sqrt(o.length / n) / rl : 0, out = n === o.length ? o : new Float32Array(n);   // equal energy over the whole buffer
    for (let i = 0; i < n; i++) out[i] = (i < o.length ? o[i] : 0) * (1 - a) + L[i] * k * a;
    return out;
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? clamp01(((px - ax) * dx + (py - ay) * dy) / L) : 0;
    return Math.hypot(ax + t * dx - px, ay + t * dy - py);
  }
  function gemDesc(g) {
    const gm = GEMS[g.k];
    return { gem: g.k, gid: g.id, x: g.x, y: g.y, zoom: 4, tier: 4, kind: 'gem', name: gm.name, biome: 'Gem', fam: 'babel-gem', key: 'gem:' + gm.id, f: 220, seed: g.k + 1, sus: false };
  }

  // ======================================================================================================
  // Rendering: point -> Float32Array (deterministic), cached
  // ======================================================================================================
  function renderNote(p, f, len, sr, src) {
    const n = Math.max(32, Math.round(len * sr));
    const one = (e, q, salt) => {
      const o = new Float32Array(n);
      e.fn(o, f, sr, Object.assign({}, q, { len }), rng(p.seed ^ salt ^ Math.round(f * 7)), e.tex ? src : null);
      return normalize(o, 1);
    };
    const a = one(p.eng, p.q, 0x1234);
    if (p.eng2 && p.w > 0) {
      const b = one(p.eng2, p.q2, 0x4321), w = clamp(p.w, 0, 0.5);
      for (let i = 0; i < n; i++) a[i] = a[i] * (1 - w) + b[i] * w;
    }
    const fo = Math.min(n >> 1, Math.round(0.03 * sr));   // notes cut short fade out
    for (let i = 0; i < fo; i++) a[n - 1 - i] *= i / fo;
    return a;
  }
  function renderSync(p, sr, src) {
    sr = sr || 44100;
    if (p.kind === 'gem') {
      const gm = GEMS[p.gem], o = new Float32Array(Math.round(gm.len * sr));
      gm.fn(o, sr, rng(0x9e3 + p.gem * 7919), src);
      return finish(o, sr);
    }
    if (p.tier < 2) { const o = renderNote(p, p.f, Math.min(3.4, p.natLen), sr, src); return finish(p.halo ? applyHalo(o, p, sr) : o, sr); }
    const { ev, echo: ec, verb } = events(p);
    const end = Math.max(...ev.map((e) => e.t + e.len)), tail = ec ? ec[0] * 4 : verb ? 1.2 : 0.05;
    const o = new Float32Array(Math.round(Math.min(5.5, end + tail) * sr));
    for (const e of ev) {
      const nt = renderNote(p, e.f, e.len, sr, src), i0 = Math.round(e.t * sr);
      for (let i = 0; i < nt.length && i0 + i < o.length; i++) o[i0 + i] += nt[i] * e.v;
    }
    if (ec) echo(o, sr, ec[0], ec[1], 0.6);
    if (verb) reverb(o, sr, verb, 1.1);
    return finish(p.halo ? applyHalo(o, p, sr) : o, sr);
  }
  // Sample sources (Texture biome, Cathedral Choir): decoded buffers of the CC0 library via VH.audio.load.
  const srcCache = new Map();
  const texSounds = () => (VH.sounds ? VH.sounds.list().filter((s) => s.source === 'sample' && !s.private && s.kind === 'sampler').sort((a, b) => (a.id < b.id ? -1 : 1)) : []);
  function nearestZone(s, f) {
    const m = 69 + 12 * Math.log2(f / 440);
    return s.sampler.zones.reduce((b, z) => (!b || Math.abs(z.rootMidi - m) < Math.abs(b.rootMidi - m) ? z : b), null);
  }
  function srcZone(p) {
    if (p.kind === 'gem') {
      if (!GEMS[p.gem].sample || !VH.sounds) return null;
      const s = VH.sounds.list().find((x) => x.kind === 'sampler' && /choir|ahh|ooh/i.test(x.id + ' ' + (x.family || '')));
      return s ? nearestZone(s, 262) : null;
    }
    if (!(p.eng.tex || (p.eng2 && p.eng2.tex))) return null;
    const list = texSounds();
    if (!list.length) return null;
    return nearestZone(list[Math.floor(hash(p.bi, Math.floor(p.u[4] * 64), 9) * list.length)], p.f);
  }
  function toSrc(buf, zone) {
    const d = buf.getChannelData(0);
    return { data: d, sr: buf.sampleRate, rootF: midiHz(zone.rootMidi) };
  }
  // -> src now, a Promise of src, or null.
  function loadSrc(zone) {
    if (!zone || !VH.audio || !VH.audio.load) return null;
    const key = zone.url || zone.blobKey;
    if (srcCache.has(key)) return srcCache.get(key);
    let pr;
    try { pr = VH.audio.load(zone); } catch (_) { return null; }
    if (pr && pr.buffer) { const s = toSrc(pr.buffer, zone); srcCache.set(key, s); return s; }
    return Promise.resolve(pr).then((b) => { const s = toSrc(b, zone); srcCache.set(key, s); return s; }, () => null);
  }
  const renders = new Map();
  // -> Float32Array now, or a Promise of one (when a sample still has to load).
  function render(p, sr) {
    const z = srcZone(p), s = z ? loadSrc(z) : null;
    const go = (src) => {
      const key = p.key + '@' + sr + (src ? '+s' : '');
      let d = renders.get(key);
      if (!d) { d = renderSync(p, sr, src); renders.set(key, d); if (renders.size > 40) renders.delete(renders.keys().next().value); }
      return d;
    };
    if (s && typeof s.then === 'function') return Promise.race([s, new Promise((r) => setTimeout(() => r(null), 2500))]).then(go);
    return go(s);
  }
  const renderAsync = (p, sr) => Promise.resolve(render(p, sr));

  function wavBlob(d, sr) {
    const n = d.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(clamp(d[i], -1, 1) * 32767), true);
    return new Blob([ab], { type: 'audio/wav' });
  }
  function theorySpectrum(p) {
    const e = p.eng;
    const sp = p.kind === 'gem' ? [[1, 1], [2, 0.4], [3, 0.2]] : e && e.spec ? e.spec(p.q) : [[1, 1], [2, 0.5], [3, 0.3], [4, 0.2], [5, 0.12]];
    return VH.sounds.normSpectrum(sp);
  }
  // Loudness match for Melody / Spiral (sound.loud, measured through the real engine). Sounds saved before this get it
  // lazily on first use (VH.sounds.ensureLoud).
  async function withLoud(sound) {
    try { const r = VH.sounds.measure ? await VH.sounds.measure(sound) : null; if (r && r.loud > 0) sound.loud = r.loud; } catch (_) { /* lazily later */ }
    return sound;
  }
  // Render the real sound, store it as a WAV blob, analyze it, save a sampler Sound (every tier).
  async function saveToLibrary(p, name) {
    const meta = { x: p.x, y: p.y, zoom: p.zoom, tier: TIERS[p.tier], biome: p.biome, gem: p.kind === 'gem' ? GEMS[p.gem].id : undefined };
    const sr = 44100, d = await renderAsync(p, sr);
    let root = p.f, spec = null;
    try {
      const an = VH.analyze.fromSamples(d, sr);
      if (an.rootHz > 0 && (p.kind === 'gem' || Math.abs(Math.log2(an.rootHz / p.f)) < 1.05)) { root = an.rootHz; spec = VH.sounds.normSpectrum(an.spectrum); }
    } catch (_) { /* fall back to the theory spectrum */ }
    if (!spec || spec.length < 2) spec = theorySpectrum(p);
    const sound = { name, family: p.fam, source: 'babel', kind: 'sampler', play: p.sus ? 'glide' : 'hit', spectrum: spec, rootHz: root, babel: meta };
    try {
      if (!window.indexedDB) throw new Error('no IndexedDB');
      const id = 'babel-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await VH.store.putBlob(id, wavBlob(d, sr));
      Object.assign(sound, { id, sampler: { zones: [{ blobKey: id, rootMidi: Math.round((69 + 12 * Math.log2(root / 440)) * 1000) / 1000 }], release: 0.2 } });
      await withLoud(sound);
      return VH.sounds.save(sound);
    } catch (err) {   // no IndexedDB: an additive approximation from the spectrum
      console.info('[babel] sampler save failed, saving a synth approximation:', err && err.message);
      Object.assign(sound, { id: 'babel-' + Date.now().toString(36), kind: 'synth',
        synth: { partials: spec, attack: 0.005, decay: Math.min(3, d.length / sr), sustain: 0, release: 0.1, glide: 0, noise: 0, wobble: 0 } });
      delete sound.sampler;
      await withLoud(sound);
      return VH.sounds.save(sound);
    }
  }

  // ======================================================================================================
  // The experiment
  // ======================================================================================================
  let inst = null;
  const stats = { renders: 0, rows: 0, draws: 0, overlay: 0, ticks: 0, jobMs: 0 };
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim()); const v = m ? parseInt(m[1], 16) : 0x808080; return [v >> 16, (v >> 8) & 255, v & 255]; };

  function create(el) {
    const BASE = 4, N = 160, view = VH.store.get('babel.view', { cx: 0, cy: 0, zoom: 1 });
    if (!(view.zoom > 0) || !isFinite(view.cx) || !isFinite(view.cy)) Object.assign(view, { cx: 0, cy: 0, zoom: 1 });
    let S = 600, soundOn = true, current = null, detector = !!VH.store.get('babel.detector', false);
    let disc = VH.store.get('babel.disc', []).filter((d) => d && typeof d.x === 'number' && d.tier >= 2 && d.tier <= 3 && d.v === 3);
    const gemStore = VH.store.get('babel.gems', null);
    const found = gemStore && gemStore.v === 4 && gemStore.found ? gemStore.found : {};   // gid -> { k, x, y, t }
    if (gemStore && gemStore.v === 3 && gemStore.found) {   // v3 layout: keep the found kinds, at the new nearest instance
      Object.assign(found, migrateFound(gemStore.found));
      VH.store.set('babel.gems', { v: 4, found });
    }
    const cleanups = [], timers = new Set();
    let alive = true;
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); };
    const span = (z) => BASE / (z || view.zoom);
    const toWorld = (px, py) => [view.cx + (px / S - 0.5) * span(), view.cy + (py / S - 0.5) * span()];
    const toScreen = (wx, wy) => [((wx - view.cx) / span() + 0.5) * S, ((wy - view.cy) / span() + 0.5) * S];
    const hitR = () => Math.min(0.06, 14 * span() / S);
    const cs = getComputedStyle(el);
    const COL = BIOMES.map((b) => hexRgb(cs.getPropertyValue('--bb-' + b.id) || b.col));
    const GEM_COL = GEMS.map((g) => hexRgb(g.sig.col));

    // ---------- layout ----------
    const { box, caption, dock } = ui.layout(el);
    const wrap = ui.h('div', 'bb-wrap'), cv = document.createElement('canvas'), ov = document.createElement('canvas');
    const ctx = cv.getContext('2d'), octx = ov.getContext('2d');
    cv.style.cursor = 'crosshair'; cv.setAttribute('aria-label', 'Map of sounds in eight biomes'); ov.className = 'bb-ov';
    wrap.append(cv, ov); box.append(wrap);
    ui.dockButton(dock, { icon: '⚄', label: 'Dive', title: 'Dive to a random rare pattern', onClick: dive });
    const dBtn = ui.dockButton(dock, { icon: '◎', label: 'Detector', title: 'Gem detector: ticks faster near a hidden gem', pressed: detector, onClick: () => {
      detector = !detector; dBtn.set({ pressed: detector }); VH.store.set('babel.detector', detector); det.next = 0;
      if (detector) VH.audio.ensure();
    } });
    ui.dockButton(dock, { icon: '−', label: 'Out', title: 'Zoom out', onClick: () => zoomAnim(1 / 2) });
    ui.dockButton(dock, { icon: '+', label: 'In', title: 'Zoom in', onClick: () => zoomAnim(2) });
    ui.dockButton(dock, { icon: '★', label: 'Save', title: 'Save this sound to your library', onClick: openSave });
    const dr = ui.drawer(el, dock, { title: 'Babel' });
    const sCur = ui.section(dr.body, 'This sound');
    const nickEl = ui.h('div', 'bb-nick', '—');
    const whereEl = ui.h('div', 'vh-desc', 'Tap the map to hear a point.');
    const ptab = ui.h('table', 'vh-table');
    sCur.append(nickEl, whereEl, ptab);
    const sBtn = ui.button(sCur, { label: 'Sound on', pressed: true, onClick: () => {
      soundOn = !soundOn; sBtn.set({ label: soundOn ? 'Sound on' : 'Muted', pressed: soundOn });
      if (soundOn) VH.audio.ensure(); else killAll();
    } });
    const gemSec = ui.section(dr.body, 'Gems');
    const gemHead = gemSec.querySelector('h3');
    const gemGrid = ui.h('div', 'bb-gems');
    const compassNote = ui.h('div', 'vh-desc bb-compass-note', 'Compass unlocked: the Detector ring points toward the nearest kind you haven’t found.');
    compassNote.hidden = true;
    gemSec.append(ui.h('div', 'vh-desc', 'Sixteen unique sounds hidden on the map, invisible until found. Turn on the Detector and follow the ticks.'), compassNote, gemGrid);
    const discEl = ui.h('div', 'bb-list'), savedEl = ui.h('div', 'bb-list bb-saved');
    ui.section(dr.body, 'Discoveries').append(discEl);
    ui.section(dr.body, 'Saved to library').append(savedEl);
    const legend = ui.h('div', 'bb-legend');
    legend.innerHTML = '<div class="vh-desc">What makes a find rare</div><dl class="bb-tiers">' +
      TIERS.map((t, i) => '<dt><span class="bb-tier t-' + t + '">' + t + '</span></dt><dd>' + ui.esc(TIER_INFO[i]) + '</dd>').join('') + '</dl>' +
      '<div class="vh-desc">Biomes</div>' + BIOMES.map((b, i) => '<span title="' + ui.esc(b.about) + '"><i style="background:rgb(' + COL[i].join(',') + ')"></i>' + b.name + '</span>').join('');
    ui.section(dr.body, 'Legend').append(legend);
    ui.section(dr.body, 'How to hunt').append(ui.h('div', 'vh-desc',
      'The map has eight biomes, each with its own instruments; brightness is texture, not value. Where two biomes meet you hear hybrids (uncommon). ' +
      'Small sparkles mark rare patterns. Epic phrases are never drawn: with the Detector on, a faint shimmer hints at them. ' +
      'Gems are tiny points with no mark at all: the Detector ticks faster and its ring glows warmer as you hover closer. Zoom in to make them easier to hit. ' +
      'Each gem lives in a biome that suits it, and the sounds around it take on a little of its character (the map there carries a faint tint of its colour). ' +
      'Drag to scrub, wheel or + / − to zoom, shift- or middle-drag to pan. ★ Save puts any sound into Melody and Spiral.'));
    const toastEl = ui.h('div', 'bb-toast'); toastEl.setAttribute('role', 'status'); el.append(toastEl);
    // act: optional { label, title, fn } adds one button to the toast (the toast stays while hovered or focused).
    function toast(html, cls, ms, act) {
      toastEl.innerHTML = html; toastEl.className = 'bb-toast show ' + (cls || '');
      if (act) {
        const b = ui.h('button', 'vh-btn bb-toast-act'); b.type = 'button'; b.textContent = act.label; if (act.title) b.title = act.title;
        b.addEventListener('click', () => { toastEl.classList.remove('show'); act.fn(); });
        toastEl.append(b);
      }
      clearTimeout(toast.t);
      const hide = () => { if (toastEl.matches(':hover, :focus-within')) toast.t = setTimeout(hide, 800); else toastEl.classList.remove('show'); };
      toast.t = setTimeout(hide, ms || 2600);
    }
    cleanups.push(() => clearTimeout(toast.t));

    // ---------- progressive map render: keep the last finished image (scaled) until the new one is ready ----------
    let shown = null, job = null, markers = [], needDraw = true, ovDirty = false;
    const keyOf = (v) => v.cx + ',' + v.cy + ',' + v.zoom;
    function startJob(n) {
      job = { cx: view.cx, cy: view.cy, zoom: view.zoom, key: keyOf(view), n, j: 0, dep: depthAt(view.zoom),
        rgb: new Uint8ClampedArray(n * n * 4), tier: new Uint8Array(n * n), R: new Float32Array(n * n), E: new Float32Array(n * n),
        halos: [], tint: TINT * clamp01(Math.log2(view.zoom) + 1) };   // zoomed out (< x0.5) a halo would be a dot: no tint
      if (job.tint > 0) job.halos = gemsNear(view.cx, view.cy, span(view.zoom) * 0.71 + HALO_R).map((g) => [g.x, g.y, GEM_COL[g.k]]);
    }
    // Halo tint: a faint wash of the gem's colour, flat over its inner half and with a noisy edge, so it says
    // "something is near" without pointing at the spot.
    const TINT = 0.11;
    function haloTint(J, wx, wy, rgb) {
      for (const [gx, gy, col] of J.halos) {
        const dx = wx - gx, dy = wy - gy, d2 = dx * dx + dy * dy;
        if (d2 > (HALO_R + 0.7) * (HALO_R + 0.7)) continue;   // the edge noise reaches at most 0.65 outward: no hard rim
        const d = Math.sqrt(d2) + 0.9 * (vnoise(wx * 1.4, wy * 1.4, 444) - 0.5) + 0.4 * (vnoise(wx * 3.1, wy * 3.1, 445) - 0.5);
        const t = J.tint * fade(clamp01((1 - d / HALO_R) / 0.5));
        if (t > 0) for (let c = 0; c < 3; c++) rgb[c] += (col[c] - rgb[c]) * t;
      }
    }
    const px3 = [0, 0, 0];
    function stepJob(budget) {
      const J = job, sp = span(J.zoom), t0 = performance.now(), tEnd = t0 + budget, hl = J.halos.length > 0;
      while (J.j < J.n && performance.now() < tEnd) {
        const j = J.j++;
        for (let i = 0; i < J.n; i++) {
          const wx = J.cx + ((i + 0.5) / J.n - 0.5) * sp, wy = J.cy + ((j + 0.5) / J.n - 0.5) * sp, c = cellAt(wx, wy, J.dep);
          const a = COL[c.bi], b = c.w > 0 ? COL[c.b2] : a, w = c.w;
          const L = (0.5 + 0.72 * c.tex) * (c.ei % 3 === 0 ? 1 : c.ei % 3 === 1 ? 0.95 : 1.05), o = j * J.n + i;
          if (hl) {
            px3[0] = a[0] + (b[0] - a[0]) * w; px3[1] = a[1] + (b[1] - a[1]) * w; px3[2] = a[2] + (b[2] - a[2]) * w;
            haloTint(J, wx, wy, px3);
            J.rgb[o * 4] = px3[0] * L; J.rgb[o * 4 + 1] = px3[1] * L; J.rgb[o * 4 + 2] = px3[2] * L;
          } else { J.rgb[o * 4] = (a[0] + (b[0] - a[0]) * w) * L; J.rgb[o * 4 + 1] = (a[1] + (b[1] - a[1]) * w) * L; J.rgb[o * 4 + 2] = (a[2] + (b[2] - a[2]) * w) * L; }
          J.rgb[o * 4 + 3] = 255;
          J.tier[o] = c.tier; J.R[o] = c.R; J.E[o] = c.E;
        }
        stats.rows++;
      }
      stats.jobMs += performance.now() - t0;
      if (J.j < J.n) return;
      const cvs = document.createElement('canvas'); cvs.width = cvs.height = J.n;
      cvs.getContext('2d').putImageData(new ImageData(J.rgb, J.n, J.n), 0, 0);
      J.canvas = cvs; shown = J; job = null; stats.renders++; needDraw = true;
      if (J.n === N) markers = findMarkers(J);
      else startJob(N);
    }
    // Rare sparkles at local peaks of the rare field; epic peaks are kept but only drawn (faintly) with the Detector.
    function findMarkers(J) {
      const n = J.n, sp = span(J.zoom), out = [];
      const peak = (arr, i, j, rad) => {
        const v = arr[j * n + i];
        for (let b = Math.max(0, j - rad); b <= Math.min(n - 1, j + rad); b++) for (let a = Math.max(0, i - rad); a <= Math.min(n - 1, i + rad); a++) {
          const w = arr[b * n + a];
          if (w > v || (w === v && b * n + a < j * n + i)) return false;
        }
        return true;
      };
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const t = J.tier[j * n + i];
        if (t === 2 && peak(J.R, i, j, 8)) out.push({ t, v: J.R[j * n + i] });
        else if (t === 3 && peak(J.E, i, j, 6)) out.push({ t, v: J.E[j * n + i] });
        else continue;
        const m = out[out.length - 1];
        m.x = J.cx + ((i + 0.5) / n - 0.5) * sp; m.y = J.cy + ((j + 0.5) / n - 0.5) * sp; m.ph = hash(i, j, 5) * 6.28;
      }
      return out.sort((a, b) => b.v - a.v).slice(0, 24);
    }

    function label(t, x, y, color) {
      ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left';
      const w = ctx.measureText(t).width;
      x = Math.max(4, Math.min(x, S - w - 6));
      ctx.fillStyle = 'rgba(11,13,18,0.7)'; ctx.fillRect(x - 3, y - 12, w + 6, 16);
      ctx.fillStyle = color || '#d8dce6'; ctx.fillText(t, x, y);
    }
    const zoomStr = () => 'zoom ×' + (view.zoom < 1000 ? view.zoom.toFixed(view.zoom < 10 ? 2 : 0) : view.zoom.toExponential(1));
    const TCOL = ['#c9cfdc', '#9fd8b0', '#8fd0ff', '#d6b4ff', '#ffd76a'];
    const esc = ui.esc;
    const badge = (t) => '<span class="bb-tier t-' + TIERS[t] + '">' + TIERS[t] + '</span>';
    let hoverTxt = '';
    function foundInView() {
      const out = [], r = span() * 0.75;
      for (const g of gemsNear(view.cx, view.cy, r)) if (found[g.id]) out.push(g);
      return out;
    }
    function draw() {
      stats.draws++;
      const k = cv.width / S;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, S, S);
      if (shown) {
        const sp = span(shown.zoom) / span() * S, [x0, y0] = toScreen(shown.cx - span(shown.zoom) / 2, shown.cy - span(shown.zoom) / 2);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(shown.canvas, x0, y0, sp, sp);
      }
      for (const s of savedList()) {
        const [x, y] = toScreen(s.babel.x, s.babel.y);
        if (x < -5 || y < -5 || x > S + 5 || y > S + 5) continue;
        ctx.fillStyle = 'rgba(216,220,230,0.85)'; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const g of foundInView()) {   // found gems are revealed for good
        const [x, y] = toScreen(g.x, g.y);
        ctx.font = '16px system-ui, sans-serif'; ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText('✦', x + 1, y + 1);
        ctx.fillStyle = '#f2d98a'; ctx.fillText('✦', x, y);
        ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = 'rgba(242,217,138,0.85)'; ctx.fillText(GEMS[g.k].name, x, y + 15);
      }
      ctx.textBaseline = 'alphabetic';
      if (current) {
        const [x, y] = toScreen(current.x, current.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 11, 0, 2 * Math.PI); ctx.stroke();
        if (current.kind !== 'gem') label(current.name, x + 14, y > 24 ? y - 10 : y + 26, TCOL[current.tier]);
      }
      label(zoomStr(), 6, S - 8, '#9aa2b5');
      drawCaption();
    }
    function drawCaption() {
      const cur = current ? badge(current.tier) + ' <b>' + esc(current.name) + '</b> · ' + esc(current.biome) + (current.biome2 ? '/' + esc(current.biome2) : '') : '';
      const dt = detector ? ' · detector: ' + (det.c < 0 ? 'nothing nearby' : det.c > 0.75 ? 'hot!' : det.c > 0.4 ? 'warm' : 'cool') : '';
      caption.innerHTML = (cur ? cur + ' · ' : '') + (hoverTxt && !drag ? '<span class="bb-hover">here: ' + esc(hoverTxt) + '</span> · ' : '') + zoomStr() + dt;
    }
    function star(x, y, r) {
      octx.beginPath();
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, q = i % 2 ? r * 0.3 : r; octx.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
      octx.closePath(); octx.fill();
    }
    // ---------- the gem detector (overlay + ticks; never reveals the spot) ----------
    const det = { c: -1, d: Infinity, next: 0, pulses: [], interval: 0, lastCap: '' };
    // Gem compass (unlocked at COMPASS_AT kinds found): direction only, toward the nearest gem of a kind not yet found.
    const COMPASS_AT = 10, COMPASS_R = 8 * G;   // blocks hold all 16 kinds where their biomes allow: one is (almost) always within ~6 G
    const foundKinds = new Set();
    const compass = { key: '', angle: null, gem: null };
    function updateCompass(pr) {
      const on = detector && foundKinds.size >= COMPASS_AT && foundKinds.size < GEMS.length;
      const key = on ? pr[0].toFixed(4) + ',' + pr[1].toFixed(4) + ',' + foundKinds.size : '';
      if (key === compass.key) return;
      compass.key = key; compass.angle = null; compass.gem = null;
      if (!on) return;
      const g = gemsNear(pr[0], pr[1], COMPASS_R, (x) => foundKinds.has(x.k))[0];
      if (g) { compass.gem = g; compass.angle = Math.atan2(g.y - pr[1], g.x - pr[0]); }
    }
    let probe = null;   // world point of the last hover / touch
    function detect(now) {
      if (!detector) { det.c = -1; det.pulses.length = 0; return; }
      const pr = probe || [view.cx, view.cy], range = span(), hit = hitR();
      const g = gemsNear(pr[0], pr[1], range, (x) => !!found[x.id])[0];
      det.d = g ? g.d : Infinity;
      det.c = g ? clamp01(1 - Math.log(Math.max(g.d, hit) / hit) / Math.log(range / hit)) : -1;
      if (det.c >= 0) {
        det.interval = 1.2 * (0.06 / 1.2) ** det.c;
        if (now >= det.next) {
          det.next = now + det.interval * 1000;
          det.pulses.push({ t: now, c: det.c });
          if (det.pulses.length > 12) det.pulses.shift();
          tick(det.c);
        }
      } else det.interval = 0;
      const capKey = det.c < 0 ? 'n' : det.c > 0.75 ? 'h' : det.c > 0.4 ? 'w' : 'c';
      if (capKey !== det.lastCap) { det.lastCap = capKey; drawCaption(); }
    }
    let tickBuf = null;
    function tick(c) {
      const a = VH.audio.ctx;
      stats.ticks++;
      if (!a || !soundOn || a.state !== 'running') return;
      if (!tickBuf || tickBuf.sampleRate !== a.sampleRate) {
        const n = Math.round(a.sampleRate * 0.03);
        tickBuf = a.createBuffer(1, n, a.sampleRate);
        const d = tickBuf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.sin(TAU * 1400 * i / a.sampleRate) * Math.exp(-i / (a.sampleRate * 0.006));
      }
      const s = a.createBufferSource(), g = a.createGain();
      s.buffer = tickBuf; s.playbackRate.value = 0.7 + 0.9 * c; g.gain.value = 0.12 + 0.3 * c;
      s.connect(g); g.connect(VH.audio.out); s.start();
    }
    function drawOverlay(t) {
      const k = ov.width / S;
      if (ovDirty) { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, ov.width, ov.height); ovDirty = false; }
      octx.setTransform(k, 0, 0, k, 0, 0);
      const ts = t / 1000;
      for (const m of markers) {
        if (m.t === 3 && !detector) continue;   // epic phrases stay invisible without the detector
        const [x, y] = toScreen(m.x, m.y);
        if (x < -12 || y < -12 || x > S + 12 || y > S + 12) continue;
        ovDirty = true;
        const tw = 0.5 + 0.5 * Math.sin(ts * 1.4 + m.ph);
        if (m.t === 2) { octx.globalAlpha = 0.2 + 0.5 * tw * tw; octx.fillStyle = '#eef3ff'; star(x, y, 3.6 * (0.75 + 0.25 * tw)); }
        else {
          const r = 12 + 5 * tw, gr = octx.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, 'rgba(236,214,255,0.3)'); gr.addColorStop(1, 'rgba(214,180,255,0)');
          octx.globalAlpha = 0.4 + 0.6 * tw; octx.fillStyle = gr; octx.beginPath(); octx.arc(x, y, r, 0, TAU); octx.fill();
        }
      }
      octx.globalAlpha = 1;
      if (detector) {
        const pr = probe || [view.cx, view.cy], [x, y] = toScreen(pr[0], pr[1]), c = Math.max(0, det.c);
        updateCompass(pr);
        if (compass.angle != null) {   // faint arrowhead on the ring's edge; no distance cue
          const a = compass.angle, ca = Math.cos(a), sa = Math.sin(a), tip = 31, base = 18, w = 3.6;
          octx.fillStyle = 'rgba(242,217,138,' + (0.42 + 0.1 * Math.sin(t / 700)).toFixed(3) + ')';
          octx.beginPath();
          octx.moveTo(x + ca * tip, y + sa * tip);
          octx.lineTo(x + ca * base - sa * w, y + sa * base + ca * w);
          octx.lineTo(x + ca * base + sa * w, y + sa * base - ca * w);
          octx.closePath(); octx.fill();
          octx.strokeStyle = 'rgba(11,13,18,0.35)'; octx.lineWidth = 1; octx.stroke();
        }
        const col = det.c < 0 ? '154,162,181' : Math.round(111 + 144 * c) + ',' + Math.round(163 + 40 * c) + ',' + Math.round(255 - 150 * c);
        ovDirty = true;
        octx.lineWidth = 1.5;
        octx.strokeStyle = 'rgba(' + col + ',' + (det.c < 0 ? 0.25 : 0.35 + 0.5 * c) + ')';
        octx.beginPath(); octx.arc(x, y, 16, 0, TAU); octx.stroke();
        for (const p of det.pulses) {
          const age = (t - p.t) / 650;
          if (age > 1) continue;
          octx.strokeStyle = 'rgba(' + col + ',' + ((0.15 + 0.6 * p.c) * (1 - age)).toFixed(3) + ')';
          octx.beginPath(); octx.arc(x, y, 16 + 26 * age, 0, TAU); octx.stroke();
        }
      }
      stats.overlay++;
    }

    let raf = 0, anim = null, lastKey = '', hoverPx = null, hoverKey = '';
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (anim) {
        const e = Math.min(1, (t - anim.t0) / 220), q = e * e * (3 - 2 * e);
        view.zoom = anim.from * (anim.to / anim.from) ** q;
        if (e >= 1) { anim = null; saveView(); }
      }
      const key = keyOf(view);
      if (key !== lastKey) { lastKey = key; needDraw = true; }
      const want = shown && shown.key === key && shown.n === N;
      if (!want && (!job || job.key !== key)) {
        const off = !shown || Math.abs(Math.log2(shown.zoom / view.zoom)) > 1 || Math.hypot(shown.cx - view.cx, shown.cy - view.cy) > 0.3 * span();
        if (!anim || !shown) startJob(off ? 48 : N);
      }
      if (job && !(anim && shown)) stepJob(shown ? 9 : 60);
      if (hoverPx && hoverPx.join() + key !== hoverKey) {   // biome name under the cursor (cheap: one cell lookup)
        hoverKey = hoverPx.join() + key;
        const [wx, wy] = toWorld(hoverPx[0], hoverPx[1]), c = cellAt(wx, wy, depthAt(view.zoom));
        hoverTxt = BIOMES[c.bi].name + (c.w > 0.15 ? ' / ' + BIOMES[c.b2].name : '') + ' · ' + BIOMES[c.bi].eng[c.ei];
        drawCaption();
      }
      if (needDraw) { needDraw = false; draw(); }
      detect(t);
      drawOverlay(t);
    }
    cleanups.push(ui.fit(box, (w, h) => {
      S = Math.max(200, Math.min(900, w, h));
      for (const c of [cv, ov]) { c.width = c.height = Math.round(S * ui.dpr()); c.style.width = c.style.height = S + 'px'; }
      wrap.style.width = wrap.style.height = S + 'px';
      needDraw = true; ovDirty = true;
    }));

    // ---------- audio: rendered buffers on the shared context ----------
    const voices = [];
    function killAll() { while (voices.length) voices[0].stop(0.04); }
    let playSeq = 0;
    function playSound(p) {
      const actx = VH.audio.ctx;
      if (!actx || !soundOn) return;
      const seq = ++playSeq, d = render(p, actx.sampleRate);
      if (d && typeof d.then === 'function') { d.then((x) => { if (alive && seq === playSeq) playData(x, actx); }); return; }
      playData(d, actx);
    }
    function playData(d, actx) {
      if (!d || !soundOn) return;
      while (voices.length >= 6) voices[0].stop(0.04);
      const buf = actx.createBuffer(1, d.length, actx.sampleRate);
      buf.copyToChannel(d, 0);
      const src = actx.createBufferSource(), g = actx.createGain();
      src.buffer = buf; g.gain.value = PLAY_GAIN; src.connect(g); g.connect(VH.audio.out);
      const t0 = actx.currentTime + 0.005;
      src.start(t0);
      let done = false;
      const v = VH.audio.track({
        stop(rel) {
          if (done) return;
          done = true;
          const t = actx.currentTime, r = rel || 0.04;
          g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + r);
          try { src.stop(t + r + 0.01); } catch (_) { /* already stopped */ }
          const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1);
          VH.audio.retire(v, t + r + 0.01);
        },
      });
      voices.push(v);
      src.onended = () => {
        if (done) return;
        done = true;
        const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1);
        VH.audio.retire(v, 0);
      };
    }

    // ---------- play a point ----------
    function showParams(p) {
      nickEl.innerHTML = badge(p.tier) + ' <span></span>';
      nickEl.lastChild.textContent = p.kind === 'gem' ? '✦ ' + p.name : p.name;
      whereEl.textContent = TIER_INFO[p.tier] + '.';
      const rows = [];
      if (p.kind === 'gem') rows.push(['Gem', GEMS[p.gem].riddle], ['Found', Object.values(found).filter((f) => f.k === p.gem).length + ' of this kind']);
      else {
        rows.push(['Biome', p.biome + (p.biome2 ? ' + ' + p.biome2 + ' (' + Math.round(p.w * 100) + ' %)' : '')]);
        rows.push(['Engine', p.eng.label + ': ' + p.eng.info(p.q)]);
        if (p.eng2) rows.push(['Blend', p.eng2.label + ': ' + p.eng2.info(p.q2)]);
        rows.push(['Pitch', p.f.toFixed(0) + ' Hz ' + noteName(p.f)]);
        if (p.tier === 2) rows.push(['Pattern', p.pat.type + (p.pat.type !== 'echo motif' ? ' · ' + CHORDS[p.pat.chord][0] : '') + ' · step ' + Math.round(p.pat.step * 1000) + ' ms']);
        if (p.tier === 3) rows.push(['Phrase', SCALES[p.pat.scale][0] + ' · ' + Math.round(60 / p.pat.step) + ' bpm']);
        if (p.halo) rows.push(['Aura', (p.halo.w > 0.6 ? 'a strong' : p.halo.w > 0.25 ? 'a clear' : 'a faint') + ' trace of something rare colours this sound', 'bb-aura']);
      }
      rows.push(['At', '(' + p.x.toFixed(4) + ', ' + p.y.toFixed(4) + ')']);
      ptab.innerHTML = rows.map(([a, b, cls]) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + esc(a) + '</td><td>' + esc(b) + '</td></tr>').join('');
    }
    function gemHit(ax, ay, bx, by) {   // the first gem within the hit radius of the segment a-b
      const r = hitR(), mx = (ax + bx) / 2, my = (ay + by) / 2, half = Math.hypot(bx - ax, by - ay) / 2 + r;
      for (const g of gemsNear(mx, my, half)) if (segDist(g.x, g.y, ax, ay, bx, by) <= r) return g;
      return null;
    }
    function playAt(wx, wy, zoom, from) {
      const g = gemHit(from ? from[0] : wx, from ? from[1] : wy, wx, wy);
      if (g) return playGem(g);
      const p = describe(wx, wy, zoom || view.zoom);
      current = p;
      showParams(p); playSound(p); needDraw = true;
      if (p.tier >= 2) discover(p);
      return p;
    }
    function playGem(g, quiet) {
      const p = gemDesc(g), gm = GEMS[g.k];
      current = p; needDraw = true;
      const first = !found[g.id], newKind = !Object.values(found).some((f) => f.k === g.k);
      if (first) {
        found[g.id] = { k: g.k, x: g.x, y: g.y, t: Date.now() };
        if (VH.track) VH.track('gem-found');
        VH.store.set('babel.gems', { v: 4, found });
        renderGems();
      }
      showParams(p); playSound(p);
      if (!quiet && first) {
        const n = new Set(Object.values(found).map((f) => f.k)).size;
        toast('✦ <b>Gem found: ' + esc(gm.name) + '</b> ' + (newKind ? '(' + n + '/' + GEMS.length + ')' : '(you already had one)') + '<br><span class="bb-sub">' + esc(gm.riddle) + '</span>', 'legendary', 4500);
      }
      return p;
    }
    const saveView = () => VH.store.set('babel.view', view);
    function zoomAnim(k) {
      const to = Math.max(0.05, Math.min(1e9, (anim ? anim.to : view.zoom) * k));
      anim = { from: view.zoom, to, t0: performance.now() };
    }
    function dive() {
      VH.audio.ensure();
      let best = null;
      for (let i = 0; i < 4000; i++) {
        const x = (Math.random() - 0.5) * 400, y = (Math.random() - 0.5) * 400;
        if (cellAt(x, y, depthAt(3)).tier === 2) { best = [x, y]; break; }
      }
      if (!best) return;
      anim = null; view.cx = best[0]; view.cy = best[1]; view.zoom = 3; saveView();
      probe = best.slice();
      playAt(best[0], best[1]);
    }
    function gemTarget(meta) {   // a saved gem sound -> the nearest gem of its kind (older saves predate the v4 layout)
      const k = GEMS.findIndex((g) => g.id === meta.gem), g = k >= 0 ? nearestOfKind(k, meta.x, meta.y) : null;
      return g ? { x: g.x, y: g.y, zoom: Math.max(4, meta.zoom || 4), gid: g.id } : { x: meta.x, y: meta.y, zoom: meta.zoom };
    }
    function goTo(d) {
      VH.audio.ensure(); anim = null;
      view.cx = d.x; view.cy = d.y; view.zoom = d.zoom || view.zoom; saveView();
      probe = [d.x, d.y];
      if (d.gid) { const [ci, cj] = d.gid.split(',').map(Number); return playGem(gemAt(ci, cj), true); }
      return playAt(d.x, d.y, d.zoom);
    }

    // ---------- discoveries (rare + epic) ----------
    function discover(p) {
      const near = 12 * span() / N;
      if (disc.some((d) => d.name === p.name && d.tier === p.tier && Math.hypot(d.x - p.x, d.y - p.y) < Math.max(near, span(d.zoom) * 3 / N))) return;
      disc.unshift({ v: 3, x: p.x, y: p.y, zoom: p.zoom, tier: p.tier, name: p.name, t: Date.now() });
      if (disc.length > 80) disc.length = 80;
      VH.store.set('babel.disc', disc); renderDisc();
      if (p.tier === 3) toast('Epic: <b>' + esc(p.name) + '</b><br><span class="bb-sub">a hidden phrase, never drawn on the map</span>', 'epic', 3500);
      else toast('Rare: <b>' + esc(p.name) + '</b><br><span class="bb-sub">a pattern sound</span>', 'rare', 2200);
    }
    function row(parent, html, btns) {
      const r = ui.h('div', 'bb-item', '<span class="bb-item-t">' + html + '</span>');
      for (const [lab, title, fn] of btns) {
        const b = ui.h('button', 'vh-btn bb-mini'); b.type = 'button'; b.textContent = lab; b.title = title; b.setAttribute('aria-label', title);
        b.addEventListener('click', fn); r.append(b);
      }
      parent.append(r);
    }
    function renderDisc() {
      discEl.innerHTML = disc.length ? '' : '<div class="vh-desc">Play a rare pattern or an epic phrase to log it here.</div>';
      for (const d of disc) row(discEl, badge(d.tier) + ' ' + esc(d.name), [
        ['▶', 'Replay ' + d.name, () => { VH.audio.ensure(); playSound(describe(d.x, d.y, d.zoom)); }],
        ['Go', 'Go there', () => goTo(d)],
      ]);
    }
    function renderGems() {
      const byKind = {};
      for (const [gid, f] of Object.entries(found)) if (!byKind[f.k] || f.t < byKind[f.k].t) byKind[f.k] = Object.assign({ gid }, f);
      const n = Object.keys(byKind).length;
      gemHead.textContent = 'Gems ' + n + '/' + GEMS.length;
      foundKinds.clear(); for (const k of Object.keys(byKind)) foundKinds.add(+k);
      compassNote.hidden = !(n >= COMPASS_AT && n < GEMS.length);
      gemGrid.innerHTML = '';
      for (const gm of GEMS) {
        const f = byKind[gm.k], tile = ui.h('div', 'bb-gem' + (f ? ' found' : ''));
        if (f) {
          tile.innerHTML = '<button type="button" class="bb-gem-play"><span class="g"></span><span class="n"></span></button><button type="button" class="vh-btn bb-mini">Go</button>';
          tile.querySelector('.g').textContent = gm.glyph; tile.querySelector('.n').textContent = gm.name;
          const pb = tile.firstChild, gb = tile.lastChild;
          pb.title = 'Replay ' + gm.name; pb.setAttribute('aria-label', 'Replay ' + gm.name);
          gb.title = 'Go to ' + gm.name; gb.setAttribute('aria-label', 'Go to ' + gm.name);
          pb.addEventListener('click', () => { VH.audio.ensure(); const [ci, cj] = f.gid.split(',').map(Number); const p = gemDesc(gemAt(ci, cj)); current = p; showParams(p); playSound(p); needDraw = true; });
          gb.addEventListener('click', () => goTo({ x: f.x, y: f.y, zoom: Math.max(4, view.zoom), gid: f.gid }));
        } else {
          tile.innerHTML = '<span class="g">?</span><span class="n"></span>';
          tile.querySelector('.n').textContent = gm.riddle;
          tile.title = 'Not found yet: ' + gm.riddle;
        }
        gemGrid.append(tile);
      }
      needDraw = true;
    }

    // ---------- save to library ----------
    const savedList = () => VH.sounds.list().filter((s) => s.source === 'babel' && s.babel && typeof s.babel.x === 'number');
    function renderSaved() {
      const all = VH.sounds.list().filter((s) => s.source === 'babel');
      savedEl.innerHTML = all.length ? '' : '<div class="vh-desc">★ Save a sound to use it in Melody and Spiral.</div>';
      for (const s of all) {
        const t = s.babel ? TIERS.indexOf(s.babel.tier) : -1;
        row(savedEl, (t >= 0 ? badge(t) + ' ' : '') + esc(s.name) + ' <span class="vh-desc">' + (s.kind === 'sampler' ? 'sample' : 'synth') + '</span>', [
          ['▶', 'Play ' + s.name, () => {
            VH.audio.ensure();
            const go = () => VH.audio.trigger(s, s.rootHz || 220, 3, { gain: 0.5 });
            if (s.kind === 'sampler') VH.sounds.prepare(s.id).then(() => { if (alive) go(); }); else go();
          }],
          ...(s.babel && typeof s.babel.x === 'number' ? [['Go', 'Go there', () => goTo(s.babel.gem ? gemTarget(s.babel) : s.babel)]] : []),
          ['→ Melody', 'Use in Melody: ' + s.name, () => useInMelody(s.id)],
          ['✕', 'Delete ' + s.name, () => {
            VH.sounds.remove(s.id);
            if (s.kind === 'sampler') s.sampler.zones.forEach((z) => z.blobKey && VH.store.delBlob(z.blobKey).catch(() => {}));
          }],
        ]);
      }
      needDraw = true;
    }
    cleanups.push(VH.sounds.onChange(renderSaved));
    const form = ui.h('form', 'bb-save', '<input type="text" maxlength="40" aria-label="Sound name"><button class="vh-btn" type="submit">Save</button><button class="vh-btn" type="button" aria-label="Cancel">✕</button>');
    form.hidden = true; el.append(form);
    const nameIn = form.querySelector('input');
    let saveP = null;
    function openSave() {
      if (!current) { toast('Tap the map to pick a sound first.'); return; }
      saveP = current;
      const n = VH.sounds.list().filter((s) => s.source === 'babel').length + 1, nm = current.name;
      nameIn.value = (nm[0].toUpperCase() + nm.slice(1)).slice(0, 34) + (current.kind === 'gem' ? '' : ' #' + n);
      form.hidden = false; nameIn.focus(); nameIn.select();
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const p = saveP, name = nameIn.value.trim() || p.name;
      form.hidden = true;
      toast('Saving…', '', 8000);
      saveToLibrary(p, name).then((s) => {
        if (alive) toast('★ Saved “' + esc(s.name) + '”. Find it under Your sounds in Melody and Spiral.', 'saved', 7000,
          { label: 'Use in Melody', title: 'Open Melody with this sound', fn: () => useInMelody(s.id) });
      }, (err) => { if (alive) toast('Could not save: ' + esc(err && err.message), '', 3500); });
    });
    form.lastChild.addEventListener('click', () => { form.hidden = true; });
    // Cross-experiment inbox (Melody consumes it): append, never overwrite.
    function useInMelody(soundId) {
      const cur = VH.store.get('melody.inbox', []);
      VH.store.set('melody.inbox', (Array.isArray(cur) ? cur : []).concat([{ type: 'sound', soundId }]));
      location.hash = '#melody';
    }
    const onKey = (e) => {   // + / − zoom (not while typing)
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || (e.target && /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
      if (e.key === '+' || e.key === '=') zoomAnim(2); else if (e.key === '-' || e.key === '_') zoomAnim(1 / 2); else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    cleanups.push(() => window.removeEventListener('keydown', onKey));
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); form.hidden = true; } });

    // ---------- pointer: click / scrub / pan, hover, wheel zoom ----------
    const cellOf = (px, py) => Math.floor(px / S * N) + ',' + Math.floor(py / S * N);
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * S / r.width, (e.clientY - r.top) * S / r.height]; };
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      VH.audio.ensure();
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const [px, py] = pos(e);
      if (e.shiftKey || e.button === 1) { drag = { pan: true, px, py, cx: view.cx, cy: view.cy }; cv.style.cursor = 'grabbing'; return; }
      if (e.button !== 0) return;
      const w = toWorld(px, py);
      probe = w; hoverPx = null; hoverTxt = '';
      drag = { pan: false, cell: cellOf(px, py), t: performance.now(), last: w };
      playAt(w[0], w[1]);
    });
    cv.addEventListener('pointermove', (e) => {
      const [px, py] = pos(e);
      if (!drag) {
        if (e.pointerType === 'mouse') { hoverPx = [clamp(px, 0, S), clamp(py, 0, S)]; probe = toWorld(hoverPx[0], hoverPx[1]); }
        return;
      }
      if (drag.pan) { view.cx = drag.cx - (px - drag.px) / S * span(); view.cy = drag.cy - (py - drag.py) / S * span(); return; }
      const w = toWorld(clamp(px, 0, S), clamp(py, 0, S));
      probe = w;
      const g = gemHit(drag.last[0], drag.last[1], w[0], w[1]);
      drag.last = w;
      const cell = cellOf(px, py), now = performance.now();
      if (g && (!current || current.gid !== g.id)) { drag.cell = cell; drag.t = now; playGem(g); return; }
      if (cell !== drag.cell && now - drag.t >= 90) { drag.cell = cell; drag.t = now; playAt(w[0], w[1]); }
    });
    const endDrag = () => { if (drag && drag.pan) saveView(); drag = null; cv.style.cursor = 'crosshair'; };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
    cv.addEventListener('pointerleave', () => { hoverPx = null; hoverKey = ''; if (hoverTxt) { hoverTxt = ''; drawCaption(); } });
    cv.addEventListener('auxclick', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      anim = null;
      const [px, py] = pos(e), [wx, wy] = toWorld(px, py);
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      view.zoom = clamp(view.zoom * Math.exp(-clamp(dy, -600, 600) * 0.0015), 0.05, 1e9);
      view.cx = wx - (px / S - 0.5) * span(); view.cy = wy - (py / S - 0.5) * span();
      saveView();
    }, { passive: false });
    // Safari sends a trackpad (and touch) pinch as gesturestart / gesturechange with a scale, not as Ctrl + wheel;
    // unhandled, it zooms the whole page. Zoom the map around the pinch instead. (Other browsers never fire these.)
    {
      let gs = 1;
      const gest = (e) => {
        e.preventDefault();
        if (!(e.scale > 0)) return;
        if (e.type === 'gesturechange') {
          anim = null;
          const [px, py] = pos(e), [wx, wy] = toWorld(px, py);
          view.zoom = clamp(view.zoom * e.scale / gs, 0.05, 1e9);
          view.cx = wx - (px / S - 0.5) * span(); view.cy = wy - (py / S - 0.5) * span();
          saveView();
        }
        gs = e.type === 'gesturestart' ? 1 : e.scale;
      };
      ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => cv.addEventListener(t, gest));
    }

    renderDisc(); renderSaved(); renderGems();
    raf = requestAnimationFrame(frame);
    return {
      destroy() {
        alive = false; cancelAnimationFrame(raf); raf = 0; killAll();
        timers.forEach(clearTimeout); timers.clear(); cleanups.forEach((f) => f());
      },
      get current() { return current; },
      view, dive, playAt, playGem, goTo, later, drawer: dr, found, det,
      get detector() { return detector; },
      get compass() { if (!detector) return { angle: null, gem: null, kinds: foundKinds.size }; return { angle: compass.angle, gem: compass.gem && { id: compass.gem.id, k: compass.gem.k, x: compass.gem.x, y: compass.gem.y }, kinds: foundKinds.size }; },
      get markers() { return markers; },
      get probe() { return probe; }, set probe(v) { probe = v; },
      get shownKey() { return shown && shown.n === N ? shown.key : ''; },
      hitR,
    };
  }

  VH.babel = {
    PLAY_GAIN,
    describe, paramsAt, cellAt, depthAt, renderSync, render: renderAsync, saveToLibrary, events,
    BIOMES, ENG, GEMS, TIERS, TIER_INFO, gemAt, gemsNear, G, stats,
    GEM_BIOMES, GEM_IN, GEM_DEPTH, HALO_R, haloAt, nearestOfKind, migrateFound,
    get current() { return inst && inst.current; }, get inst() { return inst; },
  };
  // keys format (VH.ui.shortcuts): '+' joins a combo, ' / ' separates alternatives.
  const SHORTCUTS = [
    { keys: 'Click', label: 'Hear the sound at that point' },
    { keys: 'Drag', label: 'Scrub across the map' },
    { keys: 'Wheel', label: 'Zoom around the cursor' },
    { keys: '= / −', label: 'Zoom in / out (the + key works too)' },
    { keys: 'Shift+Drag / Middle-drag', label: 'Pan the map' },
    { keys: 'Enter', label: 'Save, in the ★ Save name box' },
    { keys: 'Esc', label: 'Close the Save box or Settings' },
  ];
  if (ui.shortcuts && typeof ui.shortcuts.register === 'function') ui.shortcuts.register('babel', SHORTCUTS);
  VH.registerExperiment({
    id: 'babel', title: 'Babel', icon: '✺', shortcuts: SHORTCUTS,
    hint: 'Every point is a sound, in eight biomes. Sixteen Gems are hidden and never drawn: turn on the Detector and follow the ticks.',
    mount(el) { inst = create(el); },
    unmount() { if (inst) inst.destroy(); inst = null; },
  });
})();
