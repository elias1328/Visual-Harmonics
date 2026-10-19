// melody/tools.js - pointer tools on the melody canvas. The chord header strip is always handled first: chord name =
// picker, empty space = seek, drag = loop region, ✕ = clear it (or places an incoming chord). Below it, the current tool
// gets down/move/up/hover, and a readout near the pointer shows note + cents + fit %. Built-in tool: 'draw' (Line pen or
// Notes, per the layer's mode).
// Wave B adds tools with M.ui.addTool({ id, label, icon, ... }). See MELODY.md (Tools).
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody, md = NS.model;
  const { LO, HI, LPB, SPB, clamp } = md;

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
    function info(e) {
      const [x, y] = V.xy(e), S = M.song, t16 = clamp(V.t16Of(x), 0, S.bars * SPB - 1e-6);
      return { e, x, y, t16, midi: V.midiOf(y), bar: clamp(Math.floor(t16 / SPB), 0, S.bars - 1), layer: M.active, inHeader: y < V.HDR };
    }

    // ---------- built-in: draw (line pen / notes) ----------
    // Line strokes: a pen stroke that starts within ~1 semitone of an existing stroke (around that time) edits that
    // stroke over the drawn span ("fix"); one that starts farther away adds a new, overlapping stroke ("+ new").
    // Alt always adds a new stroke. A badge by the cursor tells which, before and while drawing.
    let pen = null, drag = null, penHover = null, altHeld = false;
    const NEAR = 1.05;   // semitones
    const idxAt = (x) => clamp(Math.floor(x / V.BW * LPB), 0, M.song.bars * LPB - 1);
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
    T.beginStroke = function (p) {
      const l = M.song.layers[M.active], tg = strokeTarget(p.x, p.y, (p.e && p.e.altKey) || altHeld);
      if (tg.st) return { st: tg.st, fix: true };
      if (l.lines.length >= md.MAX_STROKES) { M.toast('Up to ' + md.MAX_STROKES + ' line strokes per layer: draw near one to fix it'); return null; }
      return { st: md.addStroke(l, M.song.bars * LPB), fix: false };
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
      const S = M.song, s = drag.st.v, i = clamp(Math.floor(x / V.BW * LPB), 0, s.length - 1), m = V.midiOf(y);
      const from = pen ? pen.i : i, m0 = pen ? pen.m : m, st = i >= from ? 1 : -1;
      for (let k = from; ; k += st) {
        const t = i === from ? 1 : (k - from) / (i - from), mm = m0 + (m - m0) * t;
        s[k] = S.snap ? M.bands.snap(mm, Math.floor(k / LPB)) : mm;
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
    T.add({
      id: 'draw', label: 'Draw', icon: '✎', title: 'Draw: line pen or notes (per layer mode)',
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
        const g = S.grid === 16 ? 1 : 2, s = Math.floor(p.x / V.U() / g) * g;
        if (s >= S.bars * SPB) return false;
        const b = Math.floor(s / SPB), raw = V.midiOf(p.y), m = clamp(S.snap ? M.bands.snap(raw, b) : Math.round(raw), LO, HI);
        const n = { s, d: g, m };
        l.notes.push(n); drag = { kind: 'note', n, g }; M.requestRender();
        M.engine.previewNote(M.active, m, 0.3);
        return true;
      },
      move(p) {
        if (drag && drag.kind === 'line' && pen) { penHover = { x: p.x, y: p.y }; penTo(p.x, p.y); return; }
        if (drag && drag.kind === 'note') {
          const n = drag.n, end = Math.ceil(p.x / V.U() / drag.g) * drag.g;
          n.d = clamp(end - n.s, drag.g, M.song.bars * SPB - n.s); M.requestRender();
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
      const k = Math.round(m), c = Math.round((m - k) * 100), cs = M.bandsAt(t16).consonance(m);
      const nm = H.noteName(k) + (c ? ' ' + (c > 0 ? '+' : '−') + Math.abs(c) + '¢' : '');
      const pct = isNaN(cs) ? null : Math.round(cs * 100);
      return { text: nm + ' · ' + (pct == null ? 'no chord' : pct + '%' + (c ? '' : ' fit')), pct, midi: m };
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

    // ---------- chord header strip: chord name = picker, empty space = seek, drag = loop region, ✕ = clear region ----------
    let hdr = null;
    function headerDown(e, p) {
      if (M.placing && M.placing.ch) { M.placeChordAt(p.bar); return; }
      hdr = { x0: p.x, bar0: p.bar, bar: p.bar, moved: false, kind: V.headerHit(p.x, p.y) };
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
    function headerMove(p) {
      if (!hdr.moved && Math.abs(p.x - hdr.x0) > 8) hdr.moved = true;
      if (!hdr.moved) return;
      hdr.bar = p.bar;
      V.regionPreview = [Math.min(hdr.bar0, hdr.bar), Math.max(hdr.bar0, hdr.bar) + 1];
      M.requestRender();
    }
    function headerUp(p) {
      const h = hdr; hdr = null;
      if (V.regionPreview) { V.regionPreview = null; M.requestRender(); }
      if (h.moved) { M.setLoopRegion([Math.min(h.bar0, h.bar), Math.max(h.bar0, h.bar) + 1]); return; }
      if (h.kind === 'x') { M.setLoopRegion(null); return; }
      if (h.kind === 'name') { M.picker.toggle(h.bar0); return; }
      M.picker.close();
      M.engine.seek(clamp(Math.round(p.t16), 0, M.song.bars * SPB - 1));
    }

    // ---------- pointer dispatch ----------
    function call(fn, p) { try { return fn.call(cur, p, M); } catch (err) { console.error('[melody] tool ' + cur.id, err); return false; } }
    let lastP = null;
    // Abort the current drag (a second finger starts a pinch): back to the last committed song, then end the tool.
    T.cancel = function () {
      hideReadout();
      if (!capture) return;
      capture = false;
      M.revert();
      if (cur && cur.up && lastP) call(cur.up, lastP);
      penHover = null; M.requestRender();
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const p = info(e); lastP = p;
      if (p.inHeader) { hideReadout(); headerDown(e, p); return; }
      if (M.picker.isOpen) { M.picker.close(); return; }
      if (e.pointerType === 'touch') showReadout(e, p);
      if (!cur || !cur.down) return;
      capture = call(cur.down, p) !== false;
      if (capture) { try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = info(e); lastP = p;
      if (hdr) { headerMove(p); return; }
      showReadout(e, p);
      if (capture) { if (cur.move) call(cur.move, p); return; }
      if (cur && cur.hover) call(cur.hover, p);
      const c = cur && cur.cursor;
      cv.style.cursor = p.inHeader ? (M.placing ? 'copy' : V.headerHit(p.x, p.y) === 'empty' ? 'text' : 'pointer')
        : typeof c === 'function' ? call(c, p) || 'crosshair' : c || 'crosshair';
    });
    const end = (e) => {
      if (e.pointerType === 'touch' || e.type === 'pointercancel') hideReadout();
      if (hdr) { if (e.type === 'pointercancel') { hdr = null; V.regionPreview = null; M.requestRender(); } else headerUp(info(e)); return; }
      if (!capture) return;
      capture = false; if (cur && cur.up) call(cur.up, info(e));
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', (e) => {
      if (!capture || e.pointerType === 'touch') hideReadout();
      if (!capture && penHover) { penHover = null; M.requestRender(); }
    });
    return T;
  };
})();
