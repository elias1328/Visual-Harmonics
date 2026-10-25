// Melody: Song view (all sections side by side on one graph).
const { test: base, expect } = require('@playwright/test');

const BENIGN = [/goatcounter/i, /AudioContext was prevented from starting/i, /The AudioContext was not allowed to start/i, /Failed to load resource.*favicon/i];
const BENIGN_URLS = [/\/assets\/samples-private\/manifest\.json$/];
const test = base.extend({
  errors: [async ({ page }, use) => {
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
    page.on('console', (m) => {
      const ty = m.type();
      if (ty !== 'error' && ty !== 'warning') return;
      const t = m.text(), url = (m.location() || {}).url || '';
      if (BENIGN.some((r) => r.test(t)) || BENIGN_URLS.some((r) => r.test(url))) return;
      errs.push('console.' + ty + ': ' + t);
    });
    await use(errs);
    expect(errs, 'page / console errors').toEqual([]);
  }, { auto: true }],
});

async function open(page, n) {
  await page.addInitScript(() => { try { localStorage.setItem('vh:melody.tutorial', '"done"'); } catch (_) { /* ignore */ } });
  await page.goto('/index.html#melody');
  await page.waitForFunction(() => window.VH && VH.app && VH.app.current && VH.melody.song && VH.melody.song() && VH.melody.ctx);
  // n sections of 4 bars, Song view on, no loop
  await page.evaluate((n) => {
    const M = VH.melody.ctx;
    M.song.loop = false; M.setBars(4);
    while (M.song.sections.length < n) M.addSection(false);
    M.selectSection(0);
    M.view.setTimeZoom(0.5);
    M.view.setSong(true);
    M.view.setScroll(0);
  }, n);
}
// client point of song position g (sixteenths) and pitch m
const gpt = (page, g, m) => page.evaluate(([g, m]) => {
  const V = VH.melody.ctx.view, r = V.cv.getBoundingClientRect();
  return { x: r.left + (V.X0 + g * V.U() - V.scrollX) * r.width / V.VW, y: r.top + V.yOf(m) * r.height / V.TH };
}, [g, m]);
const contentOf = (page, k) => page.evaluate((k) => {
  const M = VH.melody.ctx, md = VH.melody.model, c = md.contentOf(M.song, k), l = M.song.layers[0], d = c.layers[l.id] || { lines: [], notes: [] };
  return { lines: d.lines.map((st) => ({ id: st.id, v: Array.from(st.v) })), notes: d.notes.map((n) => ({ s: n.s, d: n.d, m: n.m })), n: md.tot16(M.song) && c.bars * VH.melody.model.TS[c.ts].spb };
}, k);

