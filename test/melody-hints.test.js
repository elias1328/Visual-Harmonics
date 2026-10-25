// Chord hints (bands.js NS.hintCandidates): where a new note fits with what already sounds.
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || { VH: {} };
require('../js/core/store.js');
global.window.VH.harmony = require('../js/core/harmony.js');
require('../js/exp/melody/model.js');
require('../js/exp/melody/bands.js');
const VH = global.window.VH, NS = VH.melody, H = VH.harmony;
const spec = [1, 2, 3, 4, 5, 6].map((k) => [k, 0.88 ** (k - 1)]);   // a plucked / piano-like harmonic spectrum
const tone = (m) => ({ hz: H.midiToHz(m), m, spec });

test('C1: with C4 sounding, hints below it are fifths / fourths / sixths and never the semitone clashes', () => {
  const c = NS.hintCandidates([tone(60)], spec, 48, 59.5, { n: 4 }), ms = c.map((x) => x.m);
  assert.ok(ms.length >= 3 && c[0].c > 0.9);
  assert.ok(ms.some((m) => m === 55 || m === 53 || m === 56 || m === 57 || m === 52 || m === 51), 'fifth / fourth / sixth / third region: ' + ms);
  assert.ok(!ms.includes(59) && !ms.includes(58), 'no B3 / A#3: ' + ms);
  const all = NS.hintCandidates([tone(60)], spec, 48, 72, { n: 8 }).map((x) => x.m);
  assert.ok(!all.includes(61) && !all.includes(59), 'no C#4 / B3 in the best eight: ' + all);
});
test('hints for a chord of notes: all sounding tones count, sounding pitches are not suggested', () => {
  const c = NS.hintCandidates([tone(60), tone(64)], spec, 48, 72, { n: 4 }).map((x) => x.m);
  assert.ok(!c.includes(60) && !c.includes(64));
  assert.ok(c.includes(67) || c.includes(55) || c.includes(72), 'completes the triad: ' + c);
  assert.deepEqual(NS.hintCandidates([], spec, 48, 72), []);
});
test('C4: one hint computation is fast', () => {
  const ts = [48, 55, 60, 64, 67, 72].map(tone), t0 = performance.now();
  for (let i = 0; i < 20; i++) NS.hintCandidates(ts, spec, 36, 96, { n: 4, partials: 8 });
  const ms = (performance.now() - t0) / 20;
  console.log('hint ms (6 tones, 60 semitones):', ms.toFixed(2));
  assert.ok(ms < 8);
});
