// Cross-browser smoke flows for Visual Harmonics (Chromium, Firefox, WebKit).
// Run from e2e/: npx playwright test            (one browser: --project=firefox)
//
// Every test fails on uncaught page errors, console errors and console warnings, except the benign ones in BENIGN.
// Assertions use observable behaviour: the DOM, VH.audio.stats(), the song JSON (VH.melody.song()) and real downloads.
//
// Note: Playwright's WebKit build for Windows ships without Web Audio (no AudioContext / OfflineAudioContext). There
// the audio assertions are skipped (annotated "no-webaudio") and the flows only check the UI and that nothing throws.
const { test: base, expect } = require('@playwright/test');
const fs = require('fs');

// Known benign console messages (errors or warnings). Keep this list short and explicit.
const BENIGN = [
  /goatcounter/i,                                   // analytics script blocked / offline
  /AudioContext was prevented from starting/i,      // Firefox autoplay notice before the first gesture
  /The AudioContext was not allowed to start/i,     // Chromium autoplay notice before the first gesture
  /Failed to load resource.*favicon/i,
];
// Benign by URL: the local-only sample pack is gitignored, so a fresh clone answers 404 for its manifest.
// Benign by URL: the live gallery DB answers 404 for create_share until docs/gallery.sql's 2026-10 migration has been run (Share then gives the long link).
const BENIGN_URLS = [/\/assets\/samples-private\/manifest\.json$/, /\/rest\/v1\/rpc\/create_share$/];

// Collect a page's uncaught errors and unexpected console errors / warnings into errs.
function watch(page, errs = []) {
  page.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    const ty = m.type();
    if (ty !== 'error' && ty !== 'warning') return;
    const t = m.text(), url = (m.location() || {}).url || '';
    if (BENIGN.some((r) => r.test(t)) || BENIGN_URLS.some((r) => r.test(url))) return;
    errs.push('console.' + ty + ': ' + t);
  });
  return errs;
}

const test = base.extend({
  errors: [async ({ page }, use) => {
    const errs = watch(page);
    await use(errs);
    expect(errs, 'page / console errors').toEqual([]);
  }, { auto: true }],
});

// ---------- helpers ----------
async function open(page, hash = '#melody', { tutorial = false } = {}) {
  if (!tutorial) await page.addInitScript(() => { try { localStorage.setItem('vh:melody.tutorial', '"done"'); } catch (_) { /* ignore */ } });
  await page.goto('/index.html' + hash);
  await page.waitForFunction(() => window.VH && VH.app && VH.app.current);
  if (/^#melody/.test(hash)) await page.waitForFunction(() => VH.melody.song && VH.melody.song());
}
const hasAudio = (page) => page.evaluate(() => typeof (window.AudioContext || window.webkitAudioContext) === 'function');
async function audioOr(page, what) {
  const ok = await hasAudio(page);
  if (!ok) test.info().annotations.push({ type: 'no-webaudio', description: 'skipped: ' + what });
  return ok;
}
const stats = (page) => page.evaluate(() => VH.audio.stats());
const song = (page) => page.evaluate(() => JSON.parse(VH.melody.song()));
const melCanvas = (page) => page.locator('canvas[aria-label="Melody drawing area over the harmony map"]');
const dockBtn = (page, label) => page.locator('.vh-dock-btn', { hasText: label }).first();

async function box(loc) { const b = await loc.boundingBox(); expect(b).toBeTruthy(); return b; }

// A mono 16-bit WAV, 1 s of a sine (Node side).
function toneWav(hz, sec = 1, sr = 44100) {
  const n = Math.round(sec * sr), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400, (n - i) / 400);
    b.writeInt16LE(Math.round(0.5 * env * Math.sin(2 * Math.PI * hz * i / sr) * 32767), 44 + i * 2);
  }
  return b;
}
// Parse a PCM WAV -> { sr, ch, seconds, rms }.
function parseWav(buf) {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), len = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') data = buf.subarray(p + 8, p + 8 + len);
    p += 8 + len + (len & 1);
  }
  expect(fmt && data).toBeTruthy();
  expect(fmt.bits).toBe(16);
  const n = data.length / 2; let s = 0;
  for (let i = 0; i < n; i++) { const v = data.readInt16LE(i * 2) / 32768; s += v * v; }
  return { sr: fmt.sr, ch: fmt.ch, seconds: n / fmt.ch / fmt.sr, rms: Math.sqrt(s / n) };
}

