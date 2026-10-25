// Melody: the Randomize panel (seeds, checkboxes, undo) and layer arpeggios (live voices, WAV render, settings UI).
const { test: base, expect } = require('@playwright/test');

const BENIGN = [/goatcounter/i, /AudioContext was prevented from starting/i, /The AudioContext was not allowed to start/i, /Failed to load resource.*favicon/i];
const BENIGN_URLS = [/\/assets\/samples-private\/manifest\.json$/, /\/rest\/v1\/rpc\/create_share$/];
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
  await page.waitForFunction(() => window.VH && VH.app && VH.app.current && VH.melody.song && VH.melody.song() && VH.melody.generatePart);
}
const song = (page) => page.evaluate(() => JSON.parse(VH.melody.song()));
const base1 = (extra) => Object.assign({ v: 5, key: 0, mode: 'major', bars: 1, ts: '4/4', bpm: 120, chords: [[0, 0, 'maj']],
  layers: [{ id: 'l1', name: 'Layer 1', color: '#ffc93c', sound: 'pluck', mode: 'notes', vol: 0.8, lines: [], notes: [[0, 16, 60]] }],
  backing: { sound: 'string', vol: 0.36, on: false, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, extra);
const load = (page, s) => page.evaluate((s) => VH.melody.ctx.replaceSong(s, 'test'), s);
const tab = async (page, name) => { const t = page.locator('.vh-ptab', { hasText: name }); if (!(await t.isVisible().catch(() => false))) await page.locator('.vh-settings-btn').click(); await t.click(); };
const openPanelSong = (page) => tab(page, 'Song');

test.describe('Randomize panel', () => {
  test('dialog: checkboxes, seed, undo, remembered choices', async ({ page }) => {
    await open(page);
    await openPanelSong(page);
    const before = await song(page);
    await page.locator('.gx-rand').click();
    const dlg = page.locator('.mel-rnd');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('input[data-part]')).toHaveCount(10);
    for (const id of await dlg.locator('input[data-part]').evaluateAll((l) => l.map((x) => x.dataset.part))) {
      const cb = dlg.locator('input[data-part="' + id + '"]');
      if ((await cb.isChecked()) !== (id === 'chords')) await cb.click();
    }
    await dlg.locator('.mel-rnd-seed').fill('river-7');
    await dlg.locator('.mel-rnd-go').click();
    const a = await song(page);
    expect(a.chords).not.toEqual(before.chords);
    expect([a.key, a.mode, a.bpm, a.layers.map((l) => l.sound), a.backing]).toEqual([before.key, before.mode, before.bpm, before.layers.map((l) => l.sound), before.backing]);
    await expect(dlg.locator('.mel-rnd-used')).toContainText('river-7');
    // one undo step brings the old chords back; the same seed gives the same chords again
    await page.evaluate(() => VH.melody.ctx.undo());
    expect((await song(page)).chords).toEqual(before.chords);
    await dlg.locator('.mel-rnd-go').click();
    expect((await song(page)).chords).toEqual(a.chords);
    // dice fills a new seed; Randomize everything ticks all and changes the key part too
    await dlg.locator('.mel-rnd-dice').click();
    expect(await dlg.locator('.mel-rnd-seed').inputValue()).toMatch(/^[a-z]+-\d+$/);
    await dlg.locator('.mel-rnd-all').click();
    await expect(dlg.locator('input[data-part]:checked')).toHaveCount(10);
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vh:melody.gen.rand')));
    expect(Object.values(saved.parts).every(Boolean)).toBe(true);
    // the choices come back next time
    await page.locator('.gx-rand').click();
    await expect(page.locator('.mel-rnd input[data-part]:checked')).toHaveCount(10);
  });

  test('same seed + ticks = same song; one undo step each; whole song scope', async ({ page }) => {
    await open(page);
    const run = (o) => page.evaluate((o) => { const r = VH.melody.generatePart.randomize(o); return { seed: r.seed, s: VH.melody.song() }; }, o);
    const parts = { key: true, chords: true, lens: true, tempo: true, drums: true, backStyle: true, backInst: true, sounds: true, bars: true, melody: true };
    await load(page, base1({ bars: 4, chords: [[0, 0, 'maj'], [16, 7, 'maj'], [32, 9, 'min'], [48, 5, 'maj']] }));
    const x = await run({ seed: 'seed-1', parts, scope: 'section', spice: 0.4 });
    const n1 = await page.evaluate(() => VH.melody.hist.past.length);
    await load(page, base1({ bars: 4, chords: [[0, 0, 'maj'], [16, 7, 'maj'], [32, 9, 'min'], [48, 5, 'maj']] }));
    const y = await run({ seed: 'seed-1', parts, scope: 'section', spice: 0.4 });
    expect(y.s).toBe(x.s);
    const z = await run({ seed: 'seed-2', parts, scope: 'section', spice: 0.4 });
    expect(z.s).not.toBe(y.s);
    // melody part wrote notes on the active layer
    expect(JSON.parse(z.s).layers[0].notes.length).toBeGreaterThan(0);
    // whole song: every section gets a key/chords, the shown section stays shown
    await load(page, base1({ bars: 2, chords: [[0, 0, 'maj'], [16, 7, 'maj']], sections: [{ id: 'S1', name: 'A', rep: 1 }, { id: 'S2', name: 'B', rep: 1, bars: 2, chords: [[0, 5, 'maj'], [16, 0, 'maj']] }], cur: 0 }));
    const u0 = await page.evaluate(() => VH.melody.hist.past.length);
    await run({ seed: 'w', parts: { chords: true, key: true }, scope: 'song' });
    const w = await song(page);
    expect(w.cur).toBe(0);
    expect(w.sections[1].mode).toBe(w.mode);
    expect(w.sections[1].key).toBe(w.key);
    expect(w.sections[1].chords).not.toEqual([[0, 5, 'maj'], [16, 0, 'maj']]);
    expect(await page.evaluate(() => VH.melody.hist.past.length)).toBe(u0 + 1);
  });

  test('chords only leave key, tempo, sounds and notes alone', async ({ page }) => {
    await open(page);
    await load(page, base1({ bpm: 97, key: 3, mode: 'dorian', bars: 4, chords: [[0, 3, 'min'], [16, 8, 'maj'], [32, 10, 'maj'], [48, 3, 'min']] }));
    const a = await song(page);
    await page.evaluate(() => VH.melody.generatePart.randomize({ seed: 'k', parts: { chords: true }, scope: 'section' }));
    const b = await song(page);
    expect([b.key, b.mode, b.bpm, b.bars, b.layers.map((l) => l.sound), b.backing, b.drums]).toEqual([a.key, a.mode, a.bpm, a.bars, a.layers.map((l) => l.sound), a.backing, a.drums]);
    expect(b.chords).not.toEqual(a.chords);
  });
});

test.describe('Layer arpeggio', () => {
  // record every voice the page starts (sound id, midi, audio start time)
  const spy = (page) => page.evaluate(() => {
    window.__v = [];
    const o = VH.audio.voice;
    VH.audio.voice = function (snd, hz, opts) { window.__v.push({ id: snd && snd.id, m: 69 + 12 * Math.log2(hz / 440), when: opts && opts.when }); return o.apply(this, arguments); };
  });
  const hasAudio = (page) => page.evaluate(() => typeof (window.AudioContext || window.webkitAudioContext) === 'function');

  test('settings section writes the layer arp; Off removes it', async ({ page }) => {
    await open(page);
    await tab(page, 'Sound');
    const pat = page.locator('.gx-arp-pat');
    await pat.scrollIntoViewIfNeeded();
    await expect(page.locator('.gx-arp-rate')).toBeDisabled();
    await pat.selectOption('updown');
    await page.locator('.gx-arp-rate').selectOption('1/16t');
    await page.locator('.gx-arp-oct').selectOption('2');
    await page.locator('.gx-arp-from').selectOption('bands');
    expect((await song(page)).layers[0].arp).toEqual({ pat: 'updown', rate: '1/16t', oct: 2, from: 'bands' });
    await pat.selectOption('off');
    expect('arp' in (await song(page)).layers[0]).toBe(false);
  });

  test('live: Up 1/16 on a one-bar note starts 16 voices, stepping the chord', async ({ page }) => {
    await open(page);
    if (!(await hasAudio(page))) return;
    await load(page, base1({ layers: [Object.assign(base1().layers[0], { arp: { pat: 'up', rate: '1/16', oct: 1, from: 'chord' } })] }));
    await spy(page);
    await page.evaluate(() => VH.melody.ctx.engine.play());
    await page.waitForTimeout(2300);
    await page.evaluate(() => VH.melody.ctx.engine.stop());
    const v = (await page.evaluate(() => window.__v)).filter((x) => x.id === 'pluck');
    const t0 = v[0].when;
    const pass = v.filter((x) => x.when < t0 + 1.94);
    expect(pass.length).toBe(16);
    expect(pass.slice(0, 4).map((x) => Math.round(x.m))).toEqual([60, 64, 67, 72]);
    for (let i = 1; i < 16; i++) expect(Math.abs(pass[i].when - pass[i - 1].when - 0.125)).toBeLessThan(0.045);   // humanize moves a step by up to 15 ms
  });

  test('live: a line arp follows the line', async ({ page }) => {
    await open(page);
    if (!(await hasAudio(page))) return;
    const lay = { id: 'l1', name: 'L', color: '#ffc93c', sound: 'pluck', mode: 'line', vol: 0.8, notes: [], arp: { pat: 'up', rate: '1/8', oct: 1, from: 'chord' },
      lines: [{ id: 's1', segs: [[0].concat(Array.from({ length: 48 }, (_, i) => 60 + i / 47 * 12))] }] };
    await load(page, base1({ layers: [lay] }));
    const ok = await page.evaluate(() => VH.melody.song() && JSON.parse(VH.melody.song()).layers[0].lines.length);
    expect(ok).toBe(1);
    await spy(page);
    await page.evaluate(() => VH.melody.ctx.engine.play());
    await page.waitForTimeout(2200);
    await page.evaluate(() => VH.melody.ctx.engine.stop());
    const v = (await page.evaluate(() => window.__v)).filter((x) => x.id === 'pluck');
    const t0 = v[0].when, pass = v.filter((x) => x.when < t0 + 1.94);
    expect(pass.length).toBeGreaterThanOrEqual(8);
    const half = (a, b) => pass.filter((x) => x.when - t0 >= a && x.when - t0 < b).map((x) => x.m);
    const lo = half(0, 0.6), hi = half(1.2, 1.99);
    expect(Math.min(...hi)).toBeGreaterThan(Math.min(...lo) + 4);
    expect(Math.max(...hi)).toBeGreaterThan(Math.max(...lo) + 4);
  });

  test('bands mode: live voices and MIDI use bright bands above the note', async ({ page }) => {
    await open(page);
    if (!(await hasAudio(page))) return;
    await load(page, base1({ layers: [Object.assign(base1().layers[0], { arp: { pat: 'up', rate: '1/8', oct: 2, from: 'bands' } })] }));
    const midi = await page.evaluate(() => {
      const M = VH.melody.ctx, src = M.model.flatten(M.song), G = VH.melody.generatePart;
      const pk = G.arpPeaks(src, 0)(0);
      const notes = VH.melody.exportLib.arpLayer(src, 0, (L) => G.arpPeaks(src, L)).notes.map((n) => n.m);
      return { pk, notes, bytes: VH.melody.exportLib.songToMidi(src, { mode: 'mixed', layers: [0], arpPeaks: (L) => G.arpPeaks(src, L), soundOf: () => ({ id: 'pluck', name: 'Pluck' }) }).length };
    });
    expect(midi.pk.length).toBeGreaterThan(0);
    expect(midi.notes).toHaveLength(8);
    expect(midi.notes.every((m) => m >= 60 && m <= 84)).toBe(true);
    expect(new Set(midi.notes).size).toBeGreaterThan(2);
    await spy(page);
    await page.evaluate(() => VH.melody.ctx.engine.play());
    await page.waitForTimeout(1200);
    await page.evaluate(() => VH.melody.ctx.engine.stop());
    const v = (await page.evaluate(() => window.__v)).filter((x) => x.id === 'pluck');
    expect(v.length).toBeGreaterThanOrEqual(6);
    expect(v.every((x) => x.m >= 59.9 && x.m <= 84.1)).toBe(true);
  });

  test('WAV render of an arp layer works and differs from the held note', async ({ page }) => {
    await open(page);
    if (!(await page.evaluate(() => typeof OfflineAudioContext === 'function'))) return;
    const energy = (arp) => page.evaluate(async (arp) => {
      const lay = { id: 'l1', name: 'L', color: '#ffc93c', sound: 'pluck', mode: 'notes', vol: 0.8, lines: [], notes: [[0, 16, 60]] };
      if (arp) lay.arp = { pat: 'up', rate: '1/16', oct: 1, from: 'chord' };
      VH.melody.ctx.replaceSong({ v: 5, key: 0, mode: 'major', bars: 1, ts: '4/4', bpm: 120, chords: [[0, 0, 'maj']], layers: [lay],
        backing: { sound: 'string', vol: 0.36, on: false, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, 'test');
      const r = await VH.melody.exportPart.render({ layers: [0], backing: false, drums: false, whole: true }, 1, () => {});
      const ch = r.channels[0], sr = r.sr, out = [];
      for (let w = 0; w < 16; w++) { let s = 0; for (let i = Math.floor(w * 0.125 * sr); i < Math.floor((w * 0.125 + 0.02) * sr); i++) s += ch[i] * ch[i]; out.push(s); }
      return out;
    }, arp);
    const held = await energy(false), arp = await energy(true);
    // every arp step re-strikes (attack energy in the first 20 ms of each sixteenth); a held pluck has it only once
    expect(arp.filter((e) => e > 1e-5).length).toBeGreaterThanOrEqual(14);
    expect(held.filter((e) => e > 1e-5).length).toBeLessThan(arp.filter((e) => e > 1e-5).length);
  });
});
