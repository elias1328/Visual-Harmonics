// otest.js - browser checks for the community Gallery (run over http with a CDP browser).
//   python -m http.server 8951            (repo root)
//   msedge --headless=new --remote-debugging-port=9551 --autoplay-policy=no-user-gesture-required about:blank
//   VH_BROWSER=1 node test/otest.js        (optional: VH_URL, VH_CDP, VH_SHOT=path.png, VH_REAL=1 for one real backend round trip)
// The gallery backend is mocked (fetch is intercepted) except in the VH_REAL round trip. Under plain `node --test` it is skipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const URL0 = process.env.VH_URL || 'http://localhost:8951/';
const CDP = process.env.VH_CDP || 'http://127.0.0.1:9551';

// Installed before every page load: a fake PostgREST for the gallery URL (sessionStorage 'glmock' turns it on).
const MOCK = `(() => {
  if (!sessionStorage.getItem('glmock')) return;
  const real = window.fetch.bind(window), BASE = 'https://ctbqbqpawtxtxhltpfnc.supabase.co';
  const db = window.__glDB = { rows: [], reqs: [], mode: '' };
  const json = (st, o) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init) => {
    url = String(url); init = init || {};
    if (!url.startsWith(BASE)) return real(url, init);
    const u = new URL(url), m = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    db.reqs.push({ path: u.pathname + u.search, method: m, body, prefer: init.headers && init.headers.Prefer, key: init.headers && init.headers.apikey });
    await new Promise((r) => setTimeout(r, 20));
    if (db.mode === 'setup') return json(404, { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public.songs' in the schema cache" });
    if (db.mode === 'error') return json(500, { code: 'XX000', message: 'boom' });
    if (db.mode === 'offline') throw new TypeError('Failed to fetch');
    if (u.pathname === '/rest/v1/songs' && m === 'GET') {
      const id = u.searchParams.get('id');
      if (id) { const r = db.rows.find((x) => 'eq.' + x.id === id && !x.hidden); return json(200, r ? [{ code: r.code }] : []); }
      let rows = db.rows.filter((r) => !r.hidden);
      const or = u.searchParams.get('or');
      if (or) {   // ilike."*a*b*" -> /a.*b/
        const re = new RegExp(/ilike\\."\\*(.*?)\\*"/.exec(or)[1].toLowerCase().split('*').map((x) => x.replace(/[.?+^$|{}()[\\]\\\\]/g, '\\\\$&')).join('.*'));
        rows = rows.filter((r) => re.test(String(r.title).toLowerCase()) || re.test(String(r.author).toLowerCase()));
      }
      const ord = u.searchParams.get('order');
      rows.sort(ord.startsWith('likes') ? (a, b) => b.likes - a.likes || (b.created_at < a.created_at ? -1 : 1) : (a, b) => (b.created_at < a.created_at ? -1 : 1));
      const off = +u.searchParams.get('offset'), lim = +u.searchParams.get('limit');
      return json(200, rows.slice(off, off + lim).map((r) => ({ id: r.id, created_at: r.created_at, title: r.title, author: r.author, meta: r.meta, likes: r.likes })));
    }
    if (u.pathname === '/rest/v1/songs' && m === 'POST') {
      if (db.mode === 'busy') return json(400, { code: 'P0001', details: null, hint: null, message: 'The gallery is busy, please try again in a few minutes.' });
      const r = Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString(), likes: 0, reports: 0, hidden: false }, body);
      db.rows.push(r);
      return json(201, [{ id: r.id, created_at: r.created_at, title: r.title, author: r.author, code: r.code, meta: r.meta, likes: 0, reports: 0, hidden: false }]);
    }
    const rpc = /^\\/rest\\/v1\\/rpc\\/(like_song|report_song)$/.exec(u.pathname);
    if (rpc && m === 'POST') {
      const r = db.rows.find((x) => x.id === body.song_id);
      if (r && rpc[1] === 'like_song' && !r.hidden) r.likes++;
      if (r && rpc[1] === 'report_song') { r.reports = (r.reports || 0) + 1; r.hidden = r.reports >= 3; }
      return new Response(null, { status: 204 });
    }
    return json(404, { code: 'PGRST000', message: 'no route' });
  };
})();`;

