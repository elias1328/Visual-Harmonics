// Melody: automation select / copy / paste, lane copy to sections, per-section backing instrument.
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
  await page.waitForFunction(() => window.VH && VH.app && VH.app.current && VH.melody.song && VH.melody.song() && VH.melody.autoPart);
}
const song = (page) => page.evaluate(() => JSON.parse(VH.melody.song()));
const addLane = (page, t) => page.evaluate((t) => { const P = VH.melody.autoPart; P.addLane(t); P.open = true; return [...P.rows.keys()].pop(); }, t);
// client point of (t16, v) in a lane row
const pt = (page, id, t, v) => page.evaluate(([id, t, v]) => {
  const P = VH.melody.autoPart, r = P.rows.get(id); r.el.scrollIntoView({ block: 'center' });
  const rr = r.cv.getBoundingClientRect(), g = P.geo(id);
  return { x: rr.left + g.xOf(t), y: rr.top + 5 + (1 - v) * 26 };
}, [id, t, v]);
const lanePts = (page, id) => page.evaluate((id) => VH.melody.autoPart.laneOf(id).points.map((p) => p.slice()), id);
const msSize = (page) => page.evaluate(() => VH.melody.autoPart.ms.size);
async function clickAt(page, id, t, v, mods) {
  const p = await pt(page, id, t, v);
  for (const m of mods || []) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of mods || []) await page.keyboard.up(m);
}

test.describe('automation select / copy / paste', () => {
  test('marquee, Ctrl+C / Ctrl+V at the playhead, one undo; notes copy/paste unaffected', async ({ page }) => {
    await open(page);
    const id = await addLane(page, 'backing.vol');
    for (const [t, v] of [[4, 0.8], [8, 0.3], [12, 0.6]]) await clickAt(page, id, t, v);
    expect(await lanePts(page, id)).toHaveLength(3);
    // Shift + drag on empty space = marquee
    const a = await pt(page, id, 2, 0.95), b = await pt(page, id, 14, 0.05);
    await page.keyboard.down('Shift'); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift');
    expect(await msSize(page)).toBe(3);
    await clickAt(page, id, 30, 0.5);   // adds a 4th point (and clears the selection)
    expect(await msSize(page)).toBe(0);
    await clickAt(page, id, 4, 0.8, ['Shift']); await clickAt(page, id, 8, 0.3, ['Shift']);
    expect(await msSize(page)).toBe(2);
    await page.keyboard.press('Control+a');
    expect(await msSize(page)).toBe(4);
    await clickAt(page, id, 4, 0.8, ['Shift']); await clickAt(page, id, 30, 0.5, ['Shift']);   // deselect two: 8 and 12 remain
    expect(await msSize(page)).toBe(2);
    await page.keyboard.press('Control+c');
    await page.evaluate(() => VH.melody.ctx.engine.seek(32));
    const before = (await lanePts(page, id)).length;
    await page.keyboard.press('Control+v');
    const pts = await lanePts(page, id);
    expect(pts).toHaveLength(before + 2);
    expect(pts.filter((p) => p[0] === 32 || p[0] === 36).map((p) => p[0])).toEqual([32, 36]);   // 8 -> 32, 12 -> 36 (offset kept)
    await page.keyboard.press('Control+z');
    expect(await lanePts(page, id)).toHaveLength(before);
    // select all + Delete = one undo step
    await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
    expect(await lanePts(page, id)).toHaveLength(0);
    await page.keyboard.press('Control+z');
    expect(await lanePts(page, id)).toHaveLength(before);
    // with no lane active, Ctrl+A / C / V belong to the notes
    await page.mouse.click(5, 5);
    await page.evaluate(() => { const M = VH.melody.ctx; M.song.layers[0].notes.push({ s: 0, d: 4, m: 60 }); M.commit('test note'); });
    await page.keyboard.press('v'); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
    await page.evaluate(() => VH.melody.ctx.engine.seek(16));
    const n0 = await page.evaluate(() => VH.melody.ctx.song.layers[0].notes.length), au0 = (await lanePts(page, id)).length;
    await page.keyboard.press('Control+v');
    expect(await page.evaluate(() => VH.melody.ctx.song.layers[0].notes.length)).toBe(n0 + 1);
    expect((await lanePts(page, id)).length).toBe(au0);
  });

  test('Copy to sections: only the chosen section gets the lane; undo restores', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { const M = VH.melody.ctx; M.addSection(false); M.addSection(false); });   // A, B, C (C shown)
    const id = await addLane(page, 'master.vol');
    for (const [t, v] of [[0, 1], [16, 0.4]]) await clickAt(page, id, t, v);
    const names = await page.evaluate(() => VH.melody.ctx.song.sections.map((s) => s.name));
    await page.locator('.mel-au-more').first().scrollIntoViewIfNeeded();
    await page.locator('.mel-au-more').first().click();
    const menu = page.locator('.mel-au-menu');
    await expect(menu.locator('label')).toHaveCount(2);
    await menu.locator('label', { hasText: names[0] }).locator('input').check();
    await menu.getByRole('button', { name: 'Copy', exact: true }).click();
    let s = await song(page);
    expect(s.sections[0].auto[0].target).toBe('master.vol');
    expect(s.sections[0].auto[0].points).toHaveLength(2);
    expect(s.sections[1].auto).toBeUndefined();
    await page.keyboard.press('Control+z');
    s = await song(page);
    expect(s.sections[0].auto).toBeUndefined();
    expect(s.auto).toHaveLength(1);
  });
});

