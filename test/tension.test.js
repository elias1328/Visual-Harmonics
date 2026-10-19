// Tension dial: the pure highlight mapping h(c, T) of js/exp/melody/model.js.
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || { VH: {} };
require('../js/exp/melody/model.js');
const md = global.window.VH.melody.model;

const grid = Array.from({ length: 1001 }, (_, i) => i / 1000);
const peak = (T) => grid.reduce((b, c) => (md.tensionH(c, T) > md.tensionH(b, T) + 1e-12 ? c : b), 0);

test('h(c) equals c at tension 0', () => {
  for (const c of grid) assert.strictEqual(md.tensionH(c, 0), c);
  assert.strictEqual(md.tensionTint(0), null);
});
test('the peak moves monotonically toward lower consonance as tension rises', () => {
  let prev = Infinity;
  for (let T = 0; T <= 1.0001; T += 0.02) {
    const p = peak(T);
    assert.ok(p <= prev + 1e-9, 'T=' + T.toFixed(2) + ' peak ' + p + ' > ' + prev);
    prev = p;
  }
  assert.ok(peak(0) === 1 && peak(1) === 0, 'ends: ' + peak(0) + ', ' + peak(1));
  assert.ok(Math.abs(peak(0.5) - 0.5) < 0.1, 'Color peaks at mid consonance: ' + peak(0.5));
});
test('h stays within 0..1 and morphs smoothly (no jumps between close tensions)', () => {
  for (let T = 0; T < 1; T += 0.01) for (const c of grid) {
    const a = md.tensionH(c, T), b = md.tensionH(c, T + 0.01);
    assert.ok(a >= 0 && a <= 1 + 1e-9);
    assert.ok(Math.abs(a - b) < 0.12, 'jump at c=' + c + ' T=' + T);
  }
});
test('names and warm tint', () => {
  assert.deepStrictEqual([0, 0.5, 1].map(md.tensionName), ['Calm', 'Color', 'Tense']);
  const a = md.tensionTint(0.25), b = md.tensionTint(0.5), c = md.tensionTint(1);
  assert.ok(a.c2[0] < b.c2[0] + 1e-9 && b.c2[1] > c.c2[1] && c.c2[0] === 1 && c.c2[2] < 0.3, 'cyan -> amber -> red');
});
