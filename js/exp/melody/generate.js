// melody/generate.js - part: "🎲 Progression", "🎲 Melody" (+ "🎲 again") and the M.hooks.bandExtras
// implementation behind "Bands include other layers". See MELODY.md.
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody;
  if (!NS) return;

  // ---------- seeded randomness (Randomize panel) ----------
  function hashSeed(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry32(a) {
    return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const DEF_SPICE = 0.4;   // "Adventure": 0 = plain diatonic triads, 1 = sevenths, sus, secondary dominants, borrowed chords everywhere

  // Progression templates as scale degrees (1-based) of the current mode. home = the mode they are idiomatic in.
  const TEMPLATES = [
    { deg: [1, 5, 6, 4], home: 'major', w: 4 },   // I–V–vi–IV
    { deg: [6, 4, 1, 5], home: 'major', w: 3 },   // vi–IV–I–V
    { deg: [1, 6, 2, 5], home: 'major', w: 3 },   // I–vi–ii–V
    { deg: [2, 5, 1, 1], home: 'major', w: 2 },   // ii–V–I–I
    { deg: [1, 4, 5, 4], home: 'major', w: 3 },   // I–IV–V–IV
    { deg: [1, 3, 4, 5], home: 'major', w: 2 },   // I–iii–IV–V
    { deg: [1, 4, 6, 5], home: 'major', w: 2 },   // I–IV–vi–V
    { deg: [1, 6, 4, 5], home: 'major', w: 3 },   // I–vi–IV–V (50s)
    { deg: [6, 2, 5, 1], home: 'major', w: 2 },   // vi–ii–V–I
    { deg: [4, 5, 3, 6], home: 'major', w: 1 },   // IV–V–iii–vi (royal road)
    { deg: [1, 3, 6, 4], home: 'major', w: 2 },   // I–iii–vi–IV
    { deg: [1, 4, 1, 5], home: 'major', w: 2 },   // I–IV–I–V
    { deg: [2, 5, 3, 6], home: 'major', w: 1 },   // ii–V–iii–vi
    { deg: [1, 6, 3, 7], home: 'minor', w: 4 },   // i–VI–III–VII
    { deg: [1, 4, 5, 1], home: 'minor', w: 3 },   // i–iv–v–i
    { deg: [1, 7, 6, 7], home: 'minor', w: 3 },   // i–VII–VI–VII
    { deg: [1, 4, 7, 3], home: 'minor', w: 2 },   // i–iv–VII–III
    { deg: [1, 7, 6, 5], home: 'minor', w: 3 },   // i–VII–VI–v (Andalusian-ish)
    { deg: [1, 6, 7, 1], home: 'minor', w: 2 },   // i–VI–VII–i
    { deg: [6, 7, 1, 1], home: 'minor', w: 2 },   // VI–VII–i–i
  ];
  // Random-walk progressions: from each degree, the degrees that usually follow it (weights).
  const WALK = { 1: [[4, 3], [5, 3], [6, 3], [2, 2], [3, 1.5]], 2: [[5, 5], [4, 1], [7, 0.4]], 3: [[6, 3], [4, 3], [2, 1]], 4: [[5, 4], [1, 3], [2, 2], [6, 1.5]],
    5: [[1, 5], [6, 3], [4, 1.5], [3, 0.7]], 6: [[4, 3], [2, 3], [5, 2], [3, 1]], 7: [[1, 4], [3, 2]] };
  function walk(rnd) {
    const t = [rnd() < 0.75 ? 1 : 6];
    while (t.length < 4) t.push(t.length === 3 && rnd() < 0.7 ? wpick([[5, 4], [1, 2], [4, 2]], rnd) : wpick(WALK[t[t.length - 1]], rnd));
    return t;
  }
  // Chords from outside the scale, as [semitones above the key root, quality, weight].
  const BORROW_MAJ = [[8, 'maj', 3], [10, 'maj', 3], [5, 'min', 3], [3, 'maj', 1.5], [1, 'maj', 1], [7, 'min', 1], [2, 'dim', 0.6]];   // bVI bVII iv bIII bII v ii°
  const BORROW_MIN = [[5, 'maj', 3], [7, 'maj', 3], [7, '7', 1.5], [1, 'maj', 1], [11, 'dim', 1]];                                    // IV V V7 bII vii°
  // Modal templates (scales other than major / minor): chord roots as semitones above the key root; each chord takes its
  // quality from the scale (md.scaleChords). cad = the mode's characteristic chord, used to turn a phrase's last bar.
  const MODAL = {
    dorian: { t: [[[0, 5, 0, 5], 4], [[0, 5, 10, 0], 3], [[0, 2, 3, 5], 2], [[0, 10, 5, 0], 2]], cad: 5 },          // i–IV, i–IV–bVII–i, i–ii–bIII–IV
    phrygian: { t: [[[0, 1, 0, 1], 4], [[0, 1, 3, 1], 3], [[0, 10, 8, 1], 3], [[0, 1, 10, 0], 2]], cad: 1 },       // i–bII, i–bvii–bVI–bII
    lydian: { t: [[[0, 2, 0, 2], 4], [[0, 2, 4, 0], 3], [[0, 2, 7, 0], 2], [[0, 11, 2, 0], 1]], cad: 2 },          // I–II, I–II–iii–I
    mixolydian: { t: [[[0, 10, 5, 0], 4], [[0, 10, 5, 5], 3], [[0, 7, 10, 5], 2], [[0, 5, 10, 0], 2]], cad: 10 },  // I–bVII–IV–I, I–v–bVII–IV
    locrian: { t: [[[0, 1, 0, 1], 3], [[0, 1, 8, 1], 3], [[0, 6, 1, 0], 2]], cad: 1 },                              // i°–bII, i°–bV–bII
    harmonicMinor: { t: [[[0, 5, 7, 0], 4], [[0, 8, 7, 0], 3], [[0, 2, 7, 0], 2], [[0, 5, 8, 7], 2]], cad: 7 },     // i–iv–V–i, i–bVI–V
    melodicMinor: { t: [[[0, 5, 7, 0], 3], [[0, 2, 7, 0], 3], [[0, 5, 0, 7], 2]], cad: 7 },                         // i–IV–V–i
    phrygianDominant: { t: [[[0, 1, 0, 1], 4], [[0, 1, 5, 0], 3], [[0, 10, 1, 0], 2]], cad: 1 },                    // I–bII, I–bII–iv–I
  };
  const QW = { maj: 3, min: 3, sus2: 2, sus4: 2, dim: 1, aug: 1 };
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

  // A plan is the chords of a section, bar by bar: { A: [chord at the bar start], B: [the chord a split bar changes to],
  // pre: chord to play before B = V in a phrase's last bar }. layout* turn a plan into chord events (see below).
  function modalPlan(S, md, rnd) {
    const cs = md.scaleChords(S), triads = cs.filter((c) => QW[c.q]), pool = triads.length ? triads : cs;
    const onDeg = (d) => { const c = pool.find((x) => x.deg === d) || cs.find((x) => x.deg === d); return c ? [c.r, c.q] : null; };
    const tonic = pool.find((c) => c.deg === 0 && (c.q === 'maj' || c.q === 'min')) || pool.find((c) => c.deg === 0) || pool[0];
    const mt = MODAL[S.mode], usable = mt ? mt.t.filter(([deg]) => deg.every((d) => onDeg(d))) : [];
    let phrase;
    if (usable.length) phrase = (t, last) => t.map((d, k) => (last && k === t.length - 1 && d !== 0 && rnd() < 0.4 ? onDeg(0) : onDeg(d)));
    else {
      const others = pool.filter((c) => c !== tonic && c.deg !== 0), pick = (not) => {
        const opt = others.filter((c) => !not || c.r !== not.r || c.q !== not.q);
        return opt.length ? wpick(opt.map((c) => [c, QW[c.q] || 1]), rnd) : tonic;
      };
      phrase = (_, last) => { const a = pick(), b = pick(a), c = last || rnd() < 0.5 ? tonic : pick(b); return [tonic, a, b, c].map((x) => [x.r, x.q]); };
    }
    const tp = () => (usable.length ? wpick(usable, rnd) : null), A = tp(), B = tp(), n = Math.ceil(S.bars / 4), out = [];
    for (let p = 0; p < n; p++) {
      const t = n === 2 ? (p === 0 || rnd() < 0.5 ? A : B) : n === 4 ? (p === 2 ? B : A) : A;
      out.push(...phrase(t, n > 1 && p === n - 1));
    }
    out.length = S.bars;
    const cad = mt ? onDeg(mt.cad) : null;
    return { A: out, B: out.map((c, b) => (cad && (b % 4 === 3 || b === S.bars - 1) ? cad.slice() : (out[b + 1] || c).slice())), pre: null, p: 0.45 };
  }
  // Major / minor: templates (or a random walk when adventurous), now and then a borrowed chord, a secondary dominant.
  function diaPlan(S, md, rnd, spice) {
    const dia = md.diatonic(S), minor = S.mode === 'minor', K = S.key, n = Math.ceil(S.bars / 4), len = S.bars;
    const chordOf = (d) => { const c = dia[(d - 1) % 7]; return [c[0], c[1]]; };
    const usable = TEMPLATES.filter((t) => !(t.home === 'minor' && !minor && t.deg.includes(7))).map((t) => [t, t.home === S.mode ? t.w : t.w * 0.2]);
    const pickT = () => (rnd() < Math.min(0.6, spice * 0.9) ? walk(rnd) : wpick(usable, rnd).deg);
    const tA = pickT(), tB = pickT(), borrowed = (minor ? BORROW_MIN : BORROW_MAJ).map(([o, q, w]) => [[(K + o) % 12, q], w]);
    const base = [], lastOf = (b) => b % 4 === 3 || b === len - 1;
    for (let p = 0; p < n; p++) {
      // 4 bars: A. 8 bars: A A' or A B. 16 bars: A A B A. (Other lengths: phrases of 4, cut at the end.)
      const t = n === 2 ? (p === 0 || rnd() < 0.5 ? tA : tB) : n === 4 ? (p === 2 ? tB : tA) : tA, last = n > 1 && p === n - 1;
      t.forEach((d, k) => {
        if (minor && d === 5 && k === t.length - 1 && rnd() < 0.35) base.push([(K + 7) % 12, 'maj']);   // dominant V in minor
        else if (last && k === t.length - 1 && d !== 1 && rnd() < 0.4) base.push(chordOf(1));           // end home
        else base.push(chordOf(d));
      });
    }
    base.length = len;
    const set = new Set(md.scaleOf(S).steps.map((s) => (K + s) % 12));
    const A = base.map((c, b) => {
      const next = base[b + 1];
      if (b > 0 && rnd() < 0.3 * spice) return wpick(borrowed, rnd).slice();
      if (next && !lastOf(b) && next[1] !== 'dim' && rnd() < 0.45 * spice && (next[0] + 7) % 12 !== c[0]) return [(next[0] + 7) % 12, '7'];   // V7 of the next chord
      return colorize(md, set, c, rnd, spice);
    });
    const V5 = chordOf(5), pre = chordOf(minor ? 4 : 2);
    if (rnd() < spice * 0.5) V5[1] = minor ? V5[1] : '7';
    return { A, B: A.map((c, b) => (lastOf(b) ? V5.slice() : (A[b + 1] || c).slice())), pre, p: 0.55 };
  }
  // A triad takes a 7th or a sus (as far as the scale allows), more often the more adventurous.
  function colorize(md, set, c, rnd, spice) {
    if ((c[1] !== 'maj' && c[1] !== 'min') || rnd() >= 0.1 + 0.8 * spice) return c;
    const iv = (q) => md.QUALS[md.QI[q]][2];
    const opts = (c[1] === 'maj' ? [['maj7', 4], ['7', 4], ['sus2', 1.5], ['sus4', 2]] : [['m7', 5], ['sus2', 1], ['sus4', 1.5]])
      .filter(([q]) => iv(q).every((i) => set.has((c[0] + i) % 12)));
    return opts.length ? [c[0], wpick(opts, rnd)] : c;
  }
  function plan(S, md, rnd, spice) {
    if (S.mode === 'major' || S.mode === 'minor') return diaPlan(S, md, rnd, spice);
    const p = modalPlan(S, md, rnd), set = new Set(md.scaleOf(S).steps.map((s) => (S.key + s) % 12));
    p.A = p.A.map((c) => colorize(md, set, c, rnd, spice));
    return p;
  }
  // Layouts: chord events from a plan. 'phrase': one chord per bar, and now and then a turn at the second half of a phrase's
  // last bar. 'random': bars split at their beats in different ways (chord lengths). 'keep': the chords go into the regions
  // the section already has.
  function layoutPhrase(S, md, rnd, pl) {
    const nb = md.spb(S), T = md.tsOf(S), half = T.beats[Math.floor(T.beats.length / 2)] || nb / 2, ev = [];
    pl.A.forEach((c, b) => {
      const last = b % 4 === 3 || b === S.bars - 1;
      if (last && half > 0 && S.bars > 1 && rnd() < pl.p) {
        ev.push({ at: b * nb, chord: (same(c, pl.B[b]) && pl.pre ? pl.pre : c).slice() }); ev.push({ at: b * nb + half, chord: pl.B[b].slice() });
      } else ev.push({ at: b * nb, chord: c.slice() });
    });
    return ev;
  }
  function layoutRandom(S, md, rnd, pl, spice) {
    const nb = md.spb(S), bt = md.tsOf(S).beats, nB = bt.length, ev = [];
    pl.A.forEach((c, b) => {
      const kind = wpick([['whole', 6 - 3 * spice], ['half', nB > 1 ? 2 + 2 * spice : 0], ['late', nB > 2 ? 0.8 + spice : 0], ['all', nB > 2 && nB <= 4 ? 0.2 + spice * 0.8 : 0]], rnd);
      const alt = pl.B[b], alt2 = (pl.A[b + 1] || alt);
      const at = kind === 'half' ? [bt[Math.floor(nB / 2)]] : kind === 'late' ? [bt[nB - 1]] : kind === 'all' ? bt.slice(1) : [];
      ev.push({ at: b * nb, chord: c.slice() });
      at.forEach((x, j) => ev.push({ at: b * nb + x, chord: (j % 2 ? alt2 : alt).slice() }));
    });
    return ev;
  }
  function layoutKeep(S, md, pl) {
    const nb = md.spb(S);
    let seen = -1, j = 0;
    return S.chords.map((e) => {
      const b = Math.min(pl.A.length - 1, Math.floor(e.at / nb));
      j = b === seen ? j + 1 : 0; seen = b;
      return { at: e.at, chord: (j === 0 ? pl.A[b] : pl.B[b]).slice() };
    });
  }
  // The plan a section already holds (Chord lengths without Chords): the chord at each bar start, and the bar's last chord.
  function planOf(S, md) {
    const nb = md.spb(S), tonic = [S.key, S.mode === 'minor' ? 'min' : 'maj'];
    const A = Array.from({ length: S.bars }, (_, b) => (md.chordAt(S, b * nb) || tonic).slice());
    return { A, B: A.map((c, b) => { const r = md.regionAt(S, (b + 1) * nb - 1); return (S.chords[r].at > b * nb && S.chords[r].chord ? S.chords[r].chord : A[b + 1] || c).slice(); }), pre: null, p: 0 };
  }
  // Progression as chord events (the 🎲 Progression button).
  function progression(S, md, rnd, spice) {
    const pl = plan(S, md, rnd, spice == null ? DEF_SPICE : spice);
    return layoutPhrase(S, md, rnd, pl);
  }

  const DENS = {   // durations in sixteenths with weights, rest probability, phrase-end length
    sparse: { d: [[8, 3], [4, 3], [12, 1], [16, 1], [6, 1]], rest: 0.22, end: 12 },
    medium: { d: [[4, 5], [2, 3], [8, 2], [6, 1], [3, 1]], rest: 0.12, end: 8 },
    busy: { d: [[2, 6], [1, 2], [4, 3], [3, 1]], rest: 0.07, end: 4 },
  };
  const RANGES = { low: [48, 64], mid: [55, 74], high: [64, 84], full: [48, 84] };

  function wpick(items, rnd) {   // items: [[value, weight], ...]
    const tot = items.reduce((a, x) => a + x[1], 0);
    let r = rnd() * tot;
    for (const [v, w] of items) { if ((r -= w) < 0) return v; }
    return items[items.length - 1][0];
  }


  // ---------- melody ----------
  // Band maxima (consonant peaks) for a bar within [lo, hi]; falls back to scale tones without a chord.
  // Default (equal temperament): the whole semitones that fit the chord (chord tones, and key tones at least as
  // consonant as the bar's 60th percentile: M.bands.fitCtx), so melodies are in tune with the backing.
  // With Pure intonation (M.bands.pure) the exact band maxima, as before.
  function targetsFor(M, bar, L, lo, hi) {   // bar = chord region index
    const S = M.song, md = M.model, at = M.bandsAt(S.chords[bar].at, L);
    const X = !M.bands.pure && M.bands.fitCtx ? M.bands.fitCtx(at.region, L) : null;
    if (X) {
      const all = [];
      for (const m of X.pts) if (m >= lo - 1e-9 && m <= hi + 1e-9 && X.fits(m)) all.push(m);   // tuning grid (semitones in 12-TET)
      return { all, chordTones: X.tension > 0.3 ? [] : all.filter((m) => X.isChord(m)) };   // phrase ends rest on chord tones only while the dial is calm
    }
    let pk = (at.matchPeaks ? at.matchPeaks() : at.peaks()).filter((m) => m >= lo - 0.01 && m <= hi + 0.01);
    if (!pk.length) {
      const G = md.gridOf(S);
      pk = G.pts.filter((m) => m >= lo - 1e-9 && m <= hi + 1e-9 && G.inScale(m));
    }
    const rc = md.regionChord(S, bar), ct = rc ? md.chordMidis(rc, S).map((m) => m % 12) : [];
    const isCT = (m) => ct.some((pc) => { const d = (((m - pc) % 12) + 12) % 12; return Math.min(d, 12 - d) < 0.3; });
    return { all: pk.slice().sort((a, b) => a - b), chordTones: pk.filter(isCT).sort((a, b) => a - b) };
  }
  function melody(M, L, o, rnd) {
    const S = M.song, md = M.model, SPB = md.spb(S), tot = md.tot16(S), dens = DENS[o.density] || DENS.medium;
    const [lo, hi] = RANGES[o.range] || RANGES.mid, unit = o.notes ? Math.max(1, Math.round(md.gridStep(S.grid))) : 1;
    const phraseLen = 2 * SPB;
    const cache = new Map();
    const tg = (bar) => { if (!cache.has(bar)) cache.set(bar, targetsFor(M, bar, L, lo, hi)); return cache.get(bar); };
    const out = [];   // { s, d, m } (rests are skipped)
    let cur = (lo + hi) / 2, dir = rnd() < 0.5 ? -1 : 1, t = 0;
    while (t < tot) {
      const bar = md.regionAt(S, t), T = tg(bar), pEnd = Math.min(tot, (Math.floor(t / phraseLen) + 1) * phraseLen);
      let d = Math.max(unit, Math.round(wpick(dens.d, rnd) / unit) * unit);
      const rem = pEnd - t, ending = rem <= dens.end || t + d >= pEnd;   // the phrase's last note fills up to its end
      if (ending) d = rem; else d = Math.min(d, md.regionEnd(S, bar) - t);   // other notes stay inside their chord
      if (!ending && t > 0 && rnd() < dens.rest) { t += d; continue; }
      const list = ending && T.chordTones.length ? T.chordTones : T.all;
      if (!list.length) { t += d; continue; }
      // nearest index to the current pitch, then a hop of 0..3 bands, biased by momentum + range gravity
      let k = 0, bd = Infinity;
      list.forEach((m, i) => { const x = Math.abs(m - cur); if (x < bd) { bd = x; k = i; } });
      if (rnd() < 0.25) dir = -dir;
      const mid = (lo + hi) / 2, pull = (cur - mid) / ((hi - lo) / 2);
      if (Math.abs(pull) > 0.6 && Math.sign(pull) === dir) dir = -dir;
      const hop = ending ? wpick([[0, 3], [1, 3], [2, 1]], rnd) : wpick([[1, 6], [2, 4], [3, 2], [0, 1]], rnd);
      k = Math.max(0, Math.min(list.length - 1, k + dir * hop));
      const m = list[k];
      out.push({ s: t, d, m });
      cur = m; t += d;
    }
    return out;
  }
  // Line samples from target notes: hold, then a smooth (cosine) glide into the next target when they touch.
  function toLine(notes, len, LPB, SPB) {
    const line = new Float32Array(len).fill(NaN), k = LPB / SPB;
    notes.forEach((n, i) => {
      const a = Math.round(n.s * k), b = Math.min(len, Math.round((n.s + n.d) * k));
      const next = notes[i + 1], joined = next && next.s === n.s + n.d;
      const g = joined ? Math.min(4, Math.max(2, Math.floor((b - a) / 4))) : 0;
      for (let j = a; j < b; j++) {
        if (joined && j >= b - g) { const u = (j - (b - g) + 1) / (g + 1), w = (1 - Math.cos(Math.PI * u)) / 2; line[j] = n.m + (next.m - n.m) * w; } else line[j] = n.m;
      }
    });
    return line;
  }

  // ---------- "Bands include other layers": per-bar extra voices from the other layers ----------
  // Per grid column, collect what every other audible layer plays (its own spectrum); each bar's extras are the
  // distinct pitches weighted by the fraction of columns they sound in (top 4 per bar), quantised for stable caching.
  const MAX_EXTRAS = 4, DEBOUNCE = 120;
  function sounding(S, md, L, bar, cols) {   // -> Map(pitchKey -> { m, w }) for layer L in chord region `bar`
    const a = S.chords[bar].at, res = new Map(), l = S.layers[L], step = (md.regionEnd(S, bar) - a) / cols;
    for (let c = 0; c < cols; c++) {
      const t16 = a + (c + 0.5) * step, ps = new Set();
      for (const q of md.lineAt(l, Math.floor(t16 * 3))) ps.add(Math.round(q.m * 10) / 10);   // every stroke
      for (const n of l.notes) if (n.s <= t16 && t16 < n.s + n.d) ps.add(Math.round(n.m * 10) / 10);
      for (const m of ps) { const e = res.get(m) || { m, w: 0 }; e.w += 1 / cols; res.set(m, e); }
    }
    return res;
  }

  // ---------- Randomize ----------
  // What can be randomized (id, label, one-line description). Left out: time signature, effects, mixer levels, drum kit rows.
  const RAND_PARTS = [
    ['key', 'Key', 'The root note and the scale (major, minor, modes...) of the section.'],
    ['chords', 'Chords', 'The chord progression, using sevenths, sus and borrowed chords as far as Adventure allows.'],
    ['lens', 'Chord lengths', 'How long each chord lasts: a whole bar, half a bar, or quicker changes.'],
    ['bars', 'Bars', 'How many bars long the section is.'],
    ['tempo', 'Tempo', 'The speed of the song (BPM).'],
    ['melody', 'Melody', 'A new melody on the active layer, on the bright bands of the new chords.'],
    ['backInst', 'Backing instrument', 'The sound that plays the chords.'],
    ['backStyle', 'Backing style', 'How the chords are played: held, strummed, arpeggio, pulse or broken.'],
    ['drums', 'Drums pattern', 'A drum groove (or no drums).'],
    ['sounds', 'Sounds of layers', 'A new instrument for every melody layer.'],
  ];
  const RAND_DEFAULT = { key: true, chords: true, lens: false, bars: false, tempo: false, melody: false, backInst: false, backStyle: false, drums: false, sounds: false };
  const SCALE_W = { major: 6, minor: 6, dorian: 2, mixolydian: 2, lydian: 1.2, harmonicMinor: 1.2, melodicMinor: 0.8, majPent: 1.5, minPent: 1.5, blues: 1, phrygian: 0.6 };
  const BARS_W = [[2, 0.4], [4, 3], [6, 0.6], [8, 4], [12, 1], [16, 2]];
  const STYLE_W = { drone: 1, strum: 1.5, arp: 2, pulse: 1, broken: 1.5 };

  // The pure part of Randomize: edits song S (the shown section; every section with scope 'song') for the checked parts.
  // Each part draws from its own generator (seed + part + section), so a part's result does not depend on the other
  // checkboxes: the same seed gives the same Key / Chords / ... whatever else is checked.
  // o = { seed, spice 0..1, parts: { id: bool }, scope: 'section' | 'song' }
  // ctx = { setBars(n), show(k), setSound(L, id), setDrums(id), melody(rnd), sounds: [ids], backSounds: [ids], styles: [ids], drums: [preset ids] }
  // Returns the names of the parts that ran.
  function randomizeSong(S, md, o, ctx) {
    const seed = String(o.seed), spice = o.spice == null ? DEF_SPICE : o.spice, P = o.parts || {}, done = [];
    const R = (part, k) => mulberry32(hashSeed(seed + '|' + part + '|' + (k || 0)));
    const cur = S.cur, all = S.sections.map((_, k) => k), ks = o.scope === 'song' ? [cur].concat(all.filter((k) => k !== cur)) : [cur];
    const multi = S.sections.length > 1, wide = o.scope === 'song' || !multi;   // wide: song-wide settings, else the shown section's override
    if (P.tempo && !S.track) { const r = R('tempo'); S.bpm = Math.round(clampN(60 + (r() + r()) / 2 * 100, md.BPM_MIN, md.BPM_MAX)); done.push('tempo'); }
    if (P.sounds && ctx.sounds.length) {
      const r = R('sounds');
      S.layers.forEach((_, L) => ctx.setSound(L, ctx.sounds[Math.floor(r() * ctx.sounds.length)]));
      done.push('sounds');
    }
    const backing = (patch) => {
      if (wide) { Object.assign(S.backing, patch); S.sections.forEach((x) => { if (x.back) { Object.keys(patch).forEach((q) => delete x.back[q]); if (!Object.keys(x.back).length) delete x.back; } }); }
      else { const x = S.sections[cur]; x.back = Object.assign({}, x.back, patch); }
    };
    if (P.backInst && ctx.backSounds.length) { const r = R('backInst'); backing({ sound: ctx.backSounds[Math.floor(r() * ctx.backSounds.length)] }); done.push('backInst'); }
    if (P.backStyle && ctx.styles.length) { const r = R('backStyle'); backing({ style: wpick(ctx.styles.map((s) => [s, STYLE_W[s] || 1]), r) }); done.push('backStyle'); }
    if ((P.backInst || P.backStyle) && ctx.sync) ctx.sync();   // the bands follow the new backing instrument
    const dr = P.drums && ctx.drums ? wpick(ctx.drums.map((d) => [d, d === 'off' ? 0.7 : 1]), R('drums')) : null;
    let root = 0, mode = 'major';
    if (P.key) {
      const r = R('key');
      root = Math.floor(r() * 12); mode = wpick(Object.keys(md.SCALE).map((id) => [id, SCALE_W[id] || 0.25]), r);
      done.push('key');
    }
    ks.forEach((k) => {
      if (k !== S.cur) ctx.show(k);
      if (P.key) { S.key = root; S.mode = mode; }
      if (P.bars) { const n = wpick(BARS_W, R('bars', k)); ctx.setBars(n); }
      if (P.chords || P.lens) {
        const rc = R('chords', k), rl = R('lens', k);
        let pl;
        if (P.chords) {
          pl = plan(S, md, rc, spice);
          if (P.lens && rl() < 0.3) pl.A = pl.A.map((c, b) => (b % 2 ? pl.A[b - 1] : c));   // slow changes: two bars each
        } else pl = planOf(S, md);
        S.chords = P.lens ? layoutRandom(S, md, rl, pl, spice) : layoutKeep(S, md, pl);
        md.normChords(S);
      }
      if (dr) ctx.setDrums(dr);
      if (P.melody) ctx.melody(R('melody', k));
    });
    if (S.cur !== cur) ctx.show(cur);
    ['chords', 'lens', 'bars', 'melody'].forEach((q) => { if (P[q]) done.push(q); });
    if (dr) done.push('drums');
    return done;
  }
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor', 'iris', 'juniper', 'kelp', 'lumen', 'maple', 'nectar', 'opal', 'pine', 'quartz', 'reed', 'sage', 'tide', 'umber', 'violet', 'willow', 'yarrow', 'zephyr'];
  const newSeed = () => WORDS[Math.floor(Math.random() * WORDS.length)] + '-' + Math.floor(Math.random() * 900 + 100);
  NS.gen = { hashSeed, mulberry32, plan, progression, randomizeSong, RAND_PARTS, RAND_DEFAULT, DEF_SPICE, newSeed };

  if (!NS.parts) return;

  NS.parts.push((M) => {
    const ui = VH.ui, md = M.model;
    let alive = true;
    const rnd = Math.random;
    const opts = { density: VH.store.get('melody.gen.density', 'medium'), range: VH.store.get('melody.gen.range', 'mid') };
    let lastGen = null;   // { snap, opts, layer } of the last generated melody (for "again")

    // ---------- UI ----------
    const sec = M.ui.addPanelSection('Generate', 45, { group: 'song' });
    const r1 = ui.h('div', 'vh-row'); sec.append(r1);
    const progBtn = ui.button(r1, { label: '🎲 Progression', onClick: () => genProgression() });
    progBtn.title = 'Random chord progression in the current key (one undo step)'; progBtn.classList.add('gx-prog');
    const melBtn = ui.button(r1, { label: '🎲 Melody', onClick: () => genMelody(false) });
    melBtn.title = 'Fill the active layer with a melody on the bright bands (one undo step)'; melBtn.classList.add('gx-mel');
    const againBtn = ui.button(r1, { label: '🎲 again', onClick: () => genMelody(true) });
    againBtn.title = 'Re-roll the last melody (replaces it, still one undo step)'; againBtn.classList.add('gx-again');
    againBtn.disabled = true;
    const r2 = ui.h('div', 'vh-row'); sec.append(r2);
    r2.append(ui.h('span', 'mel-lbl', 'Melody'));
    const dSel = ui.select(r2, { label: 'Melody density', value: opts.density,
      options: [{ value: 'sparse', label: 'Sparse' }, { value: 'medium', label: 'Medium' }, { value: 'busy', label: 'Busy' }],
      onChange: (v) => { opts.density = v; VH.store.set('melody.gen.density', v); } });
    const rSel = ui.select(r2, { label: 'Melody range', value: opts.range,
      options: [{ value: 'low', label: 'Low C3–E4' }, { value: 'mid', label: 'Mid G3–D5' }, { value: 'high', label: 'High E4–C6' }, { value: 'full', label: 'Full C3–C6' }],
      onChange: (v) => { opts.range = v; VH.store.set('melody.gen.range', v); } });
    dSel.el.classList.add('gx-density'); rSel.el.classList.add('gx-range');
    sec.append(ui.h('div', 'vh-desc', 'Progressions fit the key and its scale (modes get their own moves, e.g. Dorian i–IV, Phrygian i–bII; sevenths, sus, secondary dominants and a borrowed chord now and then). Randomize… lets you pick what the dice change, with a seed to repeat a result. Melodies walk the bright bands of the active layer and end phrases on chord tones; Line or Notes follows the layer’s mode.'));

    const snapOf = () => JSON.stringify(md.serialize(M.song, false));
    function syncAgain() { againBtn.disabled = !(lastGen && lastGen.snap === snapOf()); }

    // One undo step. With auto-fit on (tools-edit), the beforeCommit hook also fits the changed bars: 'Generate + fit'.
    function genProgression() {
      const S = M.song, old = S.chords, before = JSON.stringify(old);
      let ch = null;
      for (let i = 0; i < 6; i++) { ch = progression(S, md, rnd); if (JSON.stringify(ch) !== before) break; }
      S.chords = ch;
      md.normChords(S);
      const was = new Set(old.map((e) => e.at + ':' + JSON.stringify(e.chord)));
      const changed = S.chords.map((e, r) => r).filter((r) => !was.has(S.chords[r].at + ':' + JSON.stringify(S.chords[r].chord)));
      M.commit('Random progression', { chords: changed, source: 'generate' });
      M.engine.previewChord(0);
      const fit = M.lastCommit && M.lastCommit.info && M.lastCommit.info.fitMsg, nb = md.spb(S);
      M.toast('Progression: ' + S.chords.map((e) => (e.at % nb ? '/' : '') + md.chordName(e.chord, md.namesOf(S))).join(' – ').replace(/ – \//g, ' ') + (fit ? ' · ' + fit.toLowerCase() : ''));
    }
    function genMelody(again) {
      if (again && lastGen && lastGen.snap === snapOf() && M.hist.past.length && M.hist.past[M.hist.past.length - 1].label === 'Random melody') {
        M.undo();   // replace the last roll instead of stacking undo steps
        if (lastGen.layer !== M.active && M.song.layers[lastGen.layer]) M.setActive(lastGen.layer);
      }
      const S = M.song, L = M.active, l = S.layers[L], asNotes = l.mode === 'notes';
      const notes = melody(M, L, { density: opts.density, range: opts.range, notes: asNotes }, rnd);
      l.lines = []; l.notes = [];   // the roll replaces the layer (all its strokes)
      if (asNotes) l.notes = notes.map((n) => ({ s: n.s, d: n.d, m: Math.round(n.m * 100) / 100 }));
      else l.lines = [{ id: 's1', v: toLine(notes, md.tot16(S) * 3, 3, 1) }];
      M.commit('Random melody');
      lastGen = { snap: snapOf(), layer: L, targets: notes, mode: l.mode };
      api.last = lastGen;
      syncAgain();
      M.toast((asNotes ? notes.length + ' notes' : 'A line through ' + notes.length + ' targets') + (S.tension > 0 ? ' on the highlighted notes' : ' on the bright bands') + ' · Ctrl+Z undoes');
    }
    M.on('song', syncAgain);

    // ---------- Randomize ----------
    const G = NS.gen;
    const prefs = (() => {
      const p = VH.store.get('melody.gen.rand', null) || {};
      const parts = Object.assign({}, G.RAND_DEFAULT);
      G.RAND_PARTS.forEach(([id]) => { if (p.parts && typeof p.parts[id] === 'boolean') parts[id] = p.parts[id]; });
      return { parts, scope: p.scope === 'song' ? 'song' : 'section', spice: typeof p.spice === 'number' ? Math.max(0, Math.min(1, p.spice)) : G.DEF_SPICE };
    })();
    const savePrefs = () => VH.store.set('melody.gen.rand', { parts: prefs.parts, scope: prefs.scope, spice: prefs.spice });
    let lastSeed = '';
    function fillMelody(r) {   // the melody part of Randomize: the active layer of the shown section
      const S = M.song, L = M.active, l = S.layers[L], asNotes = l.mode === 'notes';
      const density = wpick([['sparse', 1.5], ['medium', 3], ['busy', 1.5]], r);
      const notes = melody(M, L, { density, range: opts.range, notes: asNotes }, r);
      l.lines = []; l.notes = [];
      if (asNotes) l.notes = notes.map((n) => ({ s: n.s, d: n.d, m: Math.round(n.m * 100) / 100 }));
      else l.lines = [{ id: 's1', v: toLine(notes, md.tot16(S) * 3, 3, 1) }];
    }
    // One undo step. o = { seed?, parts, scope, spice }; an empty seed gets a new one. Returns { seed, done }.
    function randomize(o) {
      const S = M.song, seed = o && o.seed != null && String(o.seed).trim() ? String(o.seed).trim() : G.newSeed();
      const parts = Object.assign({}, o.parts), spice = typeof o.spice === 'number' ? o.spice : prefs.spice, sx = NS.sound;
      const pre = VH.sounds.list().filter((s) => s.source === 'preset' && !s.drum).map((s) => s.id);
      const ctx = {
        setBars: (n) => M.resizeBars(n), show: (k) => M.selectSection(k), setSound: (L, id) => M.setLayerSound(L, id, true), sync: () => M.soundsChanged(),
        setDrums: (id) => {
          const d = S.drums || (S.drums = {}), p = sx && sx.DRUM_PRESETS.find((x) => x[0] === id);
          if (!p) return;
          d.preset = id;
          if (!p[2]) d.on = false; else { const q = sx.presetPat(id, S.ts); d.on = true; d.kit = q.kit || p[2].kit; d.pat = q; d.bars = {}; }
        },
        melody: fillMelody, sounds: pre, backSounds: pre,
        styles: sx ? sx.STYLES.map((s) => s[0]) : [], drums: sx ? sx.DRUM_PRESETS.map((x) => x[0]) : null,
      };
      const done = G.randomizeSong(S, md, { seed, spice, parts, scope: o.scope === 'song' ? 'song' : 'section' }, ctx);
      const chords = parts.chords || parts.lens ? M.song.chords.map((_, i) => i) : [];
      M.engine.restartBacking();
      M.commit('Randomize', { chords, source: 'generate' });
      if (chords.length) M.engine.previewChord(0);
      lastSeed = seed; api.lastSeed = seed;
      const names = G.RAND_PARTS.filter(([id]) => done.includes(id)).map((p) => p[1].toLowerCase());
      M.toast('Randomized ' + (names.join(', ') || 'nothing') + ' · seed ' + seed, { action: { label: 'Undo', run: () => M.undo() } });
      return { seed, done };
    }
    const quick = ui.button(r1, { label: '🎲 Randomize everything', onClick: () => randomize({ parts: Object.fromEntries(G.RAND_PARTS.map(([id]) => [id, true])), scope: prefs.scope, spice: prefs.spice }) });
    quick.title = 'Randomize every part of the song (key, chords, lengths, bars, tempo, melody, sounds, drums); one undo step'; quick.classList.add('gx-all');
    const dlgBtn = ui.button(r1, { label: '🎲 Randomize…', onClick: () => openRandom() });
    dlgBtn.title = 'Choose what to randomize, with a seed to come back to a result'; dlgBtn.classList.add('gx-rand');
    let dlg = null;
    function openRandom() {
      if (dlg) return;
      const D = dlg = ui.modal('mel-rnd', 'Randomize');
      D.onClose = () => { dlg = null; };
      const B = D.body, cks = {};
      B.append(ui.h('div', 'vh-desc', 'Tick what the dice may change; everything else stays as it is. The same seed with the same ticks gives the same result.'));
      G.RAND_PARTS.forEach(([id, label, desc]) => {
        const row = ui.h('label', 'mel-rnd-ck'), cb = ui.h('input'), tx = ui.h('span', 'mel-rnd-tx');
        cb.type = 'checkbox'; cb.checked = !!prefs.parts[id]; cb.dataset.part = id; cks[id] = cb;
        tx.append(ui.h('b', null, label), ui.h('span', 'mel-rnd-ds', desc));
        cb.addEventListener('change', () => { prefs.parts[id] = cb.checked; savePrefs(); go.disabled = !anyOn(); });
        row.append(cb, tx); B.append(row);
      });
      const anyOn = () => G.RAND_PARTS.some(([id]) => cks[id].checked);
      const sl = ui.slider(B, { label: 'Adventure', min: 0, max: 1, step: 0.05, value: prefs.spice, fmt: (v) => Math.round(v * 100) + '%', onInput: (v) => { prefs.spice = v; savePrefs(); },
        desc: 'Low: plain chords of the key. High: sevenths, sus chords, secondary dominants and chords borrowed from other keys.' });
      sl.input.classList.add('mel-rnd-spice');
      const r2 = ui.h('div', 'vh-row'); B.append(r2);
      r2.append(ui.h('span', 'mel-lbl', 'Scope'));
      const scope = ui.select(r2, { label: 'Scope', value: prefs.scope, options: [{ value: 'section', label: 'Current section' }, { value: 'song', label: 'Whole song (all sections)' }],
        onChange: (v) => { prefs.scope = v; savePrefs(); } });
      scope.el.classList.add('mel-rnd-scope');
      const r3 = ui.h('div', 'vh-row'); B.append(r3);
      r3.append(ui.h('span', 'mel-lbl', 'Seed'));
      const seed = ui.h('input', 'mel-rnd-seed'); seed.type = 'text'; seed.maxLength = 24; seed.placeholder = 'new every time'; seed.setAttribute('aria-label', 'Seed');
      r3.append(seed);
      const dice = ui.button(r3, { label: '🎲', title: 'Pick a new seed', onClick: () => { seed.value = G.newSeed(); } });
      dice.classList.add('mel-rnd-dice'); dice.setAttribute('aria-label', 'New seed');
      const used = ui.h('div', 'vh-desc mel-rnd-used'); B.append(used);
      const showUsed = () => { used.textContent = lastSeed ? 'Last seed used: ' + lastSeed + ' (type it in the Seed field to get that result again)' : 'Leave the seed empty for a new result each time; type one to repeat a result.'; };
      showUsed();
      const run = (all) => {
        if (all) G.RAND_PARTS.forEach(([id]) => { cks[id].checked = true; prefs.parts[id] = true; });
        savePrefs();
        randomize({ seed: seed.value, parts: Object.assign({}, prefs.parts), scope: prefs.scope, spice: prefs.spice });
        showUsed();
      };
      const every = ui.button(D.foot, { label: 'Randomize everything', onClick: () => run(true) }); every.classList.add('mel-rnd-all');
      const go = ui.button(D.foot, { label: 'Randomize', onClick: () => run(false) }); go.classList.add('mel-rnd-go', 'primary');
      go.disabled = !anyOn();
    }
    M.cleanups.push(() => { if (dlg) dlg.close(); });

    // ---------- layer arpeggio (Settings > Sound) ----------
    const asec = M.ui.addPanelSection('Arpeggio', 24, { group: 'sound' });
    asec.append(ui.h('div', 'vh-desc', 'Plays the active layer as an arpeggio: a placed note steps through the notes above it while it sounds; a line steps from wherever the line is.'));
    const ar = {};
    const arpSel = (key, label, options, cls) => {
      const row = ui.h('div', 'vh-row'); asec.append(row); row.append(ui.h('span', 'mel-lbl', label));
      const s = ui.select(row, { label, value: options[0].value, options, onChange: () => setArp() });
      s.el.classList.add(cls); ar[key] = s; return s;
    };
    arpSel('pat', 'Pattern', [{ value: 'off', label: 'Off' }, { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }, { value: 'updown', label: 'Up-down' }, { value: 'random', label: 'Random' }], 'gx-arp-pat');
    arpSel('rate', 'Rate', [{ value: '1/8', label: '1/8' }, { value: '1/16', label: '1/16' }, { value: '1/16t', label: '1/16 triplet' }, { value: '1/32', label: '1/32' }], 'gx-arp-rate');
    arpSel('oct', 'Range', [{ value: '1', label: '1 octave' }, { value: '2', label: '2 octaves' }], 'gx-arp-oct');
    arpSel('from', 'Notes from', [{ value: 'chord', label: 'Chord tones' }, { value: 'bands', label: 'Bright bands' }], 'gx-arp-from');
    function syncArp() {
      const l = M.song.layers[M.active], a = l && md.arpIn(l.arp);
      ar.pat.value = a ? a.pat : 'off'; ar.rate.value = a ? a.rate : '1/16'; ar.oct.value = String(a ? a.oct : 1); ar.from.value = a ? a.from : 'chord';
      ['rate', 'oct', 'from'].forEach((k) => { ar[k].el.disabled = !a; });
    }
    function setArp() {
      const l = M.song.layers[M.active];
      if (!l) return;
      if (ar.pat.value === 'off') delete l.arp;
      else l.arp = md.arpIn({ pat: ar.pat.value, rate: ar.rate.value, oct: +ar.oct.value, from: ar.from.value });
      M.engine.stopLayer(M.active);
      M.commit(l.arp ? 'Arpeggio' : 'Arpeggio off');
    }
    syncArp(); M.on('song', syncArp); M.on('layer', syncArp);

    // Arp steps are shown as small ticks under the notes / along the lines of arpeggio layers.
    M.on('draw', (c, view) => {
      const S = M.song;
      if (!S.layers.some((l) => l.arp)) return;
      const t0 = Math.max(0, view.t16Of(view.scrollX) - 1), t1 = Math.min(md.tot16(S), view.t16Of(view.scrollX + view.GW) + 1), h = Math.max(2, Math.min(5, view.noteH() * 0.4));
      S.layers.forEach((l, L) => {
        const a = md.arpIn(l.arp);
        if (!a) return;
        const r = md.ARP_RATE[a.rate];
        c.fillStyle = l.color; c.globalAlpha = 0.7;
        const tick = (t, m, off) => c.fillRect(Math.round(view.xOf(t)), Math.round(view.yOf(m) + off), 1, h);
        for (const n of l.notes) {
          if (n.s >= t1 || n.s + n.d <= t0) continue;
          for (let t = n.s + Math.max(0, Math.floor((t0 - n.s) / r)) * r; t < Math.min(n.s + n.d, t1); t += r) tick(t, n.m, view.noteH() / 2 + 1);
        }
        for (const st of md.strokes(l)) {
          for (let j = Math.ceil(t0 / r); j * r < t1; j++) { const m = st.v[Math.floor(j * r * 3 + 1e-6)]; if (m === m) tick(j * r, m, 3); }
        }
        c.globalAlpha = 1;
      });
    });
    // Pitch sets for arps in bands mode of a song being exported (flat song / loop slice): see MELODY.md.
    const arpPeaks = (src, L) => (t) => {
      let k = M.song.cur, loc = t + (src.arpOff || 0);
      if (src.flat) {
        const its = src.flat.items;
        let it = its[its.length - 1];
        for (const x of its) if (t >= x.a - 1e-9 && t < x.a + x.n - 1e-9) { it = x; break; }
        k = it.k; loc = t - it.a;
      }
      let pk;
      if (k === M.song.cur) { const at = M.bandsAt(loc, L); pk = at ? (at.matchPeaks ? at.matchPeaks() : at.peaks()) : []; }
      else pk = M.bands.peaksOf ? M.bands.peaksOf(md.chordAt(src, t), L) : [];
      return pk.map((m) => md.gridSnap(M.song, m));
    };

    // ---------- bandExtras ----------
    let ver = 0, doneVer = -1, perLayer = [], assembled = new Map(), timer = 0, dirtyAt = 0;
    const stats = { computeMs: 0, delayMs: 0, runs: 0 };
    function compute() {
      const t0 = performance.now(), S = M.song, cols = S.grid === 16 ? 16 : 8;
      perLayer = S.layers.map((l, L) => {
        if (!(md.layerGain(S, L) > 0)) return null;
        const sp = M.bands.spectrumOf(M.soundOf(L)).slice().sort((a, b) => b[1] - a[1]).slice(0, 8).sort((a, b) => a[0] - b[0]);
        const g = Math.min(1, md.layerGain(S, L) / 0.8);
        return { sp, g, bars: Array.from({ length: S.chords.length }, (_, b) => sounding(S, md, L, b, cols)) };
      });
      const old = assembled;
      assembled = new Map();
      doneVer = ver;
      stats.computeMs = performance.now() - t0; stats.runs++;
      if (dirtyAt) { stats.delayMs = performance.now() - dirtyAt; dirtyAt = 0; }
      return old;
    }
    function extras(bar, L) {
      const k = bar + ':' + L;
      if (assembled.has(k)) return assembled.get(k);
      const all = [];
      perLayer.forEach((p, i) => {
        if (!p || i === L || !p.bars[bar]) return;
        for (const e of p.bars[bar].values()) all.push({ m: e.m, w: e.w * p.g, sp: p.sp });
      });
      all.sort((a, b) => b.w - a.w || a.m - b.m);
      const out = all.slice(0, MAX_EXTRAS).map((e) => {
        const w = Math.round(e.w * 20) / 20;
        return { hz: Math.round(VH.audio.midiToHz(e.m) * 100) / 100, spectrum: e.sp.map(([r, a]) => [r, Math.round(a * w * 1000) / 1000]) };
      }).filter((e) => e.spectrum.some((p) => p[1] > 0));
      assembled.set(k, out);
      return out;
    }
    function refreshBands() {
      if (!alive || !M.song.bandsOthers) return;
      const before = JSON.stringify(M.song.layers.map((_, L) => Array.from({ length: M.song.chords.length }, (_, b) => extras(b, L))));
      compute();
      const after = JSON.stringify(M.song.layers.map((_, L) => Array.from({ length: M.song.chords.length }, (_, b) => extras(b, L))));
      if (before !== after) {   // the bands cache is keyed by the extras, so unchanged bars are reused
        M.markBandsDirty();
      }
    }
    function schedule() {
      ver++;
      if (!M.song.bandsOthers) return;
      if (!dirtyAt) dirtyAt = performance.now();
      M.forget(timer);
      timer = M.later(() => { timer = 0; refreshBands(); }, DEBOUNCE);
    }
    M.hooks.bandExtras = (bar, L) => {
      if (doneVer < 0 || perLayer.length !== M.song.layers.length) compute();   // first use: compute now
      return extras(bar, L);
    };
    M.on('song', schedule);
    M.on('sounds', schedule);

    const api = { progression: (S) => progression(S || M.song, md, rnd), genProgression, genMelody, randomize, arpPeaks, prefs, stats, last: null, lastSeed: '', opts,
      extras: (b, L) => M.hooks.bandExtras(b, L), get pending() { return !!timer; } };
    NS.generatePart = api;
    return {
      destroy() {
        alive = false;
        M.forget(timer);
        if (M.hooks.bandExtras) M.hooks.bandExtras = null;
        if (NS.generatePart === api) NS.generatePart = null;
      },
    };
  });
})();