// Draw a line stroke in the given bar fraction range on the melody canvas.
async function drawStroke(page, fx0 = 0.55, fx1 = 0.8, fy = 0.5) {
  const b = await box(melCanvas(page));
  const y = b.y + 64 + (b.height - 74) * fy;
  await page.mouse.move(b.x + b.width * fx0, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + b.width * (fx0 + (fx1 - fx0) * i / 12), y - i * 2);
  await page.mouse.up();
}
// Open the chord picker for the first bar (click the chord name in the header strip).
async function openChordPicker(page) {
  const b = await box(melCanvas(page)), S = await song(page), kw = 22 + 12;   // piano strip + left margin (desktop)
  const bw = (b.width - kw - 16) / S.bars;
  await page.mouse.click(b.x + kw + bw / 2, b.y + 14 + 18);   // the chord name sits centred in bar 1's header
  await expect(page.locator('.mel-pop .mel-quick')).toBeVisible();
}
// Click a control by its box (no Playwright auto-scroll: during a pop-over's entry animation Playwright's retry scrolls
// can scroll the overflow-hidden stage, which a user never can).
async function tap(page, loc) { const b = await box(loc); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
async function openPanel(page, tab) {
  const panelTab = page.locator('.vh-ptab', { hasText: tab });
  if (!(await panelTab.isVisible().catch(() => false))) await page.locator('.vh-settings-btn').click();
  await panelTab.click();
  await expect(panelTab).toHaveAttribute('aria-selected', 'true');
}

// =====================================================================================================================
test.describe('1 load', () => {
  test('every tab loads, gallery read 200, no horizontal scroll at 400px', async ({ page }) => {
    const gal = page.waitForResponse((r) => /\/rest\/v1\//.test(r.url()) && r.request().method() === 'GET', { timeout: 30_000 });
    await open(page, '#melody');
    for (const id of ['melody', 'babel', 'spiral', 'gallery', 'lab']) {
      await page.evaluate((h) => { location.hash = h; }, '#' + id);
      await page.waitForFunction((x) => VH.app.current === x, id);
      await expect(page.locator('#stage')).not.toBeEmpty();
      await page.waitForTimeout(300);
    }
    expect((await gal).status()).toBe(200);
    await page.setViewportSize({ width: 400, height: 800 });
    for (const id of ['melody', 'babel', 'spiral', 'gallery', 'lab']) {
      await page.evaluate((h) => { location.hash = h; }, '#' + id);
      await page.waitForFunction((x) => VH.app.current === x, id);
      await page.waitForTimeout(400);
      const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(sw, id + ' horizontal scroll at 400px').toBeLessThanOrEqual(cw);
    }
  });
});

test.describe('1b touch CSS', () => {
  test('canvases take touch gestures; dock buttons and lanes are not text-selectable', async ({ page }) => {
    await open(page);
    for (const id of ['melody', 'babel', 'spiral']) {
      await page.evaluate((h) => { location.hash = h; }, '#' + id);
      await page.waitForFunction((x) => VH.app.current === x, id);
      const ta = await page.locator('.vh-stage canvas[aria-label]').first().evaluate((c) => getComputedStyle(c).touchAction);
      expect(ta, id + ' canvas touch-action').toBe('none');
      // WebKit only honours the prefixed property (the unprefixed one parses but does nothing there).
      const us = await page.locator('.vh-dock-btn').first().evaluate((b) => {
        const cs = getComputedStyle(b);
        return 'webkitUserSelect' in document.body.style ? cs.webkitUserSelect : cs.userSelect;
      });
      expect(us, id + ' dock button user-select').toBe('none');
    }
  });
});

// =====================================================================================================================
test.describe('2 melody basics', () => {
  test('tutorial skip, draw a line, place a note', async ({ page }) => {
    await page.goto('/index.html#melody');   // first visit: demo + tutorial
    await page.waitForFunction(() => window.VH && VH.melody.song && VH.melody.song());
    const skip = page.locator('.mel-coach-skip');
    await expect(skip).toBeVisible();
    await skip.click();
    await expect(skip).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('vh:melody.tutorial'))).toBe('"done"');

    const before = (await song(page)).layers[0].lines.length;
    await drawStroke(page, 0.62, 0.9, 0.45);
    await expect.poll(async () => (await song(page)).layers[0].lines.length).toBeGreaterThan(before);

    // Notes mode: the active layer's menu (click its chip again) switches it to Notes.
    await page.locator('.mel-chip.on').click();
    const modeBtn = page.locator('.mel-layermenu [data-a="mode"]');
    await expect(modeBtn).toBeVisible();
    if ((await song(page)).layers[0].mode !== 'notes') await modeBtn.click();
    await expect.poll(async () => (await song(page)).layers[0].mode).toBe('notes');
    await page.keyboard.press('Escape');
    const n0 = (await song(page)).layers[0].notes.length;
    const b = await box(melCanvas(page));
    await page.mouse.click(b.x + b.width * 0.7, b.y + 64 + (b.height - 74) * 0.3);
    await expect.poll(async () => (await song(page)).layers[0].notes.length).toBe(n0 + 1);
  });

  test('chord picker, play 1 s, stop, undo / redo', async ({ page }) => {
    await open(page);
    const c0 = (await song(page)).chords[0];
    await openChordPicker(page);
    const pick = page.locator('.mel-quick button.q:not(.cur)').first();
    await pick.click();
    await expect.poll(async () => JSON.stringify((await song(page)).chords[0])).not.toBe(JSON.stringify(c0));
    const c1 = (await song(page)).chords[0];
    await page.keyboard.press('Escape');

    const audio = await audioOr(page, 'play voices');
    const s0 = audio ? await stats(page) : null;
    await dockBtn(page, 'Play').click();
    await page.waitForTimeout(1000);
    if (audio) {
      const s1 = await stats(page);
      expect(s1.state).toBe('running');
      expect(s1.starts).toBeGreaterThan(s0.starts);
    }
    await dockBtn(page, 'Stop').click().catch(async () => { await page.keyboard.press('Space'); });
    await expect(dockBtn(page, 'Play')).toBeVisible();
    if (audio) await expect.poll(async () => (await stats(page)).live, { timeout: 5000 }).toBe(0);

    await melCanvas(page).focus().catch(() => {});
    await page.keyboard.press('Control+z');
    await expect.poll(async () => JSON.stringify((await song(page)).chords[0])).toBe(JSON.stringify(c0));
    await page.keyboard.press('Control+y');
    await expect.poll(async () => JSON.stringify((await song(page)).chords[0])).toBe(JSON.stringify(c1));
  });

  test('settings tabs, tension and look chips', async ({ page }) => {
    await open(page);
    for (const t of ['Song', 'Sound', 'Mix', 'Edit', 'Export']) {
      await openPanel(page, t);
      await expect(page.locator('.vh-acc-btn:visible').first()).toBeVisible();
    }
    await page.locator('.vh-settings-btn').click();

    const ten = page.locator('.mel-tens-chip:not(.mel-look-chip)');
    await ten.click();
    const pop = page.locator('.mel-tens-pop:not(.mel-look-pop)');
    await expect(pop).toBeVisible();
    await pop.locator('input[type=range]').fill('1');
    await expect(ten).toContainText('Tense');
    await page.keyboard.press('Escape');

    await page.locator('.mel-look-chip').click();
    const lp = page.locator('.mel-look-pop');
    await expect(lp).toBeVisible();
    const sel = lp.locator('select.mel-look-theme');
    const vals = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value));
    const cur = await sel.inputValue();
    const next = vals.find((v) => v !== cur);
    await sel.selectOption(next);
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('vh:melody.look') || '{}')).theme)).toBe(next);
  });
});

