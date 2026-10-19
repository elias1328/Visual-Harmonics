// melody/view.js - canvas geometry + drawing: harmony bands, chord headers, pitch/beat grid, layer lines + notes, playhead.
// Content coordinates: x in px from the song start (scroll applied at draw time), y in canvas px. See MELODY.md (M.view).
(function () {
  'use strict';
  const VH = window.VH, H = VH.harmony, ui = VH.ui, NS = VH.melody, md = NS.model;
  const { LO, HI, SPAN, LPB, SPB, NATURAL, clamp, chordMidis, chordName, namesOf } = md;
  const HDR = 40, LANE_GAP = 6;   // LANE_GAP = .mel-wrap's flex gap

  NS.View = function (M, box) {
    const wrap = ui.h('div', 'mel-wrap'), cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    const scroller = ui.h('input', 'mel-scroll');
    scroller.type = 'range'; scroller.min = 0; scroller.step = 1; scroller.hidden = true; scroller.setAttribute('aria-label', 'Scroll bars');
    cv.style.cursor = 'crosshair'; cv.setAttribute('aria-label', 'Melody drawing area over the harmony map');
    wrap.append(cv, scroller); box.append(wrap);

    const V = { cv, ctx, wrap, scroller, HDR, VW: 800, TH: 540, MH: 500, BW: 200, CW: 800, scrollX: 0, dpr: 1, highlightBar: -1, regionPreview: null };
    let boxW = 800, boxH = 600;
    const lanes = [];   // { el, h, fixed, ro } added with V.addLane, stacked under the canvas (and its scroll bar)
    V.U = () => V.BW / SPB;                                   // px per sixteenth
    V.xOf = (t16) => t16 * V.U();
    V.t16Of = (x) => x / V.U();
    V.yOf = (m) => HDR + (HI - m) / SPAN * V.MH;
    V.midiOf = (y) => clamp(HI - (y - HDR) / V.MH * SPAN, LO, HI);
    // Pointer event -> content coords [x, y] (scroll included).
    V.xy = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * V.VW / r.width + V.scrollX, (e.clientY - r.top) * V.TH / r.height]; };

    V.relayout = function () {
      const S = M.song;
      V.VW = Math.max(240, Math.min(1600, boxW));
      V.BW = Math.max(V.VW / S.bars, Math.min(120, V.VW / 4)); V.CW = V.BW * S.bars;
      const scrolls = V.CW > V.VW + 0.5;
      scroller.hidden = !scrolls;
      const laneH = lanes.reduce((a, l) => a + (l.el.hidden ? 0 : l.h + LANE_GAP), 0);
      V.TH = Math.max(200, boxH - (scrolls ? 20 : 0) - laneH); V.MH = V.TH - HDR; V.dpr = ui.dpr();
      lanes.forEach((l) => { l.el.style.width = V.VW + 'px'; });
      const w = Math.round(V.VW * V.dpr), h = Math.round(V.TH * V.dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      cv.style.width = V.VW + 'px'; cv.style.height = V.TH + 'px'; scroller.style.width = V.VW + 'px';
      scroller.max = Math.max(0, Math.round(V.CW - V.VW));
      V.setScroll(V.scrollX);
      M.emit('layout', V);
    };
    V.setScroll = function (x) {
      V.scrollX = clamp(x, 0, Math.max(0, V.CW - V.VW)); scroller.value = Math.round(V.scrollX);
      M.requestRender(); M.emit('scroll', V);
    };
    V.fit = () => ui.fit(box, (w, h) => { boxW = w; boxH = h; V.relayout(); });
    // A DOM strip under the canvas (e.g. the drum lane) that the layout makes room for: the canvas gets shorter by the
    // lane's height + 6 px. o.height = fixed px; omitted = measured (ResizeObserver), so content changes re-layout.
    // Returns { el, setHeight(px), remove() }. Lanes are removed on unmount with M.el.
    V.addLane = function (el, o) {
      o = o || {};
      const fixed = typeof o.height === 'number' && o.height >= 0;
      const lane = { el, h: fixed ? o.height : 0, fixed, ro: null };
      el.classList.add('mel-lane');
      wrap.append(el); lanes.push(lane);
      const measure = () => {
        if (lane.fixed || !el.isConnected) return;
        const h = Math.ceil(el.offsetHeight);
        if (h !== lane.h) { lane.h = h; V.relayout(); }
      };
      if (!fixed && typeof ResizeObserver === 'function') { lane.ro = new ResizeObserver(measure); lane.ro.observe(el); }
      const api = {
        el,
        setHeight(h) { lane.fixed = typeof h === 'number'; if (lane.fixed) { lane.h = h; V.relayout(); } else measure(); },
        remove() {
          const k = lanes.indexOf(lane);
          if (k < 0) return;
          lanes.splice(k, 1);
          if (lane.ro) lane.ro.disconnect();
          el.remove(); el.style.width = '';
          V.relayout();
        },
      };
      if (M.cleanups) M.cleanups.push(() => { if (lane.ro) lane.ro.disconnect(); });
      measure(); V.relayout();
      return api;
    };
    V.lanes = () => lanes.map((l) => ({ el: l.el, height: l.h }));
    scroller.addEventListener('input', () => V.setScroll(+scroller.value));
    cv.addEventListener('wheel', (e) => {
      if (V.CW <= V.VW + 0.5) return;
      e.preventDefault();
      V.setScroll(V.scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
    }, { passive: false });
    // Keep the playhead in view while playing.
    V.follow = function (phase) {
      if (V.CW <= V.VW + 0.5) return;
      const px = phase * V.CW;
      if (px < V.scrollX + V.VW * 0.08 || px > V.scrollX + V.VW * 0.8) V.setScroll(px - V.VW * 0.2);
    };

    function label(t, x, y) {
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
      const w = ctx.measureText(t).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x - 2, y - 10, w + 4, 13);
      ctx.fillStyle = '#cfd5e6'; ctx.fillText(t, x, y);
    }
    // What a header click at content (x, y) hits: 'x' (the loop region's clear button), 'name' (the chord name: picker)
    // or 'empty' (seek / start of a loop-region drag).
    V.headerHit = function (x, y) {
      const S = M.song, r = md.regionOf(S), BW = V.BW;
      if (r && Math.hypot(x - (r[1] * BW - 11), y - 11) <= 11) return 'x';
      const b = clamp(Math.floor(x / BW), 0, S.bars - 1), ch = S.chords[b], names = namesOf(S);
      ctx.save();
      ctx.font = '600 ' + (BW < 60 ? 12 : 15) + 'px system-ui, sans-serif';
      const w1 = ctx.measureText(ch ? chordName(ch, names) : '—').width;
      ctx.font = (BW < 70 ? 9 : 10.5) + 'px system-ui, sans-serif';
      const w2 = ctx.measureText(ch ? chordMidis(ch).map((m) => names[m % 12]).join(' ') : 'no chord').width;
      ctx.restore();
      const half = Math.min(BW / 2, Math.max(22, Math.max(w1, w2) / 2 + 8));
      return Math.abs(x - (b + 0.5) * BW) <= half ? 'name' : 'empty';
    };
    V.rrect = function (x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };


    // ---------- piano strip on the left edge (over the map; content/bar x positions are unchanged) ----------
    // Rows use V.yOf, so every key is centred on its graph row. Lit keys: layer colours (stripes if shared), chord glow, 120 ms fade.
    const FADE = 120, BLACK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    [1, 3, 6, 8, 10].forEach((k) => { BLACK[k] = 1; });
    const lit = new Map();   // midi -> { cols: [colors], t: last time lit (performance.now) }
    V.hoverMidi = null;
    V.KW = () => (V.VW <= 600 ? 14 : 22);
    V.keyOf = (y) => (y >= HDR && y <= HDR + V.MH ? clamp(Math.round(V.midiOf(y)), LO, HI) : null);
    function soundingNow(now) {
      const S = M.song, E = M.engine, out = new Map(), glow = new Set();
      const add = (m, col) => { m = Math.round(m); if (m < LO || m > HI) return; const a = out.get(m) || out.set(m, []).get(m); if (a.indexOf(col) < 0) a.push(col); };
      if (E.playing) {
        const tot = S.bars * SPB, pos = E.phase * tot, i = Math.min(S.bars * LPB - 1, Math.floor(E.phase * S.bars * LPB));
        S.layers.forEach((l, L) => {
          if (md.layerGain(S, L) <= 0) return;
          if (!isNaN(l.line[i])) add(l.line[i], l.color);
          for (const n of l.notes) if (pos >= n.s && pos < n.s + n.d) add(n.m, l.color);
        });
        const ch = S.backing.on && S.chords[Math.min(S.bars - 1, Math.floor(E.phase * S.bars))];
        if (ch) chordMidis(ch).forEach((m) => glow.add(m));
      }
      for (const p of E.previews || []) if (p.until > now) { if (p.L < 0) glow.add(p.m); else if (S.layers[p.L]) add(p.m, S.layers[p.L].color); }
      return { out, glow };
    }
    function drawKeys() {
      const now = performance.now(), { out, glow } = soundingNow(now), KW = V.KW(), rh = V.MH / SPAN, bw = KW * 0.62;
      out.forEach((cols, m) => lit.set(m, { cols, t: now }));
      let fading = false;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, HDR, KW, V.MH); ctx.clip();
      ctx.fillStyle = '#e9ecf4'; ctx.fillRect(0, HDR, KW, V.MH);
      for (let m = LO; m <= HI; m++) {
        const y = V.yOf(m), y0 = y - rh / 2, black = BLACK[m % 12], w = black ? bw : KW;
        ctx.fillStyle = black ? '#171a24' : '#e9ecf4'; ctx.fillRect(0, y0, w, rh);
        if (!black) { ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, Math.round(y0), KW, 1); }
        const L = lit.get(m);
        if (L) {
          const a = out.has(m) ? 1 : 1 - (now - L.t) / FADE;
          if (a <= 0) lit.delete(m);
          else {
            if (a < 1) fading = true;
            ctx.globalAlpha = a;
            const n = L.cols.length;
            L.cols.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(w * k / n, y0, Math.ceil(w / n), rh); });
            ctx.globalAlpha = 1;
          }
        }
        if (glow.has(m)) { ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(0, y0, w, rh); }
        if (V.hoverMidi === m) { ctx.strokeStyle = '#6fa3ff'; ctx.lineWidth = 1.5; ctx.strokeRect(0.75, y0 + 0.75, KW - 1.5, rh - 1.5); }
        if (m % 12 === 0) {
          ctx.font = (KW < 20 ? 8 : 9) + 'px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#2a3042';
          ctx.fillText(H.noteName(m), 2, Math.min(y0 + rh, V.yOf(m) + 3.5));
        }
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(KW, HDR, 1, V.MH);
      if (fading || lit.size) { if (fading) M.requestRender(); }
    }
    cv.addEventListener('pointerdown', (e) => {   // click / tap a key: play it with the active layer's instrument
      if (e.button > 0) return;
      const [, y] = V.xy(e), r = cv.getBoundingClientRect();
      if ((e.clientX - r.left) * V.VW / r.width > V.KW()) return;
      const m = V.keyOf(y);
      if (m == null) return;
      e.stopImmediatePropagation(); e.preventDefault();
      M.engine.previewNote(M.active, m, 0.5);
    });
    cv.addEventListener('pointermove', (e) => {
      const m = e.pointerType === 'touch' ? null : V.keyOf(V.xy(e)[1]);
      if (m !== V.hoverMidi) { V.hoverMidi = m; M.requestRender(); }
    });
    cv.addEventListener('pointerleave', () => { if (V.hoverMidi != null) { V.hoverMidi = null; M.requestRender(); } });

    V.draw = function () {
      const S = M.song, E = M.engine, A = M.active, names = namesOf(S), tot = S.bars * SPB, u = V.U();
      const playing = E.playing, phase = E.phase, pos = phase * tot, { VW, TH, MH, BW, CW, scrollX, dpr } = V;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, VW, TH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(M.bands.off, 0, 0, S.bars, M.bands.R, -scrollX, HDR, CW, MH);
      ctx.translate(-scrollX, 0);
      const b0 = Math.max(0, Math.floor(scrollX / BW)), b1 = Math.min(S.bars - 1, Math.floor((scrollX + VW) / BW));
      const curBar = playing ? Math.floor(phase * S.bars) : -1, xa = scrollX, xb = scrollX + VW, hb = V.highlightBar;
      for (let b = b0; b <= b1; b++) {   // chord header strip: name big, notes small
        const x = b * BW, ch = S.chords[b];
        ctx.fillStyle = b === hb ? '#24345a' : b === curBar ? '#22345e' : '#141824'; ctx.fillRect(x, 0, BW, HDR);
        ctx.strokeStyle = b === hb ? '#6fa3ff' : '#262b3a'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, 0.5, BW - 1, HDR - 1);
        ctx.textAlign = 'center';
        ctx.fillStyle = ch ? '#fff' : '#7a8194'; ctx.font = '600 ' + (BW < 60 ? 12 : 15) + 'px system-ui, sans-serif';
        ctx.fillText(ch ? chordName(ch, names) : '—', x + BW / 2, 18);
        ctx.fillStyle = '#7a8194'; ctx.font = (BW < 70 ? 9 : 10.5) + 'px system-ui, sans-serif';
        ctx.fillText(ch ? chordMidis(ch).map((m) => names[m % 12]).join(' ') : 'no chord', x + BW / 2, 33);
      }
      const reg = V.regionPreview || md.regionOf(S);
      if (reg) {   // loop region: map outside it dimmed, a bright rule over its header bars
        const x0 = reg[0] * BW, x1 = reg[1] * BW;
        ctx.fillStyle = 'rgba(5,6,12,0.42)';
        if (x0 > xa) ctx.fillRect(xa, HDR, Math.min(x0, xb) - xa, MH);
        if (x1 < xb) ctx.fillRect(Math.max(x1, xa), HDR, xb - Math.max(x1, xa), MH);
        ctx.fillStyle = 'rgba(111,163,255,0.16)'; ctx.fillRect(x0, 0, x1 - x0, HDR);
        ctx.fillStyle = '#6fa3ff'; ctx.fillRect(x0, 0, x1 - x0, 3);
        ctx.strokeStyle = 'rgba(111,163,255,0.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, HDR + MH); ctx.moveTo(x1 - 0.5, 0); ctx.lineTo(x1 - 0.5, HDR + MH); ctx.stroke();
      }
      for (let m = LO; m <= HI; m++) {   // pitch grid
        const pc = m % 12, y = Math.round(V.yOf(m)) + 0.5;
        ctx.strokeStyle = pc === 0 ? 'rgba(255,255,255,0.32)' : NATURAL[pc] ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
      }
      const notesMode = S.layers[A].mode === 'notes', step = notesMode ? (S.grid === 16 ? 1 : 2) : 4;
      for (let k = Math.max(1, b0 * SPB); k < (b1 + 1) * SPB; k += 1) {   // bar / beat / grid lines
        if (k % step) continue;
        const x = Math.round(k * u) + 0.5;
        ctx.strokeStyle = k % SPB === 0 ? 'rgba(255,255,255,0.4)' : k % 4 === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.045)';
        ctx.beginPath(); ctx.moveTo(x, HDR); ctx.lineTo(x, HDR + MH); ctx.stroke();
      }
      ctx.lineJoin = ctx.lineCap = 'round';
      const nh = clamp(MH / SPAN * 0.8, 6, 14), order = S.layers.map((_, i) => i).filter((i) => i !== A).concat(A);
      for (const L of order) {   // layers, active on top; silent (muted / not soloed) layers are faint
        const lay = S.layers[L], s = lay.line, isA = L === A, lu = BW / LPB, quiet = md.layerGain(S, L) === 0;
        ctx.globalAlpha = (isA ? 1 : 0.55) * (quiet ? 0.4 : 1);
        ctx.beginPath();
        let any = false;
        for (let i = Math.max(0, Math.floor(xa / lu) - 1); i < Math.min(s.length, Math.ceil(xb / lu) + 1); i++) {
          if (isNaN(s[i])) continue;
          const x = (i + 0.5) * lu, y = V.yOf(s[i]); any = true;
          if (i > 0 && !isNaN(s[i - 1])) ctx.lineTo(x, y); else { ctx.moveTo(x - 1, y); ctx.lineTo(x, y); }
        }
        if (any) {
          ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = isA ? 6 : 5; ctx.stroke();
          ctx.strokeStyle = lay.color; ctx.lineWidth = isA ? 3 : 2; ctx.stroke();
        }
        for (const n of lay.notes) {   // notes: rounded bars in the layer colour
          const x = n.s * u + 1, w = Math.max(3, n.d * u - 2);
          if (x > xb || x + w < xa) continue;
          const on = playing && pos >= n.s && pos < n.s + n.d;
          V.rrect(x, V.yOf(n.m) - nh / 2, w, nh, Math.min(5, nh / 2));
          ctx.fillStyle = lay.color; ctx.fill();
          ctx.strokeStyle = n.sel ? '#fff' : on ? '#fff' : 'rgba(0,0,0,0.75)'; ctx.lineWidth = on || n.sel ? 2 : 1.25; ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      M.emit('draw', ctx, V);   // overlays (content coords, scroll already applied)
      const tool = M.tools && M.tools.current;
      if (tool && tool.draw) { try { tool.draw(ctx, V); } catch (err) { console.error('[melody] tool draw', err); } }
      const lr = !V.regionPreview && md.regionOf(S);
      if (lr) {   // ✕ that clears the loop region (top-right of its last bar)
        const cx = lr[1] * BW - 11;
        ctx.fillStyle = '#6fa3ff'; ctx.beginPath(); ctx.arc(cx, 11, 7.5, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = '#07101f'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(cx - 3, 8); ctx.lineTo(cx + 3, 14); ctx.moveTo(cx + 3, 8); ctx.lineTo(cx - 3, 14); ctx.stroke();
      }
      if (!playing && E.cue != null) {   // stopped with a cue: Play starts here
        const x = E.cue * u;
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, HDR); ctx.lineTo(x, HDR + MH); ctx.stroke(); ctx.restore();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x - 5, HDR - 7); ctx.lineTo(x + 5, HDR - 7); ctx.lineTo(x, HDR); ctx.fill();
      }
      if (playing) {   // playback cursor
        const x = phase * CW, i = Math.min(S.bars * LPB - 1, Math.floor(phase * S.bars * LPB));
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HDR + MH); ctx.stroke();
        S.layers.forEach((l) => {
          if (isNaN(l.line[i])) return;
          ctx.fillStyle = l.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, V.yOf(l.line[i]), 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        });
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawKeys();
    };
    return V;
  };
})();