test.describe('per-section backing instrument', () => {
  test('section 2 plays another backing instrument in Song mode; share round-trip; UI', async ({ page }) => {
    await open(page);
    const ids = await page.evaluate(async () => {
      const M = VH.melody.ctx;
      M.addSection(false);           // B (shown)
      M.setSectionBack({ sound: 'pluck' }, 'test');
      const a = M.backingSoundOf(0).id, b = M.backingSoundOf(1).id, cur = M.backingSound().id;
      const o = await VH.store.decodeShare(await M.shareCode());
      return { a, b, cur, shared: o.sections.map((x) => (x.back || {}).sound || null) };
    });
    expect(ids.a).not.toBe(ids.b);
    expect(ids.b).toBe('pluck');
    expect(ids.cur).toBe('pluck');
    expect(ids.shared).toEqual([null, 'pluck']);
    // live: Song mode, voice log
    const log = await page.evaluate(async () => {
      const M = VH.melody.ctx, E = M.engine;
      if (!VH.audio.ensure()) return null;
      M.selectSection(0); M.setBars(1); M.selectSection(1); M.setBars(1);
      M.song.bpm = 200; M.setPlayMode('song');
      const out = [], orig = VH.audio.voice;
      VH.audio.voice = function (snd) { out.push(snd.id + '@' + M.song.cur); return orig.apply(this, arguments); };
      M.selectSection(0); E.seek(0); E.play();
      await new Promise((r) => setTimeout(r, 3500));
      E.stop(); VH.audio.voice = orig;
      return out;
    });
    expect(log, "audio started").not.toBeNull();
    {
      expect(log.some((x) => x === 'string@0'), 'section 1 plays the song backing: ' + log).toBe(true);
      expect(log.some((x) => x === 'pluck@1'), 'section 2 plays the override: ' + log).toBe(true);
      expect(log.every((x) => x === 'string@0' || x === 'pluck@1'), log.join(',')).toBe(true);
    }
    // UI: the Backing style section shows the override and can reset it
    await page.evaluate(() => VH.melody.ctx.selectSection(1));
    await page.locator('.vh-settings-btn').click();
    await page.locator('.vh-ptab', { hasText: 'Sound' }).click();
    const box = page.locator('.mel-secback');
    await expect(box.locator('.mel-secback-info')).toContainText('Section override');
    await box.getByRole('button', { name: 'Reset' }).click();
    expect((await song(page)).sections.every((x) => !x.back)).toBe(true);
  });

  test('offline render + MIDI use the section instrument', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(async () => {
      const M = VH.melody.ctx, X = VH.melody.exportLib;
      if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return null;
      M.addSection(false); M.setSectionBack({ sound: 'pluck' }, 'test');
      const S = VH.melody.model.flatten(M.song);
      const c = new OfflineAudioContext(2, 44100, 44100), g = c.createGain();
      const lib = VH.melody.sound;
      const o = lib.offline(c, S, g, { loops: 1, backingSoundOf: (k) => M.backingSoundOf(k), backingSound: M.backingSoundOf(0) });
      const ids = [...new Set(o.events.filter((e) => e[0] === 'n').map((e) => e[3]))];
      const bytes = X.songToMidi(S, { mode: 'mixed', layers: [], backing: true, drums: false, backingSound: M.backingSoundOf(0), backingSoundOf: (k) => M.backingSoundOf(k) });
      const progs = []; for (let i = 0; i < bytes.length - 1; i++) if ((bytes[i] & 0xf0) === 0xc0) progs.push(bytes[i + 1]);
      return { ids, progs: [...new Set(progs)], p1: X.gmProgram(M.backingSoundOf(0)), p2: X.gmProgram(M.backingSoundOf(1)) };
    });
    if (!r) return;
    expect(r.ids.sort()).toEqual(['pluck', 'string']);
    expect(r.p1).not.toBe(r.p2);
    expect(r.progs).toEqual(expect.arrayContaining([r.p1, r.p2]));
  });
});
