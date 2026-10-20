// Map look: the pure clarity / thickness curve and theme stops of js/exp/melody/model.js.
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || { VH: {} };
require('../js/exp/melody/model.js');
const md = global.window.VH.melody.model;

// a bumpy highlight curve with several local maxima of different heights
const R = 301;
const t = Float32Array.from({ length: R }, (_, r) => Math.max(0, 0.5 + 0.28 * Math.sin(r / 6) + 0.2 * Math.sin(r / 2.3 + 1)) / 1.0);
for (let r = 0; r < R; r++) t[r] = Math.min(1, t[r]);
const isPeak = (a, r) => (r === 0 || a[r] >= a[r - 1]) && (r === R - 1 || a[r] > a[r + 1]);

test('clarity 0 (default thickness) is the identity', () => {
  assert.strictEqual(md.lookCurve(t, { clarity: 0, thick: 50 }), t);
});
const prom = (a, r) => { let lo = a[r]; for (let q = Math.max(0, r - 6); q <= Math.min(R - 1, r + 6); q++) lo = Math.min(lo, a[q]); return a[r] - lo; };
test('clarity 100 keeps every meaningful local maximum as a line (>= 35%), nothing between', () => {
  const o = md.lookCurve(t, { clarity: 100, thick: 50 });
  let want = 0, kept = 0;
  for (let r = 0; r < R; r++) {
    if (o[r] > 0) assert.ok(isPeak(t, r), 'row ' + r + ' is not a local maximum');
    if (isPeak(t, r) && prom(t, r) >= 0.04) { want++; if (o[r] >= 0.35 - 1e-6) kept++; assert.ok(o[r] >= t[r] - 1e-6, 'a line is never dimmer'); }
  }
  assert.ok(want > 5 && kept === want, 'kept ' + kept + ' of ' + want);
});
test('monotonic in the slider: between-line rows only fade, lines only strengthen', () => {
  let prev = md.lookCurve(t, { clarity: 0, thick: 50 });
  for (let c = 1; c <= 100; c++) {
    const o = md.lookCurve(t, { clarity: c, thick: 50 });
    for (let r = 0; r < R; r++) {
      if (isPeak(t, r) && prom(t, r) >= 0.04) assert.ok(o[r] >= prev[r] - 1e-9, 'line c=' + c + ' r=' + r);
      else assert.ok(o[r] <= prev[r] + 1e-9, 'c=' + c + ' r=' + r);
    }
    prev = o;
  }
});
test('thickness widens and thins the lines', () => {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(md.lookCurve(t, { clarity: 0, thick: 90 })) > sum(t));
  assert.ok(sum(md.lookCurve(t, { clarity: 0, thick: 10 })) < sum(t));
  const on = (o) => o.filter((v) => v > 0).length;
  assert.ok(on(md.lookCurve(t, { clarity: 100, thick: 100 })) > on(md.lookCurve(t, { clarity: 100, thick: 50 })));
});
test('themes: Aurora is unchanged and the Tension tint warms every theme', () => {
  const tint = md.tensionTint(1);
  assert.deepStrictEqual(md.lookStops('aurora', tint, 50).c2, tint.c2);
  assert.deepStrictEqual(md.lookStops('aurora', null, 50).c2, md.LOOK_THEMES.aurora.c2);
  for (const k of Object.keys(md.LOOK_THEMES)) {
    const a = md.lookStops(k, null, 50), b = md.lookStops(k, tint, 50);
    assert.ok(Math.hypot(...b.c2.map((v, i) => v - a.c2[i])) > 0.3, k + ' peak colour moves visibly');
    if (!md.LOOK_THEMES[k].hot) assert.ok(b.c2[0] >= a.c2[0] - 1e-9 && b.c2[2] <= a.c2[2] + 1e-9, k + ' moves toward warm');
  }
});
test('lookIn validates stored values', () => {
  assert.deepStrictEqual(md.lookIn(null), md.LOOK_DEFAULTS);
  const o = md.lookIn({ clarity: 250, theme: 'nope', piano: false, glow: 'x' });
  assert.strictEqual(o.clarity, 100); assert.strictEqual(o.theme, 'aurora'); assert.strictEqual(o.piano, false); assert.strictEqual(o.glow, 50);
});
