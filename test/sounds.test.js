const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../js/core/sounds.js');

test('playOf: explicit play wins', () => {
  assert.strictEqual(S.playOf({ play: 'hit', family: 'strings' }), 'hit');
  assert.strictEqual(S.playOf({ play: 'glide', family: 'keys' }), 'glide');
});

test('playOf: derived from family when missing', () => {
  for (const f of ['strings', 'organ', 'woodwind', 'brass', 'choir', 'pads', 'tremolo']) assert.strictEqual(S.playOf({ family: f, kind: 'sampler' }), 'glide', f);
  for (const f of ['keys', 'plucked', 'mallets', 'bells', 'celesta', 'kalimba', 'kick', 'snare']) assert.strictEqual(S.playOf({ family: f, kind: 'sampler' }), 'hit', f);
  // unknown family: synth falls back to its envelope, sampler to hit
  assert.strictEqual(S.playOf({ family: 'zzz', kind: 'synth', synth: { sustain: 0.8 } }), 'glide');
  assert.strictEqual(S.playOf({ family: 'zzz', kind: 'synth', synth: { sustain: 0 } }), 'hit');
  assert.strictEqual(S.playOf({ family: 'zzz', kind: 'sampler' }), 'hit');
});

test('playOf: every synth preset glides; manifest entries keep their play', () => {
  for (const s of S.list().filter((x) => x.source === 'preset')) assert.strictEqual(s.play, 'glide', s.id);
  assert.strictEqual(S.fromManifest({ id: 'x', family: 'strings', zones: [{ url: 'a.mp3', rootMidi: 60 }] }).play, 'glide');
  assert.strictEqual(S.fromManifest({ id: 'x', family: 'strings', play: 'hit', zones: [{ url: 'a.mp3', rootMidi: 60 }] }).play, 'hit');
});

test('manifests: every instrument has play; glide zones have valid loop points', () => {
  for (const rel of ['../assets/samples/manifest.json', '../assets/samples-private/manifest.json']) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) continue;   // the private set is local-only
    for (const inst of JSON.parse(fs.readFileSync(p, 'utf8')).instruments) {
      assert.ok(inst.play === 'glide' || inst.play === 'hit', inst.id);
      if (inst.play !== 'glide') continue;
      for (const z of inst.zones) assert.ok(z.loopStart > 0 && z.loopEnd - z.loopStart >= 0.1, inst.id + ' ' + z.url);
    }
  }
});

test('toneResponse: neutral is flat; bright tilts up, dark tilts down', () => {
  assert.deepStrictEqual(S.toneBands({ bright: 0 }), []);
  assert.strictEqual(S.toneResponse({ bright: 0 }, 5000), 1);
  const lo = S.toneResponse({ bright: 1 }, 100), hi = S.toneResponse({ bright: 1 }, 8000);
  assert.ok(lo < 1 && hi > 3, lo + ' ' + hi);   // about -6 dB / +12 dB
  assert.ok(S.toneResponse({ bright: -1 }, 8000) < 0.35);
});

test('spectrumOf: bright = 0 is unchanged, bright = 1 raises high partials relative to low', () => {
  const s = S.get('string');
  assert.strictEqual(S.spectrumOf(s), s.spectrum);
  assert.strictEqual(S.spectrumOf(s, { bright: 0 }), s.spectrum);
  const b = S.spectrumOf(s, { bright: 1 }), d = S.spectrumOf(s, { bright: -1 });
  const rel = (sp) => sp[sp.length - 1][1] / sp[0][1];
  assert.ok(rel(b) > rel(s.spectrum) * 2, rel(b) + ' vs ' + rel(s.spectrum));
  assert.ok(rel(d) < rel(s.spectrum) / 2);
  assert.strictEqual(Math.max(...b.map((p) => p[1])), 1);
  assert.deepStrictEqual(b.map((p) => p[0]), s.spectrum.map((p) => p[0]));   // ratios untouched
  // the partial at ratio r is scaled by the filter at r * 262 Hz (before renormalising)
  const k = s.spectrum.length - 1, g = (r) => S.toneResponse({ bright: 1 }, r * 262);
  const want = (s.spectrum[k][1] * g(s.spectrum[k][0])) / (s.spectrum[0][1] * g(s.spectrum[0][0]));
  assert.ok(Math.abs(rel(b) / want - 1) < 1e-9);
  assert.deepStrictEqual(S.spectrumOf(null), S.DEFAULT_SPECTRUM);
});

