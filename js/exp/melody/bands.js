// melody/bands.js - the harmony map. For each bar, every candidate pitch (rows LO..HI) is scored against that bar's
// chord: candidate partials come from the LAYER's spectrum, chord partials from the BACKING instrument's spectrum
// (mixed spectra). Optional extra voices (M.hooks.bandExtras, used when "Bands include other layers" is on) are added.
(function () {
  'use strict';
  const VH = window.VH, H = VH.harmony, NS = VH.melody, md = NS.model;
  const { LO, HI, SPAN, clamp, chordMidis } = md;
  const R = 301, RPS = (R - 1) / SPAN;   // rows, rows per semitone
  const rowMidi = (r) => LO + r / (R - 1) * SPAN;

  function pal(t) {   // harmony palette: navy -> violet -> cyan -> white
    const c0 = [0.03, 0.04, 0.16], c1 = [0.38, 0.10, 0.55], c2 = [0.0, 0.75, 0.86], c3 = [1, 1, 1];
    const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
    return t < 0.33 ? mix(c0, c1, t / 0.33) : t < 0.66 ? mix(c1, c2, (t - 0.33) / 0.33) : mix(c2, c3, (t - 0.66) / 0.34);
  }
  function tilt(sp, b) {   // local stand-in for a tone filter when the core can't apply it to the spectrum
    const out = sp.map(([r, a]) => [r, a * Math.pow(r, b)]), mx = Math.max(...out.map((p) => p[1])) || 1;
    return out.map(([r, a]) => [r, a / mx]);
  }
  // The truthful spectrum of a sound, including its tone (bright) when it has one.
  function spectrumOf(s) {
    if (!s) return VH.sounds.spectrumOf(null);
    if (VH.sounds.toneOf) return VH.sounds.spectrumOf(s);   // core applies the sound's own tone
    const sp = VH.sounds.spectrumOf(s);
    return s.tone && s.tone.bright ? tilt(sp, s.tone.bright) : sp;
  }

  NS.Bands = function (M) {
    const cache = new Map(), off = document.createElement('canvas'), cols = [];
    let specs = [], keys = [], bSpec = null, bKey = '', bgFor = '';
    const api = { R, RPS, rowMidi, off, cols, dirty: true, spectrumOf };

    // Recompute layer + backing spectra; marks the background dirty when the active layer's map changed.
    api.refresh = function () {
      const S = M.song;
      specs = S.layers.map((_, L) => spectrumOf(M.soundOf(L)));
      keys = specs.map((s) => JSON.stringify(s));
      bSpec = spectrumOf(M.backingSound()); bKey = JSON.stringify(bSpec);
      const k = keys[M.active] + '|' + bKey;
      if (k !== bgFor) api.dirty = true;
    };
    api.invalidate = function () { cache.clear(); api.dirty = true; M.requestRender(); };
    function extras(b, L) {
      const S = M.song;
      if (!S.bandsOthers || typeof M.hooks.bandExtras !== 'function') return null;
      try {
        const x = M.hooks.bandExtras(b, L);
        return Array.isArray(x) && x.length ? x.filter((e) => e && e.hz > 0) : null;
      } catch (err) { console.error('[melody] bandExtras hook failed', err); return null; }
    }
    function cross(f, chordHz, PS, BS, ex) {   // dissonance between one candidate note and the chord (+ extra voices)
      let d = 0;
      for (const fc of chordHz) for (const [ri, ai] of PS) for (const [rj, aj] of BS) d += H.pairDissonance(f * ri, ai, fc * rj, aj);
      if (ex) for (const e of ex) for (const [ri, ai] of PS) for (const [rj, aj] of (e.spectrum || BS)) d += H.pairDissonance(f * ri, ai, e.hz * rj, aj);
      return d;
    }
    api.cross = function (f, b, L) {
      const ch = M.song.chords[b];
      if (!ch) return 0;
      if (!specs[L]) api.refresh();
      return cross(f, chordMidis(ch).map(H.midiToHz), specs[L], bSpec, extras(b, L));
    };

    // Column for bar b scored with layer L's spectrum: { D, V, px, chord } (cached).
    api.column = function (b, L) {
      const S = M.song, ch = S.chords[b];
      if (!specs[L]) api.refresh();
      if (!specs[L]) L = 0;
      const ex = ch ? extras(b, L) : null;
      const key = keys[L] + '|' + bKey + '|' + (ch ? ch.join('') : '-') + (ex ? '|' + JSON.stringify(ex) : '');
      let c = cache.get(key);
      if (c) return c;
      if (cache.size > 160) cache.clear();
      const D = new Float32Array(R), V = new Float32Array(R), px = new Uint8ClampedArray(R * 4);
      if (!ch) {
        V.fill(1);
        const k = pal(0.07);
        for (let r = 0; r < R; r++) px.set([k[0] * 255, k[1] * 255, k[2] * 255, 255], r * 4);
      } else {
        const hz = chordMidis(ch).map(H.midiToHz), w = Math.round(7 * RPS), PS = specs[L];
        for (let r = 0; r < R; r++) D[r] = cross(H.midiToHz(rowMidi(r)), hz, PS, bSpec, ex);
        // Compare each row with its ±7-semitone neighbourhood so bands read evenly, then normalise.
        for (let r = 0; r < R; r++) {
          let lo = Infinity, hi = -Infinity;
          for (let q = Math.max(0, r - w); q <= Math.min(R - 1, r + w); q++) { lo = Math.min(lo, D[q]); hi = Math.max(hi, D[q]); }
          V[r] = 0.75 * (D[r] - lo) / ((hi - lo) || 1) + 0.25 * D[r];
        }
        let mn = Infinity, mx = -Infinity;
        for (let r = 0; r < R; r++) { mn = Math.min(mn, V[r]); mx = Math.max(mx, V[r]); }
        const t = new Float32Array(R), halo = new Float32Array(R);
        for (let r = 0; r < R; r++) { V[r] = (V[r] - mn) / ((mx - mn) || 1); t[r] = 1 - V[r] ** 0.75; }
        for (let r = 1; r < R - 1; r++) {   // soft glow around consonant peaks
          if (t[r] < 0.62 || t[r] < t[r - 1] || t[r] < t[r + 1]) continue;
          const str = (t[r] - 0.62) / 0.38;
          for (let q = Math.max(0, r - 14); q <= Math.min(R - 1, r + 14); q++) halo[q] = Math.max(halo[q], str * Math.exp(-(((q - r) / 5.5) ** 2)));
        }
        for (let r = 0; r < R; r++) {
          const k = pal(t[r]), g = 0.5 * halo[r] * (1 - t[r]), G = [0.55, 0.95, 1];
          px.set([0, 1, 2].map((i) => (k[i] + (G[i] - k[i]) * g) * 255).concat(255), r * 4);
        }
      }
      c = { D, V, px, chord: ch };
      cache.set(key, c);
      return c;
    };

    // Background image (1 px per bar x R rows) for the active layer.
    api.computeBg = function () {
      const S = M.song, A = M.active;
      api.refresh();
      off.width = S.bars; off.height = R;
      const octx = off.getContext('2d'), img = octx.createImageData(S.bars, R);
      for (let b = 0; b < S.bars; b++) {
        const c = cols[b] = api.column(b, A);
        for (let r = 0; r < R; r++) img.data.set(c.px.subarray(r * 4, r * 4 + 4), ((R - 1 - r) * S.bars + b) * 4);
      }
      cols.length = S.bars;
      octx.putImageData(img, 0, 0);
      bgFor = keys[A] + '|' + bKey;
      api.dirty = false;
    };

    // 0..1 consonance of midi m in bar b for layer L (NaN without a chord).
    api.consonance = function (m, b, L) {
      L = L == null ? M.active : L;
      if (!M.song.chords[b]) return NaN;
      const V = api.column(b, L).V, rf = clamp((m - LO) * RPS, 0, R - 1), r = Math.min(R - 2, Math.floor(rf)), u = rf - r;
      return 1 - (V[r] * (1 - u) + V[r + 1] * u) ** 0.75;
    };
    // ---------- fitting to the backing: equal temperament (default) or pure intonation ----------
    // The backing plays equal-tempered chords, so by default every snap lands on a whole semitone (integer midi), picked
    // by band consonance plus chord / key membership. api.pure (Settings > Edit > Advanced "Pure intonation",
    // VH.store 'melody.pureIntonation') restores the exact band maxima (often a few cents off: just thirds, 7/4 ...).
    api.pure = VH.store.get('melody.pureIntonation', false) === true;
    const pcOf = (m) => ((Math.round(m) % 12) + 12) % 12;
    const FIT = { chord: 0.6, key: 0.25, dist: 0.15, against: 0.05, reverse: 0.5, flat: 0.3, pct: 0.6 };
    api.FIT = FIT;
    const ctxMemo = new WeakMap();
    // Fit context of bar b for layer L (null without a chord): consonance at each ET semitone, the bar's threshold
    // (60th percentile of those values), chord / key tests and the candidate scoring used by auto-fit and the snaps.
    api.fitCtx = function (b, L) {
      L = L == null ? M.active : L;
      const S = M.song, ch = S.chords[b];
      if (!ch) return null;
      const col = api.column(b, L), mk = S.key + S.mode + ch.join('');
      let mm = ctxMemo.get(col);
      if (!mm) { mm = new Map(); ctxMemo.set(col, mm); }
      if (mm.has(mk)) return mm.get(mk);
      const cons = new Float32Array(SPAN + 1);
      for (let m = LO; m <= HI; m++) {
        const rf = (m - LO) * RPS, r = Math.min(R - 2, Math.floor(rf)), u = rf - r;
        cons[m - LO] = 1 - (col.V[r] * (1 - u) + col.V[r + 1] * u) ** 0.75;
      }
      const sorted = Array.from(cons).sort((a, z) => a - z), thr = sorted[Math.min(SPAN, Math.floor(FIT.pct * SPAN))];
      const chordPc = new Set(chordMidis(ch).map((m) => m % 12));
      const keyPc = new Set(md.scaleOf(S).steps.map((x) => (S.key + x) % 12));
      const c = (m) => cons[clamp(Math.round(m), LO, HI) - LO];
      const isChord = (m) => chordPc.has(pcOf(m)), isKey = (m) => keyPc.has(pcOf(m));
      const fits = (m) => isChord(m) || (isKey(m) && c(m) >= thr - 1e-6);
      // dir: the melody's direction into this pitch (-1 | 0 | 1); prev: the (already fitted) previous pitch, so the
      // contour is kept: landing on the other side of prev (a reversed step) costs a lot, a step flattened to a repeat a little.
      const score = (n, from, dir, prev) => {
        const mv = n - from;
        let sc = c(n) + (isChord(n) ? FIT.chord + 1e-4 : 0) + (isKey(n) ? FIT.key : 0) - FIT.dist * Math.abs(mv) -
          (dir && Math.abs(mv) > 0.5 && Math.sign(mv) !== Math.sign(dir) ? FIT.against : 0);
        if (dir && prev != null) { const st = n - prev; if (Math.abs(st) < 0.25) sc -= FIT.flat; else if (Math.sign(st) !== dir) sc -= FIT.reverse; }
        return sc;
      };
      // Best ET semitone for pitch p (within ±2): p's own semitone when it already fits, else the best-scoring fitting
      // candidate (smallest move, keeping the melodic direction, ties to chord tones).
      const best = (p, dir, prev) => {
        const base = clamp(Math.round(p), LO, HI);
        if (fits(base)) return base;
        // tiers: 3 = fits and keeps the contour, 2 = a chord / key tone that keeps the contour, 1 = fits, 0 = anything
        const keeps = (n) => !dir || prev == null || (Math.abs(n - prev) >= 0.25 && Math.sign(n - prev) === dir);
        let bn = base, bs = -Infinity, bt = -1;
        for (let n = Math.max(LO, base - 2); n <= Math.min(HI, base + 2); n++) {
          const f = fits(n), k = keeps(n), t = f && k ? 3 : k && (isChord(n) || isKey(n)) ? 2 : f ? 1 : 0, s = score(n, p, dir, prev);
          if (t > bt || (t === bt && s > bs)) { bn = n; bs = s; bt = t; }
        }
        return bn;
      };
      const x = { bar: b, layer: L, chord: ch, cons, thr, c, isChord, isKey, fits, score, best };
      mm.set(mk, x);
      return x;
    };
    // Snap while drawing (ET): the whole semitone within ±1.5 of m that is bright and close (chord / key tones preferred).
    function snapET(m, b, L) {
      const x = api.fitCtx(b, L);
      if (!x) return clamp(Math.round(m), LO, HI);
      let bn = clamp(Math.round(m), LO, HI), bs = -Infinity;
      for (let n = Math.max(LO, Math.ceil(m - 1.5)); n <= Math.min(HI, Math.floor(m + 1.5)); n++) {
        const s = x.c(n) + (x.isChord(n) ? 0.35 : 0) + (x.isKey(n) ? 0.15 : 0) - 0.6 * Math.abs(n - m);
        if (s > bs) { bs = s; bn = n; }
      }
      return bn;
    }
    // Snap: ET by default; with api.pure the nearest bright band, refined to 1 cent (snapPure).
    api.snap = function (m, b, L) {
      L = L == null ? M.active : L;
      return api.pure ? api.snapPure(m, b, L) : snapET(m, b, L);
    };
    // Nearest bright band (local dissonance minimum, weighted by brightness) within ±1.5 semitones, refined to 1 cent.
    api.snapPure = function (m, b, L) {
      L = L == null ? M.active : L;
      const ch = M.song.chords[b];
      if (!ch) return Math.round(m);
      const c = api.column(b, L), rf = (m - LO) * RPS, w = 1.5 * RPS;
      let best = -1, bs = Infinity;
      for (let r = Math.max(1, Math.ceil(rf - w)); r <= Math.min(R - 2, Math.floor(rf + w)); r++) {
        if (c.D[r] > c.D[r - 1] || c.D[r] > c.D[r + 1]) continue;
        const sc = Math.abs(r - rf) / RPS + 1.2 * c.V[r];
        if (sc < bs) { bs = sc; best = r; }
      }
      if (best < 0) return Math.round(m);
      let bm = rowMidi(best), bd = Infinity;
      for (let k = -13; k <= 13; k++) {
        const t = rowMidi(best) + k / 100;
        if (t < LO || t > HI) continue;
        const d = api.cross(H.midiToHz(t), b, L);
        if (d < bd) { bd = d; bm = t; }
      }
      return bm;
    };
    // Public band data at time t16 (sixteenths) for layer L. See MELODY.md (M.bandsAt).
    api.at = function (t16, L) {
      const S = M.song;
      L = L == null ? M.active : clamp(L | 0, 0, S.layers.length - 1);
      const b = clamp(Math.floor(t16 / md.SPB), 0, S.bars - 1), c = api.column(b, L);
      return {
        bar: b, chord: S.chords[b], layer: L, rows: R, D: c.D, V: c.V,
        midiOfRow: rowMidi, rowOfMidi: (m) => clamp((m - LO) * RPS, 0, R - 1),
        consonance: (m) => api.consonance(m, b, L), snap: (m) => api.snap(m, b, L),
        peaks() {   // midi of local consonance maxima, brightest first
          if (!c.chord) return [];
          const out = [];
          for (let r = 1; r < R - 1; r++) if (c.V[r] <= c.V[r - 1] && c.V[r] <= c.V[r + 1] && c.V[r] < 0.5) out.push([rowMidi(r), c.V[r]]);
          return out.sort((a, z) => a[1] - z[1]).map((p) => p[0]);
        },
      };
    };
    return api;
  };
})();
