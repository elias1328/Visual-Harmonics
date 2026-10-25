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

async function open(page) {
  await page.addInitScript(() => { try { localStorage.setItem('vh:melody.tutorial', '"done"'); } catch (_) { /* ignore */ } });
  await page.goto('/index.html#melody');
  await page.waitForFunction(() => window.VH && VH.app && VH.app.current && VH.melody.song && VH.melody.song() && VH.melody.ctx);
  await page.evaluate(() => {
    const lay = (id, sound, notes) => ({ id, name: id, color: id === 'l1' ? '#ffc93c' : '#7dff8a', sound, mode: 'notes', vol: 0.8, lines: [], notes });
    VH.melody.ctx.replaceSong({ v: 5, key: 0, mode: 'major', bars: 2, ts: '4/4', bpm: 120, chords: [[0, 0, 'maj']],
      layers: [lay('l1', 'pluck', [[0, 16, 60]]), lay('l2', 'pluck', [[0, 16, 67]])],
      backing: { sound: 'string', vol: 0.36, on: false, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, 'test');
    VH.melody.ctx.setActive(1);
    VH.melody.ctx.view.setHints(true);
  });
}
const pt = (page, t16, m) => page.evaluate(([t, m]) => {
  const V = VH.melody.ctx.view, r = V.cv.getBoundingClientRect();
  return { x: r.left + (V.X0 + t * V.U() - V.scrollX) * r.width / V.VW, y: r.top + V.yOf(m) * r.height / V.TH };
}, [t16, m]);

test.describe('Melody chord hints', () => {
  test('hovering with the note tool marks consonant pitches against notes of both layers; H toggles and persists', async ({ page }) => {
    await open(page);
    await page.keyboard.press('n');
    const p = await pt(page, 4, 70);
    await page.mouse.move(p.x - 30, p.y); await page.mouse.move(p.x, p.y);
    await page.waitForFunction(() => VH.melody.ctx.hints.cur && VH.melody.ctx.hints.cur.cands.length >= 3);
    const h = await page.evaluate(() => { const c = VH.melody.ctx.hints.cur; return { ms: c.cands.map((x) => x.m), tones: c.tones.map((t) => [t.L, t.m]), run: VH.melody.ctx.hints.stats }; });
    expect(h.tones).toEqual(expect.arrayContaining([[0, 60], [1, 67]]));   // another layer + the active layer's own note
    expect(h.ms).not.toContain(61); expect(h.ms).not.toContain(66); expect(h.ms).not.toContain(68);
    expect(h.ms.every((m) => m !== 60 && m !== 67)).toBe(true);
    console.log('hint compute ms', JSON.stringify(h.run));
    // dragging a new note keeps hints (the dragged pitch counts)
    await page.mouse.down(); await page.mouse.move(p.x + 40, (await pt(page, 8, 72)).y, { steps: 4 });
    const dr = await page.evaluate(() => VH.melody.ctx.hints.cur && VH.melody.ctx.hints.cur.tones.map((t) => t.m));
    expect(dr && dr.length).toBeGreaterThanOrEqual(3);
    await page.mouse.up();
    // toggle with H: no hints, preference persists across reload
    await page.mouse.move(p.x, p.y);
    await page.keyboard.press('h');
    expect(await page.evaluate(() => VH.melody.ctx.view.hintsOn)).toBe(false);
    await page.mouse.move(p.x + 3, p.y); await page.waitForTimeout(80);
    expect(await page.evaluate(() => VH.melody.ctx.hints.cur)).toBeNull();
    await page.reload();
    await page.waitForFunction(() => window.VH && VH.melody.ctx);
    expect(await page.evaluate(() => VH.melody.ctx.view.hintsOn)).toBe(false);
    await page.locator('.mel-hint-chip').click();
    expect(await page.evaluate(() => VH.melody.ctx.view.hintsOn)).toBe(true);
  });
  test('Song view: hints use the section under the pointer', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { const M = VH.melody.ctx; M.addSection(false); M.selectSection(0); M.view.setSong(true); M.view.setScroll(0); });
    await page.keyboard.press('n');
    const p = await pt(page, 4, 70);
    await page.mouse.move(p.x - 20, p.y); await page.mouse.move(p.x, p.y);
    await page.waitForFunction(() => VH.melody.ctx.hints.cur && VH.melody.ctx.hints.cur.tones.length >= 2);
  });
});
