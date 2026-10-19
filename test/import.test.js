const test = require('node:test');
const assert = require('node:assert');
const A = require('../js/core/analyze.js');

const SR = 44100;
// Harmonic tone: attack 20 ms, flat sustain, 0.3 s release (decay = true for a plucked, exponentially decaying one).
function tone(f0, secs, o = {}) {
  const n = Math.round(SR * secs), x = new Float32Array(n), amps = o.amps || [1, 0.5, 0.33, 0.25, 0.2];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = o.decay ? Math.exp(-t * o.decay) * Math.min(1, t / 0.003) : Math.min(1, t / 0.02) * Math.min(1, (secs - t) / 0.3);
    let s = 0;
    amps.forEach((a, k) => { s += a * Math.sin(2 * Math.PI * f0 * (k + 1) * t); });
    x[i] = 0.25 * env * s;
  }
  return x;
}
function noiseBurst(secs, dec, seed = 1) {
  const n = Math.round(SR * secs), x = new Float32Array(n);
  let r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647 * 2 - 1; };
  for (let i = 0; i < n; i++) x[i] = 0.5 * rnd() * Math.exp(-i / SR * dec);
  return x;
}
const cents = (hz, ref) => 1200 * Math.log2(hz / ref);

test('analyzeImport: sustained 220 Hz tone -> pitched glide, root A3 within 10 cents, loop points', () => {
  const r = A.analyzeImport(tone(220, 2.5), SR);
  assert.ok(r.pitched, 'conf ' + r.conf);
  assert.ok(Math.abs(cents(r.rootHz, 220)) < 10, 'root ' + r.rootHz);
  assert.strictEqual(Math.round(r.rootMidi), 57);
  assert.strictEqual(r.play, 'glide');
  assert.ok(r.loop && r.loop.loopEnd > r.loop.loopStart && r.loop.loopStart > 0.02, JSON.stringify(r.loop));
  assert.ok(r.spectrum.length >= 4 && Math.abs(r.spectrum[1][0] - 2) < 0.03);
});

test('analyzeImport: other roots (synthetic tones) within 10 cents', () => {
  for (const f of [98, 146.83, 261.63, 440, 659.25, 1046.5]) {
    const r = A.analyzeImport(tone(f, 1.5), SR);
    assert.ok(r.pitched && Math.abs(cents(r.rootHz, f)) < 10, f + ' -> ' + r.rootHz + ' conf ' + r.conf);
  }
});

test('analyzeImport: decaying pluck is a pitched hit', () => {
  const r = A.analyzeImport(tone(330, 2, { decay: 6 }), SR);
  assert.ok(r.pitched && Math.abs(cents(r.rootHz, 330)) < 10, 'root ' + r.rootHz);
  assert.strictEqual(r.play, 'hit');
  assert.strictEqual(r.loop, null);
});

test('analyzeImport: noise burst is unpitched -> drum, hit', () => {
  const r = A.analyzeImport(noiseBurst(0.6, 25), SR);
  assert.ok(!r.pitched, 'conf ' + r.conf);
  assert.ok(r.drum);
  assert.strictEqual(r.play, 'hit');
  assert.ok(r.env.percussive && r.env.decay < 0.3, JSON.stringify(r.env));
});

test('envStats: sustained vs percussive', () => {
  assert.strictEqual(A.envStats(tone(220, 2), SR).percussive, false);
  assert.strictEqual(A.envStats(noiseBurst(1, 12), SR).percussive, true);
});

test('centroid orders low thump < snare-ish noise < hat-ish noise', () => {
  const kick = tone(55, 0.5, { decay: 10, amps: [1] });
  const hp = (x) => { const y = new Float32Array(x.length); for (let i = 1; i < x.length; i++) y[i] = x[i] - x[i - 1]; return y; };
  const snare = noiseBurst(0.4, 15, 7), hat = hp(hp(noiseBurst(0.2, 40, 3)));
  const c = [kick, snare, hat].map((x) => A.centroid(x, SR));
  assert.ok(c[0] < c[1] && c[1] < c[2], JSON.stringify(c));
});

test('kitPick: most percussive first by decay, ordered low to high by centroid', () => {
  const items = [
    { id: 'pad', decay: 3, sustain: 0.9, centroid: 500 },
    { id: 'hat', decay: 0.05, sustain: 0, centroid: 8000 },
    { id: 'kick', decay: 0.2, sustain: 0.05, centroid: 90 },
    { id: 'snare', decay: 0.15, sustain: 0, centroid: 2500 },
  ];
  assert.deepStrictEqual(A.kitPick(items, 3).map((s) => s.id), ['kick', 'snare', 'hat']);
  assert.deepStrictEqual(A.kitPick(items, 8).map((s) => s.id), ['kick', 'snare', 'hat'], 'sustained sounds are left out');
  assert.deepStrictEqual(A.kitPick(items.slice(0, 1), 8).map((s) => s.id), ['pad'], 'nothing percussive: the sustained one');
  assert.deepStrictEqual(A.kitPick([], 8), []);
});

const S = require('../js/core/sounds.js');
test('closest: missing sound falls back by play type, then spectral similarity', () => {
  // A plucked, bright harmonic spectrum -> a 'hit' preset (Pluck); a hollow odd-harmonic glide -> Clarinet.
  const pool = [S.get('pluck'), S.get('string'), { id: 'harp', play: 'hit', spectrum: [[1, 1], [2, 0.3]] }, { id: 'marimba', play: 'hit', spectrum: [[1, 1], [4, 0.6], [10, 0.3]] }];
  assert.strictEqual(S.closest({ play: 'hit', spectrum: [[1, 1], [4, 0.5], [9.8, 0.2]] }, pool).id, 'marimba');
  assert.strictEqual(S.closest({ play: 'hit', spectrum: [[1, 1], [2, 0.72], [3, 0.52], [4, 0.37], [5, 0.27]] }, pool).id, 'harp');
  assert.strictEqual(S.closest({ play: 'glide', spectrum: [[1, 1], [2, 0.72], [3, 0.52], [4, 0.37], [5, 0.27]] }, pool).id, 'pluck');
  assert.strictEqual(S.closest({ play: 'glide', spectrum: [[1, 1], [3, 0.55], [5, 0.33], [7, 0.2]] }).id, 'clarinet');
  assert.strictEqual(S.closest({ play: 'glide', spectrum: [[1, 1]] }).id, 'sine');
  assert.ok(S.closest(null));
  assert.ok(S.spectralSim([[1, 1]], [[1, 1]]) > 0.999 && S.spectralSim([[1, 1]], [[2, 1]]) < 0.01);
});
