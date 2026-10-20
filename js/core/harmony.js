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


  // ---------- scales, modes and tunings (pure; Melody's key = root + scale, per section; tuning per song) ----------
  // steps = semitones above the root. 'major' / 'minor' keep their old ids (Ionian / Aeolian) so old songs load unchanged.
  const SCALES = [
    { id: 'major', name: 'Major (Ionian)', group: 'Common', steps: [0, 2, 4, 5, 7, 9, 11], hint: 'bright, settled, happy' },
    { id: 'minor', name: 'Natural minor (Aeolian)', group: 'Common', steps: [0, 2, 3, 5, 7, 8, 10], hint: 'sad, serious' },
    { id: 'harmonicMinor', name: 'Harmonic minor', group: 'Common', steps: [0, 2, 3, 5, 7, 8, 11], hint: 'minor with a strong pull home, classical' },
    { id: 'melodicMinor', name: 'Melodic minor', group: 'Common', steps: [0, 2, 3, 5, 7, 9, 11], hint: 'smooth, jazzy minor' },
    { id: 'majPent', name: 'Major pentatonic', group: 'Common', steps: [0, 2, 4, 7, 9], hint: 'open and folky, hard to go wrong' },
    { id: 'minPent', name: 'Minor pentatonic', group: 'Common', steps: [0, 3, 5, 7, 10], hint: 'rock and blues riffs' },
    { id: 'blues', name: 'Blues', group: 'Common', steps: [0, 3, 5, 6, 7, 10], hint: 'minor pentatonic plus the blue note' },
    { id: 'dorian', name: 'Dorian', group: 'Modes', steps: [0, 2, 3, 5, 7, 9, 10], hint: 'minor but hopeful' },
    { id: 'phrygian', name: 'Phrygian', group: 'Modes', steps: [0, 1, 3, 5, 7, 8, 10], hint: 'dark, Spanish / metal' },
    { id: 'lydian', name: 'Lydian', group: 'Modes', steps: [0, 2, 4, 6, 7, 9, 11], hint: 'dreamy, floating, film music' },
    { id: 'mixolydian', name: 'Mixolydian', group: 'Modes', steps: [0, 2, 4, 5, 7, 9, 10], hint: 'major with a bluesy rock edge' },
    { id: 'locrian', name: 'Locrian', group: 'Modes', steps: [0, 1, 3, 5, 6, 8, 10], hint: 'unstable and eerie' },
    { id: 'wholeTone', name: 'Whole-tone', group: 'Exotic', steps: [0, 2, 4, 6, 8, 10], hint: 'weightless, dream sequence' },
    { id: 'diminished', name: 'Diminished (half-whole)', group: 'Exotic', steps: [0, 1, 3, 4, 6, 7, 9, 10], hint: 'tense and symmetric, jazz / suspense' },
    { id: 'phrygianDominant', name: 'Phrygian dominant', group: 'Exotic', steps: [0, 1, 4, 5, 7, 8, 10], hint: 'Middle Eastern, flamenco' },
    { id: 'hungarianMinor', name: 'Hungarian minor', group: 'Exotic', steps: [0, 2, 3, 6, 7, 8, 11], hint: 'dramatic, Romani / gothic' },
    { id: 'doubleHarmonic', name: 'Double harmonic', group: 'Exotic', steps: [0, 1, 4, 5, 7, 8, 11], hint: 'Arabic / Byzantine, very exotic' },
    { id: 'hirajoshi', name: 'Hirajoshi', group: 'Exotic', steps: [0, 2, 3, 7, 8], hint: 'Japanese, koto-like' },
    { id: 'insen', name: 'In-sen', group: 'Exotic', steps: [0, 1, 5, 7, 10], hint: 'Japanese, sparse and haunting' },
  ];
  const SCALE_BY = {}; SCALES.forEach((s) => { SCALE_BY[s.id] = s; });
  const scaleById = (id) => SCALE_BY[id] || SCALE_BY.major;

  // Chord qualities (same set and order as Melody's model.QUALS).
  const CHORD_IV = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
    7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };
  const CHORD_Q = ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4', '7', 'maj7', 'm7'];
  const RN = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
  // Roman numeral of a chord whose root is `deg` semitones above the key root (b5 is spelled bV when the scale has a 4th).
  function romanOf(deg, q, steps) {
    let n = deg === 6 && steps && steps.includes(5) ? 'bV' : RN[((deg % 12) + 12) % 12];
    if (q === 'min' || q === 'dim' || q === 'm7') n = n.replace(/[IV]+/, (x) => x.toLowerCase());
    return n + (q === 'dim' ? '°' : q === 'aug' ? '+' : q === 'maj' || q === 'min' ? '' : q === 'm7' ? '7' : q);
  }
  const fitsScale = (deg, q, set) => CHORD_IV[q].every((i) => set.has((deg + i) % 12));
  // Chords of a scale: [{ r (root pitch class), q, deg (semitones above the key root), k (degree index), rn }].
  // Seven-note scales: the triad stacked on every degree (thirds of the scale; a degree whose stacked triad is not one
  // of the qualities falls back to the first quality that fits). Other scales: every triad and 7th on each degree whose
  // notes all lie in the scale.
  function scaleChords(root, scaleId) {
    const sc = typeof scaleId === 'object' && scaleId ? scaleId : scaleById(scaleId), st = sc.steps, set = new Set(st), out = [];
    st.forEach((deg, k) => {
      if (st.length === 7) {
        const iv = [0, (st[(k + 2) % 7] - deg + 12) % 12, (st[(k + 4) % 7] - deg + 12) % 12];
        let q = CHORD_Q.slice(0, 4).find((x) => CHORD_IV[x].every((v, j) => v === iv[j]));
        if (!q) q = CHORD_Q.find((x) => fitsScale(deg, x, set));
        if (q) out.push({ r: (root + deg) % 12, q, deg, k, rn: romanOf(deg, q, st) });
      } else {
        CHORD_Q.forEach((q) => { if (fitsScale(deg, q, set)) out.push({ r: (root + deg) % 12, q, deg, k, rn: romanOf(deg, q, st) }); });
      }
    });
    return out;
  }

  // Tunings. Steps within the octave in cents; equal divisions (ed), 5-limit just / Pythagorean ratios, or cent lists
  // (Slendro / Pelog: common approximations). Melody anchors the grid at the section's key root.
  const TUNINGS = [
    { id: '12tet', name: '12-TET (standard)', ed: 12, hint: 'the usual piano tuning' },
    { id: 'ji', name: 'Just intonation (5-limit)', hint: 'pure thirds and fifths from the key root',
      ratios: [[1, 1], [16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [9, 5], [15, 8]] },
    { id: 'pyth', name: 'Pythagorean', hint: 'pure fifths, bright thirds',
      ratios: [[1, 1], [256, 243], [9, 8], [32, 27], [81, 64], [4, 3], [729, 512], [3, 2], [128, 81], [27, 16], [16, 9], [243, 128]] },
    { id: '19tet', name: '19-TET', ed: 19, hint: 'sweet thirds, extra sharps and flats' },
    { id: '24tet', name: '24-TET (quarter tones)', ed: 24, hint: 'quarter tones, maqam colours' },
    { id: '31tet', name: '31-TET', ed: 31, hint: 'meantone thirds and septimal sevenths' },
    { id: 'slendro', name: 'Slendro (approx.)', cents: [0, 240, 480, 720, 960], hint: 'Javanese gamelan, 5 near-equal steps' },
    { id: 'pelog', name: 'Pelog (approx.)', cents: [0, 120, 270, 540, 670, 785, 950], hint: 'Javanese gamelan, 7 uneven steps' },
  ];
  const TUN_BY = {}; TUNINGS.forEach((t) => { TUN_BY[t.id] = t; });
  const tuningById = (id) => TUN_BY[id] || TUN_BY['12tet'];
  const cents = (p, q) => 1200 * Math.log2(p / q);
  function tuningCents(id) {
    const t = tuningById(id);
    if (t.ed) return Array.from({ length: t.ed }, (_, k) => k * 1200 / t.ed);
    if (t.ratios) return t.ratios.map(([p, q]) => cents(p, q));
    return t.cents.slice();
  }
  // Nearest tuning pitch (midi float) to m, grid anchored at pitch class `root` (0..11). Ties go up (like Math.round).
  function tuningSnap(id, root, m) {
    const c = tuningCents(id), o = Math.floor((m - root) / 12);
    let best = m, bd = Infinity;
    for (let k = o - 1; k <= o + 1; k++) for (const x of c) {
      const p = root + 12 * k + x / 100, d = Math.abs(p - m);
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && p > best)) { bd = d; best = p; }
    }
    return best;
  }
  // Step class (0..N-1) of the tuning pitch nearest to m.
  function tuningClass(id, root, m) {
    const c = tuningCents(id), p = tuningSnap(id, root, m), r = ((((p - root) * 100) % 1200) + 1200) % 1200;
    let bi = 0, bd = Infinity;
    c.forEach((x, i) => { const d = Math.min(Math.abs(x - r), 1200 - Math.abs(x - r)); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  // Every tuning pitch in [lo, hi] (sorted) with its step class.
  function tuningGrid(id, root, lo, hi) {
    const c = tuningCents(id), pts = [], cls = [];
    for (let o = Math.floor((lo - root) / 12) - 1; root + 12 * o <= hi + 1; o++) {
      c.forEach((x, i) => { const m = root + 12 * o + x / 100; if (m >= lo - 1e-6 && m <= hi + 1e-6) { pts.push(m); cls.push(i); } });
    }
    return { id, N: c.length, root, cents: c, pts, cls };
  }
  // Scale (semitone steps) -> step classes of the tuning: identical for 12-step tunings, else the nearest step per degree.
  function scaleClasses(id, steps) {
    const c = tuningCents(id);
    if (c.length === 12) return steps.slice();
    const out = new Set();
    steps.forEach((s) => {
      let bi = 0, bd = Infinity;
      c.forEach((x, i) => { const d = Math.min(Math.abs(x - s * 100), 1200 - Math.abs(x - s * 100)); if (d < bd) { bd = d; bi = i; } });
      out.add(bi);
    });
    return [...out].sort((a, b) => a - b);
  }
  // Just ratios of the chord intervals (stacked thirds: dim 5th = 36/25, aug 5th = 25/16).
  const JI_IV = { 0: 1, 1: 16 / 15, 2: 9 / 8, 3: 6 / 5, 4: 5 / 4, 5: 4 / 3, 6: 36 / 25, 7: 3 / 2, 8: 25 / 16, 9: 5 / 3, 10: 9 / 5, 11: 15 / 8 };
  // Chord tones (midi floats) of a chord with root pitch class chRoot and semitone intervals ivs, in tuning id with the
  // grid anchored at keyRoot, voiced from base. 12-TET: the plain equal-tempered midis. JI: the chord root's grid pitch
  // times the just ratios. Others: each tone on the tuning step nearest to root + interval.
  function tunedChord(id, keyRoot, chRoot, ivs, base) {
    base = base == null ? 48 : base;
    const t = tuningById(id);
    if (t.id === '12tet') return ivs.map((i) => base + chRoot + i);
    const r = tuningSnap(t.id, keyRoot, base + chRoot);
    if (t.id === 'ji') return ivs.map((i) => r + 12 * Math.floor(i / 12) + 12 * Math.log2(JI_IV[((i % 12) + 12) % 12]));
    return ivs.map((i) => tuningSnap(t.id, keyRoot, r + i));
  }
  // Scala (.scl) file of a tuning: description, step count, then each step above the unison (ratios as p/q, cents
  // with a decimal point), ending with the octave 2/1.
  function sclText(id) {
    const t = tuningById(id), n = t.ed || (t.ratios || t.cents).length;
    const lines = ['! ' + t.id + '.scl', '!', t.name + (t.hint ? ' - ' + t.hint : ''), ' ' + n, '!'];
    for (let k = 1; k < n; k++) {
      if (t.ratios) lines.push(' ' + t.ratios[k][0] + '/' + t.ratios[k][1]);
      else lines.push(' ' + (t.ed ? k * 1200 / t.ed : t.cents[k]).toFixed(5));
    }
    lines.push(' 2/1');
    return lines.join('\n') + '\n';
  }
  // 14-bit MIDI pitch-bend value for an offset in semitones with a bend range of ±range semitones (8192 = centre).
  const bendValue = (semis, range) => Math.max(0, Math.min(16383, Math.round(8192 + semis / (range || 12) * 8191)));

  const api = { midiToHz, noteName, partials, pairDissonance, dissonance, dissonanceSpectra, reduceRatio,
    nearestRatio, tenneyHeight, octaveReduce, fordCircles,
    SCALES, scaleById, scaleChords, romanOf, CHORD_IV, CHORD_Q, TUNINGS, tuningById, tuningCents, tuningSnap, tuningClass, tuningGrid,
    scaleClasses, tunedChord, JI_IV, sclText, bendValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Harmony = api; (root.VH = root.VH || {}).harmony = api; }
})(this);
