// app.js - shell: experiment registry, hash router, about dialog, hint line, shared UI components (VH.ui).
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  const doc = root.document;
  const exps = [];
  let cur = null;   // { exp, el }
  let hintOff = null;
  let prevId = '';   // experiment mounted before the current one (VH.app.prev)
  // Tab label of an experiment (the Lab experiment, id/route 'lab', is shown as "Archive").
  const labelOf = (e) => (e.id === 'lab' ? 'Archive' : e.title);

  // ---------- tiny DOM helpers ----------
  function h(tag, cls, html) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  // Settings panel categories, in tab order (drawer.addSection's `group`). Anything else lands in 'General'.
  const GROUPS = [['song', 'Song'], ['sound', 'Sound'], ['mix', 'Mix'], ['edit', 'Edit'], ['export', 'Export'], ['general', 'General']];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- shared components ----------
  const ui = {
    h, esc,
    dpr: () => Math.min(root.devicePixelRatio || 1, 2),

    // Hero canvas area + caption line + dock. Returns { box, caption, dock }.
    layout(el, opts) {
      const box = h('div', 'vh-canvas-box'), dock = h('div', 'vh-dock');
      dock.setAttribute('role', 'toolbar'); dock.setAttribute('aria-label', 'Controls');
      el.append(box);
      let caption = null;
      if (!opts || opts.caption !== false) { caption = h('div', 'vh-caption'); caption.setAttribute('aria-live', 'polite'); el.append(caption); }
      el.append(dock);
      return { box, caption, dock };
    },

    // Calls cb(width, height) now and whenever the box's content size changes. Returns a disconnect fn.
    fit(box, cb) {
      const run = () => {
        const cs = root.getComputedStyle(box);
        const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const ht = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        if (w > 0 && ht > 0) cb(Math.floor(w), Math.floor(ht));
      };
      const ro = new ResizeObserver(run);
      ro.observe(box);
      run();
      return () => ro.disconnect();
    },

    // Big dock button: icon + label. opts: { icon, label, title, pressed, onClick }
    dockButton(dock, o) {
      const b = h('button', 'vh-dock-btn', '<span class="ic"></span><span class="lb"></span>');
      b.type = 'button';
      b.set = (p) => {
        if (p.icon != null) b.firstChild.innerHTML = p.icon;
        if (p.label != null) { b.lastChild.textContent = p.label; if (!o.title) b.title = p.label; }
        if (p.pressed != null) b.setAttribute('aria-pressed', String(!!p.pressed));
      };
      b.set(o);
      if (o.title) b.title = o.title;
      if (o.onClick) b.addEventListener('click', o.onClick);
      dock.append(b);
      return b;
    },
    dockSep(dock) { dock.append(h('span', 'vh-dock-sep')); },

    // Dock item wrapping a native <select> (accessible, touch-friendly). options: [{ value, label, group }]
    dockSelect(dock, o) {
      const wrap = h('label', 'vh-dock-btn vh-dock-select', '<span class="ic"></span><span class="lb"></span>');
      const sel = h('select');
      sel.setAttribute('aria-label', o.title || o.label || 'Choose');
      wrap.firstChild.innerHTML = o.icon || '';
      wrap.append(sel);
      if (o.title) wrap.title = o.title;
      const lb = wrap.querySelector('.lb');
      const showLabel = () => { const op = sel.options[sel.selectedIndex]; lb.textContent = op ? op.textContent : (o.label || ''); };
      const api = {
        el: wrap, select: sel,
        setOptions(opts, value) {
          sel.innerHTML = '';
          const groups = new Map();
          for (const op of opts) {
            let parent = sel;
            if (op.group) {
              if (!groups.has(op.group)) { const g = h('optgroup'); g.label = op.group; groups.set(op.group, g); sel.append(g); }
              parent = groups.get(op.group);
            }
            const e = h('option'); e.value = op.value; e.textContent = op.label; parent.append(e);
          }
          api.value = value;
        },
        get value() { return sel.value; },
        set value(v) { sel.value = v; if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0; showLabel(); },
      };
      sel.addEventListener('change', () => { showLabel(); if (o.onChange) o.onChange(sel.value); });
      api.setOptions(o.options || [], o.value);
      dock.append(wrap);
      return api;
    },

    // How a sound is best played on a continuous line: 'glide' (legato) or 'hit' (re-triggered notes).
    // Uses sound.play when present (core API), otherwise derives it from family / envelope.
    playOf(s) {
      if (!s) return 'glide';
      if (s.play === 'glide' || s.play === 'hit') return s.play;
      if (VH.sounds && VH.sounds.playOf) return VH.sounds.playOf(s);
      const f = String(s.family || '').toLowerCase();
      if (/pluck|pizz|harp|piano|keys|mallet|marimba|xylo|glock|celesta|kalimba|bell|perc|struck|drum|lute|harpsi/.test(f)) return 'hit';
      if (/string|organ|flute|wood|wind|brass|trem|choir|pad|pure|custom|voice/.test(f)) {
        return s.kind === 'synth' && s.synth && (s.synth.sustain ?? 1) < 0.3 ? 'hit' : 'glide';
      }
      if (s.kind === 'synth') return s.synth && (s.synth.sustain ?? 1) < 0.3 ? 'hit' : 'glide';
      return 'hit';
    },
    SOUND_GROUPS: ['Synths', 'Instruments', 'Your sounds', 'Local'],
    soundGroup(s) {
      if (s.private) return 'Local';
      if (s.source === 'preset' && s.id !== 'custom') return 'Synths';
      if (s.source === 'sample') return 'Instruments';
      return 'Your sounds';
    },
    // Options for the unified picker. opts.mode === 'line' splits each group into "Glides well" / "Best for notes".
    soundOptions(o) {
      o = o || {};
      const G = ui.SOUND_GROUPS, line = o.mode === 'line';
      const rows = VH.sounds.list().filter((s) => !o.filter || o.filter(s)).map((s) => {
        const g = ui.soundGroup(s), p = ui.playOf(s);
        return { value: s.id, label: s.name + (s.private ? ' · local' : ''), g, p,
          group: line ? g + ' · ' + (p === 'hit' ? 'Best for notes' : 'Glides well') : g };
      });
      return rows.sort((a, b) => G.indexOf(a.g) - G.indexOf(b.g) || (line ? (a.p === 'hit') - (b.p === 'hit') : 0));
    },
    // Plain (non-dock) <select> for panels. options: [{ value, label, group }]
    select(parent, o) {
      const sel = h('select', 'vh-select');
      sel.setAttribute('aria-label', o.label || 'Choose');
      const api = {
        el: sel, select: sel,
        setOptions(opts, value) {
          sel.innerHTML = '';
          const groups = new Map();
          for (const op of opts) {
            let par = sel;
            if (op.group) {
              if (!groups.has(op.group)) { const g = h('optgroup'); g.label = op.group; groups.set(op.group, g); sel.append(g); }
              par = groups.get(op.group);
            }
            const e = h('option'); e.value = op.value; e.textContent = op.label; par.append(e);
          }
          api.value = value;
        },
        get value() { return sel.value; },
        set value(v) { sel.value = v; if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0; },
      };
      sel.addEventListener('change', () => { if (o.onChange) o.onChange(sel.value); });
      api.setOptions(o.options || [], o.value);
      if (parent) parent.append(sel);
      return api;
    },

    // Unified instrument picker fed by VH.sounds.list(): Synths / Instruments / Your sounds / Local.
    // opts: { value, onChange(id), title, mode: 'line'|undefined, filter(sound) }. In a .vh-dock it is a dock item,
    // anywhere else a plain select. Returns { value, set(id), setMode(mode), refresh(), destroy(), el, select }.
    soundPicker(parent, o) {
      o = o || {};
      let mode = o.mode;
      const opts = () => ui.soundOptions({ mode, filter: o.filter });
      const inDock = parent && parent.classList && parent.classList.contains('vh-dock');
      const sel = inDock
        ? ui.dockSelect(parent, { icon: o.icon || '♪', title: o.title || 'Instrument', options: opts(), value: o.value, onChange: (id) => o.onChange && o.onChange(id) })
        : ui.select(parent, { label: o.title || 'Instrument', options: opts(), value: o.value, onChange: (id) => o.onChange && o.onChange(id) });
      const refresh = () => { const v = sel.value; sel.setOptions(opts(), v); };
      const off = VH.sounds.onChange(refresh);
      return {
        get value() { return sel.value; }, set(id) { sel.value = id; },
        setMode(m) { if (m !== mode) { mode = m; refresh(); } },
        refresh, destroy: off, el: sel.el, select: sel.select,
      };
    },

    // "Settings" side panel. Desktop (>= 900px): pushes the experiment's stage aside. Phones: bottom sheet.
    // API: { el, body, button, isOpen, open(group?), close(), toggle(), addSection(o), showGroup(g), group, reveal(el),
    // onChange(fn) -> off }; adds its toggle to the dock. Plain sections can still be appended to `body` (ui.section).
    // addSection({ title, order = 60, group: 'song'|'sound'|'mix'|'edit'|'export' (else 'General'), collapsed, advanced })
    // returns the section's body (a .vh-section): sections become collapsible accordions on category tabs. The tab strip
    // and the filter field appear once two or more groups have sections; the last tab and closed sections are remembered.
    drawer(el, dock, o) {
      o = o || {};
      const d = h('aside', 'vh-drawer');
      d.setAttribute('aria-label', (o.title ? o.title + ' settings' : 'Settings'));
      d.innerHTML = '<div class="vh-drawer-grab" aria-hidden="true"></div><div class="vh-drawer-head"><h2></h2><button class="vh-icon-btn" type="button" aria-label="Close settings">✕</button></div>' +
        '<div class="vh-drawer-nav" hidden><div class="vh-ptabs" role="tablist" aria-label="Settings categories"></div>' +
        '<label class="vh-filter"><span aria-hidden="true">⌕</span><input type="search" placeholder="Find a setting" aria-label="Find a setting" autocomplete="off" spellcheck="false"></label></div>' +
        '<div class="vh-drawer-body"></div>';
      d.querySelector('h2').textContent = 'Settings' + (o.title ? ' · ' + o.title : '');
      const body = d.querySelector('.vh-drawer-body'), nav = d.querySelector('.vh-drawer-nav'), tablist = nav.firstChild, filter = nav.querySelector('input');
      const empty = h('div', 'vh-filter-empty', 'No setting matches.'); empty.hidden = true;
      body.append(empty);
      el.append(d);
      const btn = ui.dockButton(dock, { icon: '⚙', label: 'Settings', title: 'Settings', pressed: false,
        onClick: () => api.toggle() });
      btn.classList.add('vh-settings-btn');
      btn.setAttribute('aria-expanded', 'false');
      const st = VH.store || { get: (k, def) => def, set() {} };
      const key = 'ui.panel.' + String(o.id || o.title || 'main').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const uid = key.replace(/\./g, '-');
      const panes = new Map();   // group -> { pane, tab, label }
      const subs = [];
      let group = null, query = '';
      const emit = () => subs.slice().forEach((f) => { try { f(api); } catch (err) { console.error('[VH] panel listener', err); } });
      const used = (g) => { const p = panes.get(g); return !!(p && p.pane.querySelector('.vh-acc')); };
      const shown = () => GROUPS.map((x) => x[0]).concat([...panes.keys()]).filter((g, i, a) => a.indexOf(g) === i && used(g));

      function paneOf(g) {
        if (panes.has(g)) return panes.get(g);
        const label = (GROUPS.find((x) => x[0] === g) || [g, g[0].toUpperCase() + g.slice(1)])[1];
        const pane = h('div', 'vh-pane'), tab = h('button', 'vh-ptab');
        pane.dataset.group = g; pane.dataset.label = label; pane.id = uid + '-' + g; pane.setAttribute('role', 'tabpanel');
        tab.type = 'button'; tab.textContent = label; tab.dataset.group = g; tab.id = pane.id + '-tab';
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', pane.id); pane.setAttribute('aria-labelledby', tab.id);
        tab.addEventListener('click', () => { if (query) { filter.value = ''; query = ''; applyFilter(); } api.showGroup(g); });
        const rank = (x) => { const i = GROUPS.findIndex((y) => y[0] === x); return i < 0 ? GROUPS.length - 1.5 : i; };
        const after = [...panes.keys()].filter((x) => rank(x) > rank(g)).sort((a, b) => rank(a) - rank(b))[0];
        body.insertBefore(pane, after ? panes.get(after).pane : empty);
        tablist.insertBefore(tab, after ? panes.get(after).tab : null);
        const P = { pane, tab, label };
        panes.set(g, P);
        return P;
      }
      function sync() {
        const gs = shown(), tabs = gs.length > 1;
        nav.hidden = !tabs;
        if (!gs.includes(group)) group = gs.includes(st.get(key + '.tab')) ? st.get(key + '.tab') : gs[0] || null;
        panes.forEach((P, g) => {
          const sel = g === group, on = gs.includes(g);
          P.tab.hidden = !on;
          P.tab.setAttribute('aria-selected', String(sel)); P.tab.tabIndex = sel ? 0 : -1;
          P.pane.hidden = !on || (!query && tabs && !sel) || P.pane.classList.contains('vh-miss');
        });
        d.classList.toggle('vh-tabbed', tabs);
      }
      function setGroup(g, remember) {
        if (!used(g)) return;
        if (remember) st.set(key + '.tab', g);
        if (g === group) return;
        group = g; sync(); body.scrollTop = 0; emit();
      }
      // ---- filter: matches section titles and control labels (not option lists); shows hits from every tab ----
      function textOf(n) {
        let s = '';
        if (n.nodeType === 3) return n.nodeValue;
        if (n.nodeType !== 1 || n.tagName === 'SELECT' || n.tagName === 'OPTION') return n.nodeType === 1 && n.getAttribute('aria-label') ? ' ' + n.getAttribute('aria-label') : '';
        if (n.getAttribute('aria-label')) s += ' ' + n.getAttribute('aria-label');
        for (const c of n.childNodes) s += textOf(c);
        return s;
      }
      function applyFilter() {
        const q = query.trim().toLowerCase();
        d.classList.toggle('vh-filtering', !!q);
        let any = false;
        panes.forEach((P) => {
          let hitPane = false;
          for (const w of P.pane.children) {
            const bd = w.querySelector(':scope > .vh-acc-body'), hd = w.querySelector(':scope > .vh-acc-h');
            if (!bd) continue;
            if (!q) { w.classList.remove('vh-miss', 'vh-hit'); [...bd.children].forEach((c) => c.classList.remove('vh-miss')); continue; }
            const all = !!hd && hd.textContent.toLowerCase().includes(q);
            let hit = false;
            for (const c of bd.children) { const m = all || textOf(c).toLowerCase().includes(q); c.classList.toggle('vh-miss', !m); hit = hit || (m && !c.hidden); }
            w.classList.toggle('vh-miss', !hit); w.classList.toggle('vh-hit', hit);
            hitPane = hitPane || hit;
          }
          P.pane.classList.toggle('vh-miss', !!q && !hitPane);
          P.tab.classList.toggle('vh-has-hit', !!q && hitPane);
          any = any || hitPane;
        });
        empty.hidden = !q || any;
        sync();
      }
      filter.addEventListener('input', () => { query = filter.value; applyFilter(); body.scrollTop = 0; });
      filter.addEventListener('keydown', (e) => { if (e.key === 'Escape' && filter.value) { e.stopPropagation(); filter.value = ''; query = ''; applyFilter(); } });
      tablist.addEventListener('keydown', (e) => {   // roving focus: arrows / Home / End move and select
        const gs = shown(), i = gs.indexOf(group);
        const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: gs.length - 1 }[e.key];
        if (j == null) return;
        e.preventDefault();
        const g = gs[(j + gs.length) % gs.length];
        api.showGroup(g); panes.get(g).tab.focus();
      });
      const closedMap = () => st.get(key + '.closed', {}) || {};
      const api = {
        el: d, body, button: btn,
        get isOpen() { return d.classList.contains('open'); },
        get group() { return group; },
        get groups() { return shown(); },
        open(g) {
          if (g) setGroup(g, false); else { const r = st.get(key + '.tab'); if (r && used(r)) setGroup(r, false); }
          if (api.isOpen) return;
          d.classList.add('open'); el.classList.add('vh-pushed'); btn.set({ pressed: true }); btn.setAttribute('aria-expanded', 'true'); emit();
        },
        close() {
          if (!api.isOpen) return;
          d.classList.remove('open'); el.classList.remove('vh-pushed'); btn.set({ pressed: false }); btn.setAttribute('aria-expanded', 'false'); emit();
        },
        toggle() { if (api.isOpen) api.close(); else api.open(); },
        showGroup(g) { setGroup(g, true); },
        onChange(fn) { subs.push(fn); return () => { const k = subs.indexOf(fn); if (k >= 0) subs.splice(k, 1); }; },
        // Make a control inside the panel visible: its tab, its accordion, no filter hiding it; then scroll to it.
        reveal(n) {
          const pane = n && n.closest && n.closest('.vh-pane');
          if (!pane || !d.contains(pane)) return;
          if (n.closest('.vh-miss')) { filter.value = ''; query = ''; applyFilter(); }
          setGroup(pane.dataset.group, false);
          const w = n.closest('.vh-acc');
          if (w && w._vhSetOpen) w._vhSetOpen(true);
          n.scrollIntoView({ block: 'center' });
        },
        addSection(so) {
          so = typeof so === 'string' ? { title: so } : so || {};
          const g = typeof so.group === 'string' && so.group ? so.group : 'general', P = paneOf(g);
          const w = h('section', 'vh-acc'), bd = h('div', 'vh-section vh-acc-body');
          w.dataset.order = so.order == null ? 60 : so.order;
          bd.id = uid + '-s' + (++secN);
          if (so.title) {
            const hd = h('h3', 'vh-acc-h'), b = h('button', 'vh-acc-btn', '<span class="t"></span><span class="chev" aria-hidden="true"></span>');
            b.type = 'button'; b.firstChild.textContent = so.title; b.setAttribute('aria-controls', bd.id);
            if (so.advanced) b.append(h('span', 'vh-acc-tag', 'Advanced'));
            hd.append(b); w.append(hd);
            const setOpen = (v, remember) => {
              w.classList.toggle('closed', !v); b.setAttribute('aria-expanded', String(v));
              if (remember) { const m = closedMap(); m[so.title] = !v; st.set(key + '.closed', m); }
            };
            w._vhSetOpen = setOpen;
            b.addEventListener('click', () => setOpen(w.classList.contains('closed'), true));
            const m = closedMap();
            setOpen(!(so.title in m ? m[so.title] : !!(so.collapsed || so.advanced)), false);
          } else w.classList.add('vh-acc-plain');
          w.append(bd);
          const next = [...P.pane.children].find((c) => +c.dataset.order > +w.dataset.order);
          P.pane.insertBefore(w, next || null);
          sync();
          if (query) applyFilter();
          return bd;
        },
      };
      let secN = 0;
      d.querySelector('.vh-drawer-head button').addEventListener('click', () => { api.close(); btn.focus(); });
      d._vhDrawer = api;
      return api;
    },
    section(parent, title) {
      const s = h('div', 'vh-section');
      if (title) s.append(h('h3', '', esc(title)));
      parent.append(s);
      return s;
    },
    // opts: { label, min, max, step, value, fmt, desc, onInput }
    slider(parent, o) {
      const d = h('div', 'vh-ctl', '<label><span class="n"></span><span class="v"></span></label><input type="range">');
      const inp = d.querySelector('input'), out = d.querySelector('.v');
      d.querySelector('.n').textContent = o.label;
      d.querySelector('.n').style.cssText = 'color:inherit;font-family:inherit';
      Object.assign(inp, { min: o.min, max: o.max, step: o.step, value: o.value });
      inp.setAttribute('aria-label', o.label);
      const fmt = o.fmt || String;
      out.textContent = fmt(Number(inp.value));
      inp.addEventListener('input', () => { const v = Number(inp.value); out.textContent = fmt(v); o.onInput(v); });
      if (o.desc) d.append(h('div', 'vh-desc', esc(o.desc)));
      parent.append(d);
      return { input: inp, set(v) { inp.value = v; out.textContent = fmt(Number(inp.value)); } };
    },
    button(parent, o) {
      const b = h('button', 'vh-btn');
      b.type = 'button'; b.textContent = o.label;
      if (o.pressed != null) b.setAttribute('aria-pressed', String(!!o.pressed));
      b.set = (p) => { if (p.label != null) b.textContent = p.label; if (p.pressed != null) b.setAttribute('aria-pressed', String(!!p.pressed)); };
      if (o.onClick) b.addEventListener('click', o.onClick);
      parent.append(b);
      return b;
    },
    // Quiet note about the sample library (file:// or missing manifest), refreshed when it resolves.
    samplesNote(parent) {
      const n = h('div', 'vh-note');
      const upd = () => { n.textContent = VH.sounds.status.note; n.hidden = !VH.sounds.status.note; };
      upd();
      VH.sounds.ready.then(upd);
      parent.append(n);
      return n;
    },
  };
  VH.ui = ui;

  // ---------- shortcut sheet ("?") ----------
  // VH.ui.shortcuts.register(expId, [{ keys, label }]) -> unregister(). keys: '+' joins a combo, ' / ' separates
  // alternatives (e.g. 'Ctrl+Shift+Z / Ctrl+Y'). The sheet lists the current experiment's shortcuts plus the global ones.
  const shortcutMap = new Map();
  const GLOBAL_KEYS = [{ keys: '?', label: 'Show or hide this list of shortcuts' }, { keys: 'Esc', label: 'Close menus, panels and dialogs' },
    { keys: 'Tab / Shift+Tab', label: 'Move between controls' }];
  let sheet = null, sheetBack = null;
  function kbdHtml(keys) {
    return String(keys).split(' / ').map((alt) => '<span class="vh-sc-alt">' + alt.split('+').map((k) => '<kbd>' + esc(k.trim() || '+') + '</kbd>').join('<i>+</i>') + '</span>').join('<i class="or">or</i>');
  }
  function renderSheet() {
    if (!sheet) return;
    const id = VH.app.current, e = exps.find((x) => x.id === id), mine = shortcutMap.get(id) || [];
    const list = (rows) => '<dl>' + rows.map((r) => '<div class="vh-sc-row"><dt>' + kbdHtml(r.keys) + '</dt><dd>' + esc(r.label) + '</dd></div>').join('') + '</dl>';
    sheet.querySelector('.vh-sheet-body').innerHTML =
      (mine.length ? '<section><h3>' + esc(e ? labelOf(e) : id) + '</h3>' + list(mine) + '</section>' : '') +
      '<section><h3>Everywhere</h3>' + list(GLOBAL_KEYS) + '</section>';
  }
  ui.shortcuts = {
    register(expId, rows) {
      const id = String(expId);
      const arr = (Array.isArray(rows) ? rows : []).filter((r) => r && r.keys && r.label).map((r) => ({ keys: String(r.keys), label: String(r.label) }));
      shortcutMap.set(id, arr);
      if (ui.shortcuts.isOpen) renderSheet();
      return () => { if (shortcutMap.get(id) === arr) shortcutMap.delete(id); };
    },
    list(expId) { return (shortcutMap.get(String(expId)) || []).slice(); },
    global: GLOBAL_KEYS,
    get isOpen() { return !!sheet && !sheet.hidden; },
    open() {
      if (!sheet) {
        sheet = h('div', 'vh-sheet');
        sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'vhSheetTitle');
        sheet.innerHTML = '<div class="vh-sheet-card"><div class="vh-sheet-head"><h2 id="vhSheetTitle">Keyboard shortcuts</h2>' +
          '<button type="button" class="vh-icon-btn" aria-label="Close shortcuts">✕</button></div><div class="vh-sheet-body"></div>' +
          '<p class="vh-sheet-foot">Press <kbd>?</kbd> any time to see this again.</p></div>';
        sheet.hidden = true;
        sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('.vh-sheet-head button')) ui.shortcuts.close(); });
        doc.body.append(sheet);
      }
      renderSheet();
      if (!sheet.hidden) return;
      sheetBack = doc.activeElement;
      sheet.hidden = false;
      sheet.querySelector('.vh-sheet-head button').focus({ preventScroll: true });
    },
    close() {
      if (!sheet || sheet.hidden) return;
      sheet.hidden = true;
      if (sheetBack && sheetBack.focus && doc.contains(sheetBack)) sheetBack.focus({ preventScroll: true });
      sheetBack = null;
    },
    toggle() { if (ui.shortcuts.isOpen) ui.shortcuts.close(); else ui.shortcuts.open(); },
  };
  function onSheetKey(e) {
    const t = e.target, tag = t && t.tagName;
    const editable = tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || (tag === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type));
    if (ui.shortcuts.isOpen) {
      if (e.key === 'Escape' || (e.key === '?' && !editable)) { e.preventDefault(); e.stopImmediatePropagation(); ui.shortcuts.close(); return; }
      if (e.key === 'Tab') {   // keep focus inside the sheet
        e.preventDefault(); sheet.querySelector('.vh-sheet-head button').focus();
        return;
      }
      e.stopImmediatePropagation();   // experiment shortcuts stay quiet while the sheet is open
      return;
    }
    if (e.key === '?' && !editable && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); ui.shortcuts.open(); }
  }

  // ---------- local-only banner (file://: sampled instruments need a server) ----------
  function initBanner() {
    const b = doc.getElementById('banner');
    if (!b || !VH.sounds || !VH.sounds.ready) return;
    VH.sounds.ready.then(() => {
      // only ever on file:// (never on http/https), and only when the sample library really could not load
      if (root.location.protocol !== 'file:' || VH.sounds.status.samples === 'ok') return;
      if (VH.store && VH.store.get('ui.banner.file.dismissed', false)) return;
      b.querySelector('span').textContent = 'Sampled instruments need a local server: double-click start.bat';
      b.hidden = false; doc.body.classList.add('vh-has-banner');
      b.querySelector('button').addEventListener('click', () => {
        b.hidden = true; doc.body.classList.remove('vh-has-banner');
        if (VH.store) VH.store.set('ui.banner.file.dismissed', true);
      }, { once: true });
    });
  }

  // ---------- registry + router ----------
  function registerExperiment(e) {
    if (!e || !e.id || typeof e.mount !== 'function' || typeof e.unmount !== 'function') throw new Error('bad experiment');
    exps.push(e);
  }
  function parse() {
    const raw = decodeURIComponent((root.location.hash || '').replace(/^#\/?/, ''));
    const i = raw.indexOf('/');
    return i < 0 ? { id: raw, sub: '' } : { id: raw.slice(0, i), sub: raw.slice(i + 1) };
  }
  const stage = () => doc.getElementById('stage');

  function unmountCurrent() {
    if (!cur) return;
    try { cur.exp.unmount(); } catch (err) { console.error('unmount failed:', cur.exp.id, err); }
    cur.el.remove();
    cur = null;
    if (hintOff) { hintOff(); hintOff = null; }
    const st = VH.audio.stats();
    if (st.live) { console.warn('[VH] experiment left ' + st.live + ' voice(s) running; stopping them'); VH.audio.stopAll(); }
  }

  function showHint(text) {
    const old = stage().querySelector('.vh-hint');
    if (old) old.remove();
    if (!text) return;
    const el = h('div', 'vh-hint');
    el.textContent = text;
    stage().append(el);
    const hide = () => { el.classList.add('gone'); off(); setTimeout(() => el.remove(), 700); };
    const off = () => { stage().removeEventListener('pointerdown', hide); doc.removeEventListener('keydown', hide); };
    stage().addEventListener('pointerdown', hide);
    doc.addEventListener('keydown', hide);
    hintOff = () => { off(); el.remove(); };
  }

  function route() {
    const { id, sub } = parse();
    const exp = exps.find((e) => e.id === id);
    if (!exp) { root.location.replace('#' + exps[0].id); return; }
    VH.app.sub = sub;
    if (cur && cur.exp === exp && exp.onRoute) { exp.onRoute(sub); return; }
    if (cur) prevId = cur.exp.id;
    unmountCurrent();
    const el = h('div', 'vh-exp');
    el.dataset.exp = exp.id;
    stage().append(el);
    cur = { exp, el };
    for (const a of doc.querySelectorAll('#tabs .vh-tab')) {
      if (a.dataset.id === exp.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    doc.title = labelOf(exp) + ' · Visual Harmonics';
    try { exp.mount(el); } catch (err) { console.error('mount failed:', exp.id, err); }
    showHint(exp.hint);
  }

  function start() {
    const tabs = doc.getElementById('tabs');
    for (const e of exps) {
      const a = h('a', 'vh-tab');
      a.href = '#' + e.id; a.dataset.id = e.id; a.textContent = labelOf(e);
      tabs.append(a);
    }
    const dlg = doc.getElementById('about');
    doc.getElementById('aboutBtn').addEventListener('click', () => {
      if (dlg.open) return;
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // click on backdrop
    doc.addEventListener('keydown', (e) => {   // Escape closes an open drawer
      if (e.key !== 'Escape') return;
      const d = stage().querySelector('.vh-drawer.open');
      if (d && d._vhDrawer) d._vhDrawer.close();
    });
    root.addEventListener('keydown', onSheetKey, true);
    root.addEventListener('hashchange', route);
    initBanner();
    route();
  }

  VH.registerExperiment = registerExperiment;
  VH.app = { start, sub: '', get current() { return cur && cur.exp.id; }, get prev() { return prevId; }, experiments: exps };
})(this);
