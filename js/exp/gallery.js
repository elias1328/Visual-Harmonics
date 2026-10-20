// gallery.js - the community Gallery tab (#gallery) and the "Publish to gallery" dialog Melody opens.
// Backend: Supabase PostgREST over plain fetch (docs/gallery.sql; VH.config.gallery = { url, key }).
// Pure helpers (query builder, meta / preview builder, row check) also load in Node for tests: module.exports.
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};

  // ===================== pure helpers =====================
  const PAGE = 24, TITLE_MAX = 60, AUTHOR_MAX = 30, META_MAX = 3500, META_JSONB_MAX = 3900;
  const LIST_SELECT = 'id,created_at,title,author,meta,likes';

  // Search text that is safe inside a PostgREST `or=(...)` filter: pattern / grouping / quoting characters become a
  // '*' wildcard (so "O1 test (auto)" still finds that title); nothing but wildcards = no search.
  function cleanSearch(q) {
    const t = String(q == null ? '' : q).slice(0, TITLE_MAX).replace(/[*%,()"\\_]/g, '*').replace(/\s+/g, ' ')
      .replace(/\s*\*[\s*]*/g, '*').trim();
    return /^[*\s]*$/.test(t) ? '' : t.replace(/^\*+|\*+$/g, '');
  }
  // Strict query-value encoding (RFC 3986: also ! ' ( ) *).
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  // Path + query of one gallery page. o = { sort: 'new' | 'top', q, offset, limit }
  function listPath(o) {
    o = o || {};
    const lim = Math.max(1, Math.min(100, o.limit | 0 || PAGE)), off = Math.max(0, o.offset | 0);
    const order = o.sort === 'top' ? 'likes.desc,created_at.desc' : 'created_at.desc';
    let p = '/rest/v1/songs?select=' + LIST_SELECT + '&order=' + order + '&limit=' + lim + '&offset=' + off;
    const q = cleanSearch(o.q);
    if (q) p += '&or=' + enc('(title.ilike."*' + q + '*",author.ilike."*' + q + '*")');
    return p;
  }
  const cps = (s) => [...s].length;   // characters as the database counts them (code points)
  const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const codePath = (id) => '/rest/v1/songs?id=eq.' + encodeURIComponent(id) + '&select=code';

  // A row from the server, checked and normalised; null when malformed (it is then skipped).
  function cleanRow(r) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
    if (typeof r.title !== 'string') return null;
    const title = r.title.trim();
    if (!title || cps(title) > TITLE_MAX) return null;
    let author = typeof r.author === 'string' ? r.author.trim() : '';
    if (!author || cps(author) > AUTHOR_MAX) author = 'Anonymous';
    const t = Date.parse(r.created_at);
    const meta = r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta) ? r.meta : {};
    return { id: r.id, title, author, created: isFinite(t) ? t : 0, meta, likes: Math.max(0, Number(r.likes) | 0) };
  }
  // Client-side check of the publish form. Returns { title, author, error }.
  function checkPublish(title, author) {
    const t = String(title == null ? '' : title).trim(), a = String(author == null ? '' : author).trim() || 'Anonymous';
    if (!t) return { title: t, author: a, error: 'Please give your song a title.' };
    if (cps(t) > TITLE_MAX) return { title: t, author: a, error: 'The title can be up to ' + TITLE_MAX + ' characters.' };
    if (cps(a) > AUTHOR_MAX) return { title: t, author: a, error: 'The nickname can be up to ' + AUTHOR_MAX + ' characters.' };
    return { title: t, author: a, error: '' };
  }

  // ---- meta + preview ----
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r1 = (x) => Math.round(x * 10) / 10;
  const utf8 = (s) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length);
  // Evenly spaced points (first and last kept), at most n.
  function downsample(pts, n) {
    if (!Array.isArray(pts)) return [];
    n = Math.max(2, n | 0);
    if (pts.length <= n) return pts.slice();
    const out = [];
    for (let i = 0; i < n; i++) out.push(pts[Math.round(i * (pts.length - 1) / (n - 1))]);
    return out;
  }
  // Conservative estimate of the PostgreSQL jsonb size (pg_column_size) of v: the table's CHECK is on jsonb bytes,
  // which run ~2-3x the JSON text for arrays of numbers (4-byte headers + entries, 4-byte aligned numerics).
  const al4 = (x) => (x + 3) & ~3;
  function jsonbBytes(v) {
    const inner = (x) => {
      if (Array.isArray(x)) return 4 + x.reduce((s, y) => s + 4 + al4(inner(y)), 0);
      if (x && typeof x === 'object') { const ks = Object.keys(x); return 4 + ks.reduce((s, k) => s + 8 + utf8(k) + al4(inner(x[k])), 0); }
      if (typeof x === 'number') return 12;
      if (typeof x === 'string') return utf8(x);
      return 0;
    };
    return 4 + inner(v);
  }
  const metaFits = (m, max) => utf8(JSON.stringify(m)) <= (max || META_MAX) && jsonbBytes(m) <= META_JSONB_MAX;
  const finite = (x) => typeof x === 'number' && isFinite(x);
  // info = { bpm, key: 'C', scale, sections, regions: [t 0..1], layers: [{ color, runs: [[[t, midi], ...]], notes: [[t0, t1, midi]] }] }
  // -> meta { bpm, key, scale, sections, layers: [colors], preview: { r: [t], l: [{ s: [[[t, m]...]...], n: [[t0, t1, m]...] }] } }
  // downsampled harder until it fits META_MAX bytes of JSON (and the server's jsonb limit).
  function buildMeta(info, maxBytes) {
    info = info || {};
    const layers = (Array.isArray(info.layers) ? info.layers : []).slice(0, 8);
    const base = {
      bpm: finite(info.bpm) ? Math.round(info.bpm) : 0,
      key: String(info.key || '').slice(0, 3),
      scale: String(info.scale || '').slice(0, 24),
      sections: Math.max(1, Math.min(99, info.sections | 0 || 1)),
      layers: layers.map((l) => (l && /^#[0-9a-f]{6}$/i.test(l.color) ? l.color.toLowerCase() : '#6fa3ff')),
    };
    const regions = (Array.isArray(info.regions) ? info.regions : []).filter((t) => finite(t) && t > 0 && t < 1).map(r3);
    const okPt = (p) => Array.isArray(p) && finite(p[0]) && finite(p[1]);
    const okNote = (n) => Array.isArray(n) && finite(n[0]) && finite(n[1]) && finite(n[2]);
    const STEPS = [[80, 64, 48], [64, 48, 48], [48, 40, 40], [36, 32, 32], [28, 24, 32], [20, 16, 24], [14, 12, 16], [10, 8, 16], [7, 6, 12], [5, 4, 8], [3, 3, 0], [2, 2, 0]];
    for (const [per, notes, regs] of STEPS) {
      for (const maxStrokes of [16, 8, 4, 2]) {
        const meta = Object.assign({}, base, { preview: {
          r: regions.slice(0, regs),
          l: layers.map((l) => ({
            s: (Array.isArray(l && l.runs) ? l.runs : []).slice(0, maxStrokes)
              .map((run) => downsample((Array.isArray(run) ? run : []).filter(okPt), per).map((p) => [r3(p[0]), r1(p[1])]))
              .filter((run) => run.length),
            n: downsample((Array.isArray(l && l.notes) ? l.notes : []).filter(okNote), notes).map((n) => [r3(n[0]), r3(n[1]), r1(n[2])]),
          })),
        } });
        if (metaFits(meta, maxBytes)) return meta;
      }
    }
    return Object.assign({}, base, { preview: { r: [], l: [] } });
  }

  const pure = { PAGE, TITLE_MAX, AUTHOR_MAX, META_MAX, META_JSONB_MAX, cleanSearch, listPath, codePath, cleanRow, checkPublish, downsample, jsonbBytes, buildMeta, metaFits };
  if (typeof module === 'object' && module.exports) module.exports = pure;
  const doc = root.document;
  if (!doc || !VH.registerExperiment) { VH.gallery = pure; return; }

  // ===================== backend =====================
  const cfg = () => (VH.config && VH.config.gallery) || {};
  // fetch the REST API. Resolves the parsed JSON (or null); rejects with an Error carrying { status, code, kind }:
  // kind 'setup' (table not created yet), 'offline', 'busy' (rate limit), 'server'.
  async function request(path, o) {
    o = o || {};
    const c = cfg();
    if (!c.url || !c.key) { const e = new Error('The gallery isn’t configured.'); e.kind = 'setup'; throw e; }
    const headers = { apikey: c.key, Authorization: 'Bearer ' + c.key };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.prefer) headers.Prefer = o.prefer;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const tm = ac ? setTimeout(() => ac.abort(), 15000) : 0;
    let res;
    try {
      res = await root.fetch(c.url + path, { method: o.method || 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: ac ? ac.signal : undefined });
    } catch (err) {
      const e = new Error(root.navigator && root.navigator.onLine === false ? 'You seem to be offline.' : 'Couldn’t reach the gallery.');
      e.kind = 'offline'; throw e;
    } finally { clearTimeout(tm); }
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const code = data && data.code, msg = data && typeof data.message === 'string' ? data.message : '';
      const e = new Error('The gallery had a problem (' + res.status + ').');
      e.status = res.status; e.code = code; e.kind = 'server';
      if (code === 'PGRST205' || code === '42P01' || (res.status === 404 && !code)) { e.kind = 'setup'; e.message = 'The gallery is being set up.'; }
      else if (code === 'P0001' && msg) { e.kind = 'busy'; e.message = msg.slice(0, 160); }
      else if (code === '23514') e.message = 'The server didn’t accept this song (too long?).';
      throw e;
    }
    return data;
  }
  const api = {
    list: (o) => request(listPath(o)).then((rows) => (Array.isArray(rows) ? rows.map(cleanRow).filter(Boolean) : [])),
    code: (id) => request(codePath(id)).then((rows) => {
      const c = Array.isArray(rows) && rows[0] && rows[0].code;
      if (typeof c !== 'string' || !/^[zj][A-Za-z0-9_-]+$/.test(c)) { const e = new Error('That song is no longer available.'); e.kind = 'server'; throw e; }
      return c;
    }),
    post: (row) => request('/rest/v1/songs', { method: 'POST', body: row, prefer: 'return=representation' }).then((rows) => cleanRow(Array.isArray(rows) ? rows[0] : rows)),
    like: (id) => request('/rest/v1/rpc/like_song', { method: 'POST', body: { song_id: id } }),
    report: (id) => request('/rest/v1/rpc/report_song', { method: 'POST', body: { song_id: id } }),
  };

  // ---- this browser's marks (likes, reports, songs published here, nickname) ----
  const S = () => VH.store;
  const marks = (k) => { const v = S().get('gallery.' + k, []); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; };
  const hasMark = (k, id) => marks(k).includes(id);
  const addMark = (k, id) => { const v = marks(k); if (!v.includes(id)) { v.push(id); S().set('gallery.' + k, v.slice(-500)); } };
  const track = (n) => { try { if (VH.track) VH.track(n); } catch (_) { /* ignore */ } };

  // ===================== preview drawing =====================
  const TINTS = ['rgba(97, 26, 140, 0.16)', 'rgba(0, 191, 220, 0.07)'];
  function drawPreview(cv, meta) {
    const ui = VH.ui, k = ui.dpr(), w = Math.max(1, cv.clientWidth || 280), hh = Math.max(1, cv.clientHeight || 110);
    cv.width = Math.round(w * k); cv.height = Math.round(hh * k);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = '#080a28'; g.fillRect(0, 0, w, hh);
    const pv = meta && meta.preview && typeof meta.preview === 'object' ? meta.preview : {};
    const cols = Array.isArray(meta && meta.layers) ? meta.layers : [];
    const regs = [0].concat((Array.isArray(pv.r) ? pv.r : []).filter((t) => finite(t) && t > 0 && t < 1)).concat([1]);
    for (let i = 0; i + 1 < regs.length; i++) { g.fillStyle = TINTS[i % 2]; g.fillRect(regs[i] * w, 0, (regs[i + 1] - regs[i]) * w, hh); }
    g.strokeStyle = 'rgba(159, 255, 255, 0.08)'; g.lineWidth = 1;
    for (let i = 1; i + 1 < regs.length; i++) { const x = Math.round(regs[i] * w) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hh); g.stroke(); }
    const L = Array.isArray(pv.l) ? pv.l : [];
    let lo = Infinity, hi = -Infinity;
    const see = (m) => { if (finite(m)) { lo = Math.min(lo, m); hi = Math.max(hi, m); } };
    L.forEach((l) => {
      if (!l || typeof l !== 'object') return;
      (Array.isArray(l.s) ? l.s : []).forEach((run) => Array.isArray(run) && run.forEach((p) => Array.isArray(p) && see(p[1])));
      (Array.isArray(l.n) ? l.n : []).forEach((n) => Array.isArray(n) && see(n[2]));
    });
    if (!(hi >= lo)) {   // nothing drawn: a calm placeholder wave
      g.strokeStyle = 'rgba(111, 163, 255, 0.35)'; g.lineWidth = 1.5; g.beginPath();
      for (let x = 0; x <= w; x += 4) { const y = hh / 2 + Math.sin(x / 24) * hh * 0.12; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke(); return;
    }
    const mid = (lo + hi) / 2, span = Math.max(12, hi - lo + 4), pad = 8;
    const Y = (m) => pad + (1 - ((m - mid) / span + 0.5)) * (hh - 2 * pad);
    L.forEach((l, i) => {
      if (!l || typeof l !== 'object') return;
      const c = typeof cols[i] === 'string' && /^#[0-9a-f]{6}$/i.test(cols[i]) ? cols[i] : '#ffc93c';
      g.strokeStyle = c; g.fillStyle = c; g.lineWidth = 1.8; g.lineCap = 'round'; g.lineJoin = 'round';
      (Array.isArray(l.s) ? l.s : []).forEach((run) => {
        if (!Array.isArray(run)) return;
        const pts = run.filter((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));
        if (!pts.length) return;
        g.beginPath();
        pts.forEach((p, j) => { if (j) g.lineTo(p[0] * w, Y(p[1])); else g.moveTo(p[0] * w, Y(p[1])); });
        if (pts.length === 1) g.lineTo(pts[0][0] * w + 1, Y(pts[0][1]));
        g.stroke();
      });
      (Array.isArray(l.n) ? l.n : []).forEach((n) => {
        if (!Array.isArray(n) || !finite(n[0]) || !finite(n[1]) || !finite(n[2])) return;
        const x = n[0] * w, ww = Math.max(2, (n[1] - n[0]) * w - 1);
        g.fillRect(x, Y(n[2]) - 1.75, ww, 3.5);
      });
    });
  }

  // ===================== Melody -> song info (for meta) =====================
  function songInfo(M) {
    const md = VH.melody && VH.melody.model, S0 = M.song;
    if (!md || !S0) return {};
    const F = md.flatten(S0), tot = Math.max(1, (F.flat && F.flat.tot) || md.tot16(F));
    const keyName = (md.namesOf(S0) || [])[S0.key] || '';
    let scale = S0.mode || '';
    try { const lab = md.scaleLabel(S0); if (lab.indexOf(keyName + ' ') === 0) scale = lab.slice(keyName.length + 1); } catch (_) { /* id */ }
    return {
      bpm: S0.bpm, key: keyName, scale, sections: (S0.sections || []).length || 1,
      regions: (F.chords || []).map((e) => e.at / tot),
      layers: F.layers.map((l) => ({
        color: l.color,
        runs: md.lineRuns(l).map((r) => { const pts = []; for (let i = r.a; i <= r.b; i++) pts.push([i / (tot * 3), r.st.v[i]]); return pts; }),
        notes: (l.notes || []).map((n) => [n.s / tot, (n.s + n.d) / tot, n.m]),
      })),
    };
  }

  // ===================== Publish dialog (opened from Melody) =====================
  let publishing = null;
  function openPublish(M) {
    const ui = VH.ui;
    if (!ui.modal || !M) return null;
    if (publishing && publishing.back.isConnected) return publishing;
    track('gallery-publish-open');
    const dlg = ui.modal('gl-publish', 'Publish to gallery');
    publishing = dlg;
    const b = dlg.body;
    const field = (label, max, value, ph) => {
      const lab = ui.h('label', 'gl-field');
      const t = ui.h('span'); t.textContent = label;
      const inp = ui.h('input'); inp.type = 'text'; inp.maxLength = max; inp.value = value; inp.placeholder = ph; inp.autocomplete = 'off'; inp.spellcheck = false;
      const cnt = ui.h('small', 'gl-count');
      const upd = () => { cnt.textContent = inp.value.length + '/' + max; };
      inp.addEventListener('input', upd); upd();
      lab.append(t, inp, cnt); b.append(lab);
      return inp;
    };
    const tIn = field('Title', TITLE_MAX, '', 'Name your song');
    tIn.required = true; tIn.classList.add('gl-title-in');
    const nick = S().get('gallery.nick', '');
    const aIn = field('Nickname', AUTHOR_MAX, typeof nick === 'string' ? nick : '', 'Anonymous');
    aIn.classList.add('gl-author-in');
    let meta = null;
    try { meta = buildMeta(songInfo(M)); } catch (err) { console.error('[gallery] preview', err); meta = buildMeta({}); }
    const pc = ui.h('canvas', 'gl-prev gl-pub-prev'); pc.setAttribute('aria-label', 'Preview of your song'); pc.setAttribute('role', 'img');
    b.append(pc);
    const note = ui.h('p', 'vh-desc gl-pub-note');
    note.textContent = 'Your song will be public. Don’t include personal info. Imported or Babel sounds play as the closest built-in for others.';
    const err = ui.h('p', 'gl-err'); err.setAttribute('role', 'alert'); err.hidden = true;
    b.append(note, err);
    const cancel = ui.h('button', 'vh-btn'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const go = ui.h('button', 'vh-btn gl-primary gl-pub-go'); go.type = 'button'; go.textContent = 'Publish';
    dlg.foot.append(cancel, go);
    cancel.addEventListener('click', () => dlg.close());
    const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };
    let busy = false;
    async function submit() {
      if (busy) return;
      const v = checkPublish(tIn.value, aIn.value);
      if (v.error) { showErr(v.error); (v.error.indexOf('nickname') >= 0 ? aIn : tIn).focus(); return; }
      showErr('');
      S().set('gallery.nick', aIn.value.trim());
      busy = true; go.disabled = true; go.textContent = 'Publishing…';
      try {
        const code = await (M.shareCode ? M.shareCode() : VH.store.encodeShare(JSON.parse(VH.melody.song())));
        if (typeof code !== 'string' || code.length > 60000) throw Object.assign(new Error('This song is too long for the gallery. Try fewer sections or layers.'), { kind: 'local' });
        const row = await api.post({ title: v.title, author: v.author, code, meta });
        if (row) addMark('mine', row.id);
        track('gallery-publish');
        dlg.close();
        const msg = 'Published “' + v.title + '” to the gallery';
        if (M.ui && M.ui.toast) M.ui.toast(msg, { action: { label: 'View in gallery', run: () => { root.location.hash = '#gallery'; } } });
      } catch (e) {
        showErr(e.kind === 'setup' ? 'The gallery is being set up. Please try again a little later.'
          : e.kind === 'offline' ? 'Couldn’t reach the gallery. Check your connection and try again.'
            : e.message || 'Something went wrong. Please try again.');
      } finally {
        busy = false;
        if (go.isConnected) { go.disabled = false; go.textContent = 'Publish'; }
      }
    }
    go.addEventListener('click', submit);
    [tIn, aIn].forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }));
    dlg.onClose = () => { if (publishing === dlg) publishing = null; };
    dlg.meta = meta;
    requestAnimationFrame(() => { drawPreview(pc, meta); tIn.focus(); });
    return dlg;
  }

  // ===================== Gallery tab =====================
  let G = null;   // mounted state
  const rel = (t) => {
    if (!t) return '';
    const s = (t - Date.now()) / 1000, a = Math.abs(s);
    const U = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400], [2629800, 'week', 604800], [31557600, 'month', 2629800], [Infinity, 'year', 31557600]];
    const u = U.find((x) => a < x[0]);
    if (a < 45) return 'just now';
    try { return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(s / u[2]), u[1]); } catch (_) { return new Date(t).toLocaleDateString(); }
  };

  function mount(el) {
    const ui = VH.ui, h = ui.h;
    const wrap = h('div', 'gl-wrap');
    const head = h('div', 'gl-head');
    const h1 = h('h1'); h1.textContent = 'Gallery';
    const sub = h('p'); sub.textContent = 'Songs made in Melody by people everywhere. Open one, remix it, publish your own from Melody › Share.';
    const ctl = h('div', 'gl-ctl');
    const sortBox = h('div', 'gl-sort'); sortBox.setAttribute('role', 'group'); sortBox.setAttribute('aria-label', 'Sort');
    const sortBtn = {};
    [['new', 'New'], ['top', 'Top']].forEach(([id, label]) => {
      const b = h('button', 'vh-btn'); b.type = 'button'; b.textContent = label; b.dataset.sort = id;
      b.addEventListener('click', () => { if (st.sort !== id) { st.sort = id; S().set('gallery.sort', id); syncSort(); load(true); } });
      sortBox.append(b); sortBtn[id] = b;
    });
    const search = h('input', 'gl-search'); search.type = 'search'; search.placeholder = 'Search titles and names'; search.maxLength = TITLE_MAX;
    search.setAttribute('aria-label', 'Search songs');
    ctl.append(sortBox, search);
    head.append(h1, sub, ctl);
    const grid = h('div', 'gl-grid'); grid.setAttribute('aria-live', 'polite');
    const status = h('div', 'gl-status'); status.hidden = true;
    const more = h('button', 'vh-btn gl-more-btn'); more.type = 'button'; more.textContent = 'Load more'; more.hidden = true;
    wrap.append(head, grid, status, more);
    el.append(wrap);

    const st = { sort: S().get('gallery.sort', 'new') === 'top' ? 'top' : 'new', q: '', offset: 0, seq: 0, rows: [], busy: false, timers: new Set() };
    const syncSort = () => { for (const k in sortBtn) sortBtn[k].setAttribute('aria-pressed', String(k === st.sort)); };
    syncSort();
    const later = (f, ms) => { const t = setTimeout(() => { st.timers.delete(t); f(); }, ms); st.timers.add(t); return t; };
    let searchT = 0;
    search.addEventListener('input', () => {
      clearTimeout(searchT); st.timers.delete(searchT);
      searchT = later(() => { const q = cleanSearch(search.value); if (q !== st.q) { st.q = q; load(true); } }, 300);
    });
    more.addEventListener('click', () => load(false));
    const onResize = () => { grid.querySelectorAll('canvas.gl-prev').forEach((c) => drawPreview(c, c._meta)); };
    let rzT = 0;
    const onWin = () => { clearTimeout(rzT); rzT = setTimeout(onResize, 120); };
    root.addEventListener('resize', onWin);
    const onOnline = () => { if (G && st.lastErr === 'offline') load(true); };
    root.addEventListener('online', onOnline);
    const onDocDown = (e) => { grid.querySelectorAll('.gl-menu:not([hidden])').forEach((m) => { if (!m.parentNode.contains(e.target)) m.hidden = true; }); };
    doc.addEventListener('pointerdown', onDocDown);

    function setStatus(kind, title, text, retry) {
      status.textContent = '';
      status.hidden = !kind; status.className = 'gl-status' + (kind ? ' gl-' + kind : '');
      if (!kind) return;
      const b = h('b'); b.textContent = title;
      const p = h('p'); p.textContent = text;
      status.append(b, p);
      if (retry) { const r = h('button', 'vh-btn'); r.type = 'button'; r.textContent = 'Try again'; r.addEventListener('click', () => load(true)); status.append(r); }
    }
    function skeletons(n) {
      for (let i = 0; i < n; i++) { const s = h('div', 'gl-card gl-skel'); s.setAttribute('aria-hidden', 'true'); s.append(h('div', 'gl-skel-art'), h('div', 'gl-skel-line'), h('div', 'gl-skel-line short')); grid.append(s); }
    }
    async function load(reset) {
      const my = ++st.seq;
      if (reset) { st.offset = 0; st.rows = []; grid.textContent = ''; }
      setStatus(null);
      more.hidden = true;
      skeletons(reset ? 6 : 3);
      grid.setAttribute('aria-busy', 'true');
      let rows, error = null;
      try { rows = await api.list({ sort: st.sort, q: st.q, offset: st.offset, limit: PAGE }); } catch (e) { error = e; }
      if (!G || my !== st.seq) return;
      grid.querySelectorAll('.gl-skel').forEach((n) => n.remove());
      grid.removeAttribute('aria-busy');
      st.lastErr = error ? error.kind : '';
      if (error) {
        if (error.kind === 'setup') setStatus('setup', 'Gallery is being set up', 'The community gallery opens very soon. Check back in a little while.', true);
        else if (error.kind === 'offline') setStatus('offline', 'You’re offline', 'The gallery needs a connection. Your own songs in Melody still work.', true);
        else setStatus('error', 'Couldn’t load the gallery', error.message || 'Something went wrong.', true);
        return;
      }
      const seen = new Set(st.rows.map((r) => r.id));
      const fresh = rows.filter((r) => !seen.has(r.id) && !hasMark('reported', r.id));
      st.rows.push(...fresh);
      st.offset += rows.length;   // server rows, so paging stays aligned even when some are skipped
      fresh.forEach((r) => grid.append(card(r)));
      requestAnimationFrame(() => fresh.forEach((r) => { const c = grid.querySelector('[data-id="' + r.id + '"] canvas'); if (c) drawPreview(c, r.meta); }));
      more.hidden = rows.length < PAGE;
      if (!st.rows.length) setStatus('empty', st.q ? 'No songs match “' + st.q + '”' : 'No songs yet', st.q ? 'Try another word.' : 'Be the first: make something in Melody, then Share › Publish to gallery.', false);
    }

    function chip(parent, text, title) { const c = h('span', 'gl-chip'); c.textContent = text; if (title) c.title = title; parent.append(c); }
    function card(r) {
      const m = r.meta, c = h('article', 'gl-card'); c.dataset.id = r.id;
      const cv = h('canvas', 'gl-prev'); cv._meta = m; cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Melody preview');
      const body = h('div', 'gl-body');
      const tl = h('div', 'gl-title-row');
      const t = h('h3', 'gl-title'); t.textContent = r.title; t.title = r.title;
      tl.append(t);
      if (hasMark('mine', r.id)) { const y = h('span', 'gl-yours'); y.textContent = 'yours'; tl.append(y); }
      const by = h('div', 'gl-by');
      const a = h('span', 'gl-author'); a.textContent = 'by ' + r.author;
      const d = h('time'); d.textContent = rel(r.created); if (r.created) { d.dateTime = new Date(r.created).toISOString(); d.title = new Date(r.created).toLocaleString(); }
      by.append(a, d);
      const chips = h('div', 'gl-chips');
      if (finite(m.bpm) && m.bpm > 0) chip(chips, Math.round(m.bpm) + ' BPM');
      const key = typeof m.key === 'string' ? m.key.slice(0, 3) : '', sc = typeof m.scale === 'string' ? m.scale.slice(0, 24) : '';
      if (key || sc) chip(chips, (key + ' ' + sc).trim());
      if (finite(m.sections) && m.sections > 0) chip(chips, (m.sections | 0) + (m.sections === 1 ? ' section' : ' sections'));
      const act = h('div', 'gl-actions');
      const like = h('button', 'gl-like'); like.type = 'button';
      const syncLike = () => {
        const on = hasMark('liked', r.id);
        like.textContent = '♥ ' + r.likes; like.setAttribute('aria-pressed', String(on)); like.disabled = on;
        like.setAttribute('aria-label', (on ? 'You liked this · ' : 'Like · ') + r.likes + ' likes');
      };
      syncLike();
      like.addEventListener('click', async () => {
        if (hasMark('liked', r.id)) return;
        addMark('liked', r.id); r.likes++; syncLike();
        try { await api.like(r.id); } catch (e) {
          r.likes = Math.max(0, r.likes - 1);
          S().set('gallery.liked', marks('liked').filter((x) => x !== r.id)); syncLike();
          flash(c, e.kind === 'offline' ? 'Offline: like not sent' : 'Couldn’t send the like');
        }
      });
      const open = h('button', 'vh-btn gl-primary gl-open'); open.type = 'button'; open.textContent = 'Open in Melody';
      open.addEventListener('click', () => openSong(r, open, c));
      const mw = h('div', 'gl-menu-wrap');
      const mb = h('button', 'gl-dots'); mb.type = 'button'; mb.textContent = '⋯'; mb.setAttribute('aria-label', 'More'); mb.setAttribute('aria-haspopup', 'menu');
      const menu = h('div', 'gl-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
      const rep = h('button', 'gl-report'); rep.type = 'button'; rep.setAttribute('role', 'menuitem');
      const syncRep = () => { const on = hasMark('reported', r.id); rep.textContent = on ? 'Reported' : 'Report…'; rep.disabled = on; };
      syncRep();
      menu.append(rep); mw.append(mb, menu);
      mb.addEventListener('click', () => { menu.hidden = !menu.hidden; if (!menu.hidden) rep.focus(); });
      rep.addEventListener('click', () => { menu.hidden = true; confirmReport(r, c); });
      act.append(like, open, mw);
      body.append(tl, by, chips, act);
      c.append(cv, body);
      return c;
    }
    function flash(c, msg) {
      let f = c.querySelector('.gl-flash');
      if (!f) { f = h('div', 'gl-flash'); f.setAttribute('role', 'status'); c.querySelector('.gl-body').append(f); }
      f.textContent = msg;
      later(() => f.remove(), 3500);
    }
    function confirmReport(r, c) {
      if (hasMark('reported', r.id) || c.querySelector('.gl-confirm')) return;
      const box = h('div', 'gl-confirm'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', 'Report this song');
      const p = h('p'); p.textContent = 'Report this song as inappropriate? After a few reports it is hidden for review.';
      const row = h('div', 'gl-confirm-row');
      const no = h('button', 'vh-btn'); no.type = 'button'; no.textContent = 'Cancel';
      const yes = h('button', 'vh-btn gl-danger'); yes.type = 'button'; yes.textContent = 'Report';
      row.append(no, yes); box.append(p, row);
      c.querySelector('.gl-body').append(box);
      yes.focus();
      no.addEventListener('click', () => box.remove());
      yes.addEventListener('click', async () => {
        yes.disabled = no.disabled = true;
        try {
          await api.report(r.id);
          addMark('reported', r.id);
          box.remove();
          c.classList.add('gl-reported');
          const rb = c.querySelector('.gl-report'); if (rb) { rb.textContent = 'Reported'; rb.disabled = true; }
          flash(c, 'Thanks, reported. It’s hidden for you.');
        } catch (e) {
          box.remove();
          flash(c, e.kind === 'offline' ? 'Offline: report not sent' : 'Couldn’t send the report');
        }
      });
    }
    async function openSong(r, btn, c) {
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = 'Opening…';
      try {
        const code = await api.code(r.id);
        const inbox = VH.store.get('melody.inbox', []);
        const items = Array.isArray(inbox) ? inbox : [];
        items.push({ type: 'song', code, title: r.title, author: r.author, from: 'gallery' });
        VH.store.set('melody.inbox', items);
        track('gallery-open');
        root.location.hash = '#melody';
      } catch (e) {
        if (!G) return;
        btn.disabled = false; btn.textContent = 'Open in Melody';
        flash(c, e.kind === 'offline' ? 'Couldn’t reach the gallery' : e.message || 'Couldn’t open this song');
      }
    }

    G = { st, el, cleanup() {
      st.seq++;
      st.timers.forEach((t) => clearTimeout(t)); st.timers.clear(); clearTimeout(rzT);
      root.removeEventListener('resize', onWin); root.removeEventListener('online', onOnline); doc.removeEventListener('pointerdown', onDocDown);
    } };
    if (root.navigator && root.navigator.onLine === false) { st.lastErr = 'offline'; setStatus('offline', 'You’re offline', 'The gallery needs a connection. Your own songs in Melody still work.', true); }
    else load(true);
  }

  VH.registerExperiment({
    id: 'gallery', title: 'Gallery', icon: '▦',
    hint: '',
    mount(el) { mount(el); },
    unmount() { if (G) { G.cleanup(); G = null; } if (publishing) publishing.close(); },
  });
  VH.gallery = Object.assign({}, pure, { api, request, openPublish, songInfo, drawPreview, get state() { return G && G.st; } });
})(typeof window !== 'undefined' ? window : globalThis);
