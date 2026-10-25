// melody/view.js - canvas geometry + drawing: harmony bands, chord headers, pitch/beat grid, layer lines + notes, playhead.
// Content coordinates: x in px from the song start (scroll applied at draw time), y in canvas px. See MELODY.md (M.view).
(function () {
  'use strict';
  const VH = window.VH, H = VH.harmony, ui = VH.ui, NS = VH.melody, md = NS.model;
  const { LO, HI, SPAN, NATURAL, clamp, chordMidis, chordName, namesOf } = md;
  const HDR = 40, LANE_GAP = 6;   // LANE_GAP = .mel-wrap's flex gap
  const Z_MIN = 12;               // pitch zoom: at least one octave stays visible

  NS.View = function (M, box) {
    const wrap = ui.h('div', 'mel-wrap'), cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    const scroller = ui.h('input', 'mel-scroll');
    scroller.type = 'range'; scroller.min = 0; scroller.step = 1; scroller.hidden = true; scroller.setAttribute('aria-label', 'Scroll bars');
    cv.style.cursor = 'crosshair'; cv.setAttribute('aria-label', 'Melody drawing area over the harmony map');
    wrap.append(cv, scroller); box.append(wrap);

    // X0 = the piano strip's width: the time axis starts right of it (content x 0 = bar 1 = canvas x X0). GW = graph width.
    // Pitch zoom: `span` semitones are visible (SPAN .. Z_MIN), the top row is `pTop`. Persisted in VH.store 'melody.view'.
    const V = { cv, ctx, wrap, scroller, HDR, VW: 800, TH: 540, MH: 500, BW: 200, CW: 800, scrollX: 0, dpr: 1, highlightBar: -1, regionPreview: null,
      X0: 22, GW: 778, span: SPAN, pTop: HI, Z_MIN, showScale: VH.store.get('melody.showScale', true) !== false };
    let boxW = 800, boxH = 600;
    const lanes = [];   // { el, h, fixed, ro } added with V.addLane, stacked under the canvas (and its scroll bar)
    V.U = () => V.BW / md.spb(M.song);                        // px per sixteenth (the bar length follows the time signature)
    V.xOf = (t16) => t16 * V.U();
    V.t16Of = (x) => x / V.U();
    V.sx = (x) => x - V.scrollX + V.X0;                       // content x -> canvas x
    V.PPS = () => V.MH / V.span;                              // px per semitone (zoom)
    V.noteH = () => clamp(V.PPS() * 0.8, 6, 20);              // note bar height
    V.yOf = (m) => HDR + (V.pTop - m) / V.span * V.MH;
    V.midiOf = (y) => clamp(V.pTop - (y - HDR) / V.MH * V.span, LO, HI);
    // Pointer event -> content coords [x, y] (scroll and the piano strip included).
    V.xy = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * V.VW / r.width + V.scrollX - V.X0, (e.clientY - r.top) * V.TH / r.height]; };
    // canvas px of a pointer event (no scroll / strip offset)
    const cxy = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * V.VW / r.width, (e.clientY - r.top) * V.TH / r.height]; };

    // ---------- pitch zoom ----------
    const ZKEY = 'melody.view';
    let zSave = 0;
    V.zoomed = () => V.span < SPAN - 1e-6;
    V.setPitchView = function (span, top, quiet) {
      const sp = clamp(+span || SPAN, Z_MIN, SPAN), tp = clamp(+top || HI, LO + sp, HI);
      if (Math.abs(sp - V.span) < 1e-6 && Math.abs(tp - V.pTop) < 1e-6) return;
      V.span = sp; V.pTop = tp;   // the cached band image is only cropped at draw time: nothing to recompute
      syncZoomUi(); M.requestRender();
      if (!quiet) {
        M.emit('scroll', V);
        if (M.forget) M.forget(zSave);
        zSave = M.later ? M.later(() => VH.store.set(ZKEY, { span: Math.round(V.span * 1000) / 1000, top: Math.round(V.pTop * 1000) / 1000 }), 250) : 0;
      }
    };
    // Zoom by factor f (< 1 = in) keeping the pitch under canvas y in place.
    V.zoomAt = function (f, y) {
      const yy = clamp(y == null ? HDR + V.MH / 2 : y, HDR, HDR + V.MH), m = V.pTop - (yy - HDR) / V.MH * V.span;
      const sp = clamp(V.span * f, Z_MIN, SPAN);
      V.setPitchView(sp, m + (yy - HDR) / V.MH * sp);
    };
    V.scrollPitch = (dm) => V.setPitchView(V.span, V.pTop + dm);
    const zs = VH.store.get(ZKEY, null);
    if (zs && typeof zs === 'object') { V.span = clamp(+zs.span || SPAN, Z_MIN, SPAN); V.pTop = clamp(+zs.top || HI, LO + V.span, HI); }
    const zoomEl = ui.h('div', 'mel-zoom');
    zoomEl.setAttribute('role', 'group'); zoomEl.setAttribute('aria-label', 'Pitch zoom');
    const zBtn = (t, label, f) => {
      const b = ui.h('button', 'mel-zoom-b', t); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
      b.addEventListener('click', () => V.zoomAt(f)); zoomEl.append(b); return b;
    };
    const zIn = zBtn('+', 'Zoom in on pitch (+, Ctrl + wheel, pinch)', 1 / 1.4), zOut = zBtn('−', 'Zoom out on pitch (−)', 1.4);
    wrap.append(zoomEl);
    // Tension dial: a "◐ Calm / Color / Tense" chip left of the zoom buttons; it opens a slider pop-over (M.setTension).
    const tenChip = ui.h('button', 'mel-tens-chip'); tenChip.type = 'button';
    tenChip.setAttribute('aria-haspopup', 'true'); tenChip.setAttribute('aria-expanded', 'false');
    const tenPop = ui.h('div', 'mel-tens-pop'); tenPop.hidden = true; tenPop.setAttribute('role', 'group'); tenPop.setAttribute('aria-label', 'Tension');
    const tenRange = ui.h('input', 'mel-tens-range'); tenRange.type = 'range'; tenRange.min = 0; tenRange.max = 1; tenRange.step = 0.01; tenRange.value = 0;
    tenRange.setAttribute('aria-label', 'Tension: what the map highlights');
    const tenTicks = ui.h('div', 'mel-tens-ticks'); ['Calm', 'Color', 'Tense'].forEach((t) => tenTicks.append(ui.h('span', '', t)));
    tenPop.append(ui.h('div', 'mel-tens-h', 'Tension'), tenRange, tenTicks,
      ui.h('div', 'mel-tens-d', 'What the map highlights: Calm = the most consonant notes, Color = spicy 7ths, 9ths, 11ths and 13ths, Tense = the roughest clashes. Snap, auto-fit and the dice follow it; playback and export do not change.'));
    wrap.append(tenChip, tenPop);
    V.syncTension = function () {
      const T = (M.song && M.song.tension) || 0, tint = md.tensionTint(T), nm = md.tensionName(T);
      tenChip.textContent = '◐ ' + nm; tenChip.title = 'Tension: ' + nm + ' (' + Math.round(T * 100) + '%) - click to change what the map highlights';
      tenChip.classList.toggle('on', T > 0);
      tenChip.style.setProperty('--tens', tint ? 'rgb(' + tint.c2.map((v) => Math.round(v * 255)).join(',') + ')' : '');
      if (document.activeElement !== tenRange) tenRange.value = T;
      if (V.placeLookChip) V.placeLookChip();
    };
    tenChip.addEventListener('click', () => { tenPop.hidden = !tenPop.hidden; tenChip.setAttribute('aria-expanded', String(!tenPop.hidden)); });
    tenRange.addEventListener('input', () => M.setTension(+tenRange.value));
    tenRange.addEventListener('change', () => M.setTension(+tenRange.value, true));
    const tenClose = (e) => {
      if (tenPop.hidden || (e.type === 'keydown' ? e.key !== 'Escape' : tenPop.contains(e.target) || tenChip.contains(e.target))) return;
      tenPop.hidden = true; tenChip.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('pointerdown', tenClose); document.addEventListener('keydown', tenClose);
    if (M.cleanups) M.cleanups.push(() => { document.removeEventListener('pointerdown', tenClose); document.removeEventListener('keydown', tenClose); });
    // Map look: a 🎨 chip left of the ◐ chip opens the same controls as Settings > Edit > Map look (V.buildLook).
    const lookChip = ui.h('button', 'mel-tens-chip mel-look-chip', '🎨'); lookChip.type = 'button';
    lookChip.title = 'Map look: colours, clarity, glow, grid'; lookChip.setAttribute('aria-label', 'Map look'); lookChip.setAttribute('aria-haspopup', 'true'); lookChip.setAttribute('aria-expanded', 'false');
    const lookPop = ui.h('div', 'mel-tens-pop mel-look-pop'); lookPop.hidden = true; lookPop.setAttribute('role', 'group'); lookPop.setAttribute('aria-label', 'Map look');
    wrap.append(lookChip, lookPop);
    const syncs = [];
    // Builds the Map look controls into host (view preferences: VH.store 'melody.look' + 'melody.showScale'; not in the song).
    V.buildLook = function (host) {
      const B = M.bands, L = () => B.look(), set = (p) => B.setLook(p);
      const THEMES = md.LOOK_THEMES, row = ui.h('div', 'vh-row'), sel = ui.h('select', 'vh-select mel-look-theme');
      sel.setAttribute('aria-label', 'Colour theme');
      Object.keys(THEMES).forEach((k) => { const o = ui.h('option', '', THEMES[k].name); o.value = k; sel.append(o); });
      sel.addEventListener('change', () => set({ theme: sel.value }));
      row.append(ui.h('span', 'vh-desc', 'Colours'), sel); host.append(row);
      const pct = (v) => Math.round(v) + '%';
      const sl = {
        clarity: ui.slider(host, { label: 'Clarity', min: 0, max: 100, step: 1, value: L().clarity, fmt: pct, onInput: (v) => set({ clarity: v }) }),
        thick: ui.slider(host, { label: 'Line thickness', min: 0, max: 100, step: 1, value: L().thick, fmt: (v) => (v < 35 ? 'Thin' : v > 65 ? 'Bold' : 'Normal'), onInput: (v) => set({ thick: v }) }),
        glow: ui.slider(host, { label: 'Glow', min: 0, max: 100, step: 1, value: L().glow, fmt: pct, onInput: (v) => set({ glow: v }) }),
        dark: ui.slider(host, { label: 'Background darkness', min: 0, max: 100, step: 1, value: L().dark, fmt: pct, onInput: (v) => set({ dark: v }) }),
        grid: ui.slider(host, { label: 'Grid lines', min: 0, max: 100, step: 1, value: L().grid, fmt: pct, onInput: (v) => set({ grid: v }) })
      };
      Object.keys(sl).forEach((k) => { sl[k].input.classList.add('mel-look-' + k); });
      const tr = ui.h('div', 'vh-row'), tg = {};
      const tog = (k, label, get, put) => { tg[k] = ui.button(tr, { label, pressed: get(), onClick: () => { put(!get()); } }); tg[k].classList.add('mel-look-t-' + k); tg[k].get = get; };
      tog('scale', 'Scale tint', () => V.showScale, (v) => V.setShowScale(v));
      tog('regions', 'Chord tints', () => L().regions, (v) => set({ regions: v }));
      tog('piano', 'Piano strip', () => L().piano, (v) => set({ piano: v }));
      tog('labels', 'Note labels', () => L().labels, (v) => set({ labels: v }));
      host.append(tr);
      const rr = ui.h('div', 'vh-row'), rb = ui.button(rr, { label: 'Reset look', onClick: () => { B.resetLook(); V.relayout(); } }); rb.classList.add('mel-look-reset'); host.append(rr);
      host.append(ui.h('div', 'vh-desc', 'A view preference for this device: not saved in the song, not shared, not part of undo.'));
      const sync = () => {
        const l = L(); sel.value = l.theme;
        Object.keys(sl).forEach((k) => { if (document.activeElement !== sl[k].input) sl[k].set(l[k]); });
        Object.keys(tg).forEach((k) => tg[k].set({ pressed: tg[k].get() }));
      };
      syncs.push(sync); sync();
      return { sync };
    };
    V.setShowScale = (v) => { V.showScale = !!v; VH.store.set('melody.showScale', V.showScale); syncs.forEach((f) => f()); if (V.onScale) V.onScale(); M.requestRender(); };
    M.on('look', () => { syncs.forEach((f) => f()); if (V.X0 !== V.KW()) V.relayout(); });
    let lookBuilt = false;
    lookChip.addEventListener('click', () => {
      if (!lookBuilt) { lookBuilt = true; V.buildLook(lookPop); }
      lookPop.hidden = !lookPop.hidden; lookChip.setAttribute('aria-expanded', String(!lookPop.hidden));
    });
    const lookClose = (e) => {
      if (lookPop.hidden || (e.type === 'keydown' ? e.key !== 'Escape' : lookPop.contains(e.target) || lookChip.contains(e.target))) return;
      lookPop.hidden = true; lookChip.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('pointerdown', lookClose); document.addEventListener('keydown', lookClose);
    if (M.cleanups) M.cleanups.push(() => { document.removeEventListener('pointerdown', lookClose); document.removeEventListener('keydown', lookClose); });
    // Zoom, tension and look chips sit at the right end of the arrangement strip (above the chords), never on the map.
    // Without a strip above the canvas they fall back to the map's top-right corner.
    function placeBar() {
      const small = V.VW <= 600, inBar = V.topH > 0, zw = small && !inBar ? 30 : 26, m = inBar ? 2 : (small ? 12 : 16);
      const top = inBar ? Math.max(0, Math.round((V.topH - LANE_GAP - zw) / 2)) : V.topH + HDR + 6;
      zoomEl.classList.toggle('inbar', inBar); wrap.classList.toggle('mel-chips-inbar', inBar);
      const zoomW = inBar ? 2 * zw + 4 : zw, tw = tenChip.offsetWidth || 70, lw = lookChip.offsetWidth || 34;
      const R = (px) => 'calc(50% - ' + (V.VW / 2 - px) + 'px)';
      zoomEl.style.top = tenChip.style.top = lookChip.style.top = top + 'px';
      zoomEl.style.right = R(m);
      tenChip.style.right = R(m + zoomW + 6);
      lookChip.style.right = R(m + zoomW + 6 + tw + 6);
      tenPop.style.top = lookPop.style.top = (inBar ? V.topH + 2 : V.topH + HDR + 36) + 'px';
      tenPop.style.right = lookPop.style.right = R(m);
      wrap.style.setProperty('--mel-bar-reserve', inBar ? (m + zoomW + 6 + tw + 6 + lw + 8) + 'px' : '0px');
    }
    const placeLookChip = placeBar;
    V.placeLookChip = placeBar;
    function syncZoomUi() {
      zIn.disabled = V.span <= Z_MIN + 1e-6; zOut.disabled = !V.zoomed();
      zoomEl.classList.toggle('zoomed', V.zoomed());
    }
    syncZoomUi();

    V.relayout = function () {
      const S = M.song;
      V.VW = Math.max(240, Math.min(1600, boxW));
      V.X0 = V.KW(); V.GW = V.VW - V.X0;
      V.BW = Math.max(V.GW / S.bars, Math.min(120, V.GW / 4)); V.CW = V.BW * S.bars;
      const scrolls = V.CW > V.GW + 0.5;
      scroller.hidden = !scrolls;
      const laneH = lanes.reduce((a, l) => a + (l.el.hidden ? 0 : l.h + LANE_GAP), 0);
      V.topH = lanes.reduce((a, l) => a + (l.top && !l.el.hidden ? l.h + LANE_GAP : 0), 0);   // lanes above the canvas
      V.TH = Math.max(200, boxH - (scrolls ? 20 : 0) - laneH); V.MH = V.TH - HDR; V.dpr = ui.dpr();
      lanes.forEach((l) => { l.el.style.width = V.VW + 'px'; });
      const w = Math.round(V.VW * V.dpr), h = Math.round(V.TH * V.dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      cv.style.width = V.VW + 'px'; cv.style.height = V.TH + 'px'; scroller.style.width = V.VW + 'px';
      scroller.max = Math.max(0, Math.round(V.CW - V.GW));
      placeBar();
      V.setScroll(V.scrollX);
      M.emit('layout', V);
    };
    V.setScroll = function (x) {
      V.scrollX = clamp(x, 0, Math.max(0, V.CW - V.GW)); scroller.value = Math.round(V.scrollX);
      M.requestRender(); M.emit('scroll', V);
    };
    V.fit = () => ui.fit(box, (w, h) => { boxW = w; boxH = h; V.relayout(); });
    // A DOM strip under the canvas (e.g. the drum lane) that the layout makes room for: the canvas gets shorter by the
    // lane's height + 6 px. o.height = fixed px; omitted = measured (ResizeObserver), so content changes re-layout.
    // Returns { el, setHeight(px), remove() }. Lanes are removed on unmount with M.el.
    V.topH = 0;
    V.addLane = function (el, o) {
      o = o || {};
      const fixed = typeof o.height === 'number' && o.height >= 0;
      const lane = { el, h: fixed ? o.height : 0, fixed, ro: null, top: !!o.top };
      el.classList.add('mel-lane');
      if (lane.top) wrap.prepend(el); else wrap.append(el);   // o.top: above the canvas (the arrangement strip)
      lanes.push(lane);
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
    // Wheel: Ctrl/Cmd = pitch zoom around the cursor; plain vertical = pitch scroll while zoomed; Shift / horizontal =
    // time scroll (a plain vertical wheel also scrolls time while not zoomed).
    cv.addEventListener('wheel', (e) => {
      const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1, dx = e.deltaX * k, dy = e.deltaY * k;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); V.zoomAt(Math.exp(clamp(dy, -200, 200) * 0.002), cxy(e)[1]); return; }
      const horiz = e.shiftKey || Math.abs(dx) > Math.abs(dy);
      if (!horiz && V.zoomed()) { e.preventDefault(); V.scrollPitch(-dy / V.PPS()); return; }
      if (V.CW <= V.GW + 0.5) return;
      e.preventDefault();
      V.setScroll(V.scrollX + (Math.abs(dx) > Math.abs(dy) ? dx : dy));
    }, { passive: false });
    // Safari (macOS) sends a trackpad pinch as gesturestart / gesturechange with a scale, not as Ctrl + wheel like
    // Chrome and Firefox; unhandled, it zooms the whole page. A touch pinch is handled by the pointer code below.
    // (Other browsers never fire these events.)
    {
      let gs = 1;
      const gest = (e) => {
        e.preventDefault();
        if (touches.size || !(e.scale > 0)) return;
        if (e.type === 'gesturechange') V.zoomAt(gs / e.scale, cxy(e)[1]);
        gs = e.type === 'gesturestart' ? 1 : e.scale;
      };
      ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => cv.addEventListener(t, gest));
    }
    // Keep the playhead in view while playing.
    V.follow = function (phase) {
      if (V.CW <= V.GW + 0.5) return;
      const px = phase * V.CW;
      if (px < V.scrollX + V.GW * 0.08 || px > V.scrollX + V.GW * 0.8) V.setScroll(px - V.GW * 0.2);
    };

    function label(t, x, y) {
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
      const w = ctx.measureText(t).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x - 2, y - 10, w + 4, 13);
      ctx.fillStyle = '#cfd5e6'; ctx.fillText(t, x, y);
    }
    // What a header point at content (x, y) hits: { kind, region, at }. kind: 'x' (the loop region's clear button),
    // 'edge' (a boundary between two chords inside a bar: drag it), 'plus' (a beat boundary near the strip's bottom:
    // split the chord there), 'name' (the chord name: picker) or 'empty' (seek / start of a loop-region drag).
    const hdrFont = (w) => (w < 34 ? 10 : w < 60 ? 12 : 15);
    V.hdrAt = function (x, y) {
      const S = M.song, r = md.regionOf(S), BW = V.BW, u = V.U(), n = md.spb(S), tot = md.tot16(S);
      if (r && Math.hypot(x - (r[1] * BW - 11), y - 11) <= 11) return { kind: 'x', region: -1 };
      const t = clamp(x / u, 0, tot - 1e-6), i = md.regionAt(S, t), e = S.chords[i], z = md.regionEnd(S, i);
      for (const q of [i, i + 1]) {
        const E = S.chords[q];
        if (E && q > 0 && E.at % n && Math.abs(x - E.at * u) <= 6) return { kind: 'edge', region: q, at: E.at };
      }
      if (y >= HDR - 16) {
        const b0 = Math.floor(t / n) * n;
        for (const p of md.beatGrid(S, false)) { const at = b0 + p; if (at > e.at && at < z && Math.abs(x - at * u) <= 7) return { kind: 'plus', region: i, at }; }
      }
      const ch = e.chord, names = namesOf(S), w = (z - e.at) * u;
      ctx.save();
      ctx.font = '600 ' + hdrFont(w) + 'px system-ui, sans-serif';
      const w1 = ctx.measureText(ch ? chordName(ch, names) : '—').width;
      ctx.font = (w < 70 ? 9 : 10.5) + 'px system-ui, sans-serif';
      const w2 = ctx.measureText(ch ? chordMidis(ch).map((m) => names[m % 12]).join(' ') : 'no chord').width;
      ctx.restore();
      const half = Math.min(w / 2, Math.max(22, Math.max(w1, w2) / 2 + 8));
      return { kind: Math.abs(x - (e.at * u + w / 2)) <= half ? 'name' : 'empty', region: i };
    };
    V.headerHit = (x, y) => V.hdrAt(x, y).kind;
    V.hdrHover = null;   // { kind, region, at } under the pointer (tools.js): drawn as a split "+" / a lit boundary grip
    V.rrect = (x, y, w, h, r) => rrectOn(ctx, x, y, w, h, r);


    // ---------- piano strip on the left edge (the time axis starts right of it, at X0) ----------
    // Rows use V.yOf, so every key is centred on its graph row. Lit keys: layer colours (stripes if shared), chord glow, 120 ms fade.
    const FADE = 120, BLACK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    [1, 3, 6, 8, 10].forEach((k) => { BLACK[k] = 1; });
    const lit = new Map();   // midi -> { cols: [colors], t: last time lit (performance.now) }
    V.hoverMidi = null;
    const lk = () => (M.bands && M.bands.look ? M.bands.look() : md.LOOK_DEFAULTS);   // the Map look (view preference)
    V.KW = () => (!lk().piano ? 0 : V.VW <= 600 ? 14 : 22);
    // The strip's key / step under y: a semitone in 12-TET, else the nearest step of the tuning grid (md.gridOf).
    V.keyOf = (y) => (y >= HDR && y <= HDR + V.MH ? md.gridSnap(M.song, V.midiOf(y)) : null);
    function soundingNow(now) {
      const S = M.song, E = M.engine, out = new Map(), glow = new Set();
      const et = md.gridOf(S).et12, add = (m, col) => { m = et ? Math.round(m) : m; if (m < LO || m > HI) return; const a = out.get(m) || out.set(m, []).get(m); if (a.indexOf(col) < 0) a.push(col); };
      if (E.playing) {
        const tot = md.tot16(S), pos = E.phase * tot, i = Math.min(tot * 3 - 1, Math.floor(pos * 3));
        S.layers.forEach((l, L) => {
          if (md.layerGain(S, L) <= 0) return;
          for (const x of md.lineAt(l, i)) add(x.m, l.color);   // every stroke lights its key
          for (const n of l.notes) if (pos >= n.s && pos < n.s + n.d) add(n.m, l.color);
        });
        const ch = S.backing.on && md.chordAt(S, pos);
        if (ch) chordMidis(ch, S).forEach((m) => glow.add(m));
      }
      for (const p of E.previews || []) if (p.until > now) { if (p.L < 0) glow.add(p.m); else if (S.layers[p.L]) add(p.m, S.layers[p.L].color); }
      return { out, glow };
    }
    // Non-12 tunings: a step strip instead of the piano. One cell per tuning step (in-scale steps tinted, the key root
    // marked), step numbers (and cents when there is room), and 12-TET reference ticks at the right edge.
    function drawSteps(G, out, glow, now) {
      const KW = V.X0, P = G.pts, PPS = V.PPS(), S = M.song;
      ctx.fillStyle = '#20253a'; ctx.fillRect(0, HDR, KW, V.MH);
      for (let k = 0; k < P.length; k++) {
        const m = P[k], lo = k ? (P[k - 1] + m) / 2 : m - 0.25, hi = k + 1 < P.length ? (P[k + 1] + m) / 2 : m + 0.25;
        const y0 = V.yOf(hi), y1 = V.yOf(lo);
        if (y1 < HDR || y0 > HDR + V.MH) continue;
        const inSc = G.scaleCls.has(G.cls[k]), root = G.cls[k] === 0;
        ctx.fillStyle = root ? '#5a6894' : inSc && V.showScale ? '#3a4466' : k % 2 ? '#262c42' : '#2b3149';
        ctx.fillRect(0, y0, KW, y1 - y0);
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, Math.round(y0), KW, 1);
        const key = Math.round(m * 1000);
        if (out.has(key)) { const cs = out.get(key); cs.forEach((c, j) => { ctx.fillStyle = c; ctx.fillRect(KW * j / cs.length, y0, Math.ceil(KW / cs.length), y1 - y0); }); }
        if (glow.has(key)) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(0, y0, KW, y1 - y0); }
        if (V.hoverMidi != null && Math.abs(V.hoverMidi - m) < 1e-6) { ctx.strokeStyle = '#6fa3ff'; ctx.lineWidth = 1.5; ctx.strokeRect(0.75, y0 + 0.75, KW - 1.5, y1 - y0 - 1.5); }
        const h = y1 - y0;
        if (h >= 8 && lk().labels) {
          ctx.font = (KW < 20 ? 7 : 8) + 'px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = root ? '#fff' : '#b9c2da';
          ctx.fillText(root ? md.namesOf(S)[S.key] + (Math.floor(Math.round(m) / 12) - 1) : String(G.cls[k]), 2, V.yOf(m) + 3);
          if (h >= 20) { ctx.fillStyle = '#8b94ad'; ctx.font = '7px system-ui, sans-serif'; ctx.fillText(Math.round(G.cents[G.cls[k]]) + '¢', 2, V.yOf(m) + 11); }
        }
      }
      ctx.fillStyle = 'rgba(255,255,255,0.55)';   // 12-TET reference ticks (octave C ticks longer)
      for (let m = LO; m <= HI; m++) { const y = Math.round(V.yOf(m)); if (y >= HDR && y <= HDR + V.MH) ctx.fillRect(KW - (m % 12 === 0 ? 7 : 4), y, m % 12 === 0 ? 7 : 4, 1); }
    }
    function drawKeys() {
      const now = performance.now(), { out, glow } = soundingNow(now), KW = V.X0, rh = V.PPS(), bw = KW * 0.62;
      const G = md.gridOf(M.song);
      if (!G.et12) {   // step strip (lit by grid pitch, keyed in milli-semitones)
        const o2 = new Map(), g2 = new Set(), gk = (m) => Math.round(G.snap(m) * 1000);
        out.forEach((c, m) => o2.set(gk(m), c)); glow.forEach((m) => g2.add(gk(m)));
        ctx.save(); ctx.beginPath(); ctx.rect(0, HDR, KW, V.MH); ctx.clip();
        drawSteps(G, o2, g2, now);
        ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(KW, HDR, 1, V.MH);
        return;
      }
      const scaleOn = V.showScale, sc = G.scaleCls;
      out.forEach((cols, m) => lit.set(m, { cols, t: now }));
      let fading = false;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, HDR, KW, V.MH); ctx.clip();
      ctx.fillStyle = '#e9ecf4'; ctx.fillRect(0, HDR, KW, V.MH);
      const mLo = Math.floor(V.pTop - V.span) - 1, mHi = Math.ceil(V.pTop) + 1;
      for (let m = LO; m <= HI; m++) {
        if (m < mLo || m > mHi) { const q = lit.get(m); if (q && !out.has(m) && now - q.t >= FADE) lit.delete(m); continue; }
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
        if (scaleOn && sc.has(((m - G.root) % 12 + 12) % 12)) {   // in-scale keys: a faint blue tint (the root a little stronger)
          ctx.fillStyle = (m - G.root) % 12 === 0 ? (black ? 'rgba(120,160,255,0.55)' : 'rgba(80,120,255,0.3)') : black ? 'rgba(120,160,255,0.35)' : 'rgba(80,120,255,0.14)';
          ctx.fillRect(0, y0, w, rh);
        }
        if (glow.has(m)) { ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(0, y0, w, rh); }
        if (V.hoverMidi === m) { ctx.strokeStyle = '#6fa3ff'; ctx.lineWidth = 1.5; ctx.strokeRect(0.75, y0 + 0.75, KW - 1.5, rh - 1.5); }
        if (!lk().labels) { /* labels off */ } else if (m % 12 === 0) {
          ctx.font = (KW < 20 ? 8 : 9) + 'px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#2a3042';
          ctx.fillText(H.noteName(m), 2, Math.min(y0 + rh, V.yOf(m) + 3.5));
        } else if (rh >= 22 && !black) {   // zoomed in: name every white key
          ctx.font = (KW < 20 ? 7 : 8) + 'px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(42,48,66,0.7)';
          ctx.fillText(H.noteName(m), 2, V.yOf(m) + 3);
        }
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(KW, HDR, 1, V.MH);
      if (fading || lit.size) { if (fading) M.requestRender(); }
    }
    // Pointer handling that runs before the tools (registered first): two-finger pinch (zoom + pan), the pitch scroll
    // bar (right edge, while zoomed), and the piano strip (click / tap = play the key; drag = scroll pitch).
    const touches = new Map();
    let pinch = null, pinchHold = false, keyDrag = null, sbDrag = null;
    const SBW = 10;
    const inBar = (cx, cy) => V.zoomed() && cx >= V.VW - SBW && cy >= HDR && cy <= HDR + V.MH;
    function pinchState() {
      const p = [...touches.values()];
      return { d: Math.max(8, Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1])), my: (p[0][1] + p[1][1]) / 2 };
    }
    V.pinching = () => !!pinch || pinchHold;
    cv.addEventListener('pointerdown', (e) => {
      const [cx, cy] = cxy(e);
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, [cx, cy]);
        if (touches.size === 2) {   // second finger: cancel the first finger's tool drag, start the pinch
          e.stopImmediatePropagation(); e.preventDefault();
          if (M.tools && M.tools.cancel) M.tools.cancel();
          keyDrag = null; sbDrag = null;
          const st = pinchState(), my = clamp(st.my, HDR, HDR + V.MH);
          pinch = { d0: st.d, span0: V.span, m: V.pTop - (my - HDR) / V.MH * V.span };
          pinchHold = true;
          return;
        }
        if (touches.size > 2 || pinchHold) { e.stopImmediatePropagation(); e.preventDefault(); return; }
      }
      if (e.button > 0) return;
      if (inBar(cx, cy)) {
        e.stopImmediatePropagation(); e.preventDefault();
        const th = HDR + (HI - V.pTop) / SPAN * V.MH, tl = V.span / SPAN * V.MH;
        sbDrag = { off: cy >= th && cy <= th + tl ? cy - th : tl / 2, id: e.pointerId };
        try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        sbMove(cy);
        return;
      }
      if (cx >= V.X0) return;
      const m = V.keyOf(cy);
      if (m == null) return;
      e.stopImmediatePropagation(); e.preventDefault();
      keyDrag = { id: e.pointerId, y0: cy, top0: V.pTop, m, moved: false, touch: e.pointerType === 'touch' };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (!keyDrag.touch) M.engine.previewNote(M.active, m, 0.5);
    });
    function sbMove(cy) { V.setPitchView(V.span, HI - (cy - sbDrag.off - HDR) / V.MH * SPAN); }
    cv.addEventListener('pointermove', (e) => {
      const [cx, cy] = cxy(e);
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, [cx, cy]);
      if (pinch && touches.size >= 2) {
        e.stopImmediatePropagation();
        const st = pinchState(), my = clamp(st.my, HDR, HDR + V.MH), sp = clamp(pinch.span0 * pinch.d0 / st.d, Z_MIN, SPAN);
        V.setPitchView(sp, pinch.m + (my - HDR) / V.MH * sp);
        return;
      }
      if (pinchHold && e.pointerType === 'touch') { e.stopImmediatePropagation(); return; }
      if (sbDrag && e.pointerId === sbDrag.id) { e.stopImmediatePropagation(); sbMove(cy); return; }
      if (keyDrag && e.pointerId === keyDrag.id) {
        e.stopImmediatePropagation();
        if (!keyDrag.moved && Math.abs(cy - keyDrag.y0) > 6) keyDrag.moved = true;
        if (keyDrag.moved) V.setPitchView(V.span, keyDrag.top0 + (cy - keyDrag.y0) / V.PPS());
        return;
      }
      const m = e.pointerType === 'touch' || cx >= V.X0 ? null : V.keyOf(cy);
      if (m !== V.hoverMidi) { V.hoverMidi = m; M.requestRender(); }
      if (inBar(cx, cy)) { e.stopImmediatePropagation(); cv.style.cursor = 'ns-resize'; }
    });
    const ptrEnd = (e) => {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (touches.size < 2) pinch = null;
        if (pinchHold) { e.stopImmediatePropagation(); if (!touches.size) pinchHold = false; return; }
      }
      if (sbDrag && e.pointerId === sbDrag.id) { e.stopImmediatePropagation(); sbDrag = null; return; }
      if (keyDrag && e.pointerId === keyDrag.id) {
        e.stopImmediatePropagation();
        const k = keyDrag; keyDrag = null;
        if (k.touch && !k.moved && e.type === 'pointerup') M.engine.previewNote(M.active, k.m, 0.5);
      }
    };
    cv.addEventListener('pointerup', ptrEnd);
    cv.addEventListener('pointercancel', ptrEnd);
    // keys + (or =) / - : pitch zoom (not while typing)
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !cv.isConnected) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type)) || (t && t.isContentEditable)) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); V.zoomAt(1 / 1.4); } else if (e.key === '-' || e.key === '_') { e.preventDefault(); V.zoomAt(1.4); }
    };
    document.addEventListener('keydown', onKey);
    if (M.cleanups) M.cleanups.push(() => document.removeEventListener('keydown', onKey));
    cv.addEventListener('pointerleave', () => { if (V.hoverMidi != null) { V.hoverMidi = null; M.requestRender(); } });

    // The layer stack (line strokes + notes; active layer on top) drawn into c (content coords, clipped to the map).
    const rrectOn = (c, x, y, w, h, r) => { c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); };
    function drawLayers(c, S, A, playing, pos, xa, xb, u) {
      c.lineJoin = c.lineCap = 'round';
      const nh = V.noteH(), order = S.layers.map((_, i) => i).filter((i) => i !== A).concat(A);
      for (const L of order) {   // layers, active on top; silent (muted / not soloed) layers are faint
        const lay = S.layers[L], isA = L === A, lu = u / 3, quiet = md.layerGain(S, L) === 0;
        c.globalAlpha = (isA ? 1 : 0.55) * (quiet ? 0.4 : 1);
        for (const st of md.strokes(lay)) {   // each line stroke (strokes may overlap)
          const s = st.v;
          c.beginPath();
          let any = false;
          for (let i = Math.max(0, Math.floor(xa / lu) - 1); i < Math.min(s.length, Math.ceil(xb / lu) + 1); i++) {
            if (isNaN(s[i])) continue;
            const x = (i + 0.5) * lu, y = V.yOf(s[i]); any = true;
            if (i > 0 && !isNaN(s[i - 1])) c.lineTo(x, y); else { c.moveTo(x - 1, y); c.lineTo(x, y); }
          }
          if (any) {
            c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = isA ? 6 : 5; c.stroke();
            c.strokeStyle = lay.color; c.lineWidth = isA ? 3 : 2; c.stroke();
          }
        }
        for (const n of lay.notes) {   // notes: rounded bars in the layer colour
          const x = n.s * u + 1, w = Math.max(3, n.d * u - 2);
          if (x > xb || x + w < xa) continue;
          const on = playing && pos >= n.s && pos < n.s + n.d;
          rrectOn(c, x, V.yOf(n.m) - nh / 2, w, nh, Math.min(5, nh / 2));
          c.fillStyle = lay.color; c.fill();
          c.strokeStyle = n.sel ? '#fff' : on ? '#fff' : 'rgba(0,0,0,0.75)'; c.lineWidth = on || n.sel ? 2 : 1.25; c.stroke();
        }
        c.globalAlpha = 1;
      }
    }
    // Everything drawLayers depends on, as one string (the playback cache key): view geometry, layer looks, the visible
    // line samples, the notes and which of them sound now.
    const lc = document.createElement('canvas'), lx = lc.getContext('2d');
    let lkKey = '';
    function layersKey(S, A, playing, pos, xa, xb, u) {
      const lu = u / 3;
      let h = 0;
      const mix = (v) => { h = (Math.imul(h, 31) + (v !== v ? -7 : Math.round(v * 1024))) | 0; };
      const parts = [V.VW, V.TH, V.dpr, V.scrollX, V.pTop, V.span, u, xa, xb, A, V.noteH()];
      S.layers.forEach((lay, L) => {
        parts.push(lay.color, md.layerGain(S, L) === 0 ? 'q' : '');
        for (const st of md.strokes(lay)) {
          const v = st.v; mix(v.length);
          for (let i = Math.max(0, Math.floor(xa / lu) - 1); i < Math.min(v.length, Math.ceil(xb / lu) + 1); i++) mix(v[i]);
        }
        for (const n of lay.notes) { mix(n.s); mix(n.d); mix(n.m); mix(n.sel ? 1 : 0); mix(playing && pos >= n.s && pos < n.s + n.d ? 1 : 0); }
        mix(-99);
      });
      return parts.join(',') + ':' + h;
    }
    V.draw = function () {
      const S = M.song, E = M.engine, A = M.active, names = namesOf(S), tot = md.tot16(S), u = V.U(), SPB = md.spb(S);
      const playing = E.playing, phase = E.phase, pos = phase * tot, { VW, TH, MH, BW, CW, scrollX, dpr, X0, GW } = V;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, VW, TH);
      ctx.imageSmoothingEnabled = false;
      // the cached band image (1 px per sixteenth x R rows, top row = HI) cropped to the visible pitch range
      const RPS = M.bands.R / SPAN;
      if (M.bands.off.width === tot) ctx.drawImage(M.bands.off, 0, (HI - V.pTop) * RPS, tot, V.span * RPS, X0 - scrollX, HDR, CW, MH);
      ctx.translate(X0 - scrollX, 0);
      const b0 = Math.max(0, Math.floor(scrollX / BW)), b1 = Math.min(S.bars - 1, Math.floor((scrollX + GW) / BW));
      const curReg = playing ? md.regionAt(S, pos) : -1, xa = scrollX, xb = scrollX + GW, hb = V.highlightBar, hv = V.hdrHover;
      for (const R of md.regions(S)) {   // chord header strip: one block per chord region (its width = its duration)
        const x = R.a * u, w = (R.z - R.a) * u, ch = R.chord, b = R.i, inner = R.a % SPB !== 0;
        if (x > xb || x + w < xa) continue;
        const tints = lk().regions;
        ctx.fillStyle = tints && b === hb ? '#24345a' : tints && b === curReg ? '#22345e' : tints && hv && hv.kind === 'name' && hv.region === b ? '#1a2133' : '#141824'; ctx.fillRect(x, 0, w, HDR);
        ctx.strokeStyle = tints && b === hb ? '#6fa3ff' : '#262b3a'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, 0.5, w - 1, HDR - 1);
        ctx.save(); ctx.beginPath(); ctx.rect(x + 2, 0, w - 4, HDR); ctx.clip();
        ctx.textAlign = 'center';
        ctx.fillStyle = ch ? '#fff' : '#7a8194'; ctx.font = '600 ' + hdrFont(w) + 'px system-ui, sans-serif';
        ctx.fillText(ch ? chordName(ch, names) : '—', x + w / 2, 18);
        if (w >= 44) {
          ctx.fillStyle = '#7a8194'; ctx.font = (w < 70 ? 9 : 10.5) + 'px system-ui, sans-serif';
          ctx.fillText(ch ? chordMidis(ch).map((m) => names[m % 12]).join(' ') : 'no chord', x + w / 2, 33);
        }
        ctx.restore();
        if (inner) {   // a chord change inside the bar: a grip to drag the boundary
          const on = (hv && hv.kind === 'edge' && hv.region === b) || V.edgeDrag === b;
          ctx.fillStyle = on ? '#6fa3ff' : 'rgba(207,213,230,0.5)'; V.rrect(x - 1.5, 9, 3, HDR - 18, 1.5); ctx.fill();
        }
      }
      if (hv && hv.kind === 'plus') {   // split here
        const x = hv.at * u, y = HDR - 9;
        ctx.fillStyle = '#6fa3ff'; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = '#07101f'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x - 3.5, y); ctx.lineTo(x + 3.5, y); ctx.moveTo(x, y - 3.5); ctx.lineTo(x, y + 3.5); ctx.stroke();
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
      ctx.save();   // graph area: everything below is clipped to the visible map (zoom / scroll)
      ctx.beginPath(); ctx.rect(xa, HDR, GW, MH); ctx.clip();
      const mLo = Math.max(LO, Math.floor(V.pTop - V.span)), mHi = Math.min(HI, Math.ceil(V.pTop));
      const G = md.gridOf(S);
      if (V.showScale) {   // scale tint: a faint band on the rows of the section's scale (tuning steps outside 12-TET)
        const P = G.pts, rh = V.PPS();
        ctx.fillStyle = 'rgba(150,180,255,0.055)';
        for (let k = 0; k < P.length; k++) {
          if (!G.scaleCls.has(G.cls[k]) || P[k] < mLo - 1 || P[k] > mHi + 1) continue;
          const hgt = G.et12 ? rh * 0.8 : Math.min(rh * 0.8, Math.max(2, (k + 1 < P.length ? P[k + 1] - P[k] : 1) * rh * 0.8));
          ctx.fillRect(xa, V.yOf(P[k]) - hgt / 2, xb - xa, hgt);
        }
      }
      ctx.globalAlpha = lk().grid / 100;   // Map look: grid visibility (semitone, bar and beat lines)
      if (G.et12) {
        for (let m = mLo; m <= mHi; m++) {   // pitch grid
          const pc = m % 12, y = Math.round(V.yOf(m)) + 0.5;
          ctx.strokeStyle = pc === 0 ? 'rgba(255,255,255,0.32)' : NATURAL[pc] ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
          ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        }
      } else {
        for (let k = 0; k < G.pts.length; k++) {   // tuning grid: one line per step, the key root brighter
          const m = G.pts[k];
          if (m < mLo - 0.01 || m > mHi + 0.01) continue;
          const y = Math.round(V.yOf(m)) + 0.5;
          ctx.strokeStyle = G.cls[k] === 0 ? 'rgba(255,255,255,0.32)' : G.scaleCls.has(G.cls[k]) ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.045)';
          ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        }
      }
      const notesMode = S.layers[A].mode === 'notes', step = notesMode ? (S.grid === 16 ? 1 : 2) : 4;
      const beats = new Set(md.tsOf(S).beats);
      for (let k = Math.max(1, b0 * SPB); k < (b1 + 1) * SPB; k += 1) {   // bar / beat / grid lines (beats follow the time signature)
        const isBeat = beats.has(k % SPB);
        if (k % step && !isBeat) continue;
        const x = Math.round(k * u) + 0.5;
        ctx.strokeStyle = k % SPB === 0 ? 'rgba(255,255,255,0.4)' : isBeat ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.045)';
        ctx.beginPath(); ctx.moveTo(x, HDR); ctx.lineTo(x, HDR + MH); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineJoin = ctx.lineCap = 'round';
      if (playing) {   // the layer stack rarely changes between playback frames: rasterize it once, blit it until it does
        const key = layersKey(S, A, playing, pos, xa, xb, u);
        if (key !== lkKey || lc.width !== cv.width || lc.height !== cv.height) {
          if (lc.width !== cv.width || lc.height !== cv.height) { lc.width = cv.width; lc.height = cv.height; } else lx.clearRect(0, 0, lc.width, lc.height);
          lx.setTransform(dpr, 0, 0, dpr, 0, 0); lx.translate(X0 - scrollX, 0);
          lx.save(); lx.beginPath(); lx.rect(xa, HDR, GW, MH); lx.clip();
          drawLayers(lx, S, A, playing, pos, xa, xb, u);
          lx.restore(); lkKey = key;
        }
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(lc, 0, 0); ctx.restore();
      } else { lkKey = ''; drawLayers(ctx, S, A, playing, pos, xa, xb, u); }
      M.emit('draw', ctx, V);   // overlays (content coords, scroll + strip offset already applied, clipped to the map)
      const tool = M.tools && M.tools.current;
      if (tool && tool.draw) { try { tool.draw(ctx, V); } catch (err) { console.error('[melody] tool draw', err); } }
      if (playing) {   // playhead dots on every sounding stroke
        const x = phase * CW, i = Math.min(tot * 3 - 1, Math.floor(pos * 3));
        S.layers.forEach((l) => {
          for (const q of md.lineAt(l, i)) {
            ctx.fillStyle = l.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, V.yOf(q.m), 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
          }
        });
      }
      ctx.restore();
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
        const x = phase * CW;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HDR + MH); ctx.stroke();
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0d1019'; ctx.fillRect(0, 0, X0, HDR);   // corner over the piano strip (header scrolls under it)
      if (X0 > 0) drawKeys();
      if (V.zoomed()) {   // slim pitch scroll bar (right edge)
        const th = HDR + (HI - V.pTop) / SPAN * MH, tl = Math.max(16, V.span / SPAN * MH), x = VW - 7;
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x, HDR, 6, MH);
        ctx.fillStyle = 'rgba(207,213,230,0.7)'; V.rrect(x + 0.5, Math.min(th, HDR + MH - tl), 5, tl, 2.5); ctx.fill();
      }
    };
    return V;
  };
})();