if (!process.env.VH_BROWSER) {
  test('otest (browser): set VH_BROWSER=1 with the server and a CDP browser running', { skip: true }, () => {});
} else {
  let ws, seq = 0;
  const pending = new Map(), errors = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  });
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: '(async () => {' + expr + '})()', awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(expr, ms = 5000) {
    for (let t = 0; t < ms; t += 50) { if (await ev('return !!(' + expr + ')')) return true; await wait(50); }
    throw new Error('timed out waiting for: ' + expr);
  }
  async function go(hash, mock) {
    await ev(mock ? 'sessionStorage.setItem("glmock", "1"); return 1' : 'sessionStorage.removeItem("glmock"); return 1');
    await send('Page.navigate', { url: URL0 + '?ot=' + Date.now() + '#melody' });
    for (let i = 0; i < 100; i++) { await wait(100); try { if (await ev('return !!(window.VH && VH.app && VH.app.current === "melody" && VH.melody.ctx)')) break; } catch (_) { /* loading */ } }
    await ev('await VH.sounds.ready; return 1');
    await ev('document.querySelectorAll(".vh-modal-back, .mx-onb, .vh-sheet").forEach((n) => n.remove()); return 1');
    if (hash !== 'melody') await ev('location.hash = "#' + hash + '"; return 1');
  }
  async function key(k, mods) {
    const code = 'Key' + k.toUpperCase(), vk = k.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk });
  }
  const click = (sel) => ev('const n = ' + sel + '; if (!n) throw new Error("no element: ' + sel.replace(/"/g, '\\"') + '"); n.click(); return 1');
  const reqs = () => ev('return window.__glDB.reqs');
  const cards = () => ev('return document.querySelectorAll(".gl-card:not(.gl-skel)").length');

  test('browser: community gallery', { timeout: 300000 }, async (t) => {
    const list = await (await fetch(CDP + '/json/list')).json();
    let page = list.find((p) => p.type === 'page');
    if (!page) page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.rej(new Error(d.error.message)); else p.res(d.result); return; }
      if (d.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || d.params.exceptionDetails.text));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console: ' + d.params.args.map((a) => a.value || a.description).join(' '));
      if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
    };
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
    await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
    // fresh browser state for this origin
    await send('Page.navigate', { url: URL0 + '?ot=0#lab' }); await wait(800);
    await ev('localStorage.clear(); sessionStorage.clear(); localStorage.setItem("vh:melody.tutorial", JSON.stringify("done")); return 1');

    t.after(() => { try { ws.close(); } catch (_) { /* closed */ } });
    await t.test('tab strip: Gallery between Spiral and Archive', async () => {
      await go('melody', true);
      const tabs = await ev('return [...document.querySelectorAll("#tabs .vh-tab")].map((a) => a.textContent + "=" + a.getAttribute("href"))');
      const i = tabs.indexOf('Gallery=#gallery');
      assert.ok(i > 0, tabs.join(','));
      assert.strictEqual(tabs[i - 1], 'Spiral=#spiral');
      assert.strictEqual(tabs[i + 1], 'Archive=#lab');
    });

    // seed the mock: 30 songs; #3 has a distinct song (bpm 77) for the Open test, #5 an XSS title, plus 2 malformed rows
    const base = await ev(`await new Promise((r) => setTimeout(r, 300));
      const M = VH.melody.ctx, G = VH.gallery;
      M.song.bpm = 96; M.commit('test bpm');
      const orig = JSON.parse(VH.melody.song());
      const other = JSON.parse(JSON.stringify(orig)); other.bpm = 77;
      const codeOther = await VH.store.encodeShare(other);
      const real = G.buildMeta(G.songInfo(M));   // the shown song (may be empty) + a drawn synthetic preview
      const meta = G.buildMeta(Object.assign({}, G.songInfo(M), { regions: [0.25, 0.5, 0.75], layers: [0, 1].map((L) => ({ color: ['#ffc93c', '#ff6fa3'][L],
        runs: [Array.from({ length: 200 }, (_, i) => [i / 200, 62 + L * 5 + 4 * Math.sin(i / 15)])], notes: [[0.1, 0.2, 60], [0.5, 0.7, 67]] })) }));
      if (real.bpm !== meta.bpm) throw new Error('meta mismatch');
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push({ id: crypto.randomUUID(), created_at: new Date(Date.now() - i * 3600e3 * 7).toISOString(),
        title: i === 5 ? '<script>window.__xss=1<\\/script><img src=x onerror=__xss=2>' : 'Song ' + i + (i === 7 ? ' moonlight' : ''),
        author: i === 9 ? '<b>Bold</b>' : 'Tester' + (i % 4), code: i === 3 ? codeOther : await M.shareCode(), meta: i === 2 ? { junk: true } : meta, likes: (i * 7) % 11 });
      rows.push({ id: 'not-a-uuid', created_at: new Date(Date.now() - 400 * 864e5).toISOString(), title: 'bad', author: 'x', code: 'jx', meta: {}, likes: 0 });
      rows.push({ id: crypto.randomUUID(), created_at: new Date(Date.now() - 401 * 864e5).toISOString(), title: '', author: 'x', code: 'jx', meta: {}, likes: 0 });
      window.__glDB.rows = rows;
      window.confirm = () => { window.__usedConfirm = true; return true; };
      return { bpm: M.song.bpm, ids: rows.map((r) => r.id) };`);
    const ids = base.ids;

    await t.test('grid: 24 cards with drawn previews, load more appends, malformed rows skipped', async () => {
      await ev('location.hash = "#gallery"; return 1');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length >= 24');
      assert.strictEqual(await cards(), 24);
      const r = await reqs();
      assert.match(r[r.length - 1].path, /order=created_at\.desc&limit=24&offset=0$/);
      assert.ok(r[r.length - 1].key, 'apikey header');
      await wait(150);
      const lit = await ev(`return [...document.querySelectorAll(".gl-card canvas.gl-prev")].slice(0, 24).map((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 120 || d[i + 1] > 120) n++;
        return n; })`);
      assert.strictEqual(lit.length, 24);
      assert.ok(lit.filter((n) => n > 30).length >= 22, 'previews drawn: ' + lit.join(','));
      const chips = await ev('return [...document.querySelector(".gl-card .gl-chips").children].map((c) => c.textContent)');
      assert.ok(chips.some((c) => /^96 BPM$/.test(c)) && chips.some((c) => /section/.test(c)), chips.join('|'));
      assert.ok(await ev('return !document.querySelector(".gl-more-btn").hidden'));
      await click('document.querySelector(".gl-more-btn")');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length > 24');
      await wait(100);
      assert.strictEqual(await cards(), 30);   // 32 rows sent, the 2 malformed ones skipped
      const last = (await reqs()).pop();
      assert.match(last.path, /offset=24$/);
      assert.ok(await ev('return document.querySelector(".gl-more-btn").hidden'), 'no more pages');
      assert.strictEqual(await ev('return document.querySelectorAll(".gl-card[data-id=\\"not-a-uuid\\"]").length'), 0);
    });

    await t.test('XSS: script titles and authors render inert text', async () => {
      const r = await ev(`const c = document.querySelector('.gl-card[data-id="${ids[5]}"]'), a = document.querySelector('.gl-card[data-id="${ids[9]}"] .gl-author');
        return { t: c.querySelector('.gl-title').textContent, scripts: c.querySelectorAll('script, img').length, a: a.textContent, b: a.querySelectorAll('b').length, x: window.__xss };`);
      assert.match(r.t, /^<script>window.__xss=1<\/script><img/);
      assert.strictEqual(r.scripts, 0); assert.strictEqual(r.b, 0); assert.strictEqual(r.a, 'by <b>Bold</b>');
      assert.strictEqual(r.x, undefined);
    });

    await t.test('search (debounced, encoded) and sort', async () => {
      const n0 = (await reqs()).length;
      await ev(`const s = document.querySelector('.gl-search');
        for (const v of ['m', 'mo', 'moon']) { s.value = v; s.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 60)); } return 1`);
      await wait(200);
      assert.strictEqual((await reqs()).length, n0, 'debounced: nothing before 300 ms');
      await until('window.__glDB.reqs.length > ' + n0);
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length === 1');
      const r = await reqs();
      assert.strictEqual(r.length, n0 + 1, 'one request for three keystrokes');
      assert.match(r[n0].path, /&or=%28title\.ilike\.%22%2Amoon%2A%22%2Cauthor\.ilike\.%22%2Amoon%2A%22%29$/);
      assert.match(await ev('return document.querySelector(".gl-card .gl-title").textContent'), /moonlight/);
      await ev(`const s = document.querySelector('.gl-search'); s.value = 'zzzz'; s.dispatchEvent(new Event('input')); return 1`);
      await until('document.querySelector(".gl-status.gl-empty") && !document.querySelector(".gl-status").hidden');
      assert.match(await ev('return document.querySelector(".gl-status").textContent'), /No songs match “zzzz”/);
      await ev(`const s = document.querySelector('.gl-search'); s.value = ''; s.dispatchEvent(new Event('input')); return 1`);
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length === 24');
      await click('document.querySelector(".gl-sort [data-sort=top]")');
      await until('window.__glDB.reqs[window.__glDB.reqs.length - 1].path.includes("order=likes.desc")');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length === 24');
      const likes = await ev('return [...document.querySelectorAll(".gl-like")].map((b) => +b.textContent.replace(/\\D/g, ""))');
      assert.deepStrictEqual(likes, likes.slice().sort((a, b) => b - a));
      assert.strictEqual(await ev('return document.querySelector(".gl-sort [data-sort=top]").getAttribute("aria-pressed")'), 'true');
      await click('document.querySelector(".gl-sort [data-sort=new]")');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length === 24 && window.__glDB.reqs[window.__glDB.reqs.length - 1].path.includes("created_at.desc")');
    });

    await t.test('like once per song per browser', async () => {
      const id = ids[1], sel = `document.querySelector('.gl-card[data-id="${id}"] .gl-like')`;
      const before = await ev('return ' + sel + '.textContent');
      await click(sel); await wait(150); await click(sel); await wait(150);
      const likeReqs = (await reqs()).filter((r) => r.path === '/rest/v1/rpc/like_song');
      assert.strictEqual(likeReqs.length, 1);
      assert.deepStrictEqual(likeReqs[0].body, { song_id: id });
      const after = await ev('return ' + sel + '.textContent');
      assert.strictEqual(+after.replace(/\D/g, ''), +before.replace(/\D/g, '') + 1);
      // still liked after a remount
      await ev('location.hash = "#lab"; return 1'); await wait(100); await ev('location.hash = "#gallery"; return 1');
      await until(sel + ' && ' + sel + '.getAttribute("aria-pressed") === "true" && ' + sel + '.disabled');
    });

    await t.test('report: in-UI confirmation, once per song', async () => {
      const id = ids[4], c = `document.querySelector('.gl-card[data-id="${id}"]')`;
      await click(c + '.querySelector(".gl-dots")');
      assert.ok(await ev('return !' + c + '.querySelector(".gl-menu").hidden'));
      await click(c + '.querySelector(".gl-report")');
      await until(c + '.querySelector(".gl-confirm")');
      await click(c + '.querySelector(".gl-confirm .vh-btn:not(.gl-danger)")');   // Cancel
      assert.strictEqual((await reqs()).filter((r) => r.path.includes('report_song')).length, 0);
      await click(c + '.querySelector(".gl-dots")'); await click(c + '.querySelector(".gl-report")');
      await click(c + '.querySelector(".gl-confirm .gl-danger")');
      await until(c + '.classList.contains("gl-reported")');
      assert.ok(await ev('return ' + c + '.querySelector(".gl-report").disabled'));
      await click(c + '.querySelector(".gl-report")');
      await wait(100);
      assert.strictEqual(await ev('return !!' + c + '.querySelector(".gl-confirm")'), false);
      const rr = (await reqs()).filter((r) => r.path.includes('report_song'));
      assert.strictEqual(rr.length, 1);
      assert.deepStrictEqual(rr[0].body, { song_id: id });
      assert.strictEqual(await ev('return window.__usedConfirm'), undefined, 'confirm() never used');
      // a reported song is hidden for this browser after a reload of the list
      await ev('location.hash = "#lab"; return 1'); await wait(100); await ev('location.hash = "#gallery"; return 1');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length >= 23');
      assert.strictEqual(await ev('return !!' + c), false);
    });

    await t.test('Open in Melody loads the song as an undo step; Ctrl+Z restores', async () => {
      await click(`document.querySelector('.gl-card[data-id="${ids[3]}"] .gl-open')`);
      await until('VH.app.current === "melody" && VH.melody.ctx && VH.melody.ctx.song.bpm === 77', 6000);
      const r = (await reqs()).pop();
      assert.strictEqual(r.path, '/rest/v1/songs?id=eq.' + ids[3] + '&select=code');
      await until('document.querySelector(".mel-toast.on")');
      assert.strictEqual(await ev('return document.querySelector(".mel-toast .t").textContent'), 'Opened “Song 3” by Tester3 (Ctrl+Z to go back)');
      assert.match(await ev('return VH.melody.hist.past[VH.melody.hist.past.length - 1].label'), /Open “Song 3”/);
      await ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(); return 1');
      await key('z', 2);
      await until('VH.melody.ctx.song.bpm === ' + base.bpm);
    });

    await t.test('publish dialog: validation, payload, toast, yours badge', async () => {
      await ev('VH.melody.ctx.ui.openPanel("export"); return 1');
      await until('document.querySelector(".mel-publish")');
      await click('document.querySelector(".mel-publish")');
      await until('document.querySelector(".gl-publish")');
      const n0 = (await reqs()).length;
      const txt = await ev('return document.querySelector(".gl-publish").textContent');
      assert.match(txt, /Your song will be public\. Don’t include personal info\. Imported or Babel sounds play as the closest built-in for others\./);
      assert.strictEqual(await ev('return document.querySelector(".gl-title-in").maxLength'), 60);
      assert.strictEqual(await ev('return document.querySelector(".gl-author-in").maxLength'), 30);
      await click('document.querySelector(".gl-pub-go")');
      await wait(100);
      assert.ok(await ev('return !document.querySelector(".gl-err").hidden'), 'error shown for empty title');
      assert.strictEqual((await reqs()).length, n0, 'nothing posted');
      // the server's rate limit message is shown
      await ev(`window.__glDB.mode = 'busy'; const t = document.querySelector('.gl-title-in'); t.value = 'x'; document.querySelector('.gl-pub-go').click(); return 1`);
      await until('document.querySelector(".gl-err").textContent.includes("busy")');
      await ev('window.__glDB.mode = ""; return 1');
      await ev(`document.querySelector('.gl-title-in').value = '  My <b>tune</b> '; document.querySelector('.gl-author-in').value = 'Eli'; document.querySelector('.gl-pub-go').click(); return 1`);
      await until('!document.querySelector(".gl-publish")');
      const post = (await reqs()).filter((r) => r.method === 'POST' && r.path === '/rest/v1/songs').pop();
      const code = await ev('return await VH.melody.ctx.shareCode()');
      assert.strictEqual(post.prefer, 'return=representation');
      assert.deepStrictEqual(Object.keys(post.body).sort(), ['author', 'code', 'meta', 'title']);
      assert.strictEqual(post.body.title, 'My <b>tune</b>');
      assert.strictEqual(post.body.author, 'Eli');
      assert.strictEqual(post.body.code, code);
      const m = post.body.meta;
      assert.strictEqual(m.bpm, 96);
      assert.ok(typeof m.key === 'string' && m.key && typeof m.scale === 'string' && m.scale, JSON.stringify([m.key, m.scale]));
      assert.ok(m.sections >= 1 && Array.isArray(m.layers) && m.layers.every((c) => /^#[0-9a-f]{6}$/.test(c)));
      assert.ok(Array.isArray(m.preview.l) && Array.isArray(m.preview.r));
      assert.ok(JSON.stringify(m).length <= 3500);
      assert.strictEqual(await ev('return VH.store.get("gallery.nick")'), 'Eli');
      await until('document.querySelector(".mel-toast.on .a") && document.querySelector(".mel-toast .a").textContent === "View in gallery"');
      await click('document.querySelector(".mel-toast .a")');
      await until('VH.app.current === "gallery" && document.querySelector(".gl-card .gl-yours")');
      const top = await ev('return { t: document.querySelector(".gl-card .gl-title").textContent, y: !!document.querySelector(".gl-card .gl-yours"), b: document.querySelectorAll(".gl-card .gl-title b").length }');
      assert.deepStrictEqual(top, { t: 'My <b>tune</b>', y: true, b: 0 });
    });

    await t.test('states: setup, offline, error (with retry)', async () => {
      for (const [mode, cls, txt] of [['setup', 'gl-setup', 'Gallery is being set up'], ['offline', 'gl-offline', 'offline'], ['error', 'gl-error', 'Couldn’t load the gallery']]) {
        await ev(`window.__glDB.mode = '${mode}'; location.hash = '#lab'; return 1`); await wait(80); await ev('location.hash = "#gallery"; return 1');
        await until(`document.querySelector('.gl-status.${cls}') && !document.querySelector('.gl-status').hidden`);
        assert.ok((await ev('return document.querySelector(".gl-status").textContent')).includes(txt), mode);
        assert.strictEqual(await cards(), 0);
      }
      await ev('window.__glDB.mode = ""; return 1');
      await click('document.querySelector(".gl-status button")');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length >= 23');   // one reported song is skipped
    });

    await t.test('skeletons while loading', async () => {
      await ev(`const f = window.fetch; window.fetch = async (...a) => { await new Promise((r) => setTimeout(r, 400)); return f(...a); };
        location.hash = '#lab'; await new Promise((r) => setTimeout(r, 50)); location.hash = '#gallery'; await new Promise((r) => setTimeout(r, 100));
        window.__skel = document.querySelectorAll('.gl-skel').length; window.fetch = f; return 1`);
      assert.ok(await ev('return window.__skel') >= 6);
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length >= 23');
    });

    await t.test('400 px layout', async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 2, mobile: false });
      await wait(400);
      const r = await ev(`const w = document.querySelector('.gl-wrap'), cs = [...document.querySelectorAll('.gl-card')].slice(0, 3).map((c) => c.getBoundingClientRect());
        return { doc: document.documentElement.scrollWidth, wrap: w.scrollWidth - w.clientWidth, left: cs.map((b) => Math.round(b.left)), right: Math.max(...cs.map((b) => b.right)),
          ctl: document.querySelector('.gl-ctl').getBoundingClientRect().right, top: document.querySelector('.vh-top').scrollWidth, open: document.querySelector('.gl-open').getBoundingClientRect().width };`);
      assert.ok(r.doc <= 400 && r.wrap <= 0, JSON.stringify(r));
      assert.strictEqual(new Set(r.left).size, 1, 'one column');
      assert.ok(r.right <= 400 && r.ctl <= 400 && r.top <= 400 && r.open > 80, JSON.stringify(r));
      // the publish dialog fits too
      await ev('location.hash = "#melody"; return 1');
      await until('VH.app.current === "melody" && VH.melody.ctx');
      await ev('VH.melody.ctx.publish(); return 1');
      await until('document.querySelector(".gl-publish")');
      const d = await ev('const b = document.querySelector(".gl-publish").getBoundingClientRect(); return [b.left, b.right]');
      assert.ok(d[0] >= 0 && d[1] <= 400, d.join(','));
      await ev('document.querySelector(".gl-publish .vh-modal-head button").click(); return 1');
      await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
    });

    if (process.env.VH_SHOT) {
      await ev('location.hash = "#gallery"; return 1');
      await until('document.querySelectorAll(".gl-card:not(.gl-skel)").length >= 23');
      await wait(400);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.VH_SHOT, Buffer.from(shot.data, 'base64'));
    }

    if (process.env.VH_REAL) {
      await t.test('real backend round trip (post, read, like, report x3 -> hidden)', async () => {
        await go('melody', false);
        assert.strictEqual(await ev('return !!window.__glDB'), false, 'no mock');
        const r = await ev(`const M = VH.melody.ctx, G = VH.gallery, api = G.api, out = {};
          // a dense preview to check the server's jsonb size limit with a full-size meta
          const info = G.songInfo(M);
          info.layers = Array.from({ length: 8 }, (_, L) => ({ color: '#6fa3ff', runs: Array.from({ length: 8 }, (_, s) => Array.from({ length: 400 }, (_, i) => [(s + i / 400) / 8, 50 + L * 3 + 6 * Math.sin(i / 9)])),
            notes: Array.from({ length: 100 }, (_, i) => [i / 100, (i + 0.5) / 100, 60 + i % 12]) }));
          const meta = G.buildMeta(info);
          out.metaBytes = JSON.stringify(meta).length;
          const code = await M.shareCode();
          const row = await api.post({ title: 'O1 test (auto-hidden)', author: 'O1 bot', code, meta });
          out.posted = !!row; out.id = row && row.id;
          const found = await api.list({ q: 'O1 test (auto-hidden)', sort: 'new' });
          out.found = found.filter((x) => x.id === out.id).length;
          out.codeOk = (await api.code(out.id)) === code;
          await api.like(out.id);
          const after = await api.list({ q: 'O1 test', sort: 'new' });
          out.likes = (after.find((x) => x.id === out.id) || {}).likes;
          for (let i = 0; i < 3; i++) await api.report(out.id);
          const gone = await api.list({ q: 'O1 test', sort: 'new' });
          out.stillListed = gone.some((x) => x.id === out.id);
          out.newest = (await api.list({})).some((x) => x.id === out.id);
          return out;`);
        console.log('[real]', JSON.stringify(r));
        assert.ok(r.posted && r.found === 1 && r.codeOk, JSON.stringify(r));
        assert.strictEqual(r.likes, 1);
        assert.strictEqual(r.stillListed, false);
        assert.strictEqual(r.newest, false);
      });
    }

    await t.test('no console errors', () => { assert.deepStrictEqual(errors, []); });
    ws.close();
  });
}
