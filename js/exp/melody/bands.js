// melody/bands.js - the harmony map. For each chord region (a bar, or part of a split bar; `b` below = region index), every candidate pitch (rows LO..HI) is scored against that bar's
// chord: candidate partials come from the LAYER's spectrum, chord partials from the BACKING instrument's spectrum
// (mixed spectra). Optional extra voices (M.hooks.bandExtras, used when "Bands include other layers" is on) are added.
(function () {
  'use strict';
  const VH = window.VH, H = VH.harmony, NS = VH.melody, md = NS.model;
  const { LO, HI, SPAN, clamp, chordMidis } = md;
  const R = 301, RPS = (R - 1) / SPAN;   // rows, rows per semitone
  const rowMidi = (r) => LO + r / (R - 1) * SPAN;

  function pal(t, st) {   // harmony palette: navy -> violet -> cyan -> white (st: stops from md.lookStops; the default = Aurora)
    const c0 = st && st.c0 ? st.c0 : [0.03, 0.04, 0.16], c1 = st ? st.c1 : [0.38, 0.10, 0.55], c2 = st ? st.c2 : [0.0, 0.75, 0.86], c3 = st ? st.c3 : [1, 1, 1];
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
    // Map look (view preference, VH.store 'melody.look'): applied at draw time to the cached columns, no recompute.
    let look = md.lookIn(VH.store.get('melody.look', null)), lookK = '';
    const isDef = () => JSON.stringify(look) === JSON.stringify(md.lookIn(null)) || (look.clarity === 0 && look.thick === 50 && look.glow === 50 && look.dark === 50 && look.theme === 'aurora');
    const keyOfLook = () => (isDef() ? '' : [look.clarity, look.thick, look.glow, look.dark, look.theme].join(','));
    lookK = keyOfLook();
    const api = { look: () => look, lookKey: () => lookK, R, RPS, rowMidi, off, cols, dirty: true, spectrumOf };

    // Recompute layer + backing spectra; marks the background dirty when the active layer's map changed.
    api.refresh = function () {
      const S = M.song;
      specs = S.layers.map((_, L) => spectrumOf(M.soundOf(L)));
      keys = specs.map((s) => JSON.stringify(s));
      bSpec = spectrumOf(M.backingSound()); bKey = JSON.stringify(bSpec);
      const k = keys[M.active] + '|' + bKey + '|' + (S.tension || 0) + '|' + lookK;
      if (k !== bgFor) api.dirty = true;
    };
    api.setLook = function (patch, save) {
      look = md.lookIn(Object.assign({}, look, patch)); lookK = keyOfLook();
      if (save !== false) VH.store.set('melody.look', look);
      api.dirty = true; M.requestRender(); M.emit('look', look);
      return look;
    };
    api.resetLook = () => { VH.store.set('melody.look', null); return api.setLook(md.lookIn(null), false); };
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
      const ch = md.regionChord(M.song, b);
      if (!ch) return 0;
      if (!specs[L]) api.refresh();
      return cross(f, chordMidis(ch, M.song).map(H.midiToHz), specs[L], bSpec, extras(b, L));
    };

    // Pixels (R x RGBA) for a highlight curve t (0..1 per row): palette + soft glow around its peaks.
    function paint(t, tint, gm) {
      const out = new Uint8ClampedArray(R * 4), halo = new Float32Array(R), G = tint ? tint.G : [0.55, 0.95, 1];
      for (let r = 1; r < R - 1; r++) {   // soft glow around the highlighted peaks
        if (t[r] < 0.62 || t[r] < t[r - 1] || t[r] < t[r + 1]) continue;
        const str = (t[r] - 0.62) / 0.38;
        for (let q = Math.max(0, r - 14); q <= Math.min(R - 1, r + 14); q++) halo[q] = Math.max(halo[q], str * Math.exp(-(((q - r) / 5.5) ** 2)));
      }
      for (let r = 0; r < R; r++) {
        const k = pal(t[r], tint), g = 0.5 * halo[r] * (1 - t[r]) * (gm == null ? 1 : gm);
        out.set([0, 1, 2].map((i) => (k[i] + (G[i] - k[i]) * g) * 255).concat(255), r * 4);
      }
      return out;
    }
    const tm = md.tensionH;
    api.tension = () => M.song.tension || 0;
    // Highlight h per row for tension T (null at 0 = the consonance itself), cached on the column.
    function hRows(col, T) {
      if (!(T > 0) || !col.chord) return null;
      if (col.hT && col.hT.T === T) return col.hT.H;
      const H = new Float32Array(R);
      for (let r = 0; r < R; r++) H[r] = tm(1 - col.V[r] ** 0.75, T);
      col.hT = { T, H };
      return H;
    }
    // Pixels of a column for tension T (the calm ones at 0 or without a chord), cached on the column.
    const glowMul = () => look.glow / 50 * (1 - 0.85 * look.clarity / 100);
    function lookPx(col, T) {   // the column's pixels under the current look (cached per look key + tension)
      const k = lookK + '|' + T;
      if (col.pxL && col.pxL.k === k) return col.pxL.px;
      const tint = T > 0 && col.chord ? md.tensionTint(T) : null, st = md.lookStops(look.theme, tint, look.dark);
      let px;
      if (!col.chord) { px = new Uint8ClampedArray(R * 4); const c = pal(0.07, st); for (let r = 0; r < R; r++) px.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], r * 4); }
      else px = paint(md.lookCurve(hRows(col, T) || col.t, look), st, glowMul());
      col.pxL = { k, px };
      return px;
    }
    api.pixels = function (col, T) {
      if (lookK) return lookPx(col, T);
      if (!(T > 0) || !col.chord) return col.px;
      if (col.pxT && col.pxT.T === T) return col.pxT.px;
      const px = paint(hRows(col, T), md.tensionTint(T));
      col.pxT = { T, px };
      return px;
    };
    // Column for bar b scored with layer L's spectrum: { D, V, px, chord } (cached).
    api.column = function (b, L) {
      const S = M.song, ch = md.regionChord(S, b);
      if (!specs[L]) api.refresh();
      if (!specs[L]) L = 0;
      const ex = ch ? extras(b, L) : null;
      const tn = md.tuningOf(S), key = keys[L] + '|' + bKey + '|' + (ch ? ch.join('') + (tn !== '12tet' ? '|' + tn + (ch.kp != null ? ch.kp : S.key) : '') : '-') + (ex ? '|' + JSON.stringify(ex) : '');
      let c = cache.get(key);
      if (c) return c;
      if (cache.size > 160) cache.clear();
      const D = new Float32Array(R), V = new Float32Array(R), px = new Uint8ClampedArray(R * 4); let tt = null;
      if (!ch) {
        V.fill(1);
        const k = pal(0.07);
        for (let r = 0; r < R; r++) px.set([k[0] * 255, k[1] * 255, k[2] * 255, 255], r * 4);
      } else {
        const hz = chordMidis(ch, S).map(H.midiToHz), w = Math.round(7 * RPS), PS = specs[L];
        for (let r = 0; r < R; r++) D[r] = cross(H.midiToHz(rowMidi(r)), hz, PS, bSpec, ex);
        // Compare each row with its ±7-semitone neighbourhood so bands read evenly, then normalise.
        for (let r = 0; r < R; r++) {
          let lo = Infinity, hi = -Infinity;
          for (let q = Math.max(0, r - w); q <= Math.min(R - 1, r + w); q++) { lo = Math.min(lo, D[q]); hi = Math.max(hi, D[q]); }
          V[r] = 0.75 * (D[r] - lo) / ((hi - lo) || 1) + 0.25 * D[r];
        }
        let mn = Infinity, mx = -Infinity;
        for (let r = 0; r < R; r++) { mn = Math.min(mn, V[r]); mx = Math.max(mx, V[r]); }
        const t = new Float32Array(R); tt = t;
        for (let r = 0; r < R; r++) { V[r] = (V[r] - mn) / ((mx - mn) || 1); t[r] = 1 - V[r] ** 0.75; }
        px.set(paint(t, null));
      }
      c = { D, V, px, chord: ch, t: ch ? tt : null };
      cache.set(key, c);
      return c;
    };

    // Background image (1 px per sixteenth x R rows) for the active layer; cols[i] = region i's column.
    api.computeBg = function () {
      const S = M.song, A = M.active, W = md.tot16(S), T = S.tension || 0;
      api.refresh();
      off.width = W; off.height = R;
      const octx = off.getContext('2d'), img = octx.createImageData(W, R);
      S.chords.forEach((e, i) => {
        const c = cols[i] = api.column(i, A), z = md.regionEnd(S, i), cpx = api.pixels(c, T);
        for (let x = e.at; x < z; x++) for (let r = 0; r < R; r++) img.data.set(cpx.subarray(r * 4, r * 4 + 4), ((R - 1 - r) * W + x) * 4);
      });
      cols.length = S.chords.length;
      octx.putImageData(img, 0, 0);
      bgFor = keys[A] + '|' + bKey + '|' + T + '|' + lookK;
      api.dirty = false;
    };

    // 0..1 consonance of midi m in bar b for layer L (NaN without a chord).
    api.consonance = function (m, b, L) {
      L = L == null ? M.active : L;
      if (!md.regionChord(M.song, b)) return NaN;
      const V = api.column(b, L).V, rf = clamp((m - LO) * RPS, 0, R - 1), r = Math.min(R - 2, Math.floor(rf)), u = rf - r;
      return 1 - (V[r] * (1 - u) + V[r + 1] * u) ** 0.75;
    };
    // 0..1 highlight h of midi m (the Tension dial's map value); equals the consonance at tension 0.
    api.match = function (m, b, L) {
      const c = api.consonance(m, b, L), T = api.tension();
      return T > 0 && !isNaN(c) ? tm(c, T) : c;
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
      const S = M.song, ch = md.regionChord(S, b);
      if (!ch) return null;
      const col = api.column(b, L), T = S.tension || 0, mk = S.key + S.mode + md.tuningOf(S) + ch.join('') + '|' + T;
      let mm = ctxMemo.get(col);
      if (!mm) { mm = new Map(); ctxMemo.set(col, mm); }
      if (mm.has(mk)) return mm.get(mk);
      // The tuning grid (md.gridOf): 12-TET = the integer midis LO..HI (as before); other tunings = their steps, anchored
      // at the key root. Everything below works on grid pitches: cons per grid pitch, chord / key tests by step class.
      const G = md.gridOf(S), P = G.pts, NP = P.length, gi = (m) => G.idx(clamp(m, LO, HI));
      const cons = new Float32Array(NP);
      for (let k = 0; k < NP; k++) {
        const rf = (P[k] - LO) * RPS, r = Math.min(R - 2, Math.floor(rf)), u = rf - r;
        cons[k] = tm(1 - (col.V[r] * (1 - u) + col.V[r + 1] * u) ** 0.75, T);
      }
      const chordCl = new Set(chordMidis(ch, S).map((m) => H.tuningClass(G.tuning, G.root, m)));
      const c = (m) => cons[gi(m)];
      const isChord = (m) => chordCl.has(G.cls[gi(m)]), isKey = (m) => G.scaleCls.has(G.cls[gi(m)]);
      // Tension: chord / key bonuses fade out as T rises (chord tones by 0.625, key tones at 1), and chord extensions
      // (7th / 9th / #11 / 11th / 13th over the root) get a bonus that peaks at Color (T ~ 0.5).
      const wC = Math.max(0, 1 - 1.6 * T), wK = 1 - T, wE = 0.45 * Math.max(0, 1 - Math.abs(T - 0.5) / 0.45), root = ch[0];
      const isExt = (m) => [2, 5, 6, 9, 10, 11].includes(((pcOf(P[gi(m)]) - root) % 12 + 12) % 12);
      const bon = (n) => (isChord(n) ? FIT.chord * wC + 1e-4 : 0) + (isKey(n) ? FIT.key * wK : 0) + (T > 0 && isExt(n) ? wE : 0);
      let thr;
      if (T > 0) {   // the target test: highlight (+ the faded bonuses) at least the bar's 70th percentile
        const sc = []; for (let k = 0; k < NP; k++) sc.push(cons[k] + bon(P[k]));
        sc.sort((a, z) => a - z); thr = sc[Math.min(NP - 1, Math.floor(0.7 * (NP - 1)))];
      } else { const sorted = Array.from(cons).sort((a, z) => a - z); thr = sorted[Math.min(NP - 1, Math.floor(FIT.pct * (NP - 1)))]; }
      const fits = T > 0 ? (m) => c(m) + bon(P[gi(m)]) >= thr - 1e-6 : (m) => isChord(m) || (isKey(m) && c(m) >= thr - 1e-6);
      // dir: the melody's direction into this pitch (-1 | 0 | 1); prev: the (already fitted) previous pitch, so the
      // contour is kept: landing on the other side of prev (a reversed step) costs a lot, a step flattened to a repeat a little.
      const score = (n, from, dir, prev) => {
        const mv = n - from;
        let sc = c(n) + (T > 0 ? bon(n) : (isChord(n) ? FIT.chord + 1e-4 : 0) + (isKey(n) ? FIT.key : 0)) - FIT.dist * Math.abs(mv) -
          (dir && Math.abs(mv) > 0.5 && Math.sign(mv) !== Math.sign(dir) ? FIT.against : 0);
        if (dir && prev != null) { const st = n - prev; if (Math.abs(st) < 0.25) sc -= FIT.flat; else if (Math.sign(st) !== dir) sc -= FIT.reverse; }
        return sc;
      };
      // Best grid pitch (ET semitone in 12-TET) for p (within ±2 semitones): p's own grid pitch when it already fits, else
      // the best-scoring fitting candidate (smallest move, keeping the melodic direction, ties to chord tones).
      const best = (p, dir, prev) => {
        const bi = gi(p), base = P[bi];
        if (fits(base)) return base;
        // tiers: 3 = fits and keeps the contour, 2 = a chord / key tone that keeps the contour, 1 = fits, 0 = anything
        const keeps = (n) => !dir || prev == null || (Math.abs(n - prev) >= 0.25 && Math.sign(n - prev) === dir);
        const win = T > 0 ? 3 : 2;   // a sparse target (Tense) may sit a little farther away
        let bn = base, bs = -Infinity, bt = -1;
        let j0 = bi; while (j0 > 0 && P[j0 - 1] >= base - win - 1e-6) j0--;
        for (let j = j0; j < NP && P[j] <= base + win + 1e-6; j++) {
          const n = P[j], f = fits(n), k = keeps(n), t = T > 0 ? (f && k ? 3 : f ? 2 : k ? 1 : 0) : f && k ? 3 : k && (isChord(n) || isKey(n)) ? 2 : f ? 1 : 0, s = score(n, p, dir, prev);
          if (t > bt || (t === bt && s > bs)) { bn = n; bs = s; bt = t; }
        }
        return bn;
      };
      const x = { bar: b, layer: L, chord: ch, tension: T, grid: G, pts: P, cons, thr, c, isChord, isKey, isExt, bon, fits, score, best };
      mm.set(mk, x);
      return x;
    };
    // Snap while drawing (tuning grid; ET semitones in 12-TET): the grid pitch within ±1.5 semitones of m that is bright and
    // close (chord / key tones preferred).
    function snapET(m, b, L) {
      const x = api.fitCtx(b, L), S = M.song;
      if (!x) return md.gridSnap(S, m);
      let bn = md.gridSnap(S, m), bs = -Infinity;
      const P = x.pts;
      for (let k = 0; k < P.length; k++) {
        const n = P[k];
        if (n < m - 1.5 - 1e-9 || n > m + 1.5 + 1e-9) continue;
        const s = x.c(n) + (x.tension > 0 ? x.bon(n) : (x.isChord(n) ? 0.35 : 0) + (x.isKey(n) ? 0.15 : 0)) - 0.6 * Math.abs(n - m);
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
      const ch = md.regionChord(M.song, b);
      if (!ch) return Math.round(m);
      const c = api.column(b, L), rf = (m - LO) * RPS, w = 1.5 * RPS, Hh = hRows(c, api.tension());
      let best = -1, bs = Infinity;
      if (Hh) {   // Tension: the nearest highlighted maximum (no 1-cent refinement: the map's own row resolution)
        for (let r = Math.max(1, Math.ceil(rf - w)); r <= Math.min(R - 2, Math.floor(rf + w)); r++) {
          if (Hh[r] < Hh[r - 1] || Hh[r] < Hh[r + 1]) continue;
          const sc = Math.abs(r - rf) / RPS + 2.4 * (1 - Hh[r]);
          if (sc < bs) { bs = sc; best = r; }
        }
        return best < 0 ? Math.round(m) : rowMidi(best);
      }
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
      const b = md.regionAt(S, clamp(t16, 0, md.tot16(S) - 1e-6)), c = api.column(b, L), e = S.chords[b], T = S.tension || 0, Hh = hRows(c, T);
      return {
        tension: T, H: Hh || null, Vh: Hh ? Hh.map((v) => 1 - v) : c.V,   // Vh: 0 = most highlighted (V itself at tension 0)
        match: (m) => api.match(m, b, L),
        matchPeaks() {   // highlighted maxima (midi), brightest first: peaks() at tension 0
          if (!Hh) return this.peaks();
          const out = [];
          for (let r = 1; r < R - 1; r++) if (Hh[r] >= Hh[r - 1] && Hh[r] >= Hh[r + 1] && Hh[r] > 0.5) out.push([rowMidi(r), Hh[r]]);
          return out.sort((a, z) => z[1] - a[1]).map((p) => p[0]);
        },
        bar: md.barAt(S, e.at), region: b, a16: e.at, z16: md.regionEnd(S, b), chord: e.chord, layer: L, rows: R, D: c.D, V: c.V,
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