// =====================================================================================================================
test.describe('3 melody exports', () => {
  async function exportAs(page, fmt) {
    await openPanel(page, 'Export');
    await page.getByRole('button', { name: /Export…/ }).click();
    await page.locator('.mx-fmt button', { hasText: fmt }).click();
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('.mx-go').click();
    return dl;
  }
  test('MIDI download', async ({ page }) => {
    await open(page);
    await drawStroke(page);
    const d = await exportAs(page, 'MIDI');
    expect(d.suggestedFilename()).toMatch(/\.mid$/);
    const buf = fs.readFileSync(await d.path());
    expect(buf.toString('ascii', 0, 4)).toBe('MThd');
    expect(buf.length).toBeGreaterThan(60);
  });
  test('WAV render: duration and non-silence', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'WAV render (OfflineAudioContext)'))) return;
    await drawStroke(page, 0.1, 0.4);
    const S = await song(page);
    const songSec = S.bars * 4 * 60 / S.bpm;
    const d = await exportAs(page, 'WAV');
    expect(d.suggestedFilename()).toMatch(/\.wav$/);
    const w = parseWav(fs.readFileSync(await d.path()));
    expect(w.ch).toBe(2);
    expect(w.seconds).toBeGreaterThanOrEqual(songSec);
    expect(w.seconds).toBeLessThan(songSec + 8);
    expect(w.rms).toBeGreaterThan(0.005);
    await expect(page.locator('.mx-status')).toContainText('Saved');
  });
  // The export path renders the real voices offline; releases that cut an envelope ramp must sound the same in every
  // browser (Firefox has no AudioParam.cancelAndHoldAtTime).
  test('note releases mid-attack / mid-decay render correctly', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'offline voice render'))) return;
    const r = await page.evaluate(async () => {
      const sr = 44100, c = new OfflineAudioContext(1, Math.round(sr * 2), sr);
      const syn = (attack, decay, sustain) => ({ id: 't', name: 't', kind: 'synth', source: 'preset', play: 'hit',
        synth: { partials: [[1, 1]], attack, decay, sustain, release: 0.1 }, spectrum: [[1, 1]] });
      VH.audio.withContext(c, () => {
        VH.audio.voice(syn(0.4, 0.3, 0.8), 220, { when: 0.1 }).stop(0.05, 0.3);    // released half-way up the attack
        VH.audio.voice(syn(0.005, 1.2, 0), 220, { when: 0.8 }).stop(0.3, 1.4);   // pluck released mid-decay
      });
      const x = (await c.startRendering()).getChannelData(0);
      const peak = (a, z) => { let p = 0; for (let i = Math.round(a * sr); i < Math.round(z * sr); i++) p = Math.max(p, Math.abs(x[i])); return p; };
      return { attackRise: peak(0.25, 0.3), pluckHead: peak(0.8, 0.85), pluckBefore: peak(1.36, 1.4), pluckAfter: peak(1.4, 1.5) };
    });
    expect(r.attackRise, 'a note released mid-attack still sounds').toBeGreaterThan(0.005);
    expect(r.pluckBefore).toBeLessThan(r.pluckHead * 0.7);   // it decayed before the release
    expect(r.pluckAfter, 'release never jumps back up').toBeLessThanOrEqual(r.pluckBefore * 1.1);
  });
  test('MP3 (if lamejs loads)', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'MP3 render'))) return;
    const lame = await page.request.get('/js/vendor/lamejs/lame.min.js');
    test.skip(!lame.ok(), 'lamejs not available');
    const d = await exportAs(page, 'MP3');
    expect(d.suggestedFilename()).toMatch(/\.mp3$/);
    const buf = fs.readFileSync(await d.path());
    expect(buf.length).toBeGreaterThan(10_000);
    const head = buf.toString('latin1', 0, 3);
    expect(head === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)).toBe(true);
  });
});

// =====================================================================================================================
// Make a v2 synth through the editor opened from the instrument picker; returns the new sound id.
async function makeSynth(page, { play = false } = {}) {
  const sel = page.locator('select[aria-label="Instrument of the active layer"], [aria-label="Instrument of the active layer"] select').first();
  await sel.selectOption('__newsynth');
  await page.waitForFunction(() => VH.synthEditor.isOpen);
  const preset = page.locator('select.vh-se-preset');
  const opts = await preset.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  expect(opts.length).toBeGreaterThan(1);
  await preset.selectOption(opts[1]);
  let voiced = null;
  if (play) {
    const audio = await audioOr(page, 'synth editor voice');
    await page.locator('.vh-se-save').focus();
    await page.keyboard.down('a');
    if (audio) {
      await expect.poll(async () => (await stats(page)).v2Live, { timeout: 5000 }).toBeGreaterThan(0);
      voiced = true;
    }
    await page.keyboard.up('a');
  }
  const ids0 = await page.evaluate(() => VH.sounds.list().map((s) => s.id));
  await page.locator('.vh-se-save').click();
  await page.waitForFunction(() => !VH.synthEditor.isOpen);
  const id = await page.evaluate((old) => VH.sounds.list().map((s) => s.id).find((x) => !old.includes(x)), ids0);
  expect(id, 'a new instrument was saved').toBeTruthy();
  return { id, voiced };
}

test.describe('4 share', () => {
  test('share link round trip in a new context, v2 synth installed', async ({ page, browser }) => {
    await open(page);
    const { id } = await makeSynth(page);
    await expect.poll(async () => (await song(page)).layers[0].sound).toBe(id);
    await drawStroke(page);
    const S = await song(page);
    await page.locator('.mel-dock-share').click();
    await page.waitForFunction(() => /#melody\/s=/.test(location.hash));
    const hash = await page.evaluate(() => location.hash);

    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    const errs = watch(p2);
    await open(p2, hash);
    await expect.poll(async () => JSON.stringify((await song(p2)).layers.map((l) => l.lines))).toBe(JSON.stringify(S.layers.map((l) => l.lines)));
    const S2 = await song(p2);
    expect(S2.chords).toEqual(S.chords);
    expect(S2.bpm).toBe(S.bpm);
    expect(S2.layers.map((l) => l.notes)).toEqual(S.layers.map((l) => l.notes));
    // The editor synth travelled in the link and was installed as a v2 synth (not a fallback).
    await expect.poll(() => p2.evaluate(() => { const S = JSON.parse(VH.melody.song()), s = VH.sounds.get(S.layers[0].sound); return !!(s && VH.sounds.isV2(s)); })).toBe(true);
    expect(errs).toEqual([]);
    await ctx2.close();
  });
});

// =====================================================================================================================
test.describe('5 synth editor', () => {
  test('opens from the picker, a preset plays, Save as instrument', async ({ page }) => {
    await open(page);
    const { id } = await makeSynth(page, { play: true });
    const ok = await page.evaluate((x) => { const s = VH.sounds.get(x); return !!s && VH.sounds.isV2(s); }, id);
    expect(ok).toBe(true);
    await expect.poll(async () => (await song(page)).layers[0].sound).toBe(id);
  });
});

// =====================================================================================================================
test.describe('6 import', () => {
  test('a 220 Hz WAV imports as an instrument', async ({ page }) => {
    await open(page);
    const sel = page.locator('[aria-label="Instrument of the active layer"]').first();
    const chooser = page.waitForEvent('filechooser');
    await sel.selectOption('__import');
    await (await chooser).setFiles({ name: 'tone220.wav', mimeType: 'audio/wav', buffer: toneWav(220) });
    const dlg = page.locator('.vh-imp');
    await expect(dlg).toBeVisible();
    if (!(await hasAudio(page))) {
      // Without Web Audio nothing can be decoded: the dialog must say so instead of throwing.
      test.info().annotations.push({ type: 'no-webaudio', description: 'skipped: decode / import' });
      await expect(dlg).toContainText(/could not be decoded/);
      return;
    }
    await expect(dlg).toContainText('A3');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => page.evaluate(() => VH.sounds.list().filter((s) => s.source === 'import').length)).toBe(1);
    const id = await page.evaluate(() => VH.sounds.list().find((s) => s.source === 'import').id);
    await expect.poll(async () => (await song(page)).layers[0].sound).toBe(id);
    // The stored audio comes back from IndexedDB and plays.
    const zone = await page.evaluate((x) => VH.sounds.get(x).sampler.zones[0], id);
    expect(zone.blobKey).toBeTruthy();
    expect(await page.evaluate((k) => VH.store.getBlob(k).then((b) => b && b.size), zone.blobKey)).toBeGreaterThan(1000);
  });
});

