// melody/tools-edit.js - B1 editing tools (a Wave B part, see MELODY.md):
//   tool palette Pen (P) · Line (L, straight glide) · Notes (N) · Select (V) · Eraser (E) in the dock's Tool pop-over,
//   selection (click / box / Shift adds, drag to move with snap, Delete, Ctrl+C/X/V, Ctrl+A, Esc),
//   vibrato per line range / note (floating mini toolbar; stored in song.ext.edit so it is undoable and re-editable;
//   applied live through M.hooks.pitchMod; drawn as a wavy line), and auto-fit of a bar's notes to a new chord
//   (a beforeCommit hook, so it also fits generated progressions, in the same undo step).
// Vibrato data lives in S.ext.edit.vib[layer] = { s: { <stroke id>: [[from, to, cents, hz], ...] } (line sample ranges of
//                                                  that stroke, to exclusive), n: [[s, m, cents, hz], ...] (notes by start + pitch) }.
// (Songs before strokes stored one `l: ranges` list; model.parse moves it to s.s1.)
// VH.melody.vibrato exposes the read helpers (e.g. for an offline export).
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody, md = NS.model;
  const { LO, HI, clamp } = md;
  const SPS = 3;                    // line samples per sixteenth
  const DEF_RATE = 5.5;
  let clip = null;                  // clipboard, kept across remounts

  // ---------- vibrato data (pure helpers on a song) ----------
  const arr = (a) => (Array.isArray(a) ? a : []);
  function vstore(S, L, make) {
    if (!S.ext || typeof S.ext !== 'object') { if (!make) return null; S.ext = {}; }
    let ed = S.ext.edit;
    if (!ed || typeof ed !== 'object') { if (!make) return null; ed = S.ext.edit = {}; }
    let v = ed.vib;
    if (!v || typeof v !== 'object') { if (!make) return null; v = ed.vib = {}; }
    let x = v[L];
    if (!x || typeof x !== 'object') { if (!make) return null; x = v[L] = { s: {}, n: [] }; }
    x.n = arr(x.n);
    if (!x.s || typeof x.s !== 'object' || Array.isArray(x.s)) x.s = {};
    if (Array.isArray(x.l)) { if (x.l.length) x.s.s1 = arr(x.s.s1).concat(x.l); delete x.l; }   // legacy: one line
    return x;
  }
  const hasLineVib = (x) => x && x.s && Object.keys(x.s).some((k) => arr(x.s[k]).length);
  const strokeOf = (l, k) => (l && Array.isArray(l.lines) ? l.lines.find((st) => st.id === k) || null : null);
  function tidy(S) {
    const ed = S.ext && S.ext.edit;
    if (!ed || !ed.vib) return;
    for (const k of Object.keys(ed.vib)) {
      const x = ed.vib[k];
      if (x && x.s) Object.keys(x.s).forEach((q) => { if (!arr(x.s[q]).length) delete x.s[q]; });
      if (!x || +k >= S.layers.length || (!hasLineVib(x) && !arr(x.n).length && !arr(x.l).length)) delete ed.vib[k];
    }
    if (!Object.keys(ed.vib).length) delete ed.vib;
    if (!Object.keys(ed).length) delete S.ext.edit;
  }
  const VIB = {
    // [cents, hz] at line sample i of stroke k (default 's1') of layer L, or null.
    lineAt(S, L, i, k) {
      const x = vstore(S, L, false);
      if (!x) return null;
      for (const r of arr(x.s[k || 's1'])) if (i >= r[0] && i < r[1]) return [r[2], r[3]];
      return null;
    },
    // [cents, hz] of note n ({ s, m }) in layer L, or null.
    noteOf(S, L, n) {
      const x = vstore(S, L, false);
      if (!x) return null;
      for (const r of x.n) if (r[0] === n.s && Math.abs(r[1] - n.m) < 0.006) return [r[2], r[3]];
      return null;
    },
    // Frequency factor at t seconds into the vibrato.
    factor: (cents, hz, t) => 2 ** (cents * Math.sin(2 * Math.PI * hz * t) / 1200),
    // Per-sample array (null | [cents, hz]) for stroke k (default 's1') of layer L.
    lineArray(S, L, k) {
      const out = new Array(md.tot16(S) * 3).fill(null), x = vstore(S, L, false);
      if (x) for (const r of arr(x.s[k || 's1'])) for (let i = Math.max(0, r[0]); i < Math.min(out.length, r[1]); i++) out[i] = [r[2], r[3]];
      return out;
    },
    trace: null,   // tests: set to [] to log [ctxTime, hz, layer] for every modulated frequency update
  };
  // Store a per-sample array back as ranges of stroke k (only where the stroke has a value, so gaps split ranges).
  function setLineArray(S, L, k, a) {
    const st = strokeOf(S.layers[L], k), line = st ? st.v : [], ranges = [];
    let cur = null;
    for (let i = 0; i < line.length; i++) {
      const v = a[i];
      if (!v || !(v[0] > 0) || isNaN(line[i])) { cur = null; continue; }
      if (cur && cur[2] === v[0] && cur[3] === v[1] && cur[1] === i) { cur[1] = i + 1; continue; }
      cur = [i, i + 1, v[0], v[1]]; ranges.push(cur);
    }
    const x = vstore(S, L, ranges.length > 0);
    if (x) { if (ranges.length) x.s[k] = ranges; else delete x.s[k]; }
    tidy(S);
  }
  function setNoteVib(S, L, n, v) {
    const x = vstore(S, L, !!v);
    if (!x) return;
    x.n = x.n.filter((r) => !(r[0] === n.s && Math.abs(r[1] - n.m) < 0.006));
    if (v && v[0] > 0) x.n.push([n.s, Math.round(n.m * 100) / 100, v[0], v[1]]);
    tidy(S);
  }
  // Drop note vibrato entries whose note is gone, and line ranges over empty samples.
  function prune(S) {
    const ed = S.ext && S.ext.edit;
    if (!ed || !ed.vib) return;
    for (const k of Object.keys(ed.vib)) {
      const L = +k, lay = S.layers[L], x = ed.vib[k];
      if (!lay || !x) continue;
      x.n = arr(x.n).filter((r) => lay.notes.some((n) => n.s === r[0] && Math.abs(n.m - r[1]) < 0.006));
      vstore(S, L, false);
      Object.keys(x.s || {}).forEach((k) => {
        if (!strokeOf(lay, k)) delete x.s[k];   // the stroke is gone
        else setLineArray(S, L, k, VIB.lineArray(S, L, k));
      });
    }
    tidy(S);
  }
  NS.vibrato = VIB;

  const CSS = `
.vhte-bar { width: min(560px, calc(100% - 16px)); padding: 6px 10px; overflow: visible; z-index: 7; animation: none;
  display: grid; grid-template-columns: auto minmax(90px, 1fr) minmax(90px, 1fr) auto; gap: 4px 12px; align-items: center; }
.vhte-bar .vh-ctl { margin: 0; min-width: 0; }
.vhte-bar .vh-ctl label { font-size: 11px; }
.vhte-bar .vh-ctl input[type="range"] { margin-top: 2px; }
.vhte-ttl { font-size: 11px; color: var(--muted, #7a8194); line-height: 1.3; white-space: nowrap; }
.vhte-ttl b { display: block; color: var(--text, #d8dce6); font-weight: 600; font-size: 12px; }
@media (max-width: 520px) {
  .vhte-bar { grid-template-columns: 1fr 1fr; }
  .vhte-bar .vhte-btns { grid-column: 2; grid-row: 1; justify-self: end; }
}
.vhte-btns { display: flex; gap: 4px; }
.vhte-btns button { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line, #262b3a); background: var(--surface-2, #1a1f2e);
  color: var(--text, #d8dce6); cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
.vhte-btns button:hover { border-color: var(--muted, #7a8194); }
`;
  function injectCss() {
    if (document.getElementById('vh-melody-tools-edit')) return;
    const st = document.createElement('style');
    st.id = 'vh-melody-tools-edit'; st.textContent = CSS;
    document.head.append(st);
  }

  NS.parts.push((M) => {
    injectCss();
    const ui = VH.ui, V = M.view, cv = V.cv;
    let alive = true;
    const touchy = (p) => p && p.e && p.e.pointerType === 'touch';
    const lay = () => M.song.layers[M.active];
    const tot16 = () => md.tot16(M.song);
    const grid = () => (M.song.grid === 16 ? 1 : 2);
    const nh = () => V.noteH();
    const lu = () => V.U() / SPS;
    const LEN = () => tot16() * SPS;
    const idxOf = (x) => clamp(Math.floor(x / lu()), 0, LEN() - 1);
    const commitE = (label) => { M.song.layers.forEach(md.pruneStrokes); prune(M.song); return M.commit(label); };
    const newStroke = (l) => (l.lines.length < md.MAX_STROKES ? md.addStroke(l, LEN()) : null);

    // ---------- selection ----------
    // sel.line: Map(stroke id -> Set(sample index)) of the active layer's line strokes
    const sel = { notes: new Set(), line: new Map() };
    let lastS = M.song;
    const selLineCount = () => { let n = 0; sel.line.forEach((s) => { n += s.size; }); return n; };
    const selAdd = (k, i) => { let s = sel.line.get(k); if (!s) sel.line.set(k, (s = new Set())); s.add(i); };
    const selDel = (k, i) => { const s = sel.line.get(k); if (s) { s.delete(i); if (!s.size) sel.line.delete(k); } };
    const selHas = (k, i) => { const s = sel.line.get(k); return !!(s && s.has(i)); };
    function eachSel(fn) {   // fn(stroke, i) for every selected line sample (strokes that still exist)
      const l = lay();
      sel.line.forEach((set, k) => { const st = strokeOf(l, k); if (st) set.forEach((i) => fn(st, i)); });
    }
    const hasSel = () => sel.notes.size > 0 || selLineCount() > 0;
    function clearSel() {
      sel.notes.forEach((n) => { delete n.sel; });
      sel.notes.clear(); sel.line.clear();
      M.requestRender(); syncBar();
    }
    function selNote(n, on) { if (on) { sel.notes.add(n); n.sel = true; } else { sel.notes.delete(n); delete n.sel; } }
    function runOf(st, i) {   // contiguous run of stroke st's samples containing i
      const s = st.v;
      let a = i, b = i;
      while (a > 0 && !isNaN(s[a - 1])) a--;
      while (b < s.length - 1 && !isNaN(s[b + 1])) b++;
      return [a, b];
    }
    function validateSel() {
      if (M.song !== lastS) { lastS = M.song; sel.notes.clear(); sel.line.clear(); syncBar(); return; }
      const l = lay(), ns = new Set(l.notes);
      sel.notes.forEach((n) => { if (!ns.has(n)) sel.notes.delete(n); });
      [...sel.line.keys()].forEach((k) => {
        const st = strokeOf(l, k);
        if (!st) { sel.line.delete(k); return; }
        [...sel.line.get(k)].forEach((i) => { if (i >= st.v.length || isNaN(st.v[i])) selDel(k, i); });
      });
      syncBar();
    }
    function selectAll() {
      clearSel();
      const l = lay();
      l.notes.forEach((n) => selNote(n, true));
      l.lines.forEach((st) => st.v.forEach((v, i) => { if (!isNaN(v)) selAdd(st.id, i); }));
      if (hasSel() && M.tools.current.id !== 'select') pick('select');
      M.requestRender(); syncBar();
    }
    function selBox() {   // content-coords bbox of the selection
      const u = V.U(), h = nh();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      sel.notes.forEach((n) => { x0 = Math.min(x0, n.s * u); x1 = Math.max(x1, (n.s + n.d) * u); const y = V.yOf(n.m); y0 = Math.min(y0, y - h / 2); y1 = Math.max(y1, y + h / 2); });
      eachSel((st, i) => { const x = (i + 0.5) * lu(), y = V.yOf(st.v[i]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
      return x0 <= x1 ? { x0, x1, y0, y1 } : null;
    }

    // ---------- hit testing ----------
    function hit(p) {
      const k = M.tools.noteAt(p.x, p.y);
      if (k >= 0) { const n = lay().notes[k]; return { kind: 'note', n, m: n.m, t: n.s }; }
      const w = lu(), tol = touchy(p) ? 14 : 9;
      let best = -1, bs = null, bd = tol;
      for (const st of lay().lines) {
        const s = st.v;
        for (let i = Math.max(0, Math.floor((p.x - tol) / w)); i <= Math.min(s.length - 1, Math.ceil((p.x + tol) / w)); i++) {
          if (isNaN(s[i])) continue;
          const d = Math.hypot((i + 0.5) * w - p.x, V.yOf(s[i]) - p.y);
          if (d <= bd) { bd = d; best = i; bs = st; }
        }
      }
      return best >= 0 ? { kind: 'line', st: bs, k: bs.id, i: best, m: bs.v[best], t: best / SPS } : null;
    }
    const isSelHit = (h) => (h.kind === 'note' ? sel.notes.has(h.n) : selHas(h.k, h.i));
    function setHit(h, on) {
      if (h.kind === 'note') { selNote(h.n, on); return; }
      const [a, b] = runOf(h.st, h.i);
      for (let i = a; i <= b; i++) { if (on) selAdd(h.k, i); else selDel(h.k, i); }
    }

    // ---------- move ----------
    let drag = null;
    function startMove(p, h) {
      const S = M.song, L = M.active, l = lay();
      drag = {
        kind: 'move', t0: p.t16, y0: p.y, x0: p.x, anchorM: h.m, anchorT: h.t, moved: false,
        notes: [...sel.notes].map((n) => ({ n, s: n.s, m: n.m, v: VIB.noteOf(S, L, n) })),
        // per selected stroke: its samples and vibrato before the move, the selected indices and values
        strokes: [...sel.line.keys()].map((k) => strokeOf(l, k)).filter(Boolean).map((st) => {
          const idx = [...sel.line.get(st.id)].sort((a, b) => a - b), orig = st.v.slice();
          return { st, k: st.id, orig, vib: VIB.lineArray(S, L, st.id), idx, vals: idx.map((i) => orig[i]) };
        }),
        vstore: JSON.stringify(vstore(S, L, false) || null),
      };
      let lo = Infinity, hi = -Infinity, mlo = Infinity, mhi = -Infinity;
      drag.notes.forEach((o) => { lo = Math.min(lo, o.s); hi = Math.max(hi, o.s + o.n.d); mlo = Math.min(mlo, o.m); mhi = Math.max(mhi, o.m); });
      drag.strokes.forEach((g) => g.idx.forEach((i, k) => { lo = Math.min(lo, i / SPS); hi = Math.max(hi, (i + 1) / SPS); mlo = Math.min(mlo, g.vals[k]); mhi = Math.max(mhi, g.vals[k]); }));
      Object.assign(drag, { lo, hi, mlo, mhi });
    }
    function moveTo(p) {
      const S = M.song, L = M.active, l = lay(), d = drag;
      if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 3) return;
      d.moved = true;
      const q = l.mode === 'notes' ? grid() : 1;
      let dt = Math.round((p.t16 - d.t0) / q) * q;
      dt = clamp(dt, -Math.floor(d.lo / q) * q, Math.floor((tot16() - d.hi) / q) * q);
      const raw = V.midiOf(p.y) - V.midiOf(d.y0);
      let dm;
      if (S.snap) {
        const b = md.regionAt(S, clamp(d.anchorT + dt, 0, tot16() - 1e-6));
        dm = M.bands.snap(clamp(d.anchorM + raw, LO, HI), b) - d.anchorM;
      } else dm = Math.round(raw);
      dm = clamp(dm, LO - d.mlo, HI - d.mhi);
      const dS = dt * SPS;
      // notes
      const snapN = (JSON.parse(d.vstore) || {}).n || [];
      const x = vstore(S, L, snapN.length > 0);
      if (x) x.n = snapN;
      d.notes.forEach((o) => { o.n.s = o.s + dt; o.n.m = Math.round((o.m + dm) * 1000) / 1000; });
      d.notes.forEach((o) => { if (o.v) setNoteVib(S, L, { s: o.s, m: o.m }, null); });
      d.notes.forEach((o) => { if (o.v) setNoteVib(S, L, o.n, o.v); });
      // line samples, per stroke (vacated samples clear, the destination in the same stroke is overwritten)
      sel.line.clear();
      d.strokes.forEach((g) => {
        const v = g.st.v;
        v.set(g.orig);
        const va = g.vib.slice(), nv = g.idx.map((i) => g.vib[i]);
        g.idx.forEach((i) => { v[i] = NaN; va[i] = null; });
        g.idx.forEach((i, k) => {
          const j = i + dS;
          if (j < 0 || j >= v.length) return;
          v[j] = clamp(g.vals[k] + dm, LO, HI); va[j] = nv[k]; selAdd(g.k, j);
        });
        setLineArray(S, L, g.k, va);
      });
      d.dt = dt; d.dm = dm;
      M.requestRender();
    }

    // ---------- delete / copy / paste ----------
    function delSel() {
      if (!hasSel()) return;
      const S = M.song, L = M.active, l = lay();
      l.notes = l.notes.filter((n) => !sel.notes.has(n));
      eachSel((st, i) => { st.v[i] = NaN; });
      clearSel();
      commitE('Delete selection');
    }
    function copySel() {
      if (!hasSel()) return false;
      const S = M.song, L = M.active, l = lay();
      let t0 = Infinity;
      sel.notes.forEach((n) => { t0 = Math.min(t0, n.s); });
      eachSel((st, i) => { t0 = Math.min(t0, i / SPS); });
      t0 = Math.floor(t0);
      let end = 0;
      const line = [];   // { sk: source stroke, k: sample offset, m, v }
      eachSel((st, i) => { end = Math.max(end, (i + 1) / SPS - t0); line.push({ sk: st.id, k: i - t0 * SPS, m: st.v[i], v: VIB.lineAt(S, L, i, st.id) }); });
      line.sort((a, b) => a.k - b.k);
      clip = {
        notes: [...sel.notes].map((n) => { end = Math.max(end, n.s + n.d - t0); return { s: n.s - t0, d: n.d, m: n.m, v: VIB.noteOf(S, L, n) }; }),
        line,
      };
      clip.len = Math.ceil(end);
      return true;
    }
    function pasteAt(t, label) {
      if (!clip) return;
      const S = M.song, L = M.active, l = lay(), tot = tot16();
      t = clamp(Math.round(t), 0, tot - 1);
      clearSel();
      clip.notes.forEach((c) => {
        const s = t + c.s;
        if (s >= tot) return;
        const n = { s, d: Math.min(c.d, tot - s), m: c.m };
        l.notes.push(n); selNote(n, true);
        setNoteVib(S, L, n, c.v);
      });
      // each copied stroke is pasted as a new stroke, layered over what is there (the last stroke when the layer is full)
      const dest = new Map();
      clip.line.forEach((c) => {
        const j = t * SPS + c.k;
        if (j < 0 || j >= LEN()) return;
        let g = dest.get(c.sk);
        if (!g) { const st = newStroke(l) || l.lines[l.lines.length - 1]; g = { st, va: VIB.lineArray(S, L, st.id) }; dest.set(c.sk, g); }
        g.st.v[j] = c.m; g.va[j] = c.v; selAdd(g.st.id, j);
      });
      dest.forEach((g) => setLineArray(S, L, g.st.id, g.va));
      if (M.tools.current.id !== 'select') pick('select');
      commitE(label || 'Paste');
      syncBar();
    }
    let hover = null;   // last pointer position over the canvas (content coords), for paste
    const onHover = (e) => { const [x, y] = V.xy(e); hover = { x, y, mouse: e.pointerType === 'mouse' }; };
    const onLeave = () => { hover = null; };
    cv.addEventListener('pointermove', onHover);
    cv.addEventListener('pointerleave', onLeave);
    M.cleanups.push(() => { cv.removeEventListener('pointermove', onHover); cv.removeEventListener('pointerleave', onLeave); });
    function pasteHere() {
      if (!clip) return;
      const q = lay().mode === 'notes' ? grid() : 1;
      const t = hover && hover.mouse ? V.t16Of(hover.x) : M.engine.pos16;
      pasteAt(Math.floor(t / q) * q);
    }
    function duplicate() {
      if (!copySel()) return;
      let end = 0;
      sel.notes.forEach((n) => { end = Math.max(end, n.s + n.d); });
      eachSel((st, i) => { end = Math.max(end, Math.ceil((i + 1) / SPS)); });
      pasteAt(end, 'Duplicate');
    }

    // ---------- tools ----------
    const D = M.tools.list.find((t) => t.id === 'draw');
    const delegate = (id, label, icon, title) => ({
      id, label, icon, title,
      down: (p) => D.down(p, M), move: (p) => D.move(p, M), up: (p) => D.up(p, M),
      hover: (p) => (D.hover ? D.hover(p, M) : undefined),
      draw: (ctx, v) => (D.draw ? D.draw(ctx, v) : undefined),
      deactivate: () => (D.deactivate ? D.deactivate() : undefined),
      cursor: (p) => (D.cursor ? D.cursor(p, M) : 'crosshair'),
    });

    // Straight line: press, drag, release = a linear glide between the two points. Like the Pen, it fixes the stroke it
    // starts near (within ~1 semitone) or adds a new overlapping stroke (always with Alt).
    let lt = null, ltHover = null;
    function endM(p, i) {
      let m = p.midi;
      if (p.e && p.e.shiftKey) m = Math.round(m);
      else if (M.song.snap) m = M.bands.snap(m, md.regionAt(M.song, i / SPS));
      return clamp(m, LO, HI);
    }
    function applyLine() {
      const s = lt.st.v, { i0, i1, m0, m1 } = lt;
      s.set(lt.orig);
      const a = Math.min(i0, i1), b = Math.max(i0, i1);
      for (let k = a; k <= b; k++) s[k] = i1 === i0 ? m1 : m0 + (m1 - m0) * (k - i0) / (i1 - i0);
      M.requestRender();
    }
    const lineTool = {
      id: 'line', label: 'Line', icon: '╱', title: 'Straight line (L): press, drag, release. Shift = whole semitones',
      cursor: 'crosshair',
      down(p) {
        const b = M.tools.beginStroke(p);
        if (!b) return false;
        const i = idxOf(p.x), m = endM(p, i);
        lt = { st: b.st, fix: b.fix, orig: b.st.v.slice(), i0: i, i1: i, m0: m, m1: m };
        applyLine(); return true;
      },
      move(p) { if (!lt) return; lt.i1 = idxOf(p.x); lt.m1 = endM(p, lt.i1); applyLine(); },
      up(p) { if (!lt) return; lt = null; if (touchy(p)) ltHover = null; commitE('Straight line'); },
      hover(p) { ltHover = p.inHeader ? null : p; M.requestRender(); },
      deactivate() { ltHover = null; },
      draw(ctx) {
        if (!lt) {
          if (ltHover && !V.pinching() && lay().mode === 'line') {
            const alt = !!(ltHover.e && ltHover.e.altKey);
            M.tools.drawBadge(ctx, ltHover.x, ltHover.y, !!M.tools.strokeTarget(ltHover.x, ltHover.y, alt).st);
          }
          return;
        }
        M.tools.drawBadge(ctx, (lt.i1 + 0.5) * lu(), V.yOf(lt.m1), lt.fix);
        const w = lu();
        ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo((lt.i0 + 0.5) * w, V.yOf(lt.m0)); ctx.lineTo((lt.i1 + 0.5) * w, V.yOf(lt.m1)); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#fff';
        [[lt.i0, lt.m0], [lt.i1, lt.m1]].forEach(([i, m]) => { ctx.beginPath(); ctx.arc((i + 0.5) * w, V.yOf(m), 4, 0, 2 * Math.PI); ctx.fill(); });
        ctx.restore();
      },
    };

    // Eraser: removes the parts of lines (splitting them) and the notes it touches.
    let er = null, erHover = null;
    function eraseSeg(x0, y0, x1, y1, r) {
      const l = lay(), w = lu(), dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
      const dist = (px, py) => {
        const t = L2 ? clamp(((px - x0) * dx + (py - y0) * dy) / L2, 0, 1) : 0;
        return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      };
      let changed = false;
      for (const st of l.lines) {
        const s = st.v;
        for (let i = Math.max(0, Math.floor((Math.min(x0, x1) - r) / w)); i <= Math.min(s.length - 1, Math.ceil((Math.max(x0, x1) + r) / w)); i++) {
          if (!isNaN(s[i]) && dist((i + 0.5) * w, V.yOf(s[i])) <= r) { s[i] = NaN; changed = true; }
        }
      }
      const u = V.U(), h = nh(), steps = Math.max(1, Math.ceil(Math.sqrt(L2) / 2));
      const keep = l.notes.filter((n) => {
        const ax = n.s * u, bx = (n.s + n.d) * u, cy = V.yOf(n.m);
        for (let k = 0; k <= steps; k++) {
          const px = x0 + dx * k / steps, py = y0 + dy * k / steps;
          const ddx = Math.max(ax - px, 0, px - bx), ddy = Math.max(Math.abs(py - cy) - h / 2, 0);
          if (Math.hypot(ddx, ddy) <= r) return false;
        }
        return true;
      });
      if (keep.length !== l.notes.length) { l.notes = keep; changed = true; }
      if (changed) { er.changed = true; M.requestRender(); }
    }
    // After erasing: a run of a stroke that the eraser cut in two (or more) is split into strokes of its own (the first
    // piece stays, each later piece becomes a new stroke with its vibrato), so every stroke stays one connected phrase
    // where it used to be one.
    function splitCut(orig) {
      const S = M.song, L = M.active, l = lay();
      let made = 0;
      for (const st of l.lines.slice()) {
        const o = orig.get(st.id), v = st.v;
        if (!o) continue;
        for (let a = 0; a < o.length; a++) {
          if (isNaN(o[a])) continue;
          let b = a; while (b + 1 < o.length && !isNaN(o[b + 1])) b++;
          const pieces = [];   // surviving pieces of the original run [a, b]
          for (let i = a; i <= b; i++) {
            if (isNaN(v[i])) continue;
            let j = i; while (j + 1 <= b && !isNaN(v[j + 1])) j++;
            pieces.push([i, j]); i = j;
          }
          for (const [i, j] of pieces.slice(1)) {
            const ns = newStroke(l);
            if (!ns) break;
            const va = VIB.lineArray(S, L, st.id), nva = new Array(v.length).fill(null);
            for (let q = i; q <= j; q++) { ns.v[q] = v[q]; nva[q] = va[q]; v[q] = NaN; va[q] = null; }
            setLineArray(S, L, ns.id, nva); setLineArray(S, L, st.id, va);
            made++;
          }
          a = b;
        }
      }
      return made;
    }
    const eraseTool = {
      id: 'erase', label: 'Eraser', icon: '⌫', title: 'Eraser (E): drag over lines or notes to remove just those parts',
      cursor: 'cell',
      down(p) {
        er = { x: p.x, y: p.y, r: touchy(p) ? 16 : 10, changed: false, orig: new Map(lay().lines.map((st) => [st.id, st.v.slice()])) };
        erHover = p; eraseSeg(p.x, p.y, p.x, p.y, er.r); return true;
      },
      move(p) { if (!er) return; eraseSeg(er.x, er.y, p.x, p.y, er.r); er.x = p.x; er.y = p.y; erHover = p; M.requestRender(); },
      up() { const e = er; er = null; if (e && e.changed) { splitCut(e.orig); commitE('Erase'); } },
      hover(p) { erHover = p; M.requestRender(); },
      deactivate() { erHover = null; },
      draw(ctx) {
        const p = er || erHover;
        if (!p || p.inHeader) return;
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.fillStyle = 'rgba(255,107,107,0.15)';
        ctx.beginPath(); ctx.arc(p.x, p.y, er ? er.r : touchy(p) ? 16 : 10, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); ctx.restore();
      },
    };

    const selectTool = {
      id: 'select', label: 'Select', icon: '⬚', title: 'Select (V): click or box-select, Shift adds; drag to move; Delete removes',
      cursor(p) { return hit(p) ? 'move' : 'default'; },
      down(p) {
        const h = hit(p), add = p.e && p.e.shiftKey;
        if (h) {
          if (add && isSelHit(h)) { setHit(h, false); M.requestRender(); syncBar(); return false; }
          if (!isSelHit(h)) { if (!add) clearSel(); setHit(h, true); }
          startMove(p, h); M.requestRender(); syncBar();
          return true;
        }
        if (!add) clearSel();
        drag = { kind: 'rect', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return true;
      },
      move(p) {
        if (!drag) return;
        if (drag.kind === 'rect') { drag.x1 = p.x; drag.y1 = p.y; M.requestRender(); return; }
        moveTo(p); syncBar();
      },
      up() {
        const d = drag; drag = null;
        if (!d) return;
        if (d.kind === 'rect') {
          const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
          if (x1 - x0 > 3 || y1 - y0 > 3) {
            const l = lay(), u = V.U(), h = nh(), w = lu();
            l.notes.forEach((n) => { const y = V.yOf(n.m); if (n.s * u <= x1 && (n.s + n.d) * u >= x0 && y + h / 2 >= y0 && y - h / 2 <= y1) selNote(n, true); });
            l.lines.forEach((st) => st.v.forEach((v, i) => { if (isNaN(v)) return; const x = (i + 0.5) * w, y = V.yOf(v); if (x >= x0 && x <= x1 && y >= y0 && y <= y1) selAdd(st.id, i); }));
          }
          M.requestRender(); syncBar(); return;
        }
        if (d.moved && (d.dt || d.dm)) commitE('Move');
        M.requestRender(); syncBar();
      },
      deactivate() { drag = null; clearSel(); },
      draw(ctx) {
        if (!drag || drag.kind !== 'rect') return;
        const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
        ctx.save(); ctx.fillStyle = 'rgba(111,163,255,0.12)'; ctx.strokeStyle = 'rgba(111,163,255,0.9)'; ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]); ctx.fillRect(x, y, w, h); ctx.strokeRect(x + 0.5, y + 0.5, w, h); ctx.restore();
      },
    };

    // ---------- palette ----------
    const PAL = [
      ['pen', '✎', 'Pen', 'P', 'Pen (P): freehand line. Start on a line to fix it; start away from it (or hold Alt) to layer a new line'],
      ['line', '╱', 'Line', 'L', lineTool.title],
      ['notes', '♩', 'Notes', 'N', 'Notes (N): click to place, drag right to lengthen, click a note to delete'],
      ['select', '⬚', 'Select', 'V', selectTool.title],
      ['erase', '⌫', 'Erase', 'E', eraseTool.title],
    ];
    M.ui.addTool(delegate('pen', 'Pen', '✎', PAL[0][4]));
    M.ui.addTool(lineTool);
    M.ui.addTool(delegate('notes', 'Notes', '♩', PAL[2][4]));
    M.ui.addTool(selectTool);
    M.ui.addTool(eraseTool);

    // The dock's single Tool button lists this palette (with keys) in its pop-over; picking keeps the layer mode in step.
    M.ui.configureTools({ items: PAL, pick: (id) => pick(id) });

    function pick(id) {
      if (!M.tools.list.some((t) => t.id === id)) return;
      M.ui.setTool(id);
      const l = lay();
      if ((id === 'pen' || id === 'line') && l.mode === 'notes') M.setLayerMode(M.active);
      else if (id === 'notes' && l.mode === 'line') M.setLayerMode(M.active);
      syncSeg();
    }
    function syncToolToMode() {
      const cur = M.tools.current, mode = lay().mode;
      if (!cur) return;
      if (cur.id === 'draw') M.ui.setTool(mode === 'notes' ? 'notes' : 'pen');
      else if ((cur.id === 'pen' || cur.id === 'line') && mode === 'notes') M.ui.setTool('notes');
      else if (cur.id === 'notes' && mode === 'line') M.ui.setTool('pen');
      syncSeg();
    }
    function syncSeg() {
      M.ui.syncTools();
      syncBar();
    }

    // ---------- vibrato mini toolbar ----------
    const bar = ui.h('div', 'mel-float vhte-bar');
    bar.hidden = true; bar.setAttribute('role', 'dialog'); bar.setAttribute('aria-label', 'Selection');
    const ttl = ui.h('div', 'vhte-ttl', '<b>∿ Vibrato</b><span class="vhte-n"></span>');
    const btns = ui.h('div', 'vhte-btns');
    const mk = (txt, title, fn) => { const b = ui.h('button', '', txt); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', fn); btns.append(b); return b; };
    mk('⧉', 'Duplicate selection', () => duplicate());
    mk('🗑', 'Delete selection (Delete)', () => delSel());
    bar.append(ttl);
    let vibDepth = 0, vibRate = DEF_RATE, editing = false;
    const depthSl = ui.slider(bar, { label: 'Depth', min: 0, max: 100, step: 1, value: 0, fmt: (v) => v + '¢', onInput: (v) => { vibDepth = v; applyVib(); } });
    const rateSl = ui.slider(bar, { label: 'Rate', min: 2, max: 9, step: 0.1, value: DEF_RATE, fmt: (v) => v.toFixed(1) + ' Hz', onInput: (v) => { vibRate = v; applyVib(); } });
    bar.append(btns);
    [depthSl, rateSl].forEach((s) => {
      s.input.addEventListener('pointerdown', () => { editing = true; });
      s.input.addEventListener('change', () => { editing = false; commitE('Vibrato'); syncBar(); });
    });
    M.el.append(bar);
    function applyVib() {
      if (!hasSel()) return;
      const S = M.song, L = M.active, v = vibDepth > 0 ? [Math.round(vibDepth), Math.round(vibRate * 10) / 10] : null;
      sel.notes.forEach((n) => setNoteVib(S, L, n, v));
      sel.line.forEach((set, k) => {
        if (!strokeOf(lay(), k)) return;
        const a = VIB.lineArray(S, L, k);
        set.forEach((i) => { a[i] = v; });
        setLineArray(S, L, k, a);
      });
      M.requestRender();
    }
    let barPos = '';
    function syncBar() {
      const show = alive && hasSel() && M.tools.current && M.tools.current.id === 'select' && !(drag && (drag.kind === 'rect' || drag.moved));
      if (bar.hidden !== !show) bar.hidden = !show;
      if (!show) { barPos = ''; return; }
      const S = M.song, L = M.active;
      bar.querySelector('.vhte-n').textContent = (sel.notes.size ? sel.notes.size + ' note' + (sel.notes.size > 1 ? 's' : '') : '') +
        (sel.notes.size && selLineCount() ? ' + ' : '') + (selLineCount() ? (sel.line.size > 1 ? sel.line.size + ' lines' : 'line') : '');
      if (!editing) {
        let v = null;
        for (const n of sel.notes) { v = VIB.noteOf(S, L, n); if (v) break; }
        if (!v) eachSel((st, i) => { if (!v) v = VIB.lineAt(S, L, i, st.id); });
        vibDepth = v ? v[0] : 0; vibRate = v ? v[1] : vibRate;
        depthSl.set(vibDepth); rateSl.set(vibRate);
      }
      placeBar();
    }
    // The bar sits over the chord header strip (top of the canvas), centred on the selection; when the selection
    // reaches up there it moves to the bottom edge instead, so it never covers what is selected.
    function placeBar() {
      const b = selBox();
      if (!b) return;
      const er0 = M.el.getBoundingClientRect(), cr = cv.getBoundingClientRect(), k = cr.width / V.VW, ky = cr.height / V.TH;
      const bw = bar.offsetWidth || 300, bh = bar.offsetHeight || 60;
      const cx = cr.left - er0.left + V.sx((b.x0 + b.x1) / 2) * k, ct = cr.top - er0.top;
      const top = b.y0 * ky < bh + 10 ? ct + cr.height - bh - 4 : ct + 4;
      const lo = Math.max(8, cr.left - er0.left), hi = Math.min(er0.width - 8, cr.right - er0.left) - bw;
      const left = clamp(cx - bw / 2, lo, Math.max(lo, hi));
      const pos = Math.round(left) + ',' + Math.round(top);
      if (pos === barPos) return;
      barPos = pos; bar.style.left = Math.round(left) + 'px'; bar.style.top = Math.round(top) + 'px';
    }

    // ---------- overlay: selection highlight + vibrato waves ----------
    M.on('draw', (ctx) => {
      const S = M.song, u = V.U(), w = lu(), sec16 = md.secPer16(S), xa = V.scrollX, xb = V.scrollX + V.GW, px1 = V.PPS();
      ctx.save();
      ctx.lineJoin = ctx.lineCap = 'round';
      // selected line samples: white halo
      if (sel.line.size) {
        ctx.beginPath();
        sel.line.forEach((set, k) => {
          const st = strokeOf(lay(), k);
          if (!st) return;
          let prev = -2;
          [...set].sort((a, b) => a - b).forEach((i) => {
            const x = (i + 0.5) * w, y = V.yOf(st.v[i]);
            if (i === prev + 1) ctx.lineTo(x, y); else { ctx.moveTo(x - 1, y); ctx.lineTo(x, y); }
            prev = i;
          });
        });
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 10; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      // vibrato: wavy lines (period in px from the real rate and tempo)
      S.layers.forEach((l, L) => {
        const x = vstore(S, L, false);
        if (!x) return;
        ctx.globalAlpha = L === M.active ? 1 : 0.55;
        for (const [k, rs] of Object.entries(x.s || {})) for (const r of arr(rs)) {
          const st = strokeOf(l, k);
          if (!st) continue;
          const line = st.v, a = Math.max(0, r[0]), b = Math.min(line.length, r[1]), amp = r[2] / 100 * px1;
          const xs = Math.max(xa, (a + 0.5) * w), xe = Math.min(xb, (b - 0.5) * w);
          if (xe < xs) continue;
          ctx.beginPath();
          let pen = false;
          for (let X = xs; X <= xe + 0.01; X += 1) {
            const f = X / w - 0.5, i = Math.floor(f), t = f - i;
            const v0 = line[clamp(i, a, b - 1)], v1 = line[clamp(i + 1, a, b - 1)];
            if (isNaN(v0) || isNaN(v1)) { pen = false; continue; }
            const m = v0 + (v1 - v0) * t, y = V.yOf(m) - amp * Math.sin(2 * Math.PI * r[3] * (X / u) * sec16);
            if (pen) ctx.lineTo(X, y); else { ctx.moveTo(X, y); pen = true; }
          }
          ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3.5; ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 1.5; ctx.stroke();
        }
        const h = nh();
        for (const r of x.n) {
          const n = l.notes.find((q) => q.s === r[0] && Math.abs(q.m - r[1]) < 0.006);
          if (!n) continue;
          const x0 = n.s * u + 3, x1 = (n.s + n.d) * u - 3, cy = V.yOf(n.m), amp = Math.min(h / 2 - 1.5, Math.max(1.2, r[2] / 100 * px1));
          if (x1 < xa || x0 > xb || x1 <= x0) continue;
          ctx.beginPath();
          for (let X = x0; X <= x1; X += 1) {
            const y = cy - amp * Math.sin(2 * Math.PI * r[3] * ((X - n.s * u) / u) * sec16);
            if (X === x0) ctx.moveTo(X, y); else ctx.lineTo(X, y);
          }
          ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
        }
      });
      ctx.restore();
      if (!bar.hidden) placeBar();
    });

    // ---------- engine hook: vibrato on the layer voices ----------
    // The engine asks every play tick for a cents offset of each of its voices. Line: the vibrato range under the
    // playhead, phase on song time. Note: the note's vibrato, phase from the note start.
    M.addHook('pitchMod', (L, kind, t, ref) => {
      if (!alive || L < 0 || !ref) return 0;
      const S = M.song, l = S.layers[L];
      if (!l) return 0;
      let vr = null, el = 0;
      if (kind === 'note') {
        vr = VIB.noteOf(S, L, ref);
        const tot = tot16();
        el = ((((t.pos16 - ref.s) % tot) + tot) % tot) * t.secPer16;
      } else if (kind === 'line') {
        const k = ref.k || 's1', st = strokeOf(l, k);
        if (st && !isNaN(st.v[ref.i])) vr = VIB.lineAt(S, L, ref.i, k);
        el = t.pos16 * t.secPer16;
      }
      if (!vr || !(vr[0] > 0)) return 0;
      const c = vr[0] * Math.sin(2 * Math.PI * vr[1] * el);
      if (VIB.trace) VIB.trace.push([t.ctxTime, VH.audio.midiToHz(ref.m + c / 100), L]);
      return c;
    });

    // ---------- auto-fit on chord change (one undo step with the chord) ----------
    const AF_KEY = 'melody.autofit';
    let autofit = VH.store.get(AF_KEY, true) !== false;
    // Pure intonation (Settings > Edit > Advanced): the old exact-band fit. Nearest bright band (local consonance
    // maximum) within ±1.5 semitones of m, or null.
    function bandNear(info, m) {
      const V = info.Vh, R = info.rows, rf = info.rowOfMidi(m), w = 1.5 * (R - 1) / md.SPAN;
      let best = -1, bs = Infinity;
      for (let r = Math.max(1, Math.ceil(rf - w)); r <= Math.min(R - 2, Math.floor(rf + w)); r++) {
        if (V[r] > V[r - 1] || V[r] > V[r + 1] || V[r] > 0.8) continue;
        const sc = Math.abs(r - rf) / (R - 1) * md.SPAN + 1.2 * V[r];
        if (sc < bs) { bs = sc; best = r; }
      }
      if (best < 0) return null;
      const t = info.snap(info.midiOfRow(best));   // refine to the cent
      return Math.abs(t - info.midiOfRow(best)) < 0.2 ? t : info.midiOfRow(best);
    }
    function moveNote(S, L, n, m) {   // keeps the note's vibrato attached
      const v = VIB.noteOf(S, L, n);
      if (v) setNoteVib(S, L, n, null);
      n.m = m;
      if (v) setNoteVib(S, L, n, v);
    }
    function fitBarPure(b) {
      const S = M.song;
      let notes = 0, pts = 0;
      S.layers.forEach((l, L) => {
        const info = M.bandsAt(S.chords[b].at + 0.01, L);
        if (!info.chord) return;
        const memo = new Map(), near = (m) => {
          const k = Math.round(m * 100);
          if (!memo.has(k)) memo.set(k, bandNear(info, m));
          return memo.get(k);
        };
        l.notes.forEach((n) => {
          if (md.regionAt(S, n.s) !== b) return;
          const t = near(n.m);
          if (t == null || Math.abs(t - n.m) < 0.005) return;
          moveNote(S, L, n, Math.round(clamp(t, LO, HI) * 100) / 100); notes++;
        });
        for (const st of md.strokes(l)) {   // every stroke
          const line = st.v;
          for (let i = S.chords[b].at * SPS; i < Math.min(line.length, md.regionEnd(S, b) * SPS); i++) {
            const m = line[i];
            if (isNaN(m)) continue;
            const t = near(m);
            if (t != null && Math.abs(t - m) >= 0.005) { line[i] = clamp(t, LO, HI); pts++; }
          }
        }
      });
      return { notes, pts };
    }

    // Musical fit (default): only what clashes moves, onto equal-tempered semitones, and lines keep their shape.
    //   A note / plateau whose semitone is a chord tone, or a key tone at least as consonant as the bar's 60th
    //   percentile (M.bands.fitCtx), stays (only re-tuned to the exact semitone). Anything else moves to the best whole
    //   semitone within ±2 (band consonance + chord / key bonus - distance, preferring the line's direction; ties to
    //   chord tones). Notes keep a deliberate microtonal offset (|offset| > 30 cents while Snap is off). A line is split
    //   into plateaus (runs within ±0.35 semitone for >= a sixteenth, without a steady slope), each shifted as one unit
    //   (its median lands on the semitone), and glides, re-drawn between the new plateau ends (their own curve, rescaled).
    //   Vibrato is index-keyed for lines (sample indices do not change) and re-keyed for notes.
    const PLAT = { tol: 0.35, min: SPS, slope: 0.05, trim: 0.2 };
    function plateaus(s, a0, b0) {   // plateaus [a, b) (sample indices) within run [a0, b0) of line s
      const out = [];
      let i = a0;
      while (i < b0) {
        let lo = s[i], hi = s[i], j = i + 1;
        while (j < b0 && Math.max(hi, s[j]) - Math.min(lo, s[j]) <= 2 * PLAT.tol) { lo = Math.min(lo, s[j]); hi = Math.max(hi, s[j]); j++; }
        // trim the ends that are really the glides into / out of it (> 0.2 semitone from its median)
        let a = i, z = j;
        if (z - a >= PLAT.min) {
          const med = median(Array.from(s.subarray(a, z)));
          while (a < z && Math.abs(s[a] - med) > PLAT.trim) a++;
          while (z > a && Math.abs(s[z - 1] - med) > PLAT.trim) z--;
        }
        const n = z - a;
        const slope = n > 1 ? Math.abs(s[z - 1] - s[a]) / (n - 1) : 0;   // a slow slide is a glide, not a plateau
        if (n >= PLAT.min && (slope < PLAT.slope || (n >= 2 * PLAT.min && slope < 2 * PLAT.slope))) { out.push([a, z]); i = z; } else i++;
      }
      return out;
    }
    const median = (a) => { const q = a.slice().sort((x, y) => x - y), k = q.length >> 1; return q.length % 2 ? q[k] : (q[k - 1] + q[k]) / 2; };
    const ease = (u) => (1 - Math.cos(Math.PI * clamp(u, 0, 1))) / 2;
    // Re-draw glide samples [a, b) of s (originals in o) between anchors La = [old, new] (left) and Ra (right):
    //   a glide whose new span keeps its direction and roughly its size is mapped affinely (its own curve, rescaled);
    //   a nearly level connection keeps its shape with the offset easing from one anchor's to the other's;
    //   anything else (direction flipped, span collapsed or blown up) becomes a plain eased curve between the anchors.
    function redrawGlide(s, o, a, b, La, Ra) {
      const len = b - a + 1, dA = La[1] - La[0], dB = Ra[1] - Ra[0], span0 = Ra[0] - La[0], span1 = Ra[1] - La[1];
      const k = span1 / span0, mode = Math.abs(span0) < 0.75 ? 'offset' : k >= 0.33 && k <= 3 ? 'affine' : 'ease';
      for (let i = a; i < b; i++) {
        const u = ease((i - a + 1) / len);
        s[i] = clamp(mode === 'affine' ? La[1] + (o[i] - La[0]) * k : mode === 'offset' ? o[i] + dA + (dB - dA) * u : La[1] + span1 * u, LO, HI);
      }
    }
    // st (tests: VH.melody.fitStats = { items: [] }) collects { L, kind, from, to, micro, kept } per note / plateau.
    function fitBarET(b, stats) {
      const S = M.song, snap = !!S.snap;
      let notes = 0, pts = 0;
      S.layers.forEach((l, L) => {
        const X = M.bands.fitCtx(b, L);
        if (!X) return;
        // ---- notes, in time order (melodic direction from the previous note of the layer) ----
        const ord = l.notes.slice().sort((x, y) => x.s - y.s || x.m - y.m);
        ord.forEach((n, k) => {
          if (md.regionAt(S, n.s) !== b) return;
          const base = Math.round(n.m), off = n.m - base, micro = !snap && Math.abs(off) > 0.3;
          const prev = ord[k - 1], dir = prev && Math.abs(n.m - prev.m) >= 0.25 ? Math.sign(n.m - prev.m) : 0;
          const t = X.best(base, dir, prev ? prev.m - (micro ? off : 0) : null), nm = Math.round(clamp(t + (micro ? off : 0), LO, HI) * 1000) / 1000;
          if (stats) stats.items.push({ L, kind: 'note', from: n.m, to: nm, micro, kept: t === base });
          if (Math.abs(nm - n.m) < 0.0005) return;
          moveNote(S, L, n, nm); notes++;
        });
        // ---- line: per stroke, plateaus move as units, glides are re-drawn ----
        for (const st of md.strokes(l)) {
        const s = st.v, i0 = S.chords[b].at * SPS, i1 = Math.min(s.length, md.regionEnd(S, b) * SPS), o = s.slice();
        let i = i0;
        while (i < i1) {
          if (isNaN(o[i])) { i++; continue; }
          let j = i;
          while (j < i1 && !isNaN(o[j])) j++;
          // run [i, j) inside the bar; it continues into the neighbouring bar when the sample there is set (fixed anchor)
          const contL = i === i0 && i0 > 0 && !isNaN(o[i0 - 1]), contR = j === i1 && i1 < s.length && !isNaN(o[i1]);
          const P = plateaus(o, i, j).map(([a, z]) => ({ a, z, med: median(Array.from(o.subarray(a, z))) }));
          P.forEach((p, k) => {
            const ref = P[k - 1] ? P[k - 1].med : contL ? o[i - 1] : null, prevTo = P[k - 1] ? P[k - 1].to : ref;
            const dir = ref == null || Math.abs(p.med - ref) < 0.25 ? 0 : Math.sign(p.med - ref);
            const tied = k === 0 && p.a === i && contL;   // a held note coming in over the bar line
            const tie = tied ? Math.round(o[i - 1]) : NaN;
            // keep the tie as a common tone when it fits the new chord; else the smallest audible move from it, stepping the
            // way the line goes next (or came from), so the re-articulation at the bar line adds no turn to the contour
            if (!tied) p.to = X.best(p.med, dir, prevTo);
            else {
              const nx = P[k + 1];
              let way = nx && Math.abs(nx.med - p.med) >= 0.25 ? Math.sign(nx.med - p.med) : 0;
              if (!way) { let q = i - 1; while (q >= 0 && !isNaN(s[q]) && Math.abs(s[q] - tie) < 0.25) q--; if (q >= 0 && !isNaN(s[q])) way = Math.sign(tie - s[q]); }
              p.to = X.best(tie, way, way ? tie : null);
            }
            if (stats) stats.items.push({ L, kind: 'plateau', stroke: st.id, from: p.med, to: p.to, micro: false, kept: p.to === Math.round(p.med) });
            const d = p.to - p.med;
            if (Math.abs(d) >= 0.0005) for (let q = p.a; q < p.z; q++) s[q] = clamp(o[q] + d, LO, HI);
          });
          // a held note coming in over the bar line now changes pitch there: ease into it over a sixteenth
          // (at the bar's end the next bar keeps its pitch until its own chord changes: a plain re-articulation)
          const P0 = P[0];
          if (P0 && P0.a === i && contL && P0.to !== P0.med) {
            const e = Math.min(P0.z, i + SPS);
            for (let q = i; q < e; q++) s[q] = clamp(o[i - 1] + (s[q] - o[i - 1]) * ease((q - i + 1) / (SPS + 1)), LO, HI);
          }
          if (P.length) {
            const gl = [];
            let cur = i;
            P.forEach((p) => { if (p.a > cur) gl.push([cur, p.a]); cur = p.z; });
            if (cur < j) gl.push([cur, j]);
            gl.forEach(([a, z]) => {
              const pl = P.find((p) => p.z === a), pr = P.find((p) => p.a === z);
              let La = pl ? [o[a - 1], s[a - 1]] : a === i0 && contL ? [o[a - 1], o[a - 1]] : null;
              let Ra = pr ? [o[z], s[z]] : z === i1 && contR ? [o[z], o[z]] : null;
              if (!La && Ra) La = [o[a], o[a] + Ra[1] - Ra[0]];   // a loose end follows its one anchor
              if (!Ra && La) Ra = [o[z - 1], o[z - 1] + La[1] - La[0]];
              if (!La || !Ra || (Math.abs(La[1] - La[0]) < 0.0005 && Math.abs(Ra[1] - Ra[0]) < 0.0005)) return;
              redrawGlide(s, o, a, z, La, Ra);
            });
          }
          i = j;
        }
        for (let q = i0; q < i1; q++) if (!isNaN(s[q]) && Math.abs(s[q] - o[q]) >= 0.0005) pts++;
        }
      });
      return { notes, pts };
    }
    const fitBar = (b, st) => (M.bands.pure ? fitBarPure(b) : fitBarET(b, st));
    // Runs inside M.commit, before the snapshot: chord edits (M.setChord, source 'chord') and generated progressions
    // (source 'generate') get their bars fitted in the same undo step, labelled 'Chord + fit' / 'Generate + fit'.
    const fitMsg = (r, what) => 'Fitted ' + (r.notes ? r.notes + ' note' + (r.notes > 1 ? 's' : '') : '') + (r.notes && r.pts ? ' and ' : '') + (r.pts ? 'the line' : '') + ' to ' + what;
    M.addHook('beforeCommit', (cx) => {
      if (!alive || !autofit || (cx.source !== 'chord' && cx.source !== 'generate')) return;
      const S = M.song, r = { notes: 0, pts: 0 };
      for (const b of new Set(cx.chords)) {
        if (!(b >= 0 && b < S.chords.length) || !md.regionChord(S, b)) continue;
        const x = fitBar(b, NS.fitStats); r.notes += x.notes; r.pts += x.pts;
      }
      if (!r.notes && !r.pts) return;
      cx.label = cx.source === 'generate' ? 'Generate + fit' : cx.label === 'Chord' ? 'Chord + fit' : cx.label + ' + fit';
      cx.info = Object.assign({}, cx.info, { fit: r, fitMsg: fitMsg(r, cx.source === 'generate' ? 'the new chords' : 'the new chord') });
      if (cx.source === 'chord') M.toast(cx.info.fitMsg);
    });
    // Keep vibrato (keyed by layer index) attached to the right layers when one is deleted (same undo step).
    M.on('layerRemoved', (id, i) => {
      const S = M.song, v = S.ext && S.ext.edit && S.ext.edit.vib;
      if (!v) return;
      const nv = {};
      Object.keys(v).forEach((k) => { const L = +k; if (L < i) nv[L] = v[k]; else if (L > i) nv[L - 1] = v[k]; });
      S.ext.edit.vib = nv; tidy(S);
    });

    // ---------- Settings: Editing ----------
    const sec = M.ui.addPanelSection('Editing', 30, { group: 'edit' });
    const row = ui.h('div', 'vh-row'); sec.append(row);
    const afBtn = ui.button(row, { label: 'Auto-fit notes to a new chord', pressed: autofit, onClick: () => {
      autofit = !autofit; VH.store.set(AF_KEY, autofit); afBtn.set({ pressed: autofit });
    } });
    sec.append(ui.h('div', 'vh-desc', 'When on, changing a bar’s chord moves only the notes that clash with it, to the nearest chord or key tone (within 2 semitones, in tune with the backing). Lines keep their shape. Undo reverts both.'));
    // Advanced: pure intonation (exact band maxima, often a few cents off equal temperament) for snaps and auto-fit.
    const PURE_KEY = 'melody.pureIntonation';
    M.bands.pure = VH.store.get(PURE_KEY, false) === true;
    const adv = M.ui.addPanelSection({ title: 'Intonation', order: 95, group: 'edit', advanced: true });
    const prow = ui.h('div', 'vh-row'); adv.append(prow);
    const pureBtn = ui.button(prow, { label: 'Pure intonation', pressed: M.bands.pure, onClick: () => {
      M.bands.pure = !M.bands.pure; VH.store.set(PURE_KEY, M.bands.pure); pureBtn.set({ pressed: M.bands.pure });
      M.toast('Pure intonation: ' + (M.bands.pure ? 'on (snaps land exactly on the bands)' : 'off (snaps land on equal-tempered notes)'));
    } });
    pureBtn.classList.add('mel-pure');
    adv.append(ui.h('div', 'vh-desc', 'Off (default): Snap, Line ends, moves, auto-fit and 🎲 Melody land on equal-tempered notes, in tune with the backing chords. ' +
      'On: they land exactly on the bright bands (just intonation; often a few cents off the backing).'));
    sec.append(ui.h('div', 'vh-desc', 'Tools: P pen · L straight line · N notes · V select · E eraser. Select: click or drag a box (Shift adds), drag to move, ' +
      'Delete removes, Ctrl+C / Ctrl+X / Ctrl+V copy, cut, paste (at the mouse or playhead), Ctrl+A selects the layer, Esc clears. ' +
      'Select something to set its vibrato.'));

    // ---------- keys ----------
    const KEYS = { p: 'pen', l: 'line', n: 'notes', v: 'select', e: 'erase' };
    function onKey(e) {
      if (!alive || e.defaultPrevented) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) ||
        (tag === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type))) return;
      const k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (k === 'a') { e.preventDefault(); selectAll(); }
        else if (k === 'c' && hasSel()) { e.preventDefault(); copySel(); M.toast('Copied'); }
        else if (k === 'x' && hasSel()) { e.preventDefault(); copySel(); delSel(); }
        else if (k === 'v' && clip) { e.preventDefault(); pasteHere(); }
        return;
      }
      if (e.altKey) return;
      if (k === 'delete' || k === 'backspace') { if (hasSel()) { e.preventDefault(); delSel(); } return; }
      if (k === 'escape') { if (hasSel()) clearSel(); return; }
      if (e.shiftKey || e.repeat || !KEYS[k]) return;
      if (t && t.closest && t.closest('.mel-pop')) return;
      e.preventDefault(); pick(KEYS[k]);
    }
    document.addEventListener('keydown', onKey);
    M.cleanups.push(() => document.removeEventListener('keydown', onKey));

    // ---------- sync ----------
    M.on('song', () => { validateSel(); syncToolToMode(); });
    M.on('layer', () => { clearSel(); syncToolToMode(); });
    M.on('tool', () => syncSeg());
    M.on('scroll', () => syncBar());
    M.on('layout', () => syncBar());
    syncToolToMode();

    return {
      destroy() {
        alive = false;
        sel.notes.forEach((n) => { delete n.sel; });
      },
    };
  });
})();
