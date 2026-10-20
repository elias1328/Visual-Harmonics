const test = require('node:test');
const assert = require('node:assert');
const Y = require('../js/core/synth.js');
const S = require('../js/core/sounds.js');

const amp = (sp, r) => { const p = sp.find((x) => Math.abs(x[0] - r) < 1e-3); return p ? p[1] : 0; };
const open = (wave, extra) => Y.normalize(Object.assign({ oscs: [{ wave }], filter: { cutoff: 18000, keyTrack: 0 } }, extra));

test('analytic spectrum: saw is 1/n', () => {
  const sp = Y.spectrum(open('saw'));
  assert.strictEqual(sp.length, 16);
  for (let n = 1; n <= 8; n++) assert.ok(Math.abs(amp(sp, n) - 1 / n) < 0.01 / n + 0.002, 'harmonic ' + n + ': ' + amp(sp, n));
});

test('analytic spectrum: square is odd-only 1/n, triangle odd 1/n^2, sine one partial', () => {
  const sq = Y.spectrum(open('square'));
  for (const [r] of sq) assert.strictEqual(Math.round(r) % 2, 1, 'even partial ' + r);
  assert.ok(Math.abs(amp(sq, 3) - 1 / 3) < 0.01 && Math.abs(amp(sq, 5) - 1 / 5) < 0.01);
  const tri = Y.spectrum(open('triangle'));
  assert.ok(Math.abs(amp(tri, 3) - 1 / 9) < 0.01 && amp(tri, 2) === 0);
  assert.deepStrictEqual(Y.spectrum(open('sine')), [[1, 1]]);
});

test('analytic spectrum: a 2 kHz lowpass cuts the 10th partial of C4 by > 12 dB', () => {
  const a = Y.spectrum(open('saw')), b = Y.spectrum(Y.normalize({ oscs: [{ wave: 'saw' }], filter: { type: 'lowpass', cutoff: 2000, q: 0.7, keyTrack: 0 } }));
  const db = 20 * Math.log10(amp(b, 10) / amp(a, 10));
  assert.ok(db < -12, 'only ' + db.toFixed(1) + ' dB');
  assert.ok(amp(b, 1) === 1 && amp(b, 2) > 0.45, 'passband untouched');
});

test('analytic spectrum: resonance peak and env amount at the sustain level', () => {
  const flat = Y.spectrum(Y.normalize({ oscs: [{ wave: 'saw' }], filter: { cutoff: 1048, q: 0.7, keyTrack: 0 } }));
  const res = Y.spectrum(Y.normalize({ oscs: [{ wave: 'saw' }], filter: { cutoff: 1048, q: 8, keyTrack: 0 } }));
  assert.ok(amp(res, 4) > 2 * amp(flat, 4), 'resonance boosts the partial at the cutoff');
  const env = Y.spectrum(Y.normalize({ oscs: [{ wave: 'saw' }], filter: { cutoff: 500, envAmt: 2, keyTrack: 0 }, filtEnv: { s: 1 } }));
  const env0 = Y.spectrum(Y.normalize({ oscs: [{ wave: 'saw' }], filter: { cutoff: 500, envAmt: 2, keyTrack: 0 }, filtEnv: { s: 0 } }));
  assert.ok(amp(env, 8) > 4 * amp(env0, 8), 'env amount opens the held cutoff');
});

test('analytic spectrum: stretch moves the ratios; oct/semi/level shift and weigh oscillators; noise ignored', () => {
  const sp = Y.spectrum(open('saw', { oscs: [{ wave: 'saw', stretch: 1.02 }] }));
  assert.ok(Math.abs(sp[1][0] - 2 ** 1.02) < 1e-3 && Math.abs(sp[7][0] - 8 ** 1.02) < 1e-2);
  const two = Y.spectrum(Y.normalize({ oscs: [{ wave: 'sine' }, { wave: 'sine', oct: 1, semi: 7, level: 0.5 }, { wave: 'noise' }], filter: { cutoff: 18000 } }));
  assert.strictEqual(two.length, 2);
  assert.ok(Math.abs(two[1][0] - 2 * 2 ** (7 / 12)) < 1e-3 && Math.abs(two[1][1] - 0.5) < 0.02);
  const p = Y.spectrum(Y.normalize({ oscs: [{ wave: 'partials', partials: [[1, 1], [2.76, 0.5]] }], filter: { cutoff: 18000 } }));
  assert.deepStrictEqual(p.map((x) => x[0]), [1, 2.76]);
});