test.describe('6b import MP3 (decode)', () => {
  test('an MP3 exported by the app imports again', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'MP3 decode'))) return;
    test.skip(!(await page.request.get('/js/vendor/lamejs/lame.min.js')).ok(), 'lamejs not available');
    await openPanel(page, 'Export');
    await page.getByRole('button', { name: /Export…/ }).click();
    await page.locator('.mx-fmt button', { hasText: 'MP3' }).click();
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('.mx-go').click();
    const mp3 = fs.readFileSync(await (await dl).path());
    await page.locator('.mx-x').click();
    await page.locator('.vh-settings-btn').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[aria-label="Instrument of the active layer"]').first().selectOption('__import');
    await (await chooser).setFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: mp3 });
    const dlg = page.locator('.vh-imp');
    await expect(dlg).toBeVisible();
    await expect(dlg).not.toContainText('could not be decoded');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => page.evaluate(() => VH.sounds.list().filter((s) => s.source === 'import').length)).toBe(1);
  });
});

// =====================================================================================================================
test.describe('3b sampled instrument', () => {
  test('a sampled (MP3) instrument plays and renders to WAV', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'sampler'))) return;
    await page.evaluate(() => VH.sounds.ready);
    const sel = page.locator('[aria-label="Instrument of the active layer"]').first();
    const id = await page.evaluate(() => (VH.sounds.list().find((s) => s.kind === 'sampler' && s.source === 'sample') || {}).id);
    expect(id, 'a sampled instrument in the library').toBeTruthy();
    await sel.selectOption(id);
    await expect.poll(async () => (await song(page)).layers[0].sound).toBe(id);
    await drawStroke(page, 0.05, 0.5);
    await openPanel(page, 'Export');
    await page.getByRole('button', { name: /Export…/ }).click();
    await page.locator('.mx-fmt button', { hasText: 'WAV' }).click();
    await page.locator('.mx-scope button', { hasText: 'Chosen parts' }).click();
    // only the sampled layer: untick backing and drums
    for (const c of await page.locator('.mx-backing input, .mx-drums input').all()) if (await c.isChecked() && await c.isEnabled()) await c.uncheck();
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('.mx-go').click();
    const w = parseWav(fs.readFileSync(await (await dl).path()));
    expect(w.rms).toBeGreaterThan(0.003);
  });
});

// =====================================================================================================================
// Older WebKit (Safari < 14.1) and Firefox lack some Web Audio API pieces. Remove them and check the app still works.
test.describe('10 legacy Web Audio fallbacks (emulated)', () => {
  test('no StereoPanner / cancelAndHold / OfflineAudioContext.suspend, callback-only decode and render', async ({ page }) => {
    await page.addInitScript(() => {
      if (typeof BaseAudioContext !== 'function') return;
      delete BaseAudioContext.prototype.createStereoPanner;
      delete AudioParam.prototype.cancelAndHoldAtTime;
      delete OfflineAudioContext.prototype.suspend;
      const dec = BaseAudioContext.prototype.decodeAudioData;
      BaseAudioContext.prototype.decodeAudioData = function (ab, ok, err) { dec.call(this, ab).then(ok, err); };
      const ren = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function () { ren.call(this); };   // result only via oncomplete
    });
    await open(page);
    if (!(await audioOr(page, 'legacy Web Audio'))) return;
    expect(await page.evaluate(() => typeof AudioContext.prototype.createStereoPanner)).toBe('undefined');
    // a v2 synth (pan stage) + a pan automation lane (B2 channel panner)
    await makeSynth(page);
    const add = page.locator('select[aria-label="Add an automation lane"]');
    const pan = await add.locator('option').evaluateAll((os) => (os.find((o) => /pan/i.test(o.textContent)) || {}).value);
    if (pan) await add.selectOption(pan);
    await drawStroke(page, 0.05, 0.5);
    await dockBtn(page, 'Play').click();
    await page.waitForTimeout(800);
    expect((await stats(page)).starts).toBeGreaterThan(0);
    await page.keyboard.press('Space');
    await openPanel(page, 'Export');
    await page.getByRole('button', { name: /Export…/ }).click();
    await page.locator('.mx-fmt button', { hasText: 'WAV' }).click();
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('.mx-go').click();
    const w = parseWav(fs.readFileSync(await (await dl).path()));
    expect(w.rms).toBeGreaterThan(0.005);
    await page.locator('.mx-x').click();
    await page.locator('.vh-settings-btn').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[aria-label="Instrument of the active layer"]').first().selectOption('__import');
    await (await chooser).setFiles({ name: 'tone220.wav', mimeType: 'audio/wav', buffer: toneWav(220) });
    await expect(page.locator('.vh-imp')).toContainText('A3');
  });
});

// =====================================================================================================================
// Safari reports a trackpad pinch as gesturestart / gesturechange (scale), not Ctrl + wheel. Synthesized here, since
// Playwright can't produce real GestureEvents; checks the map zooms and the page itself does not (defaultPrevented).
test.describe('11 Safari pinch (gesture events)', () => {
  const pinch = (page, sel, scale) => page.evaluate(([sel, scale]) => {
    const cv = document.querySelector(sel), r = cv.getBoundingClientRect(), out = [];
    for (const [type, s] of [['gesturestart', 1], ['gesturechange', scale], ['gestureend', scale]]) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, { scale: { value: s }, clientX: { value: r.left + r.width / 2 }, clientY: { value: r.top + r.height / 2 } });
      cv.dispatchEvent(e); out.push(e.defaultPrevented);
    }
    return out.every(Boolean);
  }, [sel, scale]);
  test('pinch zooms the Melody map and the Babel map', async ({ page }) => {
    await open(page);
    const span = () => page.evaluate(() => VH.melody.ctx.view.span), s0 = await span();
    expect(await pinch(page, 'canvas[aria-label="Melody drawing area over the harmony map"]', 2)).toBe(true);
    expect(await span()).toBeLessThan(s0);
    await page.evaluate(() => { location.hash = '#babel'; });
    await page.waitForFunction(() => VH.app.current === 'babel');
    await pinch(page, 'canvas[aria-label="Map of sounds in eight biomes"]', 0.8);   // saves a view to compare with
    const z0 = await page.evaluate(() => JSON.parse(localStorage.getItem('vh:babel.view')).zoom);
    expect(z0).toBeGreaterThan(0);
    expect(await pinch(page, 'canvas[aria-label="Map of sounds in eight biomes"]', 2)).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vh:babel.view') || '{}').zoom)).toBeGreaterThan(z0 * 1.5);
  });
});

