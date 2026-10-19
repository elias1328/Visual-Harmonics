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
  function pitchACF(frame, sr) {
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
    if (best < 0 || bestV <= 0.2) return 0;
    let pick = best;   // earliest local max that is nearly as strong (avoids octave-down errors)
    for (let l = minL + 1; l < maxL; l++) {
      const v = acf(l);
      if (v >= 0.9 * bestV && v >= acf(l - 1) && v >= acf(l + 1)) { pick = l; break; }
    }
    const a = acf(pick - 1), b = acf(pick), c = acf(pick + 1), den = a - 2 * b + c;
    const off = den ? 0.5 * (a - c) / den : 0;
    return sr / (pick + Math.max(-0.5, Math.min(0.5, off)));
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

  const api = { fromSamples, fromBuffer, fft, findLoop, bakeLoopFade };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.VH = root.VH || {}).analyze = api;
})(this);
