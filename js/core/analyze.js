// analyze.js - pitch + spectrum of a recorded sound (no DOM).
// fromSamples(float32, sampleRate) / fromBuffer(audioBuffer) -> { rootHz, spectrum: [[ratio, amp], ...] }
// Browser: window.VH.analyze. Node: module.exports (fromSamples only needs plain arrays).
(function (root) {
  'use strict';
  const MAXP = 16;

  // In-place iterative radix-2 FFT. re/im: Float64Array of length 2^k.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const p = i + k, q = p + len / 2;
          const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const pow2below = (n) => 2 ** Math.floor(Math.log2(Math.max(2, n)));

  // Pick an analysis frame: skip the attack (first ~8 %), then take up to 2^15 samples.
  function frameOf(x) {
    const N = Math.min(32768, pow2below(x.length));
    const start = Math.max(0, Math.min(x.length - N, Math.floor(x.length * 0.08)));
    return Float64Array.from({ length: N }, (_, i) => x[start + i]);
  }

  // Pitch by normalized autocorrelation (computed via FFT), first strong peak, parabolic refinement.
  function pitchACF(frame, sr) { return acfPitch(frame, sr).hz; }
  // -> { hz, conf }: conf = the normalized autocorrelation at the picked period (0..1; noise ~0, a clean tone ~1).
  function acfPitch(frame, sr) {
    const N = frame.length, M = N * 2, re = new Float64Array(M), im = new Float64Array(M);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += frame[i];
    mean /= N;
    for (let i = 0; i < N; i++) re[i] = frame[i] - mean;
    fft(re, im);
    for (let i = 0; i < M; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im);   // real & even -> forward FFT == inverse up to scale
    const r0 = re[0] || 1, acf = (l) => re[l] / r0 / (1 - l / N);   // unbiased
    const minL = Math.floor(sr / 2000), maxL = Math.min(N / 2, Math.ceil(sr / 30));
    let best = -1, bestV = -Infinity;
    for (let l = minL + 1; l < maxL; l++) { const v = acf(l); if (v > bestV) { bestV = v; best = l; } }
    if (best < 0 || bestV <= 0.2) return { hz: 0, conf: Math.max(0, bestV) };
    let pick = best;   // earliest local max that is nearly as strong (avoids octave-down errors)
    for (let l = minL + 1; l < maxL; l++) {
      const v = acf(l);
      if (v >= 0.9 * bestV && v >= acf(l - 1) && v >= acf(l + 1)) { pick = l; break; }
    }
    const a = acf(pick - 1), b = acf(pick), c = acf(pick + 1), den = a - 2 * b + c;
    const off = den ? 0.5 * (a - c) / den : 0;
    return { hz: sr / (pick + Math.max(-0.5, Math.min(0.5, off))), conf: Math.min(1, b) };
  }

  // Hann-windowed magnitude spectrum, zero-padded x2.
  function magSpectrum(frame) {
    const N = frame.length, M = N * 2, re = new Float64Array(M), im = new Float64Array(M);
    for (let i = 0; i < N; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    const mag = new Float64Array(M / 2);
    for (let i = 0; i < M / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  // Local maxima with parabolic (log-magnitude) interpolation -> [{ hz, a }].
  function peaks(mag, binHz, floor) {
    const out = [];
    for (let i = 2; i < mag.length - 1; i++) {
      const b = mag[i];
      if (b < floor || b < mag[i - 1] || b < mag[i + 1]) continue;
      const la = Math.log(mag[i - 1] + 1e-12), lb = Math.log(b + 1e-12), lc = Math.log(mag[i + 1] + 1e-12);
      const den = la - 2 * lb + lc, off = den ? 0.5 * (la - lc) / den : 0;
      out.push({ hz: (i + off) * binHz, a: Math.exp(lb - 0.25 * (la - lc) * off) });
    }
    return out;
  }

  function fromSamples(x, sampleRate) {
    const empty = { rootHz: 0, spectrum: [[1, 1]] };
    if (!x || x.length < 512 || !(sampleRate > 0)) return empty;
    const frame = frameOf(x);
    let rootHz = pitchACF(frame, sampleRate);
    const mag = magSpectrum(frame), binHz = sampleRate / (mag.length * 2);
    let max = 0;
    for (let i = 1; i < mag.length; i++) if (mag[i] > max) max = mag[i];
    if (!max) return empty;
    const pk = peaks(mag, binHz, max * 0.003);
    if (!(rootHz > 0) && pk.length) rootHz = pk.reduce((a, b) => (b.a > a.a ? b : a)).hz;   // no clear period: loudest peak
    if (!(rootHz > 0)) return empty;
    // Refine the root with a nearby spectral peak (FFT resolution beats ACF at low pitch).
    const near = pk.filter((p) => Math.abs(p.hz / rootHz - 1) < 0.03 && p.a > max * 0.05);
    if (near.length) rootHz = near.reduce((a, b) => (b.a > a.a ? b : a)).hz;
    // Harmonic slots: strongest peak within ±3 % of k * root (allows mild stretch).
    const used = new Set(), parts = [];
    for (let k = 1; k <= 32 && k * rootHz < sampleRate / 2; k++) {
      let best = null;
      for (const p of pk) if (!used.has(p) && Math.abs(p.hz / (k * rootHz) - 1) < 0.03 && (!best || p.a > best.a)) best = p;
      if (best && best.a > max * 0.01) { used.add(best); parts.push([best.hz / rootHz, best.a]); }
    }
    // Non-harmonic peaks: strong ones that no harmonic slot claimed (bells, glass, drums).
    for (const p of pk) if (!used.has(p) && p.a > max * 0.08 && p.hz / rootHz >= 0.5) parts.push([p.hz / rootHz, p.a]);
    parts.sort((a, b) => b[1] - a[1]);
    const top = parts.slice(0, MAXP), amax = top.reduce((m, p) => Math.max(m, p[1]), 0) || 1;
    const spectrum = top.map(([r, a]) => [Math.round(r * 10000) / 10000, Math.round(a / amax * 10000) / 10000])
      .sort((a, b) => a[0] - b[0]);
    return { rootHz, spectrum };
  }

  function fromBuffer(buf) {
    const n = buf.length, ch = buf.numberOfChannels, mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    return fromSamples(mono, buf.sampleRate);
  }

  // ---------- loop points ----------
  // findLoop(x, sr, { rootHz, minLen, maxLen }) -> { start, end, loopStart, loopEnd, seam, match, rms } | null
  // Picks a sustain region (after the attack, before the fade), then searches pairs of rising zero
  // crossings ~whole periods apart that minimise the waveform mismatch around the seam.
  // start/end are sample indices: playback runs [start, end) and then jumps back to start, so the
  // seam jump is |x[end] - x[start]| (the deviation from the natural continuation), reported / RMS.
  function findLoop(x, sr, opts) {
    const o = opts || {}, n = x ? x.length : 0;
    if (n < 2048 || !(sr > 0)) return null;
    const minLen = Math.round((o.minLen ?? 0.25) * sr), maxLen = Math.round((o.maxLen ?? 2.5) * sr);
    const fr = Math.max(64, Math.round(sr * 0.02)), nf = Math.floor(n / fr), env = new Float64Array(nf);
    let peak = 0;
    for (let i = 0; i < nf; i++) {
      let s = 0;
      for (let k = i * fr; k < (i + 1) * fr; k++) s += x[k] * x[k];
      env[i] = Math.sqrt(s / fr); if (env[i] > peak) peak = env[i];
    }
    if (!(peak > 1e-5)) return null;
    const envAt = (i) => env[Math.max(0, Math.min(nf - 1, Math.floor(i / fr)))];
    // Sustain region: from where the level first reaches hi*peak (+ settle) to the last frame above lo*peak.
    let a = 0, b = 0;
    for (const [hi, lo] of [[0.6, 0.5], [0.45, 0.3], [0.3, 0.15]]) {
      let fa = 0; while (fa < nf && env[fa] < hi * peak) fa++;
      let fb = nf - 1; while (fb > fa && env[fb] < lo * peak) fb--;
      a = Math.min((fa + 4) * fr, n - 1); b = Math.max(a, (fb - 2) * fr);
      if (b - a >= minLen * 1.3) break;
    }
    const P = o.rootHz > 0 ? sr / o.rootHz : 0;
    const w = Math.max(32, Math.min(1024, Math.round(P || sr / 200)));
    a = Math.max(a, w + 1); b = Math.min(b, n - w - 2);
    if (b - a < 8 * w) return null;
    const minL = Math.min(minLen, Math.floor((b - a) * 0.6)), maxL = Math.min(maxLen, b - a);
    let rs = 0;
    for (let i = a; i < b; i++) rs += x[i] * x[i];
    const rms = Math.sqrt(rs / (b - a)) || 1e-9, r2 = rms * rms;
    const zc = [];
    for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) zc.push(i);
    if (zc.length < 4) return null;
    const startZ = zc.filter((i) => i <= a + (b - a) * 0.4), step = Math.max(1, Math.floor(startZ.length / 30));
    let best = null;
    for (let si = 0; si < startZ.length; si += step) {
      const s = startZ[si];
      for (const e of zc) {
        const L = e - s;
        if (L < minL) continue;
        if (L > maxL) break;
        const seam = Math.abs(x[e] - x[s]) / rms;
        let d = 0;
        for (let k = -w; k < w; k++) { const q = x[s + k] - x[e + k]; d += q * q; }
        const match = d / (2 * w * r2), envMis = Math.abs(envAt(s) - envAt(e)) / rms;
        const slope = Math.abs((x[e] - x[e - 1]) - (x[s] - x[s - 1])) / rms;
        const score = match + 2 * envMis + 5 * seam + slope - 0.05 * L / maxL;
        if (!best || score < best.score) best = { start: s, end: e, seam, match, score };
      }
    }
    if (!best) return null;
    return { start: best.start, end: best.end, loopStart: best.start / sr, loopEnd: best.end / sr,
      seam: best.seam, match: best.match, rms };
  }

  // Crossfade the material just before `end` into the material just before `start` (in place), so a
  // loop [start, end) is seamless even when the waveforms only roughly match. n = fade length in samples.
  function bakeLoopFade(x, start, end, n) {
    n = Math.min(n, start, Math.floor((end - start) / 4));
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n, e = end - n + i, s = start - n + i;
      x[e] = x[e] * (1 - t) + x[s] * t;
    }
    return n;
  }


  // ---------- imported sounds (VH.ui import dialog; Node-testable) ----------
  // RMS envelope in hops of `hop` seconds.
  function envelope(x, sr, hop) {
    const n = Math.max(1, Math.round((hop || 0.01) * sr)), m = Math.max(1, Math.floor(x.length / n)), e = new Float32Array(m);
    for (let i = 0; i < m; i++) { let s = 0; for (let k = i * n, z = Math.min(x.length, k + n); k < z; k++) s += x[k] * x[k]; e[i] = Math.sqrt(s / n); }
    return e;
  }
  // Envelope shape: { peakT, attack, decay (s from the peak until -20 dB, or to the end), sustain (median level of the
  // body after the peak, relative to the peak), dur (until the level stays below -26 dB), percussive }.
  function envStats(x, sr) {
    const hop = 0.01, e = envelope(x, sr, hop);
    let ip = 0;
    for (let i = 1; i < e.length; i++) if (e[i] > e[ip]) ip = i;
    const pk = e[ip] || 1e-9;
    let id = ip; while (id < e.length && e[id] >= pk * 0.1) id++;
    let ie = e.length - 1; while (ie > ip && e[ie] < pk * 0.05) ie--;
    const a = Math.min(ie, ip + Math.round(0.15 / hop)), b = Math.max(a + 1, Math.round(ip + (ie - ip) * 0.8));
    const body = Array.from(e.slice(a, b)).sort((p, q) => p - q), sustain = body.length ? body[Math.floor(body.length / 2)] / pk : 0;
    const decay = (id - ip) * hop, dur = (ie + 1) * hop;
    return { peakT: ip * hop, attack: ip * hop, decay, sustain, dur, percussive: decay < 0.5 || sustain < 0.3 };
  }
  // The steady part of a sound: after the attack settles, while the level stays >= 30 % of the peak (>= 2048 samples
  // when possible). -> [a, b) sample indices.
  function sustainRange(x, sr) {
    const hop = 0.01, e = envelope(x, sr, hop), n = Math.round(hop * sr);
    let ip = 0;
    for (let i = 1; i < e.length; i++) if (e[i] > e[ip]) ip = i;
    const pk = e[ip] || 1e-9;
    let ia = ip + Math.max(3, Math.round(0.04 / hop));
    let ib = ia; while (ib < e.length && e[ib] >= pk * 0.3) ib++;
    let a = Math.min(x.length, ia * n), b = Math.min(x.length, ib * n);
    if (b - a < 4096) { a = Math.min(ip * n, Math.max(0, x.length - 4096)); b = Math.min(x.length, a + Math.max(4096, b - a)); }
    return [a, b];
  }
  // Spectral centroid (Hz) of the first ~0.2 s from the peak: kick-like sounds are low, hats high.
  function centroid(x, sr) {
    const e = envelope(x, sr, 0.005);
    let ip = 0;
    for (let i = 1; i < e.length; i++) if (e[i] > e[ip]) ip = i;
    const a = Math.max(0, ip * Math.round(0.005 * sr) - Math.round(0.005 * sr)), N = Math.min(8192, pow2below(Math.max(512, Math.min(x.length - a, sr * 0.2))));
    const fr = Float64Array.from({ length: N }, (_, i) => x[a + i] || 0), mag = magSpectrum(fr), binHz = sr / (mag.length * 2);
    let s = 0, w = 0;
    for (let i = 1; i < mag.length; i++) { const p = mag[i] * mag[i]; s += p * i * binHz; w += p; }
    return w > 0 ? s / w : 0;
  }
  // Full analysis of an imported recording (mono samples):
  // { rootHz, rootMidi, conf, pitched, play: 'glide'|'hit', drum, spectrum (from the sustain portion), loop | null, env, centroid }
  const MIN_CONF = 0.5;
  function analyzeImport(x, sr) {
    const env = envStats(x, sr), [a, b] = sustainRange(x, sr), seg = x.subarray ? x.subarray(a, b) : x.slice(a, b);
    const fr = frameOf(seg.length >= 512 ? seg : x), ap = acfPitch(fr, sr);
    const an = fromSamples(seg.length >= 512 ? seg : x, sr);
    const pitched = ap.conf >= MIN_CONF && an.rootHz > 0;
    const rootHz = pitched ? an.rootHz : 0, play = env.percussive ? 'hit' : 'glide';
    let loop = null;
    if (play === 'glide' && pitched) {
      const L = findLoop(x, sr, { rootHz, minLen: 0.2, maxLen: Math.min(2.5, x.length / sr * 0.6) });
      if (L) loop = { loopStart: L.loopStart, loopEnd: L.loopEnd, seam: L.seam, match: L.match };
    }
    return { rootHz, rootMidi: rootHz > 0 ? 69 + 12 * Math.log2(rootHz / 440) : 60, conf: ap.conf, pitched, play,
      drum: !pitched, spectrum: pitched ? an.spectrum : [[1, 1]], loop, env, centroid: centroid(x, sr) };
  }
  // Drum kit from candidate sounds [{ id, decay, sustain, centroid, ... }]: the most percussive ones (fast decay, little
  // sustain; sustained sounds only when nothing percussive is there) up to `max`, ordered low to high by spectral
  // centroid (kick-like first, hat-like last).
  function kitPick(items, max) {
    const score = (s) => (s.decay > 0 ? s.decay : 9) + 2 * (s.sustain || 0), ok = (items || []).filter((s) => s && isFinite(s.centroid));
    const perc = ok.filter((s) => (s.sustain || 0) < 0.4 && s.decay < 1.5);
    return (perc.length ? perc : ok).slice().sort((p, q) => score(p) - score(q)).slice(0, max || 8).sort((p, q) => p.centroid - q.centroid);
  }
  // Mono mix of an AudioBuffer (first `maxSec` seconds).
  function monoOf(buf, maxSec) {
    const n = Math.min(buf.length, maxSec ? Math.round(maxSec * buf.sampleRate) : buf.length), ch = buf.numberOfChannels, mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    return mono;
  }

  // ---------- backing tracks (Melody "Import backing track"): tempo, beat phase, harmonic partials, chords, key ----------
  // Pure + Node-testable. The browser drives track.analyze(...) (async, yields between chunks, reports progress); the
  // grid-dependent part (track.grid) is cheap, so tempo / phase corrections re-run only that.
  const TRACK_SR = 11025;
  // Two cascaded biquad low-passes (Butterworth, 4th order) at fc, then decimation to ~TRACK_SR.
  function downsample(x, sr, target) {
    target = target || TRACK_SR;
    const f = Math.max(1, Math.round(sr / target));
    if (f === 1) return { y: Float32Array.from(x), sr };
    const fc = 0.42 * sr / f, w = 2 * Math.PI * fc / sr, cw = Math.cos(w), sw = Math.sin(w);
    let y = x;
    for (const Q of [0.5412, 1.3066]) {
      const al = sw / (2 * Q), a0 = 1 + al, b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
      const o = new Float32Array(y.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) { const v = y[i], r = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = r; o[i] = r; }
      y = o;
    }
    const n = Math.floor(y.length / f), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i * f];
    return { y: out, sr: sr / f };
  }
  const hannOf = (N) => Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  // Onset strength: positive spectral flux of log magnitudes (N 512, hop 64 at ~11 kHz), minus a local mean, rectified.
  // Frame i is at time (i * hop + N / 2) / sr + ONSET_BIAS (the flux peaks a little before the attack reaches the centre).
  const ONSET_BIAS = 0.015;
  function onsetEnv(y, sr, o) {
    o = o || {};
    const N = o.N || 512, hop = o.hop || 64, nf = Math.max(0, Math.floor((y.length - N) / hop) + 1), w = hannOf(N);
    const env = new Float32Array(nf), re = new Float64Array(N), im = new Float64Array(N), K = N / 2;
    let prev = new Float64Array(K), cur = new Float64Array(K);
    const from = o.from || 0, to = Math.min(nf, o.to == null ? nf : o.to);
    if (o.state) prev = o.state;
    for (let i = from; i < to; i++) {
      const a = i * hop;
      for (let k = 0; k < N; k++) { re[k] = y[a + k] * w[k]; im[k] = 0; }
      fft(re, im);
      let s = 0;
      for (let k = 1; k < K; k++) { const m = Math.log(1 + 20 * Math.hypot(re[k], im[k])); cur[k] = m; const d = m - prev[k]; if (d > 0) s += d; }
      env[i] = i ? s : 0;
      const t = prev; prev = cur; cur = t;
    }
    return { env, fps: sr / hop, t0: N / 2 / sr + ONSET_BIAS, hop, N, state: prev };
  }
  function onsetNorm(env, fps) {   // subtract a ~0.25 s moving mean, half-wave rectify, scale to max 1
    const n = env.length, h = Math.max(1, Math.round(0.125 * fps)), out = new Float32Array(n);
    let s = 0, c = 0, mx = 0;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); const v = env[i] - (pre[b] - pre[a]) / (b - a); out[i] = v > 0 ? v : 0; if (out[i] > mx) mx = out[i]; }
    void s; void c;
    if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;
    return out;
  }
  const lerpAt = (a, x) => { const i = Math.floor(x); if (i < 0 || i >= a.length - 1) return 0; const u = x - i; return a[i] * (1 - u) + a[i + 1] * u; };
  // Tempo (60..180 BPM) + beat phase from an onset envelope. Autocorrelation with a weak log-tempo prior picks the
  // period, then a comb search (period +-4 %, every phase) refines period and phase together.
  // -> { bpm, period (s), phase (s, first beat time >= 0), conf, cands: [{ bpm, s }] }
  function tempoOf(envRaw, fps, t0, o) {
    o = o || {};
    const env = onsetNorm(envRaw, fps), n = env.length, lo = o.lo || 60, hi = o.hi || 180;
    const lMin = Math.floor(60 * fps / hi) - 1, lMax = Math.ceil(60 * fps / lo) + 1;
    if (n < lMax * 2) return { bpm: 0, period: 0, phase: 0, conf: 0, cands: [] };
    const acf = new Float64Array(lMax + 2);
    let mean = 0; for (let i = 0; i < n; i++) mean += env[i]; mean /= n;
    for (let l = Math.max(1, lMin - 1); l <= lMax + 1; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += (env[i] - mean) * (env[i + l] - mean); acf[l] = s / (n - l); }
    const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
    const cands = [];
    for (let l = Math.max(2, lMin); l <= lMax; l++) {
      if (acf[l] <= 0 || acf[l] < acf[l - 1] || acf[l] < acf[l + 1]) continue;
      const a = acf[l - 1], b = acf[l], c = acf[l + 1], den = a - 2 * b + c, off = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      const bpm = 60 * fps / (l + off);
      if (bpm < lo - 1 || bpm > hi + 1) continue;
      cands.push({ bpm, s: b * prior(bpm) });
    }
    cands.sort((p, q) => q.s - p.s);
    if (!cands.length) return { bpm: 0, period: 0, phase: 0, conf: 0, cands };
    const comb = (P) => {   // P in frames -> best phase (frames) and its mean onset value
      let best = -1, bp = 0;
      const steps = Math.ceil(P);
      for (let p = 0; p < steps; p++) {
        let s = 0, k = 0;
        for (let x = p; x < n - 1; x += P) { s += lerpAt(env, x); k++; }
        s /= k || 1;
        if (s > best) { best = s; bp = p; }
      }
      // sub-frame phase: parabola through the neighbours
      const sc = (p) => { let s = 0, k = 0; for (let x = p; x < n - 1; x += P) { if (x >= 0) { s += lerpAt(env, x); k++; } } return s / (k || 1); };
      const a = sc(bp - 0.5), b = sc(bp), c = sc(bp + 0.5), den = a - 2 * b + c, off = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) * 0.5 : 0;
      return { s: best, p: bp + off };
    };
    // a few strong candidates (and their x2 / /2 when in range), each refined by the comb
    const tries = [];
    cands.slice(0, 3).forEach((c) => [c.bpm, c.bpm * 2, c.bpm / 2].forEach((b) => { if (b >= lo - 1 && b <= hi + 1 && !tries.some((t) => Math.abs(t / b - 1) < 0.03)) tries.push(b); }));
    let best = null;
    for (const b0 of tries) {
      let bb = null;
      for (let r = -0.04; r <= 0.04 + 1e-9; r += 0.002) {
        const bpm = b0 * (1 + r), P = 60 * fps / bpm, cb = comb(P);
        if (!bb || cb.s > bb.s) bb = { bpm, P, s: cb.s, p: cb.p };
      }
      for (let r = -0.002; r <= 0.002 + 1e-9; r += 0.0002) {   // fine
        const bpm = bb.bpm * (1 + r), P = 60 * fps / bpm, cb = comb(P);
        if (cb.s > bb.s) bb = { bpm, P, s: cb.s, p: cb.p, fine: true };
      }
      const sc = bb.s * prior(bb.bpm);
      if (!best || sc > best.sc) best = Object.assign(bb, { sc });
    }
    const period = 60 / best.bpm;
    let phase = best.p / fps + t0;
    phase = ((phase % period) + period) % period;
    return { bpm: best.bpm, period, phase, conf: Math.min(1, best.s / (mean * 3 + 1e-9) / 3), cands: cands.slice(0, 5) };
  }
  // Sliding median of 9 (or len) values.
  const MB = new Float64Array(64);
  function median(a, len) {   // insertion sort into a scratch buffer (len is small)
    for (let i = 0; i < len; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && MB[j] > v) { MB[j + 1] = MB[j]; j--; } MB[j + 1] = v; }
    return MB[len >> 1];
  }
  // Harmonic frames: STFT (N 4096, hop 512 at ~11 kHz) up to maxHz, harmonic / percussive separation by median
  // filtering (time median = harmonic, frequency median = percussive, soft mask H^2 / (H^2 + P^2)), then per frame the
  // strongest harmonic peaks (parabolic, <= 32) and a peak chroma. Incremental: call with { from, to } chunks.
  const FR_N = 4096, FR_HOP = 512, FR_PK = 32, MED = 9;
  function harmonicFrames(y, sr, o) {
    o = o || {};
    const N = FR_N, hop = FR_HOP, nf = Math.max(0, Math.floor((y.length - N) / hop) + 1), binHz = sr / N, maxHz = o.maxHz || 4000;
    const K = Math.min(N / 2 - 1, Math.floor(maxHz / binHz)), w = hannOf(N), half = MED >> 1;
    const st = o.st || { mags: new Map(), out: 0, pk: new Float32Array(nf * FR_PK * 2), chroma: new Float32Array(nf * 12), nf };
    const re = new Float64Array(N), im = new Float64Array(N), tmp = new Float64Array(Math.max(MED, 2 * half + 1));
    const magAt = (i) => {
      i = Math.max(0, Math.min(nf - 1, i));
      let m = st.mags.get(i);
      if (m) return m;
      const a = i * hop; m = new Float32Array(K);
      for (let k = 0; k < N; k++) { re[k] = (y[a + k] || 0) * w[k]; im[k] = 0; }
      fft(re, im);
      for (let k = 0; k < K; k++) m[k] = Math.hypot(re[k], im[k]) / (N / 4);
      st.mags.set(i, m);
      return m;
    };
    const emit = (t) => {
      const R = []; for (let j = -half; j <= half; j++) R.push(magAt(t + j));
      const X = R[half], H = new Float32Array(K), L = R.length;
      for (let k = 0; k < K; k++) {   // harmonic: median over time; percussive: median over frequency
        for (let j = 0; j < L; j++) tmp[j] = R[j][k];
        const h = median(tmp, L);
        const a = Math.max(0, k - half), b = Math.min(K, k + half + 1), m = b - a;
        for (let j = 0; j < m; j++) tmp[j] = X[a + j];
        const pp = median(tmp, m), h2 = h * h, p2 = pp * pp;
        H[k] = X[k] * (h2 + p2 > 0 ? h2 / (h2 + p2) : 0);
      }
      let mx = 0;
      for (let k = 0; k < K; k++) if (H[k] > mx) mx = H[k];
      const pks = [];
      if (mx > 1e-6) {
        const floor = mx * 0.004, k0 = Math.max(2, Math.floor(35 / binHz));
        for (let k = k0; k < K - 1; k++) {
          const b = H[k];
          if (b < floor || b < H[k - 1] || b < H[k + 1]) continue;
          const la = Math.log(H[k - 1] + 1e-12), lb = Math.log(b + 1e-12), lc = Math.log(H[k + 1] + 1e-12), den = la - 2 * lb + lc, off = den ? 0.5 * (la - lc) / den : 0;
          pks.push([(k + off) * binHz, Math.exp(lb - 0.25 * (la - lc) * off)]);
        }
        pks.sort((p, q) => q[1] - p[1]);
      }
      const base = t * FR_PK * 2, cb = t * 12;
      for (let j = 0; j < Math.min(FR_PK, pks.length); j++) { st.pk[base + 2 * j] = pks[j][0]; st.pk[base + 2 * j + 1] = pks[j][1]; }
      for (const [f, a] of pks) if (f >= 40 && f <= 2100) { const pc = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12; st.chroma[cb + pc] += Math.sqrt(a); }
    };
    const to = Math.min(nf, o.to == null ? nf : o.to);
    while (st.out < to) { emit(st.out); st.mags.delete(st.out - half); st.out++; }
    st.fps = sr / hop; st.t0 = N / 2 / sr; st.done = st.out >= nf;
    return st;
  }
  // Partials of the frames in [t0, t1) seconds: their peaks accumulated (power) on an 1/8-semitone grid, then the
  // strongest maxima (parabolic, <= max) -> [[hz, amp 0..1], ...] sorted by hz.
  const HB = 8, HLO = 30, HN = Math.ceil(Math.log2(4400 / HLO) * 12 * HB);
  function partialsIn(fr, t0, t1, max) {
    const a = Math.max(0, Math.ceil((t0 - fr.t0) * fr.fps)), b = Math.min(fr.nf - 1, Math.floor((t1 - fr.t0) * fr.fps - 1e-9));
    const hist = new Float64Array(HN + 2);
    let cnt = 0;
    for (let i = a; i <= b; i++) {
      cnt++;
      for (let j = 0; j < FR_PK; j++) {
        const f = fr.pk[(i * FR_PK + j) * 2], am = fr.pk[(i * FR_PK + j) * 2 + 1];
        if (!(f > HLO)) continue;
        const x = Math.log2(f / HLO) * 12 * HB, k = Math.floor(x), u = x - k, p = am * am;
        if (k >= 0 && k < HN) { hist[k] += p * (1 - u); hist[k + 1] += p * u; }
      }
    }
    if (!cnt) return [];
    const pk = [];
    for (let k = 1; k <= HN; k++) {
      const v = hist[k];
      if (v <= 0 || v < hist[k - 1] || v < hist[k + 1]) continue;
      const la = Math.sqrt(hist[k - 1]), lb = Math.sqrt(v), lc = Math.sqrt(hist[k + 1]), den = la - 2 * lb + lc, off = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (la - lc) / den)) : 0;
      pk.push([HLO * 2 ** ((k + off) / 12 / HB), Math.sqrt(v / cnt)]);
    }
    pk.sort((p, q) => q[1] - p[1]);
    const top = pk.slice(0, max || 24), mx = top.length ? top[0][1] : 1;
    return top.filter((p) => p[1] >= mx * 0.02).map((p) => [p[0], p[1] / mx]).sort((p, q) => p[0] - q[0]);
  }
  // ---------- chords + key ----------
  const CHORD_IV = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };
  const CHORD_PRIOR = { maj: 1, min: 1, '7': 0.93, m7: 0.93, maj7: 0.9, sus2: 0.86, sus4: 0.86, dim: 0.86, aug: 0.8 };
  const CHORD_Q = Object.keys(CHORD_IV);
  function chordTemplate(root, q) { const t = new Float64Array(12); CHORD_IV[q].forEach((iv, j) => { t[(root + iv) % 12] = j ? 1 : 1.15; }); return t; }
  const TEMPL = [];
  for (const q of CHORD_Q) for (let r = 0; r < 12; r++) { const t = chordTemplate(r, q); let n = 0; for (const v of t) n += v * v; TEMPL.push({ r, q, t, n: Math.sqrt(n), pr: CHORD_PRIOR[q] }); }
  // Scores of every chord for a chroma vector (cosine x prior) -> [{ r, q, s }] (TEMPL order).
  function chordScores(c) {
    let cn = 0; for (let i = 0; i < 12; i++) cn += c[i] * c[i]; cn = Math.sqrt(cn) || 1;
    return TEMPL.map((T) => { let d = 0; for (let i = 0; i < 12; i++) d += c[i] * T.t[i]; return { r: T.r, q: T.q, s: d / cn / T.n * T.pr }; });
  }
  function matchChord(c) { return chordScores(c).reduce((a, b) => (b.s > a.s ? b : a)); }
  // Smoothed chord sequence over beat chromas (Viterbi: score - change penalty) -> [[root, q] | null per beat].
  function chordSeq(chromas, penalty) {
    const n = chromas.length, S = TEMPL.length, pen = penalty == null ? 0.12 : penalty;
    if (!n) return [];
    const sc = chromas.map((c) => chordScores(c).map((x) => x.s)), back = [];
    let v = sc[0].slice();
    for (let t = 1; t < n; t++) {
      let bi = 0; for (let j = 1; j < S; j++) if (v[j] > v[bi]) bi = j;
      const nv = new Array(S), bk = new Int16Array(S);
      for (let j = 0; j < S; j++) { const stay = v[j], sw = v[bi] - pen; if (stay >= sw) { nv[j] = stay + sc[t][j]; bk[j] = j; } else { nv[j] = sw + sc[t][j]; bk[j] = bi; } }
      v = nv; back.push(bk);
    }
    let j = 0; for (let k = 1; k < S; k++) if (v[k] > v[j]) j = k;
    const out = new Array(n);
    for (let t = n - 1; t >= 0; t--) {
      const e = chromas[t].reduce((s, x) => s + x, 0);
      out[t] = e > 1e-9 ? [TEMPL[j].r, TEMPL[j].q] : null;
      if (t) j = back[t - 1][j];
    }
    return out;
  }
  // Krumhansl-Kessler key profiles; key = the best Pearson correlation with the chroma -> { root, mode, r, all }.
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function pearson(a, b) {
    let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12;
    let s = 0, sa = 0, sb = 0; for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
    return sa && sb ? s / Math.sqrt(sa * sb) : 0;
  }
  // o.tonic: optional [root, q] of the first chord (a song usually starts on its tonic): +0.15 for the matching key (settles relative major / minor).
  function keyOf(chroma, o) {
    const all = [];
    for (let r = 0; r < 12; r++) for (const [mode, P] of [['major', KK_MAJ], ['minor', KK_MIN]]) {
      const rot = Array.from({ length: 12 }, (_, i) => P[(i - r + 12) % 12]);
      let s = pearson(chroma, rot);
      const t = o && o.tonic;
      if (t && t[0] === r && ((mode === 'major') === (t[1] === 'maj' || t[1] === '7' || t[1] === 'maj7'))) s += 0.15;
      all.push({ root: r, mode, r: s });
    }
    all.sort((p, q) => q.r - p.r);
    return Object.assign({}, all[0], { all: all.slice(0, 4) });
  }
  // ---------- the grid: beats, half-beat partial slots, beat chroma, downbeat, chords per bar, key ----------
  // fr = harmonicFrames state; bpm + phase (first beat >= 0, s); o = { dur, beatsPerBar (4), downbeat (index 0..3 | null = detect) }
  function trackGrid(fr, bpm, phase, o) {
    o = o || {};
    const T = 60 / bpm, dur = o.dur || (fr.nf / fr.fps + fr.t0), bpb = o.beatsPerBar || 4;
    const nb = Math.max(1, Math.ceil((dur - phase) / T)), chromas = [];
    for (let b = 0; b < nb; b++) {
      const t0 = phase + b * T, t1 = t0 + T, c = new Float64Array(12);
      const a = Math.max(0, Math.ceil((t0 - fr.t0) * fr.fps)), z = Math.min(fr.nf - 1, Math.floor((t1 - fr.t0) * fr.fps - 1e-9));
      for (let i = a; i <= z; i++) for (let k = 0; k < 12; k++) c[k] += fr.chroma[i * 12 + k];
      chromas.push(c);
    }
    const seq = chordSeq(chromas);
    // downbeat: the beat position (mod bpb) where the harmony changes most (chroma novelty + chord changes)
    let db = o.downbeat;
    if (db == null) {
      const sc = new Float64Array(bpb), cos = (p, q) => { let d = 0, a = 0, b = 0; for (let k = 0; k < 12; k++) { d += p[k] * q[k]; a += p[k] * p[k]; b += q[k] * q[k]; } return a && b ? d / Math.sqrt(a * b) : 1; };
      for (let b = 1; b < nb; b++) {
        const ch = seq[b] && seq[b - 1] && (seq[b][0] !== seq[b - 1][0] || seq[b][1] !== seq[b - 1][1]) ? 1 : 0;
        sc[b % bpb] += (1 - cos(chromas[b], chromas[b - 1])) + 0.5 * ch;
      }
      db = 0; for (let k = 1; k < bpb; k++) if (sc[k] > sc[db] + 1e-9) db = k;
    }
    const first = phase + db * T, barSec = bpb * T;
    let nBars = Math.max(1, Math.ceil((dur - first - 0.5 * T) / barSec));
    {   // drop trailing bars that only hold a fade-out (harmonic energy < 12 % of the median bar)
      const en = []; for (let k = 0; k < nBars; k++) { let s = 0; for (let j = 0; j < bpb; j++) { const c = chromas[db + k * bpb + j]; if (c) for (let q = 0; q < 12; q++) s += c[q]; } en.push(s); }
      const med = en.slice().sort((p, q) => p - q)[en.length >> 1] || 0;
      while (nBars > 1 && en[nBars - 1] < 0.12 * med) nBars--;
    }
    // chords per bar: the beats' majority; a bar whose halves differ (each half one chord, >= 2 beats) is split
    const key = (c) => (c ? c[0] + c[1] : '-');
    const bars = [];
    for (let k = 0; k < nBars; k++) {
      const bs = []; for (let j = 0; j < bpb; j++) { const b = db + k * bpb + j; bs.push(b < nb ? seq[b] : null); }
      const count = (arr) => { const m = new Map(); arr.forEach((c) => { if (c) m.set(key(c), (m.get(key(c)) || { c, n: 0 })); if (c) m.get(key(c)).n++; }); return [...m.values()].sort((p, q) => q.n - p.n); };
      const all = count(bs), h = bpb >> 1, A = count(bs.slice(0, h)), B = count(bs.slice(h));
      if (A.length && B.length && A[0].n === h && B[0].n === bpb - h && key(A[0].c) !== key(B[0].c) && h >= 2) bars.push([{ at: 0, c: A[0].c }, { at: h, c: B[0].c }]);
      else bars.push([{ at: 0, c: all.length ? all[0].c : null }]);
    }
    const tot = new Float64Array(12);
    chromas.forEach((c) => { let s = 0; for (let k = 0; k < 12; k++) s += c[k]; if (s > 0) for (let k = 0; k < 12; k++) tot[k] += c[k] / s; });
    const tonic = bars.length && bars[0][0].c ? bars[0][0].c : null, K = keyOf(tot, { tonic });
    return { bpm, period: T, phase, downbeat: db, first, barSec, nBars, beats: nb, seq, bars, key: { root: K.root, mode: K.mode, r: K.r } };
  }
  // Partial slots (half a beat each) from the track's first downbeat: slotsOf(fr, bpm, first, dur) -> { t0, dt, n, hz, a }
  // (Float32Array n * 24 each, hz 0 = unused).
  function trackSlots(fr, bpm, first, dur, max) {
    max = max || 24;
    const dt = 30 / bpm, t0 = first - Math.ceil(first / dt) * dt, n = Math.max(1, Math.ceil((dur - t0) / dt));
    const hz = new Float32Array(n * max), a = new Float32Array(n * max);
    for (let s = 0; s < n; s++) {
      const p = partialsIn(fr, t0 + s * dt, t0 + (s + 1) * dt, max);
      p.forEach(([f, v], j) => { hz[s * max + j] = f; a[s * max + j] = v; });
    }
    return { t0, dt, n, max, hz, a };
  }
  // Waveform overview: peak |x| per `res` seconds.
  function waveOf(x, sr, res) {
    const h = Math.max(1, Math.round((res || 0.01) * sr)), n = Math.ceil(x.length / h), w = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let k = i * h, z = Math.min(x.length, k + h); k < z; k++) { const v = Math.abs(x[k]); if (v > m) m = v; } w[i] = m; }
    return w;
  }
  // Full analysis of a mono track (async; yields every ~40 ms). onProgress(f 0..1, label). -> { dur, sr, tempo, frames, wave, onset }
  async function analyzeTrack(x, sr, o) {
    o = o || {};
    const prog = o.onProgress || (() => {}), pause = o.yield || (() => new Promise((r) => setTimeout(r, 0)));
    const isAlive = o.isAlive || (() => true);
    let tl = Date.now();
    const maybe = async () => { if (Date.now() - tl > 40) { await pause(); tl = Date.now(); if (!isAlive()) throw new Error('cancelled'); } };
    prog(0, 'Preparing'); await maybe();
    const { y, sr: r2 } = downsample(x, sr);
    const dur = x.length / sr;
    prog(0.05, 'Finding the beat');
    const N = 512, hop = 64, nf = Math.max(0, Math.floor((y.length - N) / hop) + 1);
    let on = null, state = null;
    const env = new Float32Array(nf);
    for (let i = 0; i < nf; i += 2000) {
      on = onsetEnv(y, r2, { from: i, to: i + 2000, state });
      env.set(on.env.subarray(i, Math.min(nf, i + 2000)), i); state = on.state;
      prog(0.05 + 0.2 * i / Math.max(1, nf), 'Finding the beat'); await maybe();
    }
    const tempo = tempoOf(env, r2 / hop, N / 2 / r2 + ONSET_BIAS);
    prog(0.3, 'Separating harmony from drums'); await maybe();
    const nh = Math.max(0, Math.floor((y.length - FR_N) / FR_HOP) + 1);
    let st = null;
    for (let i = 0; i <= nh; i += 24) {
      st = harmonicFrames(y, r2, { st, to: Math.min(nh, i + 24) });
      prog(0.3 + 0.65 * Math.min(1, i / Math.max(1, nh)), 'Reading the harmony'); await maybe();
    }
    if (!st.done) st = harmonicFrames(y, r2, { st });
    const frames = { fps: st.fps, t0: st.t0, nf: st.nf, pk: st.pk, chroma: st.chroma };
    prog(0.97, 'Chords'); await maybe();
    const wave = waveOf(x, sr, 0.01);
    prog(1, 'Done');
    return { dur, tempo, frames, wave, waveRes: 0.01, onset: { env, fps: r2 / hop, t0: N / 2 / r2 + ONSET_BIAS } };
  }
  const track = { SR: TRACK_SR, downsample, onsetEnv, onsetNorm, tempoOf, harmonicFrames, partialsIn, chordScores, matchChord, chordSeq, chordTemplate,
    keyOf, grid: trackGrid, slots: trackSlots, waveOf, analyze: analyzeTrack, CHORD_IV, CHORD_Q, ONSET_BIAS, FR_PK };

  const api = { fromSamples, fromBuffer, fft, findLoop, bakeLoopFade, acfPitch, envelope, envStats, sustainRange, centroid, analyzeImport, kitPick, monoOf, MIN_CONF, track };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.VH = root.VH || {}).analyze = api;
})(this);
