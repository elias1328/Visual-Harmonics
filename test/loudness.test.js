const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../js/core/sounds.js');

const sine = (hz, amp, sec, sr = 48000) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));

test('K-weighting: ~flat at 1 kHz region, +4 dB shelf up high, high-pass cuts the lows', () => {
  assert.ok(Math.abs(S.toDb(S.kMag(500))) < 1, 'mid ~0 dB');
  assert.ok(Math.abs(S.toDb(S.kMag(8000)) - 4) < 0.3, 'shelf +4 dB');
  assert.ok(Math.abs(S.toDb(S.kMag(60)) + 3) < 0.3, '-3 dB at the 60 Hz corner');
  assert.ok(S.toDb(S.kMag(20)) < -15, 'lows cut');
});

test('kRms of a sine matches its RMS times |K(f)|, over a window', () => {
  const sr = 48000, x = sine(500, 0.5, 1.5, sr), want = 0.5 / Math.SQRT2 * S.kMag(500, sr);
  assert.ok(Math.abs(S.kRms(x, sr, 0.2, 1) / want - 1) < 0.01);
  const half = Float32Array.from(x, (v, i) => (i < sr * 0.5 ? v : 0));   // silent after 0.5 s
  assert.ok(Math.abs(S.toDb(S.kRms(half, sr, 0, 1)) - S.toDb(want) + 3.01) < 0.15);
  assert.strictEqual(S.kRms(new Float32Array(0), sr), 0);
});

test('loudFor brings a measurement to the reference and stays within 0.1..10', () => {
  for (const db of [-30, -18, -9]) assert.ok(Math.abs(db + S.toDb(S.loudFor(db)) - S.LOUD_REF_DB) < 0.01, String(db));
  assert.strictEqual(S.loudFor(-200), 10);
  assert.strictEqual(S.loudFor(40), 0.1);
  assert.strictEqual(S.loudFor(NaN), 1);
  assert.strictEqual(S.loudOf({}), 1);
  assert.strictEqual(S.loudOf({ loud: 2 }), 2);
});

test('partial-power rescaling: same partials = same loud; one partial vs many is consistent', () => {
  const p = [[1, 1], [2, 0.5], [3, 0.25]];
  assert.strictEqual(S.loudScaled(0.5, p, p), 0.5);
  const l = S.loudScaled(1, p, [[1, 1]]);   // the sum-normalised fundamental alone has more power -> lower gain
  assert.ok(l < 1 && l > 0.5, String(l));
});

test('presets carry loud; Custom and derived sounds inherit it', () => {
  for (const s of S.list().filter((x) => x.source === 'preset' && x.id !== 'custom')) assert.ok(s.loud >= 0.1 && s.loud <= 10, s.id);
  assert.strictEqual(S.custom({ n: 12, stretch: 1, roll: 0.88 }).loud, S.get('string').loud);   // default Custom = String's partials
  const d = S.derive('clarinet', { tone: { bright: 0.5 } });
  assert.strictEqual(d.loud, S.get('clarinet').loud);
  S.remove(d.id);
});

test('comfortMidi: C4, kept inside a sampler\'s range', () => {
  assert.strictEqual(S.comfortMidi({ kind: 'synth' }), 60);
  assert.strictEqual(S.comfortMidi({ sampler: { zones: [{ rootMidi: 69 }, { rootMidi: 93 }] } }), 69);
  assert.strictEqual(S.comfortMidi({ sampler: { zones: [{ rootMidi: 28 }, { rootMidi: 56 }] } }), 56);
});

test('manifests: every instrument has a sane loud (0.1..10), and fromManifest keeps it', () => {
  for (const rel of ['../assets/samples/manifest.json', '../assets/samples-private/manifest.json']) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) continue;   // the private set is local-only
    for (const inst of JSON.parse(fs.readFileSync(p, 'utf8')).instruments) {
      assert.ok(typeof inst.loud === 'number' && inst.loud >= 0.1 && inst.loud <= 10, inst.id + ' loud ' + inst.loud);
      assert.strictEqual(S.fromManifest(inst).loud, inst.loud);
    }
  }
});
