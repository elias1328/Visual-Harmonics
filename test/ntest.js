// ntest.js - browser checks for the v2 synth + synth editor (run over http with a CDP browser).
//   python -m http.server 8931            (repo root)
//   msedge --headless=new --remote-debugging-port=9531 --autoplay-policy=no-user-gesture-required about:blank
//   VH_BROWSER=1 node test/ntest.js        (optional: VH_URL, VH_CDP, VH_SHOT=path.png)
// Under plain `node --test` it is skipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const URL0 = process.env.VH_URL || 'http://localhost:8931/';
const CDP = process.env.VH_CDP || 'http://127.0.0.1:9531';

if (!process.env.VH_BROWSER) {
  test('ntest (browser): set VH_BROWSER=1 with the server and a CDP browser running', { skip: true }, () => {});
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
  async function go(hash) {
    await send('Page.navigate', { url: URL0 + '?nt=' + Date.now() + '#' + hash });
    for (let i = 0; i < 100; i++) { await wait(100); try { if (await ev('return !!(window.VH && VH.app && VH.app.current === ' + JSON.stringify(hash) + ' && document.querySelector(".vh-dock select"))')) break; } catch (_) { /* loading */ } }
    await ev('await VH.sounds.ready; return 1');
    await ev('document.querySelectorAll(".vh-modal-back, .mx-onb, .vh-sheet").forEach((n) => n.remove()); return 1');
  }
  async function mouse(type, x, y) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }); }
  async function key(type, k) {
    const code = 'Key' + k.toUpperCase();
    await send('Input.dispatchKeyEvent', { type, key: k, code, text: type === 'keyDown' ? k : undefined, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  }
  // Pick "＋ New synth…" in the experiment's instrument picker (the first dock select that has it).
  const OPEN_NEW = `const sel = [...document.querySelectorAll('.vh-dock select')].find((s) => [...s.options].some((o) => o.value === '__newsynth'));
    if (!sel) return 'no picker row';
    sel.value = '__newsynth'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return VH.synthEditor.current && document.querySelector('.vh-synthed') ? 'ok' : 'not open';`;

  test('browser: v2 synth engine + editor', { timeout: 240000 }, async (t) => {
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
    await go('melody');

    await t.test('every preset renders offline: non-silent, no NaN, loud within ±2 dB', async () => {
      const res = await ev(`const out = [];
        for (const p of VH.synth.PRESETS) {
          const s = VH.synth.toSound(p.model, { id: 'nt-' + p.id, name: p.name }), r = await VH.sounds.measure(s);
          s.loud = r.loud;
          const c = new OfflineAudioContext(1, Math.ceil(44100 * 1.6), 44100), g = c.createGain(); g.connect(c.destination);
          VH.audio.withContext(c, () => { const v = VH.audio.voice(s, 261.63, { gain: 1, dest: g, when: 0 }); v.stop(undefined, 1.5); });
          const x = (await c.startRendering()).getChannelData(0);
          let nan = 0, peak = 0; for (const v of x) { if (!isFinite(v)) nan++; else peak = Math.max(peak, Math.abs(v)); }
          out.push({ id: p.id, loud: r.loud, raw: r.db, db: VH.sounds.toDb(VH.sounds.kRms(x, 44100, 0, 1)), nan, peak });
        }
        return out;`);
      for (const r of res) {
        assert.strictEqual(r.nan, 0, r.id + ' NaN');
        assert.ok(r.peak > 0.01, r.id + ' silent');
        assert.ok(Math.abs(r.db - -18) <= 2, r.id + ' loudness ' + r.db.toFixed(2) + ' dB (loud ' + r.loud + ')');
      }
      console.log('  presets:', res.map((r) => r.id + ' ' + r.db.toFixed(1) + 'dB/loud ' + r.loud).join(', '));
    });

    await t.test('2-octave legato glide: no restart, lands within ±5 cents, no level dip', async () => {
      const r = await ev(`const sr = 44100, c = new OfflineAudioContext(1, sr * 2, sr), g = c.createGain(); g.connect(c.destination);
        const s = VH.synth.toSound({ oscs: [{ wave: 'sine' }], filter: { cutoff: 18000, keyTrack: 0 }, ampEnv: { a: 0.01, d: 0.1, s: 1, r: 0.1 } }, { id: 'nt-glide', loud: 1 });
        const sup = VH.synth.toSound(VH.synth.preset('supersaw'), { id: 'nt-sup', loud: 1 });
        let st0, st1, st2, n0;
        VH.audio.withContext(c, () => {
          const v = VH.audio.voice(s, 130.81, { gain: 0.5, dest: g, when: 0 });
          const w = VH.audio.voice(sup, 130.81, { gain: 0, dest: g, when: 0 }); n0 = w.sources;
          st0 = VH.audio.stats().starts;
          v.setFreq(523.25, 0.15, 0.5); w.setFreq(523.25, 0.15, 0.5);
          st1 = VH.audio.stats().starts;
          v.stop(undefined, 1.85); w.stop(undefined, 1.85);
        });
        const x = (await c.startRendering()).getChannelData(0);
        // frequency from interpolated zero crossings in 1.2..1.7 s
        let first = -1, last = -1, n = 0;
        for (let i = Math.floor(1.2 * sr); i < 1.7 * sr; i++) if (x[i - 1] < 0 && x[i] >= 0) { const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]); if (first < 0) first = t; last = t; n++; }
        const f = (n - 1) * sr / (last - first);
        const rms = []; for (let a = 0.2; a < 1.7; a += 0.05) { let q = 0; const i0 = Math.floor(a * sr); for (let i = i0; i < i0 + 0.05 * sr; i++) q += x[i] * x[i]; rms.push(Math.sqrt(q / (0.05 * sr))); }
        return { f, cents: 1200 * Math.log2(f / 523.25), restarts: st1 - st0, dip: Math.min(...rms) / Math.max(...rms), unison: n0 };`);
      assert.strictEqual(r.restarts, 0, 'setFreq started new sources');
      assert.ok(Math.abs(r.cents) <= 5, 'landed ' + r.cents.toFixed(2) + ' cents off');
      assert.ok(r.dip > 0.7, 'level dip ' + r.dip.toFixed(2));
      console.log('  glide: ' + r.f.toFixed(2) + ' Hz (' + r.cents.toFixed(2) + ' ¢), min/max rms ' + r.dip.toFixed(3) + ', supersaw sources ' + r.unison);
    });

    await t.test('CPU guard: unison thins out past 12 live voices', async () => {
      const r = await ev(`VH.audio.ensure(); const s = VH.synth.toSound(VH.synth.preset('supersaw'), { id: 'nt-cpu', loud: 1 });
        const vs = []; for (let i = 0; i < 16; i++) vs.push(VH.audio.voice(s, 220, { gain: 0 }));
        const u = vs.map((v) => v.uMax); vs.forEach((v) => v.stop(0.01)); return u;`);
      assert.strictEqual(r[0], 7); assert.ok(r[15] < 7, 'unison not reduced: ' + r);
    });

    await t.test('editor opens from the picker in Melody and Spiral', async () => {
      assert.strictEqual(await ev(OPEN_NEW), 'ok', 'melody');
      await ev('VH.synthEditor.current.close(); return 1');
      await go('spiral');
      assert.strictEqual(await ev(OPEN_NEW), 'ok', 'spiral');
      await ev('VH.synthEditor.current.close(); return 1');
      await go('melody');
    });

    await t.test('drawing partials changes the spectrum', async () => {
      assert.strictEqual(await ev(OPEN_NEW), 'ok');
      await ev(`const E = VH.synthEditor.current; E.loadPreset('organ'); E.tab(0); await new Promise((r) => setTimeout(r, 80)); return 1`);
      const before = await ev('return JSON.stringify(VH.synthEditor.current.spectrum)');
      const rect = await ev(`const r = document.querySelector('.vh-se-partials').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, hidden: !!document.querySelector('.vh-se-pwrap').hidden }`);
      assert.ok(!rect.hidden && rect.w > 100, 'partials canvas not shown');
      await mouse('mousePressed', rect.x + rect.w * 0.05, rect.y + rect.h * 0.5);
      for (let i = 1; i <= 12; i++) await mouse('mouseMoved', rect.x + rect.w * (0.05 + i * 0.06), rect.y + rect.h * (0.2 + 0.05 * (i % 3)));
      await mouse('mouseReleased', rect.x + rect.w * 0.77, rect.y + rect.h * 0.3);
      await wait(120);
      const after = await ev('return JSON.stringify(VH.synthEditor.current.spectrum)');
      assert.notStrictEqual(after, before);
      assert.ok(JSON.parse(after).length > JSON.parse(before).length, 'more partials after drawing');
    });

    await t.test('lowering the cutoff widens the bright bands (within 100 ms)', async () => {
      const r = await ev(`const E = VH.synthEditor.current;
        E.setModel({ oscs: [{ wave: 'saw' }], filter: { type: 'lowpass', cutoff: 8000, q: 0.7, keyTrack: 0 } });
        await new Promise((r) => setTimeout(r, 120));
        const open = E.brightRows(), u0 = E.updates;
        // move the Cutoff slider like a user would
        const inp = [...document.querySelectorAll('.vh-se-sl')].find((l) => l.textContent.startsWith('Cutoff')).querySelector('input');
        inp.value = 1000 * Math.log(400 / 30) / Math.log(18000 / 30); inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
        return { open, closed: E.brightRows(), redrawn: E.updates > u0, cutoff: E.model.filter.cutoff };`);
      assert.ok(r.redrawn, 'not redrawn within 100 ms');
      assert.ok(r.closed > r.open + 10, 'bright rows ' + r.open + ' -> ' + r.closed);
      console.log('  bright rows: cutoff 8 kHz ' + r.open + ' -> ' + r.cutoff + ' Hz ' + r.closed);
    });

    await t.test('audition: keys and map clicks play the synth', async () => {
      const a0 = await ev('return VH.synthEditor.current.auditions');
      await key('keyDown', 'a'); await wait(120);
      const live = await ev('return VH.audio.stats().v2Live');
      await key('keyUp', 'a');
      const m = await ev(`const r = document.querySelector('.vh-se-map').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.4 }`);
      await mouse('mousePressed', m.x, m.y); await mouse('mouseReleased', m.x, m.y);
      await wait(100);
      const a1 = await ev('return VH.synthEditor.current.auditions');
      assert.ok(live >= 1, 'key did not start a voice');
      assert.strictEqual(a1 - a0, 2);
    });

    await t.test('screenshot of the editor', async () => {
      await ev(`VH.synthEditor.current.loadPreset('warm-pad'); VH.synthEditor.current.tab(0); return 1`);
      await wait(200);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (process.env.VH_SHOT) fs.writeFileSync(process.env.VH_SHOT, Buffer.from(shot.data, 'base64'));
      await ev('VH.synthEditor.current.close(); return 1');
    });

    await t.test('save -> appears in every picker -> plays in Melody', async () => {
      await ev(`VH.sounds.list().filter((x) => x.name === 'NTest brass').forEach((x) => VH.sounds.remove(x.id)); return 1`);
      assert.strictEqual(await ev(OPEN_NEW), 'ok');
      const r = await ev(`const E = VH.synthEditor.current; E.loadPreset('brass'); E.setName('NTest brass');
        document.querySelector('.vh-synthed .vh-se-save').click();
        for (let i = 0; i < 50 && VH.synthEditor.current; i++) await new Promise((r) => setTimeout(r, 100));
        const s = VH.sounds.list().find((x) => x.name === 'NTest brass');
        const sels = [...document.querySelectorAll('select')].filter((x) => [...x.options].some((o) => o.value === 'string'));
        return { id: s && s.id, source: s && s.source, loud: s && s.loud, inAll: sels.length > 1 && sels.every((x) => [...x.options].some((o) => o.value === (s && s.id))), picked: sels.some((x) => x.value === (s && s.id)),
          edit: sels.some((x) => x.value === (s && s.id) && [...x.options].some((o) => o.value === '__editsynth')) };`);
      assert.ok(r.id && r.source === 'custom' && r.loud > 0, JSON.stringify(r));
      assert.ok(r.inAll && r.picked && r.edit, JSON.stringify(r));
      const p = await ev(`document.querySelector('[title="Play / stop (Space)"]').click();
        let mx = 0; for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); mx = Math.max(mx, VH.audio.stats().v2Live); }
        document.querySelector('[title="Play / stop (Space)"]').click(); return mx;`);
      assert.ok(p >= 1, 'no v2 voice while Melody played');
      // edit live: ✎ Edit, change cutoff, the saved sound (same id) updates
      const e = await ev(`const sel = [...document.querySelectorAll('.vh-dock select')].find((s) => [...s.options].some((o) => o.value === '__editsynth'));
        sel.value = '__editsynth'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
        const E = VH.synthEditor.current, id = E.editId; let fired = 0; const off = VH.sounds.onChange(() => fired++);
        E.set('filter.cutoff', 333);
        for (let i = 0; i < 40 && VH.sounds.get(id).synth.filter.cutoff !== 333; i++) await new Promise((r) => setTimeout(r, 50));
        off(); E.close(); const s = VH.sounds.get(id); VH.sounds.remove(id);
        return { cutoff: s.synth.filter.cutoff, fired, same: id === sel.value || true };`);
      assert.strictEqual(e.cutoff, 333); assert.ok(e.fired >= 1);
    });

    await t.test('randomize 20x: never silent, never clipped', async () => {
      const r = await ev(`const E = VH.synthEditor.open({}); const out = [];
        for (let i = 0; i < 20; i++) {
          E.randomize(); const s = E.sound(), m = await VH.sounds.measure(s); s.loud = m.loud;
          const c = new OfflineAudioContext(1, 44100 * 1.6, 44100), g = c.createGain(); g.connect(c.destination);
          VH.audio.withContext(c, () => { const v = VH.audio.voice(s, 261.63, { dest: g, when: 0 }); v.stop(undefined, 1.2); });
          const x = (await c.startRendering()).getChannelData(0);
          let peak = 0, nan = 0; for (const v of x) { if (!isFinite(v)) nan++; else peak = Math.max(peak, Math.abs(v)); }
          out.push({ peak, nan, db: VH.sounds.toDb(VH.sounds.kRms(x, 44100, 0, 1)) - 20 * Math.log10(0.3), loud: m.loud });
        }
        E.close(); return out;`);
      for (const x of r) {
        assert.strictEqual(x.nan, 0);
        assert.ok(x.db > -24, 'quiet random synth: ' + JSON.stringify(x));
        assert.ok(x.peak < 1, 'clipped: ' + JSON.stringify(x));
      }
      console.log('  random: K-RMS ' + Math.min(...r.map((x) => x.db)).toFixed(1) + '..' + Math.max(...r.map((x) => x.db)).toFixed(1) + ' dB @gain 1, max peak (gain .3) ' + Math.max(...r.map((x) => x.peak)).toFixed(2));
    });

    await t.test('0 console errors', async () => {
      await wait(300);
      assert.deepStrictEqual(errors, []);
    });
    ws.close();
  });
}
