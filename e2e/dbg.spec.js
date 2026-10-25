const { test } = require('@playwright/test');
test('dbg', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('vh:melody.tutorial', '"done"'); });
  await page.goto('/index.html#melody');
  await page.waitForFunction(() => window.VH && VH.melody.song && VH.melody.song() && VH.melody.generatePart);
  const r = await page.evaluate(async () => {
    const lay = { id: 'l1', name: 'L', color: '#ffc93c', sound: 'pluck', mode: 'notes', vol: 0.8, lines: [], notes: [[0, 16, 60]], arp: { pat: 'up', rate: '1/16', oct: 1, from: 'chord' } };
    VH.melody.ctx.replaceSong({ v: 5, key: 0, mode: 'major', bars: 1, ts: '4/4', bpm: 120, chords: [[0, 0, 'maj']], layers: [lay], backing: { sound: 'string', vol: 0.36, on: false, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, 't');
    const log = [], o = VH.audio.voice;
    VH.audio.voice = function (s, hz, op) { log.push([+(op.when).toFixed(3), Math.round(69 + 12 * Math.log2(hz / 440))]); return o.apply(this, arguments); };
    VH.melody.ctx.engine.play();
    await new Promise((r) => setTimeout(r, 2400));
    VH.melody.ctx.engine.stop();
    return log;
  });
  console.log(JSON.stringify(r));
});