test.describe('Song view', () => {
  test('renders all sections with boundary labels and continuous bar numbers; repeats are marked', async ({ page }) => {
    await open(page, 3);
    await page.evaluate(() => { const M = VH.melody.ctx; M.setRepeat(1, 2); M.view.relayout(); M.view.draw(); });
    const r = await page.evaluate(() => {
      const V = VH.melody.ctx.view;
      return { song: V.song, items: V.items().map((it) => [it.k, it.r, it.a, it.n, it.bar0]), labels: V.rulerLabels.map((l) => [l.bar, l.text, l.k, l.r]), btn: document.querySelector('.mel-arr-view').getAttribute('aria-pressed') };
    });
    expect(r.song).toBe(true);
    expect(r.btn).toBe('true');
    expect(r.items.map((i) => i[0])).toEqual([0, 1, 1, 2]);   // arrangement order with the repeat
    expect(r.items.map((i) => i[4])).toEqual([0, 4, 8, 12]);
    const bars = r.labels.map((l) => l[0]);
    expect(bars).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));   // 1..16 continuous across 4 passes
    const chips = r.labels.filter((l) => /[A-Za-z]/.test(l[1]));
    expect(chips).toHaveLength(4);
    expect(chips.map((c) => c[1])).toEqual(expect.arrayContaining([expect.stringMatching(/^1 +/), expect.stringMatching(/^5 +/), expect.stringMatching(/^9 .*repeat/), expect.stringMatching(/^13 +/)]));
    // leaving returns to the section last edited, and the preference is stored
    expect(await page.evaluate(() => VH.store.get('melody.songView', false))).toBe(true);
    await page.keyboard.press('o');
    expect(await page.evaluate(() => VH.melody.ctx.view.song)).toBe(false);
    await page.keyboard.press('o');
    expect(await page.evaluate(() => VH.melody.ctx.view.song)).toBe(true);
  });

  test('a line stroke over a section boundary becomes two strokes with the same pitch; one undo removes both', async ({ page }) => {
    await open(page, 3);
    await page.keyboard.press('p');
    const past0 = await page.evaluate(() => VH.melody.hist.past.length);
    const a = await gpt(page, 56, 62), b = await gpt(page, 72, 66);   // section 1 ends at 64
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    const s0 = await contentOf(page, 0), s1 = await contentOf(page, 1);
    expect(s0.lines).toHaveLength(1); expect(s1.lines).toHaveLength(1);
    const lastIdx = (v) => { for (let i = v.length - 1; i >= 0; i--) if (v[i] != null && !Number.isNaN(v[i])) return i; return -1; };
    const firstIdx = (v) => v.findIndex((x) => x != null && !Number.isNaN(x));
    const v0 = s0.lines[0].v, v1 = s1.lines[0].v;
    expect(lastIdx(v0)).toBe(s0.n * 3 - 1);   // ends at the boundary
    expect(firstIdx(v1)).toBe(0);              // starts right there
    expect(v1[0]).toBe(v0[v0.length - 1]);     // same pitch
    expect(s0.lines[0].id).toBe(s1.lines[0].id);   // same stroke id: one continuous voice
    expect(firstIdx(v0)).toBeGreaterThan(0);
    expect(lastIdx(v1)).toBeGreaterThan(3);
    expect(await page.evaluate(() => VH.melody.hist.past.length)).toBe(past0 + 1);   // one undo step
    await page.keyboard.press('Control+z');
    const u0 = await contentOf(page, 0), u1 = await contentOf(page, 1);
    expect(u0.lines).toHaveLength(0); expect(u1.lines).toHaveLength(0);
    expect(await page.evaluate(() => VH.melody.hist.past.length)).toBe(past0);
  });

  test('a note placed in the section-2 region goes into section 2 at the local time', async ({ page }) => {
    await open(page, 3);
    await page.keyboard.press('n');
    const g = 64 + 20 + 0.4;   // 20.4 sixteenths into section 2
    const p = await gpt(page, g, 64);
    await page.mouse.click(p.x, p.y);
    const info = await page.evaluate(() => { const M = VH.melody.ctx; return { cur: M.song.cur, grid: M.song.grid }; });
    expect(info.cur).toBe(1);
    const s1 = await contentOf(page, 1), s0 = await contentOf(page, 0);
    expect(s0.notes).toHaveLength(0);
    expect(s1.notes).toHaveLength(1);
    const want = await page.evaluate((g) => VH.melody.model.gridFloor(g, VH.melody.ctx.song.grid), 20.4);
    expect(s1.notes[0].s).toBe(want);
    await page.keyboard.press('Control+z');
    expect((await contentOf(page, 1)).notes).toHaveLength(0);
  });

  test('playing in Song view runs the sections in arrangement order and the playhead crosses the boundaries', async ({ page }) => {
    await open(page, 3);
    await page.evaluate(() => { const M = VH.melody.ctx; M.selectSection(0); M.song.bpm = 200; [0, 1, 2].forEach((k) => { M.selectSection(k); M.setBars(1); }); M.selectSection(0); M.view.draw(); window.__tr = { pass: [], x: [], cur: [] }; M.onPlayTick((t) => { const r = window.__tr; if (r.pass[r.pass.length - 1] !== t.pass) r.pass.push(t.pass); r.x.push(M.view.playX()); const c = M.song.cur; if (r.cur[r.cur.length - 1] !== c) r.cur.push(c); }); });
    await page.evaluate(() => VH.melody.ctx.engine.play());
    await page.waitForFunction(() => !VH.melody.ctx.engine.playing, null, { timeout: 15000 });
    const tr = await page.evaluate(() => window.__tr);
    expect(tr.pass).toEqual([0, 1, 2]);
    expect(tr.cur).toEqual([0, 1, 2]);
    const u = await page.evaluate(() => VH.melody.ctx.view.U());
    expect(Math.max(...tr.x)).toBeGreaterThan(32 * u);   // reached the third section (16 sixteenths each)
    let back = 0, jump = 0;
    for (let i = 1; i < tr.x.length; i++) { const d = tr.x[i] - tr.x[i - 1]; if (d < -1e-6) back++; if (d > 12 * u) jump++; }
    expect(back).toBe(0);   // never moves backwards: it is one continuous playhead
    expect(jump).toBe(0);
  });

  test('the Line tool splits at the boundary too, and the ruler seeks across the whole song', async ({ page }) => {
    await open(page, 3);
    await page.keyboard.press('l');
    const a = await gpt(page, 120, 60), b = await gpt(page, 136, 70);   // section 2 ends at 128
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
    const s1 = await contentOf(page, 1), s2 = await contentOf(page, 2);
    expect(s1.lines).toHaveLength(1); expect(s2.lines).toHaveLength(1);
    expect(s2.lines[0].v[0]).toBe(s1.lines[0].v[s1.lines[0].v.length - 1]);
    expect(await page.evaluate(() => VH.melody.hist.past.length && VH.melody.hist.past[VH.melody.hist.past.length - 1].label)).toMatch(/across sections/);
    // ruler click in section 3 (stopped): section 3 is shown, Play starts there
    const r = await gpt(page, 140, 60);
    const y = await page.evaluate(() => { const V = VH.melody.ctx.view, c = V.cv.getBoundingClientRect(); return c.top + 7 * c.height / V.TH; });
    await page.mouse.click(r.x, y);
    const st = await page.evaluate(() => { const M = VH.melody.ctx; return { cur: M.song.cur, cue: M.engine.cue }; });
    expect(st.cur).toBe(2);
    expect(st.cue).toBeGreaterThan(10); expect(st.cue).toBeLessThan(14);
    await page.evaluate(() => VH.melody.ctx.engine.play());
    expect(await page.evaluate(() => VH.melody.ctx.engine.pass)).toBe(2);
    await page.evaluate(() => VH.melody.ctx.engine.stop());
  });

  test('frame time of a 10-section song (static and playing)', async ({ page }) => {
    await open(page, 10);
    const r = await page.evaluate(async () => {
      const M = VH.melody.ctx, V = M.view;
      V.setTimeZoom(0.4); V.setScroll(0);
      for (let k = 0; k < 10; k++) { M.selectSection(k); const l = M.song.layers[0]; for (let i = 0; i < 6; i++) l.notes.push({ s: i * 8, d: 4, m: 60 + (i % 5) }); const st = VH.melody.model.addStroke(l, M.song.bars * 16 * 3); for (let i = 20; i < 150; i++) st.v[i] = 62 + Math.sin(i / 9) * 3; M.commit('seed'); }
      M.selectSection(0); V.setScroll(0);
      const time = (n) => { V.draw(); const t0 = performance.now(); for (let i = 0; i < n; i++) V.draw(); return (performance.now() - t0) / n; };
      const wide = time(60);
      V.setTimeZoom(0.4);
      const stat = time(60);
      M.engine.play();
      await new Promise((res) => setTimeout(res, 300));
      const play = time(60);
      M.engine.stop();
      const vis = V.items().filter((it) => (it.a + it.n) * V.U() > V.scrollX && it.a * V.U() < V.scrollX + V.GW).length;
      return { wide, stat, play, vis, w: V.GW };
    });
    console.log('Song view ms/frame (10 sections):', JSON.stringify(r));
    expect(r.stat).toBeLessThan(40);
  });
});