// =====================================================================================================================
test.describe('7 babel', () => {
  test('click to play, Detector toggle, Save', async ({ page }) => {
    await open(page, '#babel');
    const cv = page.locator('canvas[aria-label="Map of sounds in eight biomes"]');
    const b = await box(cv);
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await page.waitForFunction(() => !!VH.babel.current);
    if (await audioOr(page, 'babel playback')) await expect.poll(async () => (await stats(page)).state).toBe('running');
    const det = dockBtn(page, 'Detector');
    const p0 = await det.getAttribute('aria-pressed');
    await det.click();
    await expect(det).not.toHaveAttribute('aria-pressed', String(p0));
    await det.click();
    await expect(det).toHaveAttribute('aria-pressed', String(p0));
    await dockBtn(page, 'Save').click();
    const form = page.locator('form:visible').filter({ has: page.locator('input[type=text]') }).first();
    await expect(form).toBeVisible();
    await form.locator('button[type=submit], button').first().click();
    await expect(page.getByText(/★ Saved/)).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => VH.sounds.list().filter((s) => s.source === 'babel').length)).toBe(1);
  });
});

// =====================================================================================================================
test.describe('8 spiral', () => {
  test('a chord via chord mode shows the meter; Latch holds', async ({ page }) => {
    await open(page, '#spiral');
    const cv = page.locator('canvas[aria-label="Pitch spiral instrument"]');
    const b = await box(cv);
    await tap(page, dockBtn(page, 'Single'));
    await expect(page.locator('.sp-pop')).toBeVisible();
    await page.waitForTimeout(250);   // pop-in animation
    await tap(page, page.locator('.sp-chip[data-chord]').nth(1));   // Maj
    await expect(page.locator('.sp-chip[aria-pressed="true"]')).toHaveCount(1);
    await tap(page, dockBtn(page, 'Latch'));
    await expect(page.locator('.sp-latchnote')).toBeVisible();
    const audio = await audioOr(page, 'spiral voices');
    await page.mouse.click(b.x + b.width * 0.5 + Math.min(b.width, b.height) * 0.3, b.y + b.height * 0.5);
    // the meter: 3 latched notes are analysed (chord readout + "Send to Melody" box with the chord name)
    await expect(page.locator('.sp-send')).toBeVisible();
    await expect(page.locator('.sp-send button').first()).toContainText(/Melody · \S+/);
    if (audio) {
      await expect.poll(async () => (await stats(page)).live).toBeGreaterThanOrEqual(3);
      await page.waitForTimeout(500);
      expect((await stats(page)).live).toBeGreaterThanOrEqual(3);   // still held after release (latched)
    }
  });
});

// =====================================================================================================================
test.describe('9 audio unlock', () => {
  const unlock = async (page, act) => {
    await open(page, '#spiral');
    if (!(await audioOr(page, 'audio unlock'))) return;
    expect((await stats(page)).state).not.toBe('running');
    const b = await box(page.locator('canvas[aria-label="Pitch spiral instrument"]'));
    await act(b);
    await expect.poll(async () => (await stats(page)).state).toBe('running');
  };
  test('AudioContext runs after the first click', async ({ page }) => {
    await unlock(page, (b) => page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.2));
  });
  test('AudioContext runs after the first key', async ({ page }) => {
    await unlock(page, async () => { await page.locator('body').focus(); await page.keyboard.press('a'); });
  });
  test('AudioContext runs after a click on plain UI (no sound played)', async ({ page }) => {
    await unlock(page, () => page.locator('.vh-settings-btn').click());
  });
  test.describe('touch', () => {
    test.use({ hasTouch: true });
    test('AudioContext runs after the first tap', async ({ page }) => {
      await unlock(page, (b) => page.touchscreen.tap(b.x + b.width / 2, b.y + b.height * 0.2));
    });
  });
});

test.describe('12 backing track', () => {
  test('import a 90 BPM beat: tempo, chords, key, WAV export with the track, share note', async ({ page }) => {
    test.setTimeout(120_000);
    const G = require('../test/beatgen.js');
    const beat = G.makeBeat({ bpm: 90, bars: 8 });
    await open(page);
    await openPanel(page, 'Song');
    const btn = page.locator('.mel-track-import');
    await btn.scrollIntoViewIfNeeded();
    const chooser = page.waitForEvent('filechooser');
    await btn.click();
    await (await chooser).setFiles({ name: 'beat90.wav', mimeType: 'audio/wav', buffer: Buffer.from(G.wavBytes(beat.x, beat.sr)) });
    if (!(await audioOr(page, 'backing track decode + analysis'))) {
      await expect(page.locator('.mel-toast')).toContainText(/Could not use that file/);
      return;
    }
    await expect.poll(() => page.evaluate(() => !!(VH.melody.trackPart && VH.melody.trackPart.ready() && VH.melody.ctx.song.track)), { timeout: 60_000 }).toBe(true);
    const S = await song(page);
    expect(Math.abs(S.bpm - 90)).toBeLessThanOrEqual(1);
    expect(Math.abs(S.track.offsetSec - beat.downbeats[0])).toBeLessThan(0.03);
    expect(S.backing.on).toBe(false);
    expect(S.sections[0].name).toBe('Track A');
    const bars = await page.evaluate(() => { const M = VH.melody.ctx; return M.model.barChords(M.song); });
    const ok = bars.filter((c, i) => c && c[0] === beat.chords[i][0] && c[1] === beat.chords[i][1]).length;
    expect(ok).toBeGreaterThanOrEqual(6);
    expect([S.key, S.mode]).toEqual([0, 'major']);
    // the harmony map follows the audio
    expect(await page.evaluate(() => VH.melody.ctx.bandsAt(1).track)).toBe(true);
    // WAV: no notes drawn, so everything audible is the track
    await openPanel(page, 'Export');
    await page.getByRole('button', { name: /Export…/ }).click();
    await page.locator('.mx-fmt button', { hasText: 'MIDI' }).click();
    await expect(page.locator('.mx-dlg .mx-note')).toContainText('backing track');
    await page.locator('.mx-fmt button', { hasText: 'WAV' }).click();
    await expect(page.locator('.mx-track')).toHaveCount(1);
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('.mx-go').click();
    const w = parseWav(fs.readFileSync(await (await dl).path()));
    expect(w.seconds).toBeGreaterThanOrEqual(8 * 4 * 60 / 90);
    expect(w.rms).toBeGreaterThan(0.03);
    // share: the track stays local, the note says so
    const sh = await page.evaluate(async () => { const M = VH.melody.ctx; await M.share(); const o = await VH.store.decodeShare(await M.shareCode()); return { track: !!o.track, backing: o.backing.on }; });
    expect(sh).toEqual({ track: false, backing: true });
    await expect(page.locator('.mel-sharebox .mel-share-note')).toContainText('stays on your device');
  });
});