test('spectrumOf: a sound with a stored tone applies it, and an extra tone adds on top', () => {
  const s = S.get('string'), t = Object.assign({}, s, { tone: { bright: 0.5 } });
  assert.deepStrictEqual(S.spectrumOf(t), S.spectrumOf(s, { bright: 0.5 }));
  assert.strictEqual(S.spectrumOf(t, { bright: -0.5 }), t.spectrum);
});

test('derive: synth naming, fields, stretch/roll on the base partials', () => {
  const d = S.derive('string', { stretch: 1.1, roll: 0.5, tone: { bright: 0.3 } });
  assert.strictEqual(d.id, 'string-custom');
  assert.strictEqual(d.name, 'String (custom)');
  assert.strictEqual(d.source, 'custom');
  assert.strictEqual(d.kind, 'synth');
  assert.strictEqual(d.play, 'glide');
  assert.strictEqual(d.derivedFrom, 'string');
  assert.deepStrictEqual(d.tone, { bright: 0.3 });
  assert.ok(Math.abs(d.synth.partials[1][0] - 2 ** 1.1) < 1e-12);
  assert.ok(Math.abs(d.synth.partials[1][1] - 0.88 * 0.5) < 1e-12);
  assert.strictEqual(d.synth.attack, S.get('string').synth.attack);
  assert.strictEqual(S.get('string-custom').name, 'String (custom)');
  // deriving again (also from the derived sound) edits the same sound, relative to the original base
  const d2 = S.derive('string-custom', { stretch: 1 });
  assert.strictEqual(d2.id, 'string-custom');
  assert.strictEqual(d2.name, 'String (custom)');
  assert.deepStrictEqual(d2.synth.partials, S.get('string').synth.partials);
  assert.deepStrictEqual(d2.tone, { bright: 0.3 });   // tone kept when not given
  assert.strictEqual(S.list().filter((s) => s.id === 'string-custom').length, 1);
  const d3 = S.derive('sine', { partials: [[1, 1], [3, 0.5]] });
  assert.deepStrictEqual(d3.synth.partials, [[1, 1], [3, 0.5]]);
  assert.deepStrictEqual(d3.spectrum, [[1, 1], [3, 0.5]]);
  assert.throws(() => S.derive('nope', {}));
});

test('derive: samplers only take tone', () => {
  const base = S.save({ id: 'smp', name: 'Smp', family: 'strings', source: 'sample', kind: 'sampler',
    sampler: { zones: [{ url: 'a.mp3', rootMidi: 60, loopStart: 0.5, loopEnd: 1 }], release: 0.6 }, spectrum: [[1, 1], [2, 0.5]] });
  const d = S.derive(base.id, { tone: { bright: -2 }, stretch: 2, partials: [[1, 1]] });
  assert.strictEqual(d.name, 'Smp (custom)');
  assert.strictEqual(d.kind, 'sampler');
  assert.strictEqual(d.source, 'custom');
  assert.strictEqual(d.play, 'glide');
  assert.deepStrictEqual(d.tone, { bright: -1 });   // clamped
  assert.deepStrictEqual(d.sampler, base.sampler);
  assert.notStrictEqual(d.sampler.zones[0], base.sampler.zones[0]);
  assert.deepStrictEqual(d.spectrum, base.spectrum);
  assert.strictEqual(d.synth, undefined);
});

test('manifests: every zone gain (when present) is within [0.25, 4]', () => {
  let n = 0;
  for (const rel of ['../assets/samples/manifest.json', '../assets/samples-private/manifest.json']) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) continue;
    for (const inst of JSON.parse(fs.readFileSync(p, 'utf8')).instruments) {
      for (const z of inst.zones) {
        if (z.gain === undefined) continue;
        n++;
        assert.ok(typeof z.gain === 'number' && z.gain >= 0.25 && z.gain <= 4, inst.id + ' ' + z.url + ' gain ' + z.gain);
        assert.ok(Math.abs(z.gain - 1) > 0.05, inst.id + ' ' + z.url + ' redundant gain');
      }
    }
  }
  assert.ok(n > 0);
});
