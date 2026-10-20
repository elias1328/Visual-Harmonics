// Backing-track analysis (js/core/analyze.js `track`): tempo + phase on click tracks and synthetic beats, chord
// templates on synthetic chroma, key estimation.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../js/core/analyze.js');
const G = require('./beatgen.js');
const T = A.track;

function tempoOfClicks(bpm) {
  const c = G.clicks(bpm, 20, 22050, 0.1), d = T.downsample(c.x, c.sr), on = T.onsetEnv(d.y, d.sr);
  return { r: T.tempoOf(on.env, on.fps, on.t0), c };
}
for (const bpm of [70, 90, 128, 140]) {
  test('tempo of a ' + bpm + ' BPM click track (+-1 BPM, phase +-30 ms)', () => {
    const { r, c } = tempoOfClicks(bpm), P = 60 / bpm;
    assert.ok(Math.abs(r.bpm - bpm) <= 1, 'bpm ' + r.bpm);
    const d = Math.abs(((r.phase - c.times[0]) % P + P * 1.5) % P - P / 2);
    assert.ok(d < 0.03, 'phase off by ' + d);
  });
}

const sum = (cs) => { const c = new Float64Array(12); cs.forEach(([pc, a]) => { c[pc] += a; }); return c; };
test('chord templates: synthetic chroma', () => {
  const rnd = ((s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; })(42);
  const cases = [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, '7'], [2, 'm7'], [11, 'dim'], [3, 'maj7'], [4, 'sus4']];
  for (const [r, q] of cases) {
    const c = new Float64Array(12);
    T.CHORD_IV[q].forEach((iv, j) => { c[(r + iv) % 12] += j ? 0.9 : 1.2; });
    for (let k = 0; k < 12; k++) c[k] += 0.12 * rnd();
    const m = T.matchChord(c);
    assert.deepStrictEqual([m.r, m.q], [r, q], 'expected ' + r + q + ' got ' + m.r + m.q);
  }
  // a triad with weak overtone leakage (the 5th's fifth) stays a triad
  const m = T.matchChord(sum([[0, 1.2], [4, 0.9], [7, 1], [2, 0.15], [11, 0.1]]));
  assert.deepStrictEqual([m.r, m.q], [0, 'maj']);
});
test('chord sequence: smoothing keeps one chord through a noisy beat', () => {
  const C = sum([[0, 1], [4, 1], [7, 1]]), Am = sum([[9, 1], [0, 1], [4, 1]]), noisy = sum([[0, 1], [4, 0.4], [7, 0.3], [9, 0.7], [2, 0.4]]);
  const s = T.chordSeq([C, C, noisy, C, Am, Am, Am, Am]);
  assert.deepStrictEqual(s.map((c) => c[0] + c[1]), ['0maj', '0maj', '0maj', '0maj', '9min', '9min', '9min', '9min']);
});
test('key estimation (Krumhansl): major, minor, tonic hint', () => {
  const scale = (root, steps, w) => { const c = new Float64Array(12); steps.forEach((s, i) => { c[(root + s) % 12] += w[i]; }); return c; };
  const k1 = T.keyOf(scale(7, [0, 2, 4, 5, 7, 9, 11], [3, 1, 2, 1, 2.5, 1, 1]));
  assert.deepStrictEqual([k1.root, k1.mode], [7, 'major']);
  const k2 = T.keyOf(scale(9, [0, 2, 3, 5, 7, 8, 11], [3, 1, 2.2, 1, 2.5, 1.2, 1]));
  assert.deepStrictEqual([k2.root, k2.mode], [9, 'minor']);
  // Am F C G: the same notes as C major; the first chord (Am) decides
  const ch = sum([[9, 1], [0, 1], [4, 1], [5, 1], [9, 1], [0, 1], [0, 1], [4, 1], [7, 1], [7, 1], [11, 1], [2, 1]]);
  const k3 = T.keyOf(ch, { tonic: [9, 'min'] });
  assert.deepStrictEqual([k3.root, k3.mode], [9, 'minor']);
  const k4 = T.keyOf(ch, { tonic: [0, 'maj'] });
  assert.deepStrictEqual([k4.root, k4.mode], [0, 'major']);
});

const beats = [
  { name: '90 BPM C Am F G', o: { bpm: 90, bars: 8 }, key: [0, 'major'] },
  { name: '140 BPM Am F C G (heavy)', o: { bpm: 140, bars: 8, heavy: true, chords: [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']] }, key: [9, 'minor'] },
];
for (const B of beats) {
  test('synthetic beat ' + B.name + ': tempo, phase, bars, chords, key', async () => {
    const b = G.makeBeat(B.o), an = await T.analyze(b.x, b.sr, { yield: () => Promise.resolve() });
    assert.ok(Math.abs(an.tempo.bpm - B.o.bpm) <= 1, 'bpm ' + an.tempo.bpm);
    const g = T.grid(an.frames, an.tempo.bpm, an.tempo.phase, { dur: an.dur });
    assert.ok(Math.abs(g.first - b.downbeats[0]) < 0.03, 'downbeat ' + g.first);
    assert.strictEqual(g.nBars, B.o.bars);
    const ok = g.bars.filter((bar, k) => bar[0].c && bar[0].c[0] === b.chords[k][0] && bar[0].c[1] === b.chords[k][1]).length;
    assert.ok(ok / B.o.bars >= 0.75, ok + '/' + B.o.bars + ' bars');
    assert.deepStrictEqual([g.key.root, g.key.mode], B.key);
    const sl = T.slots(an.frames, an.tempo.bpm, g.first, an.dur);
    assert.ok(sl.n >= B.o.bars * 8 && sl.hz[sl.max * 4] > 0);
  });
}
