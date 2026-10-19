const test = require('node:test');
const assert = require('node:assert');
const A = require('../js/core/analyze.js');

function tone(f0, amps, sr, secs, stretch = 1) {
  const n = Math.round(sr * secs), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, env = Math.exp(-t * 0.8);
    let s = 0;
    amps.forEach((a, k) => { s += a * Math.sin(2 * Math.PI * f0 * (k + 1) ** stretch * t + k); });
    x[i] = 0.3 * env * s;
  }
  return x;
}

test('fromSamples: 220 Hz harmonic tone round-trip', () => {
  const amps = [1, 0.6, 0.45, 0.3, 0.2, 0.1];
  const r = A.fromSamples(tone(220, amps, 44100, 1.5), 44100);
  assert.ok(Math.abs(r.rootHz / 220 - 1) < 0.01, 'root ' + r.rootHz);
  assert.ok(r.spectrum.length >= 4 && r.spectrum.length <= 16);
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(r.spectrum[k][0] / (k + 1) - 1) < 0.02, 'ratio ' + k + ' ' + r.spectrum[k][0]);
  assert.strictEqual(Math.max(...r.spectrum.map((p) => p[1])), 1);
});

test('fromSamples: weak fundamental still finds the root (not an octave up)', () => {
  const r = A.fromSamples(tone(110, [0.3, 1, 0.8, 0.5], 48000, 1), 48000);
  assert.ok(Math.abs(r.rootHz / 110 - 1) < 0.01, 'root ' + r.rootHz);
});

test('fromSamples: silence / too short is safe', () => {
  assert.deepStrictEqual(A.fromSamples(new Float32Array(100), 44100).spectrum, [[1, 1]]);
  assert.strictEqual(A.fromSamples(new Float32Array(44100), 44100).rootHz, 0);
});

test('findLoop: synthetic sustained tone loops with a seam jump < 2% of RMS', () => {
  const sr = 44100, f0 = 220, n = sr * 3, x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, env = Math.min(1, t / 0.15) * (t > 2.5 ? Math.max(0, 1 - (t - 2.5) / 0.5) : 1);
    x[i] = 0.4 * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t + 1) + 0.25 * Math.sin(2 * Math.PI * 3 * f0 * t + 2));
  }
  const r = A.findLoop(x, sr, { rootHz: f0 });
  assert.ok(r, 'found');
  assert.ok(r.seam < 0.02, 'seam ' + r.seam);
  assert.ok(r.loopStart > 0.15, 'after the attack ' + r.loopStart);
  assert.ok(r.loopEnd < 2.5, 'before the fade ' + r.loopEnd);
  assert.ok(r.loopEnd - r.loopStart >= 0.25, 'length');
  const periods = (r.end - r.start) * f0 / sr;
  assert.ok(Math.abs(periods - Math.round(periods)) < 0.05, 'period-aligned ' + periods);
  assert.ok(x[r.start - 1] < 0 && x[r.start] >= 0 && x[r.end - 1] < 0 && x[r.end] >= 0, 'rising zero crossings');
});

test('findLoop: silence / too short returns null', () => {
  assert.strictEqual(A.findLoop(new Float32Array(44100), 44100), null);
  assert.strictEqual(A.findLoop(new Float32Array(100), 44100), null);
});

test('bakeLoopFade: tail before loopEnd ends on the samples before loopStart', () => {
  const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7));
  const before = x.slice(), n = A.bakeLoopFade(x, 300, 800, 50);
  assert.strictEqual(n, 50);
  assert.strictEqual(x[799], before[299]);
  assert.ok(Math.abs(x[750] - (before[750] * (1 - 1 / 50) + before[250] / 50)) < 1e-6);
  assert.deepStrictEqual(x.slice(0, 750), before.slice(0, 750));
});
