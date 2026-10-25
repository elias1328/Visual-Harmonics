// melody/generate.js - part: "🎲 Progression", "🎲 Melody" (+ "🎲 again") and the M.hooks.bandExtras
// implementation behind "Bands include other layers". See MELODY.md.
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody;
  if (!NS || !NS.parts) return;

  // Templates as scale degrees (1-based) of the current mode. home = the mode they are idiomatic in.
  const TEMPLATES = [
    { deg: [1, 5, 6, 4], home: 'major', w: 4 },   // I–V–vi–IV
    { deg: [6, 4, 1, 5], home: 'major', w: 3 },   // vi–IV–I–V
    { deg: [1, 6, 2, 5], home: 'major', w: 3 },   // I–vi–ii–V
    { deg: [2, 5, 1, 1], home: 'major', w: 2 },   // ii–V–I–I
    { deg: [1, 4, 5, 4], home: 'major', w: 3 },   // I–IV–V–IV
    { deg: [1, 6, 3, 7], home: 'minor', w: 4 },   // i–VI–III–VII
    { deg: [1, 4, 5, 1], home: 'minor', w: 3 },   // i–iv–v–i
  ];
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
  // Progression of a scale other than major / minor: a modal template when the scale has one (and its chords exist),
  // else a generic one from the chords that fit the scale (tonic, two others, home or another at a phrase end).
  function modalProgression(S, md, rnd) {
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
    // now and then the mode's characteristic chord turns a phrase's last bar (on its second half)
    const nb = md.spb(S), half = md.tsOf(S).beats[Math.floor(md.tsOf(S).beats.length / 2)] || nb / 2, ev = [];
    const cad = mt ? onDeg(mt.cad) : null;
    out.forEach((c, b) => {
      ev.push({ at: b * nb, chord: c });
      const last = b % 4 === 3 || b === S.bars - 1;
      if (cad && last && half > 0 && S.bars > 1 && !(c[0] === cad[0] && c[1] === cad[1]) && rnd() < 0.45) ev.push({ at: b * nb + half, chord: cad.slice() });
    });
    return ev;
  }
  const BORROW_P = 0.12;
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

  // ---------- progression ----------
  function progression(S, md, rnd) {
    if (S.mode !== 'major' && S.mode !== 'minor') return modalProgression(S, md, rnd);
    const dia = md.diatonic(S), minor = S.mode === 'minor';
    const chordOf = (d) => { const c = dia[(d - 1) % 7]; return [c[0], c[1]]; };
    const usable = TEMPLATES.filter((t) => !(t.home === 'minor' && !minor && t.deg.includes(7))).map((t) => [t, t.home === S.mode ? t.w : t.w * 0.2]);
    const borrowed = minor ? [[(S.key + 5) % 12, 'maj'], [(S.key + 7) % 12, 'maj']]                    // IV, V (from major / harmonic minor)
      : [[(S.key + 8) % 12, 'maj'], [(S.key + 10) % 12, 'maj'], [(S.key + 5) % 12, 'min']];       // bVI, bVII, iv
    const phrase = (t, last) => t.deg.map((d, k) => {
      if (k > 0 && rnd() < BORROW_P) return borrowed[Math.floor(rnd() * borrowed.length)].slice();
      if (minor && d === 5 && k === t.deg.length - 1 && rnd() < 0.35) return [(S.key + 7) % 12, 'maj'];   // dominant V in minor
      if (last && k === t.deg.length - 1 && d !== 1 && rnd() < 0.4) return chordOf(1);                    // end home
      return chordOf(d);
    });
    const A = wpick(usable, rnd), n = Math.ceil(S.bars / 4), out = [];
    let B = wpick(usable, rnd);
    for (let p = 0; p < n; p++) {
      // 4 bars: A. 8 bars: A A' or A B. 16 bars: A A B A. (Other lengths: phrases of 4, cut at the end.)
      const t = n === 2 ? (p === 0 || rnd() < 0.5 ? A : B) : n === 4 ? (p === 2 ? B : A) : A;
      out.push(...phrase(t, n > 1 && p === n - 1));
    }
    out.length = S.bars;
    // chord events: one chord per bar, and now and then two in a phrase's last bar (a turn towards the next phrase:
    // V on the bar's second half, or IV / ii then V when the bar already holds V)
    const nb = md.spb(S), half = md.tsOf(S).beats[Math.floor(md.tsOf(S).beats.length / 2)] || nb / 2, ev = [];
    const V5 = chordOf(5), pre = chordOf(minor ? 4 : 2), same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
    out.forEach((c, b) => {
      ev.push({ at: b * nb, chord: c });
      const last = b % 4 === 3 || b === S.bars - 1;
      if (last && half > 0 && S.bars > 1 && rnd() < 0.55) {
        if (same(c, V5)) { ev[ev.length - 1].chord = pre; ev.push({ at: b * nb + half, chord: V5.slice() }); } else ev.push({ at: b * nb + half, chord: V5.slice() });
      }
    });
    return ev;
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
    const [lo, hi] = RANGES[o.range] || RANGES.mid, unit = o.notes ? (S.grid === 16 ? 1 : 2) : 1;
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
    sec.append(ui.h('div', 'vh-desc', 'Progressions fit the key and its scale (modes get their own moves, e.g. Dorian i–IV, Phrygian i–bII; now and then a borrowed chord). Melodies walk the bright bands of the active layer and end phrases on chord tones; Line or Notes follows the layer’s mode.'));

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

    // ---------- bandExtras ----------
    let ver = 0, doneVer = -1, perLayer = [], assembled = new Map(), timer = 0, dirtyAt = 0;
    const stats = { computeMs: 0, delayMs: 0, runs: 0 };
    function compute() {
      const t0 = performance.now(), S = M.song, cols = S.grid || 8;
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

    const api = { progression: (S) => progression(S || M.song, md, rnd), genProgression, genMelody, stats, last: null, opts,
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