test.describe('13 storage housekeeping', () => {
  test('blob GC keeps referenced audio and drops orphans; tidy removes old keys', async ({ page }) => {
    await open(page, '#spiral');
    const r = await page.evaluate(async () => {
      // blobs written "by an earlier session": straight into IndexedDB, not through VH.store.putBlob
      const db = await new Promise((res, rej) => { const q = indexedDB.open('visual-harmonics', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const put = (k) => new Promise((res) => { const t = db.transaction('blobs', 'readwrite'); t.objectStore('blobs').put(new Blob(['x']), k); t.oncomplete = res; });
      for (const k of ['imp-keep', 'track:keep', 'track:keep:an', 'babel-orphan', 'track:orphan', 'track:orphan:an']) await put(k);
      const sounds = VH.store.get('sounds', []);
      VH.store.set('sounds', sounds.concat([{ id: 'imp-keep', name: 'Kept', kind: 'sampler', source: 'import', sampler: { zones: [{ blobKey: 'imp-keep', rootMidi: 60 }] }, spectrum: [[1, 1]] }]));
      VH.store.set('melody.song', Object.assign(VH.store.get('melody.song', {}) || {}, { track: { blobKey: 'track:keep' } }));
      localStorage.setItem('vh:babel.rarity', '1'); localStorage.setItem('vh:babel.radar', 'true');
      const gone = VH.store.tidy();
      const first = await VH.store.gcBlobs({ graceMs: 0 });          // marks orphans only
      const second = await VH.store.gcBlobs({ graceMs: 0 });         // now deletes them
      VH.store.set('sounds', sounds);
      return { gone, first: first.deleted, second: second.deleted.sort(), left: (await VH.store.blobKeys()).sort() };
    });
    expect(r.gone.sort()).toEqual(['vh:babel.radar', 'vh:babel.rarity']);
    expect(r.first).toEqual([]);
    expect(r.second).toEqual(['babel-orphan', 'track:orphan', 'track:orphan:an']);
    for (const k of ['imp-keep', 'track:keep', 'track:keep:an']) expect(r.left).toContain(k);
    for (const k of r.second) expect(r.left).not.toContain(k);
  });
});

// =====================================================================================================================
test.describe('14 playback + editing regressions', () => {
  // Log every voice the page starts: { hz, t0, ct } (the engine looks VH.audio.voice up per call).
  const spyVoices = (page) => page.evaluate(() => {
    const orig = VH.audio.voice; window.__v = [];
    VH.audio.voice = function (s, hz) { const v = orig.apply(this, arguments); window.__v.push({ hz, t0: v.t0, ct: VH.audio.ctx ? VH.audio.ctx.currentTime : 0 }); return v; };
  });
  const voicesAt = (page, midi) => page.evaluate((m) => window.__v.filter((x) => Math.abs(x.hz - VH.audio.midiToHz(m)) < 0.01).length, midi);

  test('a note at time 0 plays, in section 1 and at a later section start (Song mode)', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'note voices'))) return;
    await page.evaluate(() => {
      const M = VH.melody.ctx;
      M.setBars(1); M.song.bpm = 200; M.song.loop = false;
      M.song.layers[0].mode = 'notes'; M.song.layers[0].notes = [{ s: 0, d: 2, m: 72 }]; M.commit('note A');
      M.addSection(false); M.song.layers[0].notes = [{ s: 0, d: 2, m: 74 }]; M.commit('note B');
      M.selectSection(0); M.setPlayMode('song');
    });
    await spyVoices(page);
    await dockBtn(page, 'Play').click();
    await expect.poll(() => voicesAt(page, 72), { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(() => voicesAt(page, 74), { timeout: 5000 }).toBeGreaterThan(0);
    await page.keyboard.press('Space');
  });

  test('a loop region over part of the section repeats only those bars; Section mode loops without one', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { const M = VH.melody.ctx; M.setPlayMode('section'); M.song.bpm = 200; M.setLoopRegion([1, 2]); });
    await dockBtn(page, 'Play').click();
    const pos = [];
    for (let i = 0; i < 30; i++) { await page.waitForTimeout(100); pos.push(await page.evaluate(() => VH.melody.ctx.engine.pos16)); }
    expect(pos.every((p) => p >= 16 && p < 32), pos.join(',')).toBe(true);
    expect(pos.some((p, i) => i && p < pos[i - 1]), 'wrapped: ' + pos.join(',')).toBe(true);
    // no region and Loop off: Section mode still loops the section (Loop is about the end of the song in Song mode)
    await page.evaluate(() => { const M = VH.melody.ctx; M.setLoopRegion(null); M.song.loop = false; M.setBars(1); M.engine.seek(12); });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => VH.melody.ctx.engine.playing)).toBe(true);
    await page.keyboard.press('Space');
  });

  test('undo / redo keep Snap, the tool, the look and the zoom', async ({ page }) => {
    await open(page);
    const prefs = () => page.evaluate(() => { const M = VH.melody.ctx; return { snap: M.song.snap, tool: M.tools.current.id, look: localStorage.getItem('vh:melody.look'), span: M.view.span }; });
    await page.locator('body').focus();
    await page.keyboard.press('s');   // snap on
    await page.keyboard.press('=');   // zoom in
    await page.keyboard.press('v');   // Select tool
    const p0 = await prefs();
    expect(p0.snap).toBe(true);
    await page.evaluate(() => { const M = VH.melody.ctx; M.song.layers[0].notes.push({ s: 0, d: 2, m: 60 }); M.commit('edit'); });
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+z');
    expect(await prefs()).toEqual(p0);
    await page.keyboard.press('s');   // off, then an edit + undo: stays off
    await page.evaluate(() => { const M = VH.melody.ctx; M.song.layers[0].notes.push({ s: 2, d: 2, m: 62 }); M.commit('edit 2'); });
    await page.keyboard.press('Control+z');
    expect((await prefs()).snap).toBe(false);
  });

  test('hidden tab: a Worker tick keeps scheduling ahead, in step with the audio clock', async ({ page }) => {
    await open(page);
    if (!(await audioOr(page, 'background scheduling'))) return;
    await page.evaluate(() => {
      const M = VH.melody.ctx; M.setBars(4); M.song.bpm = 120;
      M.song.layers[0].mode = 'notes'; M.song.layers[0].notes = Array.from({ length: 16 }, (_, k) => ({ s: k * 4, d: 2, m: 60 + (k % 5) })); M.commit('notes');
    });
    await dockBtn(page, 'Play').click();
    await page.waitForTimeout(600);
    await spyVoices(page);
    // background: rAF no longer steps the engine (main.js skips it while hidden) and page timers fire at most once a second
    await page.evaluate(() => {
      const si = window.setInterval, st = window.setTimeout;
      window.setInterval = (f, ms, ...a) => si(f, Math.max(1000, ms || 0), ...a);
      window.setTimeout = (f, ms, ...a) => st(f, Math.max(1000, ms || 0), ...a);
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.__bg = { c0: VH.melody.ctx.engine.cont16, t0: VH.audio.ctx.currentTime };
    });
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => {
      const E = VH.melody.ctx.engine, sec = E.secPer16(), now = VH.audio.ctx.currentTime;
      return { bgAhead: E.bgAhead, moved: (E.cont16 - window.__bg.c0) * sec, audio: now - window.__bg.t0,
        ahead: Math.max(...window.__v.map((x) => x.t0 - x.ct)), n: window.__v.length };
    });
    expect(r.bgAhead).toBe(1.5);
    expect(r.n, 'notes scheduled while hidden').toBeGreaterThan(2);
    expect(r.ahead, 'scheduled well ahead').toBeGreaterThan(0.5);
    expect(Math.abs(r.moved - r.audio), JSON.stringify(r)).toBeLessThan(0.15);
    await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => VH.melody.ctx.engine.playing)).toBe(true);
    await page.keyboard.press('Space');
  });

  test('a tool key right after picking an instrument in a select switches the tool, not the select', async ({ page }) => {
    await open(page);
    const sel = page.locator('.vh-dock select').first();
    const vals = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => !/^__/.test(v)));
    const cur = await sel.inputValue(), v = vals.find((x) => x !== cur);
    await sel.selectOption(v);
    await sel.focus();
    await page.keyboard.press('v');
    await expect.poll(() => page.evaluate(() => VH.melody.ctx.tools.current.id)).toBe('select');
    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => VH.melody.ctx.tools.current.id)).toBe('pen');
    expect(await sel.inputValue()).toBe(v);
  });

  test('a share link made on the last section with a loop region opens at section 1, time 0, no loop', async ({ page, browser }) => {
    await open(page);
    const code = await page.evaluate(async () => {
      const M = VH.melody.ctx;
      M.addSection(false); M.addSection(false);
      M.setLoopRegion([1, 2]); M.engine.seek(20);
      return M.shareCode();
    });
    const ctx2 = await browser.newContext(), p2 = await ctx2.newPage();
    const errs = watch(p2);
    await open(p2, '#melody/s=' + code);
    await expect.poll(() => p2.evaluate(() => VH.melody.ctx.song.sections.length)).toBe(3);
    const st = await p2.evaluate(() => {
      const M = VH.melody.ctx, S = M.song;
      return { cur: S.cur, phase: M.engine.phase, cue: M.engine.cue, region: S.loopRegion, others: S.sections.map((x) => x.data && x.data.loopRegion).filter(Boolean), mode: M.playMode };
    });
    expect(st).toEqual({ cur: 0, phase: 0, cue: null, region: null, others: [], mode: 'song' });
    expect(errs).toEqual([]);
    await ctx2.close();
  });

  test('backing arpeggio: 1/16 T and 1/32 rates; the default stays 1/8', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const snd = VH.melody.sound, ev = (rate) => snd.backingEvents('arp', [60, 64, 67], 0.1, rate ? { rate } : {}, 0, { ts: '4/4' }).length;
      return { choices: snd.STYLE_CHOICES.arp.rate.map((x) => x[0]), def: snd.STYLE_DEF.arp.rate, n8: ev(null), n16t: ev('1/16t'), n32: ev('1/32') };
    });
    expect(r.choices).toEqual(expect.arrayContaining(['1/16t', '1/32']));
    expect([r.def, r.n8, r.n16t, r.n32]).toEqual(['1/8', 8, 24, 32]);
  });

  test('phone notice: shown on a small screen until dismissed, never at desktop size', async ({ page, browser }) => {
    await open(page);
    await expect(page.locator('#banner')).toBeHidden();
    expect(await page.evaluate(() => VH.store.KEYS.includes('ui.phoneNotice'))).toBe(true);
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } }), p2 = await ctx2.newPage();
    const errs = watch(p2);
    await open(p2);
    const ban = p2.locator('#banner');
    await expect(ban).toBeVisible();
    await expect(ban).toContainText('Best on a computer');
    await ban.locator('.vh-banner-x').click();
    await expect(ban).toBeHidden();
    await p2.reload();
    await p2.waitForFunction(() => window.VH && VH.app && VH.app.current);
    await expect(p2.locator('#banner')).toBeHidden();
    expect(errs).toEqual([]);
    await ctx2.close();
  });
});

