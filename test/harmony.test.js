const test = require('node:test');
const assert = require('node:assert');
const H = require('../js/core/harmony.js');

const hz = H.midiToHz;
const C4 = hz(60), Cs4 = hz(61), D4 = hz(62), E4 = hz(64), Fs4 = hz(66), G4 = hz(67), C5 = hz(72);

test('1. midiToHz', () => {
  assert.strictEqual(H.midiToHz(69), 440);
  assert.ok(Math.abs(H.midiToHz(60) - 261.6256) < 0.001);
});

test('2. noteName', () => {
  assert.strictEqual(H.noteName(60), 'C4');
  assert.strictEqual(H.noteName(66), 'F#4');
  assert.strictEqual(H.noteName(72), 'C5');
});

test('3. single note has zero dissonance', () => {
  assert.strictEqual(H.dissonance([C4]), 0);
});

test('4. fifth is less dissonant than tritone', () => {
  assert.ok(H.dissonance([C4, G4]) < H.dissonance([C4, Fs4]));
});

test('5. octave is less dissonant than minor second', () => {
  assert.ok(H.dissonance([C4, C5]) < H.dissonance([C4, Cs4]));
});

test('6. major triad is less dissonant than cluster', () => {
  assert.ok(H.dissonance([C4, E4, G4]) < H.dissonance([C4, Cs4, D4]));
});

test('7. nearestRatio simple cases', () => {
  const a = H.nearestRatio(1.5);
  assert.deepStrictEqual([a.p, a.q], [3, 2]);
  const b = H.nearestRatio(G4 / C4);
  assert.deepStrictEqual([b.p, b.q], [3, 2]);
  const c = H.nearestRatio(2);
  assert.deepStrictEqual([c.p, c.q], [2, 1]);
});

test('8. tritone has no simple ratio', () => {
  const t = H.nearestRatio(Math.SQRT2, 32, 1);
  assert.ok(t === null || t.q >= 12);
});

test('9. tenneyHeight', () => {
  assert.ok(H.tenneyHeight(3, 2) < H.tenneyHeight(45, 32));
});

test('10. octaveReduce', () => {
  assert.strictEqual(H.octaveReduce(3), 1.5);
  assert.strictEqual(H.octaveReduce(0.75), 1.5);
});

test('11. fordCircles(3)', () => {
  const fc = H.fordCircles(3);
  const xs = fc.map((c) => c.x).sort((a, b) => a - b);
  assert.deepStrictEqual(xs, [1, 4 / 3, 3 / 2, 5 / 3, 2]);
  const half = fc.find((c) => c.p === 3 && c.q === 2);
  assert.strictEqual(half.r, 1 / 8);
});

test('12. dissonanceSpectra: harmonic spectrum ranks fifth below tritone', () => {
  const spec = Array.from({ length: 8 }, (_, k) => [k + 1, 0.88 ** k]);
  assert.ok(H.dissonanceSpectra([C4, G4], spec) < H.dissonanceSpectra([C4, Fs4], spec));
  assert.strictEqual(H.dissonanceSpectra([C4], spec), 0);
});

test('13. dissonanceSpectra: a single partial makes far-apart fifth and tritone both ~0', () => {
  const sine = [[1, 1]];
  const fifth = H.dissonanceSpectra([C4, hz(79)], sine), tritone = H.dissonanceSpectra([C4, hz(78)], sine);
  assert.ok(fifth < 1e-3 && tritone < 1e-3, fifth + ' ' + tritone);
  assert.ok(H.dissonanceSpectra([C4, Cs4], sine) > 0.1);
});