test('VH.sounds.spectrumOf uses the analytic spectrum for v2 synths; old synths unchanged', () => {
  const s = Y.toSound(Y.preset('pluck'), { id: 'x' });
  assert.deepStrictEqual(S.spectrumOf(s), Y.spectrum(Y.preset('pluck')));
  const str = S.get('string');
  assert.strictEqual(S.spectrumOf(str), str.spectrum);
  const saved = S.save(Y.toSound(Y.preset('organ'), { name: 'Org', source: 'custom' }));
  assert.ok(Array.isArray(saved.synth.partials) && saved.synth.v === 2 && saved.spectrum.length > 1);
  S.remove(saved.id);
});

test('play comes from the envelope: short decay into silence = hit, otherwise glide', () => {
  assert.strictEqual(Y.playOf({ ampEnv: { a: 0.002, d: 0.7, s: 0, r: 0.2 } }), 'hit');
  assert.strictEqual(Y.playOf({ ampEnv: { a: 0.002, d: 6, s: 0, r: 0.2 } }), 'glide');
  assert.strictEqual(Y.playOf({ ampEnv: { a: 0.01, d: 0.3, s: 0.8, r: 0.3 } }), 'glide');
  assert.strictEqual(S.playOf(Y.toSound(Y.preset('pluck'), { id: 'a' })), 'hit');
  assert.strictEqual(S.playOf(Y.toSound(Y.preset('bell'), { id: 'b' })), 'hit');
  assert.strictEqual(S.playOf(Y.toSound(Y.preset('warm-pad'), { id: 'c' })), 'glide');
  const saved = S.save(Object.assign(Y.toSound(Y.preset('pluck'), { name: 'P' }), { play: 'glide' }));
  assert.strictEqual(saved.play, 'hit', 'save derives play from the envelope');
  S.remove(saved.id);
});

test('portable round-trip keeps the exact synth; ids are stable', () => {
  for (const p of Y.PRESETS) {
    const s = Y.toSound(p.model, { id: 'u1', name: p.name, loud: 0.734 });
    const d = Y.portable(s), j = JSON.parse(JSON.stringify(d)), back = Y.fromPortable(j);
    assert.deepStrictEqual(back.synth, s.synth, p.id);
    assert.strictEqual(back.name, p.name); assert.strictEqual(back.loud, 0.734); assert.strictEqual(back.play, s.play);
    assert.strictEqual(Y.fromPortable(j).id, back.id);
    assert.ok(JSON.stringify(d).length < 600, p.id + ' compact: ' + JSON.stringify(d).length);
  }
  assert.strictEqual(S.portable(S.get('string')), null, 'only v2 synths are portable');
  assert.ok(S.fromPortable(S.portable(Y.toSound(Y.preset('bell'), { id: 'z', name: 'B' }))).synth.v === 2);
});

test('presets: 16, all valid; randomize stays musical', () => {
  assert.strictEqual(Y.PRESETS.length, 16);
  for (const p of Y.PRESETS) assert.ok(Y.spectrum(p.model).length >= 1, p.id);
  let seed = 7; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 200; i++) {
    const m = Y.randomize(rng);
    assert.ok(m.oscs[0].level === 1 && m.oscs[0].wave !== 'noise');
    assert.ok(m.filter.q <= 6 && m.filter.cutoff >= 80 && m.filter.cutoff <= 6000);
    assert.ok(m.ampEnv.s > 0 || m.ampEnv.d >= 0.35);
    assert.ok(Y.passRatio(m) > 0.1, 'filter lets enough through');
  }
});

test('derive from a v2 synth makes a plain additive synth', () => {
  const v2 = S.save(Y.toSound(Y.preset('brass'), { name: 'Br' }));
  const d = S.derive(v2.id, { stretch: 1.01 });
  assert.ok(!d.synth.v && Array.isArray(d.synth.partials) && d.synth.sustain === v2.synth.ampEnv.s);
  S.remove(d.id); S.remove(v2.id);
});