// =====================================================================================================================
// Graph editor: finer grids, ruler, scroll bar, edge margins, hold-and-drag notes, wider range + scrolling + time stretch.
test.describe('15 graph editor', () => {
  // canvas geometry (CSS px, relative to the canvas) + view state
  const geo = (page) => page.evaluate(() => { const V = VH.melody.ctx.view; return { X0: V.X0, Y0: V.Y0, RL: V.RL, HDR: V.HDR, U: V.U(), BW: V.BW, CW: V.CW, GW: V.GW, scrollX: V.scrollX, span: V.span, pTop: V.pTop, MH: V.MH, PPS: V.PPS(), tz: V.tz }; });
  const toNotes = (page) => page.evaluate(() => { const M = VH.melody.ctx; M.setActive(1); M.song.layers[1].notes.length = 0; M.song.snap = false; M.requestRender(); });
  const noteCell = async (page, t16, m) => {   // page coords of sixteenth t16 and midi m
    const b = await box(melCanvas(page)), g = await geo(page);
    const y = await page.evaluate((m) => VH.melody.ctx.view.yOf(m), m);
    return [b.x + g.X0 + t16 * g.U - g.scrollX, b.y + y];
  };

  test('grids 1/32 and 1/16T: selectable, 1/32 notes place and round-trip, old songs keep 1/8', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent))).toEqual(expect.arrayContaining(['1/8', '1/16', '1/32', '1/8T', '1/16T']));
    await toNotes(page);
    await page.evaluate(() => { VH.melody.ctx.song.grid = 32; });
    const [x, y] = await noteCell(page, 3.3, 60);
    await page.mouse.click(x, y);
    let notes = (await song(page)).layers[1].notes;
    expect(notes).toEqual([[3, 0.5, 60]]);
    await page.evaluate(() => { VH.melody.ctx.song.layers[1].notes.length = 0; VH.melody.ctx.song.grid = 24; });
    const [x2, y2] = await noteCell(page, 3.4, 62);
    await page.mouse.click(x2, y2);
    notes = (await song(page)).layers[1].notes;
    expect(notes.length).toBe(1);
    expect(notes[0][0]).toBeCloseTo(3.33333, 4);
    expect(notes[0][1]).toBeCloseTo(0.66667, 4);
    const rt = await page.evaluate(() => {
      const md = VH.melody.model, o = JSON.parse(VH.melody.song()), p = md.parse(o);
      const old = md.parse(Object.assign({}, o, { grid: undefined })), bad = md.parse(Object.assign({}, o, { grid: 5 }));
      return { grid: p.grid, notes: p.layers[1].notes, old: old.grid, bad: bad.grid };
    });
    expect(rt.grid).toBe(24); expect(rt.old).toBe(8); expect(rt.bad).toBe(8);
    expect(rt.notes[0].d).toBeCloseTo(2 / 3, 4);
  });

  test('ruler seeks and never edits chords; the chord strip never seeks', async ({ page }) => {
    await open(page);
    const b = await box(melCanvas(page)), g = await geo(page), chords0 = (await song(page)).chords;
    await page.evaluate(() => VH.melody.ctx.engine.seek(1));
    await page.mouse.click(b.x + g.X0 + g.BW * 2 + 5, b.y + g.RL / 2);
    const cue = await page.evaluate(() => VH.melody.ctx.engine.cue);
    expect(cue).toBeGreaterThan(30); expect(cue).toBeLessThan(36);
    expect((await song(page)).chords).toEqual(chords0);
    await page.evaluate(() => VH.melody.ctx.engine.seek(20));
    await page.mouse.click(b.x + g.X0 + 4, b.y + g.RL + 8);   // empty chord-strip space, top part (no split "+")
    expect(await page.evaluate(() => VH.melody.ctx.engine.cue)).toBe(20);
    // dragging along the ruler scrubs
    await page.mouse.move(b.x + g.X0 + 10, b.y + g.RL / 2); await page.mouse.down();
    await page.mouse.move(b.x + g.X0 + g.BW * 3, b.y + g.RL / 2, { steps: 5 }); await page.mouse.up();
    expect(await page.evaluate(() => VH.melody.ctx.engine.cue)).toBeGreaterThan(40);
    expect((await song(page)).chords).toEqual(chords0);
  });

  test('horizontal scroll bar: thumb ~ visible fraction, drags, hidden when it all fits', async ({ page }) => {
    await open(page);
    const bar = page.locator('.mel-hbar');
    await expect(bar).toBeHidden();
    await page.evaluate(() => VH.melody.ctx.setBars(16));
    await expect(bar).toBeVisible();
    const g = await geo(page), tb = await box(bar), th = await box(page.locator('.mel-hbar-thumb'));
    expect(th.width / tb.width).toBeGreaterThan(g.GW / g.CW - 0.03);
    expect(th.width / tb.width).toBeLessThan(g.GW / g.CW + 0.03);
    await page.mouse.move(th.x + th.width / 2, th.y + th.height / 2); await page.mouse.down();
    await page.mouse.move(th.x + th.width / 2 + 80, th.y + th.height / 2, { steps: 4 }); await page.mouse.up();
    expect((await geo(page)).scrollX).toBeGreaterThan(100);
    await page.mouse.click(tb.x + 3, tb.y + tb.height / 2);   // track click left of the thumb = page back
    expect((await geo(page)).scrollX).toBe(0);
    await page.evaluate(() => VH.melody.ctx.setBars(2));
    await expect(bar).toBeHidden();
  });

  test('edge margin: a press 8px left of the graph starts a stroke at time 0', async ({ page }) => {
    await open(page);
    const b = await box(melCanvas(page)), g = await geo(page);
    await page.evaluate(() => { const M = VH.melody.ctx; M.setActive(0); M.song.layers[0].lines.length = 0; });
    const y = b.y + g.Y0 + g.MH / 2;
    await page.mouse.move(b.x + g.X0 - 8, y); await page.mouse.down();
    await page.mouse.move(b.x + g.X0 + 60, y - 10, { steps: 4 }); await page.mouse.up();
    const first = await page.evaluate(() => { const v = VH.melody.ctx.song.layers[0].lines[0].v; return [v[0], v.findIndex((x) => !Number.isNaN(x))]; });
    expect(first[1]).toBe(0); expect(Number.isNaN(first[0])).toBe(false);
  });

  test('notes: press + drag right and up makes one longer, higher note; one undo removes it', async ({ page }) => {
    await open(page);
    await toNotes(page);
    await page.evaluate(() => { VH.melody.ctx.song.grid = 16; });
    const [x, y] = await noteCell(page, 2.5, 60), g = await geo(page);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 1.5 * g.U, y - 30, { steps: 4 });
    await page.mouse.move(x + 2 * g.U, y - 30, { steps: 3 });
    await page.mouse.up();
    let notes = (await song(page)).layers[1].notes;
    expect(notes.length).toBe(1);
    expect(notes[0][0]).toBe(2); expect(notes[0][1]).toBe(3); expect(notes[0][2]).toBeGreaterThan(60);
    await page.keyboard.press('Control+z');
    expect((await song(page)).layers[1].notes.length).toBe(0);
    // drag left of the start: the note spans the dragged range
    const [x2, y2] = await noteCell(page, 8.5, 60);
    await page.mouse.move(x2, y2); await page.mouse.down();
    await page.mouse.move(x2 - 2 * g.U, y2, { steps: 5 }); await page.mouse.up();
    notes = (await song(page)).layers[1].notes;
    expect(notes[0].slice(0, 2)).toEqual([6, 3]); expect(notes[0][2]).toBe(60);
  });

  test('range: an octave more each way, pitch scroll, time stretch (stored)', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => [VH.melody.model.LO, VH.melody.model.HI]);
    expect(r[0]).toBeLessThanOrEqual(36); expect(r[1]).toBeGreaterThanOrEqual(96);
    const b = await box(melCanvas(page)), g = await geo(page);
    await page.mouse.move(b.x + b.width / 2, b.y + g.Y0 + g.MH / 2);
    await page.mouse.wheel(0, 200);
    expect((await geo(page)).pTop).toBeLessThan(g.pTop);   // wheel down = lower pitches
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 400);
    const low = await geo(page);
    expect(low.pTop - low.span).toBeLessThan(40);          // reaches below the old C3 floor (48)
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400);
    const hi = await geo(page);
    expect(hi.pTop).toBeGreaterThan(90);
    await page.getByRole('button', { name: /Stretch time/ }).click();
    const g2 = await geo(page);
    expect(g2.BW).toBeGreaterThan(g.BW * 1.2); expect(g2.tz).toBeCloseTo(1.25, 2);
    await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('vh:melody.view') || '{}')).tz)).toBeCloseTo(1.25, 2);
    await page.mouse.move(b.x + b.width / 2, b.y + g.Y0 + g.MH / 2);
    await page.keyboard.down('Alt'); await page.mouse.wheel(0, 300); await page.keyboard.up('Alt');
    expect((await geo(page)).tz).toBeLessThan(1.25);
  });
});
