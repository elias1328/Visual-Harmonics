// harmony.js - pure harmony math (no DOM). Browser: window.VH.harmony (+ window.Harmony for prototypes/). Node: module.exports.
(function (root) {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToHz(m) { return 440 * 2 ** ((m - 69) / 12); }

  function noteName(m) { return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

  function partials(f, n = 6) {
    const out = [];
    for (let k = 1; k <= n; k++) out.push({ f: f * k, a: 0.88 ** (k - 1) });
    return out;
  }

  // Sethares / Plomp-Levelt dissonance of two pure tones.
  function pairDissonance(f1, a1, f2, a2) {
    const fmin = Math.min(f1, f2);
    const s = 0.24 / (0.0207 * fmin + 18.96);
    const x = s * Math.abs(f2 - f1);
    return Math.min(a1, a2) * (Math.exp(-3.5 * x) - Math.exp(-5.75 * x));
  }

  // Sum over partial pairs that belong to different notes.
  function dissonance(freqs, n = 6) {
    if (!freqs || freqs.length < 2) return 0;
    const ps = freqs.map((f) => partials(f, n));
    let d = 0;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++)
        for (const a of ps[i]) for (const b of ps[j]) d += pairDissonance(a.f, a.a, b.f, b.a);
    return d;
  }

  // Like dissonance(), but every note uses the given spectrum [[ratio, amp], ...] (a Sound's `spectrum`).
  // Sums pairDissonance over partials of *different* notes only.
  function dissonanceSpectra(freqs, spectrum) {
    if (!freqs || freqs.length < 2 || !spectrum || !spectrum.length) return 0;
    let d = 0;
    for (let i = 0; i < freqs.length; i++)
      for (let j = i + 1; j < freqs.length; j++) {
        const fi = freqs[i], fj = freqs[j];
        for (const [ri, ai] of spectrum) for (const [rj, aj] of spectrum) d += pairDissonance(fi * ri, ai, fj * rj, aj);
      }
    return d;
  }

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }

  function reduceRatio(p, q) { const g = gcd(p, q) || 1; return [p / g, q / g]; }

  // Simplest fraction (smallest p*q) with q <= maxDen within tolCents of r, or null.
  function nearestRatio(r, maxDen = 32, tolCents = 15) {
    if (!(r > 0)) return null;
    let best = null;
    for (let q = 1; q <= maxDen; q++) {
      const p0 = Math.round(r * q);
      for (const p of [p0 - 1, p0, p0 + 1]) {
        if (p < 1 || gcd(p, q) !== 1) continue;
        const cents = 1200 * Math.log2(r / (p / q));
        if (Math.abs(cents) > tolCents) continue;
        if (!best || p * q < best.p * best.q) best = { p, q, cents };
      }
    }
    return best;
  }

  function tenneyHeight(p, q) { const [a, b] = reduceRatio(p, q); return Math.log2(a * b); }

  function octaveReduce(r) {
    if (!(r > 0)) return NaN;
    while (r >= 2) r /= 2;
    while (r < 1) r *= 2;
    return r;
  }

  // Reduced fractions p/q in [lo, hi] with q <= maxDen; r = Ford circle radius.
  function fordCircles(maxDen, lo = 1, hi = 2) {
    const out = [];
    for (let q = 1; q <= maxDen; q++) {
      for (let p = Math.ceil(lo * q - 1e-9); p <= Math.floor(hi * q + 1e-9); p++) {
        if (p < 1 || gcd(p, q) !== 1) continue;
        out.push({ p, q, x: p / q, r: 1 / (2 * q * q) });
      }
    }
    return out;
  }

  const api = { midiToHz, noteName, partials, pairDissonance, dissonance, dissonanceSpectra, reduceRatio,
    nearestRatio, tenneyHeight, octaveReduce, fordCircles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Harmony = api; (root.VH = root.VH || {}).harmony = api; }
})(this);
