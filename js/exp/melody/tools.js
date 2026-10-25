// melody/tools.js - pointer tools on the melody canvas. The chord header strip is always handled first: chord name =
// picker, drag = loop region (the ruler above it seeks), ✕ = clear it (or places an incoming chord). Below it, the current tool
// gets down/move/up/hover, and a readout near the pointer shows note + cents + fit %. Built-in tool: 'draw' (Line pen or
// Notes, per the layer's mode).
// Parts add tools with M.ui.addTool({ id, label, icon, ... }). See MELODY.md (Tools).
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody, md = NS.model;
  const { LO, HI, clamp } = md;

  NS.Tools = function (M) {
    const V = M.view, cv = V.cv, tools = [];
    let cur = null, capture = false;
    const T = {
      list: tools,
      get current() { return cur; },
      add(tool) {
        if (!tool || !tool.id || tools.some((t) => t.id === tool.id)) return null;
        tools.push(tool);
        if (!cur) cur = tool;
        M.emit('tools', tools);
        return tool;
      },
      set(id) {
        const t = tools.find((x) => x.id === id);
        if (!t || t === cur) return;
        if (cur && cur.deactivate) cur.deactivate();
        cur = t;
        if (cur.activate) cur.activate();
        cv.style.cursor = typeof cur.cursor === 'string' ? cur.cursor : 'crosshair';
        M.emit('tool', cur); M.requestRender();
      },
    };
    // Pointer info passed to tools (content coords).
    // x is clamped to the song and the pitch to LO..HI, so a press in the silent edge margins still works (left / right / bottom).
    // The header is the ruler (inRuler: seek only) over the chord strip (inChord: chords, loop region).
    // Song view: x / t16 are relative to the section under the pointer (or the one a drag began in, V.lock); gt is the
    // song position (sixteenths), foreign says that section is not the shown one (hover only: a press shows it first).
    function info(e, ov) {
      let [x0, y] = V.xy(e), S = M.song, W = V.CW, it = null;
      if (V.song) { const items = V.items(); it = items[V.lock >= 0 && items[V.lock] ? V.lock : V.itemIdx(items, V.gxy(e)[0])]; W = it.n * V.U(); }
      if (ov) { x0 = ov.x; y = ov.y; }
      const x = clamp(x0, 0, W - 1e-6), tot = it ? it.n : md.tot16(S), t16 = clamp(V.t16Of(x), 0, tot - 1e-6), foreign = !!it && it.k !== S.cur;
      return { e, x, y, t16, midi: V.midiOf(y), bar: md.barAt(S, t16), region: md.regionAt(S, t16), layer: M.active, inHeader: y < V.HDR, inRuler: y < V.RL, inChord: y >= V.RL && y < V.HDR,
        gt: it ? it.a + t16 : t16, item: it, foreign };
    }

    // ---------- built-in: draw (line pen / notes) ----------
    // Line strokes: a pen stroke that starts within ~1 semitone of an existing stroke (around that time) edits that
    // stroke over the drawn span ("fix"); one that starts farther away adds a new, overlapping stroke ("+ new").
    // Alt always adds a new stroke. A badge by the cursor tells which, before and while drawing.
    let pen = null, drag = null, penHover = null, altHeld = false;
    const NEAR = 1.05;   // semitones
    const idxAt = (x) => clamp(Math.floor(x / V.U() * 3), 0, md.tot16(M.song) * 3 - 1);   // line sample (3 per sixteenth)
    // The stroke of layer l nearest to midi m within NEAR around sample i (± a sixteenth), or null.
    function strokeNear(l, i, m) {
      let best = null, bd = NEAR;
      for (const st of md.strokes(l)) {
        for (let k = Math.max(0, i - 3); k <= Math.min(st.v.length - 1, i + 3); k++) {
          const v = st.v[k];
          if (isNaN(v)) continue;
          const d = Math.abs(v - m) + Math.abs(k - i) * 0.01;
          if (d <= bd) { bd = d; best = st; }
        }
      }
      return best;
    }
    // Where a line stroke starting at content (x, y) goes: { st (stroke to fix) | null (new), i, m }.
    function strokeTarget(x, y, alt) {
      const l = M.song.layers[M.active], i = idxAt(x), m = V.midiOf(y);
      return { st: alt ? null : strokeNear(l, i, m), i, m };
    }
    T.strokeTarget = strokeTarget;
    T.strokeNear = strokeNear;
    // Stroke to draw into for a press at p (creates the new one). null when the layer is full.
    T.lastStroke = null;   // the stroke the latest press began / fixes (Song view joins the pieces across sections with it)
    T.beginStroke = function (p) {
      const l = M.song.layers[M.active], tg = strokeTarget(p.x, p.y, (p.e && p.e.altKey) || altHeld);
      if (tg.st) { T.lastStroke = tg.st; return { st: tg.st, fix: true }; }
      if (l.lines.length >= md.MAX_STROKES) { M.toast('Up to ' + md.MAX_STROKES + ' line strokes per layer: draw near one to fix it'); return null; }
      T.lastStroke = md.addStroke(l, md.tot16(M.song) * 3);
      return { st: T.lastStroke, fix: false };
    };
    // "fix" / "+ new" pill by the cursor (content coords)
    T.drawBadge = function (ctx, x, y, fix) {
      const t = fix ? 'fix' : '+ new';
      ctx.save();
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left';
      const w = ctx.measureText(t).width + 10, bx = x + 12, by = y + 12;
      V.rrect(bx, by, w, 17, 8.5);
      ctx.fillStyle = fix ? 'rgba(255,201,60,0.92)' : 'rgba(125,255,138,0.92)'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#0b0d12'; ctx.fillText(t, bx + 5, by + 12.5);
      ctx.restore();
    };
    T.badgeState = () => {   // tests: what the badge shows now ('fix' | 'new' | null)
      if (drag && drag.kind === 'line') return drag.fix ? 'fix' : 'new';
      if (!penHover || M.song.layers[M.active].mode !== 'line') return null;
      return strokeTarget(penHover.x, penHover.y, penHover.alt || altHeld).st ? 'fix' : 'new';
    };
    const onAlt = (e) => { if (e.key === 'Alt') { const a = e.type === 'keydown'; if (a !== altHeld) { altHeld = a; M.requestRender(); } } };
    document.addEventListener('keydown', onAlt); document.addEventListener('keyup', onAlt);
    const onBlur = () => { altHeld = false; };
    window.addEventListener('blur', onBlur);
    if (M.cleanups) M.cleanups.push(() => { document.removeEventListener('keydown', onAlt); document.removeEventListener('keyup', onAlt); window.removeEventListener('blur', onBlur); });
    function penTo(x, y) {
      const S = M.song, s = drag.st.v, i = clamp(Math.floor(x / V.U() * 3), 0, s.length - 1), m = V.midiOf(y);
      const from = pen ? pen.i : i, m0 = pen ? pen.m : m, st = i >= from ? 1 : -1;
      for (let k = from; ; k += st) {
        const t = i === from ? 1 : (k - from) / (i - from), mm = m0 + (m - m0) * t;
        s[k] = S.snap ? M.bands.snap(mm, md.regionAt(S, k / 3)) : mm;
        if (k === i) break;
      }
      pen = { i, m }; M.requestRender();
    }
    function noteAt(x, y) {
      const ns = M.song.layers[M.active].notes, u = V.U(), tol = Math.max(6, V.noteH() / 2 + 2);
      for (let k = ns.length - 1; k >= 0; k--) {
        const n = ns[k];
        if (x >= n.s * u && x <= (n.s + n.d) * u && Math.abs(y - V.yOf(n.m)) <= tol) return k;
      }
      return -1;
    }
    T.noteAt = noteAt;
    // Pitch for a new / dragged note at canvas-content y, start s: snapped to the bright bands (Snap on) or to the tuning grid.
    const notePitch = (y, s) => { const S = M.song, raw = V.midiOf(y); return clamp(S.snap ? M.bands.snap(raw, md.regionAt(S, s)) : md.gridSnap(S, raw), LO, HI); };
    T.add({
      id: 'draw', label: 'Draw', icon: '✎', title: 'Draw (P pen, N notes): line pen or notes, per layer mode',
      down(p) {
        const S = M.song, l = S.layers[M.active];
        if (l.mode === 'line') {
          const b = T.beginStroke(p);
          if (!b) return false;
          pen = null; drag = { kind: 'line', st: b.st, fix: b.fix }; penHover = { x: p.x, y: p.y };
          penTo(p.x, p.y); return true;
        }
        const hit = noteAt(p.x, p.y);
        if (hit >= 0) { l.notes.splice(hit, 1); M.commit('Delete note'); return false; }
        const st = md.gridStep(S.grid), s = md.gridFloor(p.x / V.U(), S.grid), tot = md.tot16(S);
        if (s >= tot) return false;
        const m = notePitch(p.y, s), n = { s, d: Math.min(st, tot - s), m };
        l.notes.push(n); drag = { kind: 'note', n, st, s0: s, y0: p.y, vert: false }; M.requestRender();
        M.engine.previewNote(M.active, m, 0.3);
        return true;
      },
      move(p) {
        if (drag && drag.kind === 'line' && pen) { penHover = { x: p.x, y: p.y }; penTo(p.x, p.y); return; }
        if (drag && drag.kind === 'note') {   // hold + drag: right = longer, left of the start = the note spans the range, up / down = pitch
          const S = M.song, n = drag.n, tot = md.tot16(S), tt = p.x / V.U(), g = S.grid;
          let a = drag.s0, z = drag.s0 + drag.st;
          if (tt < drag.s0) a = Math.max(0, md.gridFloor(tt, g)); else z = Math.max(z, md.gridCeil(tt, g));
          z = Math.min(z, tot);
          n.s = a; n.d = md.r5(Math.max(z - a, Math.min(drag.st, tot - a)));
          if (!drag.vert && Math.abs(p.y - drag.y0) >= 5) drag.vert = true;
          if (drag.vert) {
            const m = notePitch(p.y, a);
            if (m !== n.m) { n.m = m; M.engine.previewNote(M.active, m, 0.3); }
          }
          M.requestRender();
        }
      },
      up(p) {
        const d = drag; pen = null; drag = null;
        if (p && p.e && p.e.pointerType === 'touch') penHover = null;
        if (d) M.commit(d.kind === 'line' ? (d.fix ? 'Draw line' : 'Draw new line') : 'Add note');
      },
      hover(p) { const o = penHover; penHover = p.inHeader ? null : { x: p.x, y: p.y, alt: !!(p.e && p.e.altKey) }; if (o || penHover) M.requestRender(); },
      deactivate() { penHover = null; },
      draw(ctx) {
        if (M.song.layers[M.active].mode !== 'line') return;
        if (drag && drag.kind === 'line' && penHover) { T.drawBadge(ctx, penHover.x, penHover.y, drag.fix); return; }
        if (penHover && !V.pinching()) T.drawBadge(ctx, penHover.x, penHover.y, !!strokeTarget(penHover.x, penHover.y, penHover.alt || altHeld).st);
      },
      cursor(p) { return M.song.layers[M.active].mode === 'notes' && noteAt(p.x, p.y) >= 0 ? 'pointer' : 'crosshair'; },
    });

    // ---------- hover readout: note + cents + fit % under the pointer (same band data as the map) ----------
    const H = VH.harmony;
    const ro = VH.ui.h('div', 'mel-readout'); ro.hidden = true; ro.setAttribute('aria-hidden', 'true');
    M.el.append(ro);
    T.readout = ro;
    // Text for a pitch at time t16 on the active layer: "E4 · 92% fit" / "F#4 +18¢ · 31%" / "E4 · no chord".
    T.readoutText = function (t16, m) {
      const k = Math.round(m), c = Math.round((m - k) * 100), at = M.bandsAt(t16), tn = at.tension > 0, cs = tn ? at.match(m) : at.consonance(m);
      const nm = H.noteName(k) + (c ? ' ' + (c > 0 ? '+' : '−') + Math.abs(c) + '¢' : '');
      const pct = isNaN(cs) ? null : Math.round(cs * 100);
      return { text: nm + ' · ' + (pct == null ? 'no chord' : pct + '%' + (c ? '' : tn ? ' match' : ' fit')), pct, midi: m };
    };
    function showReadout(e, p) {
      if (p.inHeader || (e.pointerType === 'touch' && !(e.buttons & 1) && e.type !== 'pointerdown')) { hideReadout(); return; }
      const r = T.readoutText(p.t16, p.midi);
      ro.textContent = r.text; ro.dataset.pct = r.pct == null ? '' : r.pct; ro.dataset.midi = r.midi.toFixed(3);
      ro.classList.toggle('nochord', r.pct == null);
      ro.style.setProperty('--fit', r.pct == null ? 0 : r.pct / 100);
      ro.hidden = false;
      const er = M.el.getBoundingClientRect(), w = ro.offsetWidth, h = ro.offsetHeight, touch = e.pointerType === 'touch';
      const cx = e.clientX - er.left, cy = e.clientY - er.top, pad = 6;
      let x = touch ? cx - w / 2 : cx + 14, y = touch ? cy - h - 44 : cy - h - 12;
      if (!touch && x + w > er.width - pad) x = cx - w - 14;   // flip to the left of the cursor near the right edge
      if (y < pad) y = touch ? cy + 40 : cy + 18;
      ro.style.left = Math.round(clamp(x, pad, Math.max(pad, er.width - w - pad))) + 'px';
      ro.style.top = Math.round(clamp(y, pad, Math.max(pad, er.height - h - pad))) + 'px';
    }
    function hideReadout() { if (!ro.hidden) ro.hidden = true; }
    T.hideReadout = hideReadout;

    // ---------- chord header strip: chord name = picker, drag = loop region, ✕ = clear region ----------
    // Chord regions: "+" at a beat boundary (hover near the strip's bottom) splits; a grip between two chords drags the
    // boundary (snaps to beats, Shift: half-beats); dropping it on the next / previous boundary merges; right-click menu.
    let hdr = null;
    // Snapped boundary position for content x inside bar `bar` (Shift = half-beats).
    T.edgeSnap = function (x, bar, half) {
      const S = M.song, n = md.spb(S), t = x / V.U() - bar * n;
      let best = 0, bd = Infinity;
      for (const p of md.beatGrid(S, half).concat([n])) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
      return bar * n + best;
    };
    // Move the boundary of region r to t16 (clamped to its neighbours). Returns 'move' | 'merge-left' | 'merge-right'.
    function edgeTo(r, t) {
      const S = M.song, e = S.chords[r], lo = S.chords[r - 1].at, hi = md.regionEnd(S, r);
      t = clamp(t, lo, hi);
      if (t <= lo) return { kind: 'merge-left', t: lo };
      if (t >= hi) return { kind: 'merge-right', t: hi };
      e.at = t;
      return { kind: 'move', t };
    }
    T.edgeTo = edgeTo;
    // Finish a boundary drag: merge or move, one undo step (auto-fit runs on the chords that changed in time).
    T.edgeDone = function (r, res) {
      const S = M.song;
      if (res.kind === 'merge-left') {   // the region before collapsed: this chord now starts where it did
        S.chords[r].at = S.chords[r - 1].at; S.chords.splice(r - 1, 1);
        M.commit('Merge chords', { chords: [r - 1], source: 'chord' });
      } else if (res.kind === 'merge-right') {
        S.chords.splice(r, 1);
        M.commit('Merge chords', { chords: [r - 1], source: 'chord' });
      } else M.commit('Move chord change', { chords: [r - 1, r], source: 'chord' });
    };
    function headerDown(e, p) {
      if (M.placing && M.placing.ch) { M.placeChordAt(p.region); return; }
      const h = V.hdrAt(p.x, p.y);
      if (h.kind === 'edge') {
        hdr = { edge: h.region, at0: h.at, bar: md.barAt(M.song, h.at - 1e-6), res: { kind: 'move', t: h.at }, moved: false, x0: p.x };
        V.edgeDrag = h.region;
      } else hdr = { x0: p.x, bar0: p.bar, bar: p.bar, moved: false, kind: h.kind, hit: h };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
    function headerMove(p) {
      if (hdr.edge != null) {
        if (!hdr.moved && Math.abs(p.x - hdr.x0) > 3) hdr.moved = true;
        if (!hdr.moved) return;
        const S = M.song, n = md.spb(S), bar = hdr.bar, x = clamp(p.x, bar * n * V.U(), (bar + 1) * n * V.U());
        S.chords[hdr.edge].at = hdr.at0;
        hdr.res = edgeTo(hdr.edge, T.edgeSnap(x, bar, !!(p.e && p.e.shiftKey)));
        if (hdr.res.kind !== 'move') S.chords[hdr.edge].at = hdr.res.t;   // preview at the neighbour
        M.bands.dirty = true; M.requestRender();
        return;
      }
      if (!hdr.moved && Math.abs(p.x - hdr.x0) > 8) hdr.moved = true;
      if (!hdr.moved) return;
      hdr.bar = p.bar;
      V.regionPreview = [Math.min(hdr.bar0, hdr.bar), Math.max(hdr.bar0, hdr.bar) + 1];
      M.requestRender();
    }
    function headerUp(p) {
      const h = hdr; hdr = null;
      if (h.edge != null) {
        V.edgeDrag = null;
        const S = M.song;
        if (!h.moved) { S.chords[h.edge].at = h.at0; M.requestRender(); return; }
        if (h.res.kind !== 'move') S.chords[h.edge].at = h.at0;
        T.edgeDone(h.edge, h.res);
        return;
      }
      if (V.regionPreview) { V.regionPreview = null; M.requestRender(); }
      if (h.moved) { M.setLoopRegion([Math.min(h.bar0, h.bar), Math.max(h.bar0, h.bar) + 1]); return; }
      if (h.kind === 'x') { M.setLoopRegion(null); return; }
      if (h.kind === 'plus') { M.picker.close(); M.splitChord(h.hit.at); return; }
      if (h.kind === 'name') { M.picker.toggle(h.hit.region); return; }
      M.picker.close();   // empty chord-strip space never seeks (that is the ruler's job)
    }
    // Ruler above the chord strip: click / drag only seeks the playhead.
    let rul = null;
    function rulerTo(p) {
      if (V.song) {   // Song view: the ruler seeks along the whole arrangement (the section there becomes the shown one)
        const t = clamp(Math.round(p.gt), 0, md.songTot(M.song) - 1);
        if (rul.t !== t) { rul.t = t; M.seekSong(t); }
        return;
      }
      const t = clamp(Math.round(p.t16), 0, md.tot16(M.song) - 1);
      if (rul.t !== t) { rul.t = t; M.engine.seek(t); }
    }
    // Right-click on the chord strip: Split here / Merge / Change chord.
    const cmenu = VH.ui.h('div', 'mel-cmenu mel-float'); cmenu.hidden = true; cmenu.setAttribute('role', 'menu');
    M.el.append(cmenu);
    T.closeMenu = () => { cmenu.hidden = true; };
    T.openMenu = function (p, clientX, clientY) {
      const S = M.song, n = md.spb(S), r = p.region, e = S.chords[r], z = md.regionEnd(S, r), bar = md.barAt(S, e.at);
      const at = T.edgeSnap(p.x, md.barAt(S, p.t16), false), next = S.chords[r + 1];
      const items = [];
      if (at > e.at && at < z) items.push(['Split here', () => M.splitChord(at)]);
      if (r > 0 && e.at % n) items.push(['Merge with previous', () => M.mergeChord(r)]);
      if (next && next.at % n && md.barAt(S, next.at) === bar) items.push(['Merge with next', () => M.mergeChord(r + 1)]);
      items.push(['Change chord…', () => M.picker.open(r)]);
      cmenu.innerHTML = '';
      items.forEach(([label, run]) => {
        const b = VH.ui.h('button', 'mel-cm-item', label); b.type = 'button'; b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => { T.closeMenu(); run(); });
        cmenu.append(b);
      });
      cmenu.hidden = false;
      const er = M.el.getBoundingClientRect();
      cmenu.style.left = clamp(clientX - er.left, 6, Math.max(6, er.width - cmenu.offsetWidth - 6)) + 'px';
      cmenu.style.top = clamp(clientY - er.top + 4, 6, Math.max(6, er.height - cmenu.offsetHeight - 6)) + 'px';
      const f = cmenu.querySelector('button'); if (f) f.focus({ preventScroll: true });
    };
    cv.addEventListener('contextmenu', (e) => {
      let p = info(e);
      if (!p.inChord) return;
      if (p.foreign) { if (M.engine.playing) return; M.selectSection(p.item.k); p = info(e); }
      e.preventDefault();
      T.openMenu(p, e.clientX, e.clientY);
    });
    const offMenu = (e) => { if (!cmenu.hidden && !cmenu.contains(e.target)) T.closeMenu(); };
    const escMenu = (e) => { if (e.key === 'Escape' && !cmenu.hidden) T.closeMenu(); };
    document.addEventListener('pointerdown', offMenu, true); document.addEventListener('keydown', escMenu);
    if (M.cleanups) M.cleanups.push(() => { document.removeEventListener('pointerdown', offMenu, true); document.removeEventListener('keydown', escMenu); });

    // ---------- Song view: line strokes over section boundaries ----------
    // A pen / line drag that leaves its section is split: the piece so far ends at the boundary, the next section gets a new
    // stroke that starts there at the same pitch (and the same stroke id when free there, so playback glides on in one
    // voice). Every piece is committed silently (M.holding); the release records ONE undo step for the whole gesture.
    let hopped = false, lastG = null;
    const hopTool = () => (cur.id === 'pen' || cur.id === 'line' || cur.id === 'draw') && M.song.layers[M.active].mode === 'line';
    function hopAcross(e, gx, y) {
      const items = V.items(), U = V.U();
      for (let guard = 0; guard < 64; guard++) {
        const it = items[V.lock];
        if (!it) return;
        const x0 = it.a * U, x1 = (it.a + it.n) * U, dir = gx >= x1 ? 1 : gx < x0 ? -1 : 0, ni = V.lock + dir;
        if (!dir || ni < 0 || ni >= items.length) return;
        const gb = dir > 0 ? x1 : x0, f = gx === lastG.x ? 1 : clamp((gb - lastG.x) / (gx - lastG.x), 0, 1), yb = lastG.y + (y - lastG.y) * f;
        const edge = dir > 0 ? it.n * U - 1e-3 : 0, last = T.lastStroke, prevId = last && last.id;
        call(cur.move, info(e, { x: edge, y: yb }));
        const vb = last ? last.v[dir > 0 ? last.v.length - 1 : 0] : NaN;
        if (!M.holding) { M.holding = true; M.heldLabel = ''; }
        call(cur.up, info(e, { x: edge, y: yb }));
        const nxt = items[ni];
        if (nxt.k !== M.song.cur) M.selectSection(nxt.k);
        V.lock = V.focus = ni; hopped = true;
        const p = info(e, { x: dir > 0 ? 0 : nxt.n * U - 1e-3, y: yb });
        p.e = { pointerType: e.pointerType, pointerId: e.pointerId, shiftKey: e.shiftKey, altKey: true, clientX: e.clientX, clientY: e.clientY };   // Alt: always a new stroke
        if (!isNaN(vb)) { p.midi = vb; p.y = V.yOf(vb); p.exact = true; }
        capture = call(cur.down, p) !== false;
        const ns = T.lastStroke;
        if (ns && ns !== last) {
          const l = M.song.layers[M.active];
          if (prevId && !l.lines.some((q) => q !== ns && q.id === prevId)) ns.id = prevId;
          if (!isNaN(vb)) ns.v[dir > 0 ? 0 : ns.v.length - 1] = vb;
        }
        lastG = { x: gb, y: yb };
        if (!capture) return;
      }
    }
    function finishHold() {   // the gesture ended: one undo step for everything it did
      if (!M.holding) return;
      const lb = M.heldLabel || 'Draw line';
      M.holding = false; M.heldLabel = '';
      M.commit(lb + ' across sections');
    }

    // ---------- pointer dispatch ----------
    function call(fn, p) { try { return fn.call(cur, p, M); } catch (err) { console.error('[melody] tool ' + cur.id, err); return false; } }
    let lastP = null;
    // Abort the current drag (a second finger starts a pinch): back to the last committed song, then end the tool.
    T.cancel = function () {
      hideReadout();
      V.lock = -1; M.holding = false; M.heldLabel = '';
      if (!capture) return;
      capture = false;
      M.revert();
      if (cur && cur.up && lastP) call(cur.up, lastP);
      penHover = null; M.requestRender();
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      let p = info(e); lastP = p;
      if (V.song && !p.inRuler) {   // Song view: a press belongs to the section under it, which becomes the shown one
        if (p.foreign && M.engine.playing) { M.toast('Stop playback to edit another section'); return; }
        if (p.foreign) M.selectSection(p.item.k);
        const items = V.items();
        V.lock = V.focus = items.findIndex((q) => q.a === p.item.a);
        p = info(e); lastP = p; lastG = { x: V.gxy(e)[0], y: p.y }; hopped = false;
      }
      if (p.inRuler) {
        hideReadout(); M.picker.close(); rul = { t: -1, id: e.pointerId };
        try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        rulerTo(p); return;
      }
      if (p.inHeader) { hideReadout(); headerDown(e, p); return; }
      if (M.picker.isOpen) { M.picker.close(); return; }
      if (e.pointerType === 'touch') showReadout(e, p);
      if (!cur || !cur.down) return;
      capture = call(cur.down, p) !== false;
      if (capture) { try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }
    });
    // ---------- harmony hints: where a new note would sound best with everything sounding at the pointer's time ----------
    // While hovering / dragging with the pen, notes or line tool, short dashes mark the most consonant pitches (same Plomp-Levelt
    // sum as the bands, with each sound's own spectrum) against ALL notes sounding then (every audible layer, the active layer
    // and the dragged note included) plus the backing chord. A view preference (V.hintsOn, key H); M.hints is the debug / test hook.
    const HINT_TOOLS = { draw: 1, pen: 1, notes: 1, line: 1 }, IVN = ['unison', 'm2', 'M2', 'm3', 'M3', 'P4', 'tritone', 'P5', 'm6', 'M6', 'm7', 'M7'];
    const hintMemo = new Map(), sids = new Map();
    const sid = (o) => { if (!sids.has(o)) sids.set(o, sids.size); return sids.get(o); };
    const hstat = { runs: 0, last: 0, max: 0, total: 0, hits: 0 };
    let hpos = null;   // { gt (song position, sixteenths), t16, item, y } of the pointer, or null
    M.on('sounds', () => { hintMemo.clear(); sids.clear(); });
    function hintTones(Sx, k, t16) {
      const out = [], live = Sx === M.song, i3 = Math.floor(t16 * 3);
      Sx.layers.forEach((l, L) => {
        if (!(md.layerGain(Sx, L) > 0)) return;
        const snd = live ? M.soundOf(L) : (VH.sounds.get(l.sound) || M.soundOf(L)), add = (m) => out.push({ m, L, hz: H.midiToHz(m), snd });
        for (const n of l.notes || []) if (n.s <= t16 && t16 < n.s + n.d) add(n.m);
        for (const q of md.lineAt(l, i3)) add(q.m);
      });
      const ch = md.regionChord(Sx, md.regionAt(Sx, t16));
      if (ch && Sx.backing && Sx.backing.on !== false) {
        const bs = live ? M.backingSound() : M.backingSoundOf(k);
        for (const m of md.chordMidis(ch, Sx)) out.push({ m, L: -1, hz: H.midiToHz(m), snd: bs });
      }
      return out;
    }
    function hintsAt(pos) {   // -> { k, t16, cands: [{m, c, d}], tones, ms } (memoized by sounding pitch set + sounds + range)
      const S = M.song, it = pos.item, k = it ? it.k : S.cur, Sx = it && it.k !== S.cur ? md.sectionSong(S, it.k) : S;
      if (!Sx) return null;
      const tones = hintTones(Sx, k, pos.t16), snd = M.soundOf(M.active), hi = Math.min(md.HI, Math.ceil(V.pTop)), lo = Math.max(md.LO, Math.floor(V.pTop - V.span));
      const key = tones.map((t) => t.L + ':' + Math.round(t.m * 100) + ':' + sid(t.snd)).join(',') + '|' + sid(snd) + '|' + lo + '|' + hi;
      let r = hintMemo.get(key);
      if (r) hstat.hits++;
      else {
        const t0 = performance.now();
        r = NS.hintCandidates(tones.map((t) => ({ hz: t.hz, m: t.m, spec: M.bands.spectrumOf(t.snd) })), M.bands.spectrumOf(snd), lo, hi, { n: 4 });
        const ms = performance.now() - t0;
        hstat.runs++; hstat.last = ms; hstat.total += ms; hstat.max = Math.max(hstat.max, ms);
        if (hintMemo.size > 80) hintMemo.clear();
        hintMemo.set(key, r);
      }
      return { k, t16: pos.t16, cands: r, tones };
    }
    const hintName = (m) => { const k = Math.round(m), c = Math.round((m - k) * 100); return H.noteName(k) + (c ? (c > 0 ? '+' : '−') + Math.abs(c) + '¢' : ''); };
    function hintLabel(h, c) {
      let nt = null;
      for (const t of h.tones) if (!nt || Math.abs(t.m - c.m) < Math.abs(nt.m - c.m)) nt = t;
      const d = nt ? Math.round(Math.abs(c.m - nt.m)) : 0;
      return hintName(c.m) + (nt ? ' · ' + (d && d % 12 === 0 ? (d / 12 > 1 ? d / 12 + ' oct' : 'octave') : IVN[d % 12]) : '');
    }
    T.drawHints = function (ctx) {
      M.hints.cur = null;
      if (!V.hintsOn || !hpos || !cur || !HINT_TOOLS[cur.id] || V.pinching()) return;
      const h = hintsAt(hpos);
      M.hints.cur = h;
      if (!h || !h.cands.length) return;
      const x = hpos.gt * V.U() - V.origin, hi = Math.min(md.HI, V.pTop), lo = Math.max(md.LO, V.pTop - V.span), h2 = Math.max(2, V.noteH() * 0.32);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, V.yOf(hi)); ctx.lineTo(x, V.yOf(lo)); ctx.stroke();
      for (const t of h.tones) {   // what is sounding here: small rings (backing chord tones fainter)
        if (t.m < lo || t.m > hi) continue;
        ctx.strokeStyle = t.L < 0 ? 'rgba(255,255,255,0.35)' : (M.song.layers[t.L] || {}).color || '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, V.yOf(t.m), 3.5, 0, 2 * Math.PI); ctx.stroke();
      }
      h.cands.forEach((c, i) => {
        const y = V.yOf(c.m), a = 0.3 + 0.7 * c.c;
        ctx.fillStyle = 'rgba(' + (i ? '180,240,255' : '255,255,255') + ',' + a.toFixed(2) + ')'; ctx.strokeStyle = 'rgba(0,0,0,' + (0.55 * a).toFixed(2) + ')'; ctx.lineWidth = 1;
        V.rrect(x - 13, y - h2 / 2, 26, h2, h2 / 2); ctx.fill(); ctx.stroke();
      });
      if (M.bands.look().labels) {
        const c = h.cands[0], y = V.yOf(c.m), t = hintLabel(h, c);
        ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(t).width + 10, bx = x + 17;
        V.rrect(bx, y - 8, w, 16, 8); ctx.fillStyle = 'rgba(11,13,18,0.82)'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(t, bx + 5, y + 0.5);
      }
      ctx.restore();
    };
    M.hints = { cur: null, stats: hstat, get on() { return V.hintsOn; }, set: (v) => V.setHints(v), toggle: () => V.setHints(!V.hintsOn), at: hintsAt };
    function hintMove(p, e) {   // pointer over the map with a hint tool (or null to clear)
      const on = p && V.hintsOn && !p.inHeader && cur && HINT_TOOLS[cur.id] && !(e && e.pointerType === 'touch' && !(e.buttons & 1) && !capture);
      const n = on ? { gt: p.gt, t16: p.t16, item: p.item, y: p.y } : null;
      if (!n && !hpos) return;
      hpos = n; M.requestRender();
    }
    cv.addEventListener('pointermove', (e) => {
      let p = info(e); lastP = p;
      if (rul) { rulerTo(p); return; }
      if (hdr) { headerMove(p); return; }
      if (V.song && p.foreign && !capture) {   // hover over a section that is not the shown one: no tool hover until a press shows it
        hideReadout(); if (V.hdrHover) { V.hdrHover = null; M.requestRender(); }
        hintMove(p, e);
        if (penHover) { penHover = null; M.requestRender(); }
        cv.style.cursor = p.inRuler ? 'col-resize' : p.inHeader ? 'default' : 'crosshair';
        return;
      }
      const hv = p.inChord && !M.placing ? V.hdrAt(p.x, p.y) : null, ov = V.hdrHover;
      if ((hv ? hv.kind + hv.region + ':' + hv.at : '') !== (ov ? ov.kind + ov.region + ':' + ov.at : '')) { V.hdrHover = hv; M.requestRender(); }
      showReadout(e, p);
      hintMove(p, e);
      if (capture) {
        if (V.song && V.lock >= 0 && lastG && hopTool()) { const gx = V.gxy(e)[0]; hopAcross(e, gx, p.y); lastG = { x: gx, y: p.y }; if (hopped) { p = info(e); lastP = p; } }
        if (capture && cur.move) call(cur.move, p);
        return;
      }
      if (cur && cur.hover) call(cur.hover, p);
      const c = cur && cur.cursor;
      cv.style.cursor = p.inRuler ? 'col-resize' : p.inHeader ? (M.placing ? 'copy' : hv.kind === 'empty' ? 'default' : hv.kind === 'edge' ? 'ew-resize' : 'pointer')
        : typeof c === 'function' ? call(c, p) || 'crosshair' : c || 'crosshair';
    });
    const end0 = (e) => {
      if (e.pointerType === 'touch' || e.type === 'pointercancel') { hideReadout(); hintMove(null); }
      if (rul) { rul = null; return; }
      if (hdr) {
        if (e.type === 'pointercancel') { if (hdr.edge != null) { M.song.chords[hdr.edge].at = hdr.at0; V.edgeDrag = null; } hdr = null; V.regionPreview = null; M.requestRender(); } else headerUp(info(e));
        return;
      }
      if (!capture) return;
      capture = false; if (cur && cur.up) call(cur.up, info(e));
    };
    const end = (e) => { end0(e); V.lock = -1; finishHold(); };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', (e) => {
      if (V.hdrHover) { V.hdrHover = null; M.requestRender(); }
      if (!capture || e.pointerType === 'touch') hideReadout();
      if (!capture && penHover) { penHover = null; M.requestRender(); }
      if (!capture) hintMove(null);
    });
    M.on('tool', () => hintMove(null));
    return T;
  };
})();
