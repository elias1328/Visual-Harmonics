// Scales, modes and tunings (js/core/harmony.js) + tuned MIDI export (js/exp/melody/export.js).
const test = require('node:test');
const assert = require('node:assert');
const H = require('../js/core/harmony.js');
const X = require('../js/exp/melody/export.js');

test('scale degree sets', () => {
  const st = (id) => H.scaleById(id).steps.join(',');
  assert.strictEqual(st('major'), '0,2,4,5,7,9,11');
  assert.strictEqual(st('minor'), '0,2,3,5,7,8,10');
  assert.strictEqual(st('dorian'), '0,2,3,5,7,9,10');
  assert.strictEqual(st('phrygian'), '0,1,3,5,7,8,10');
  assert.strictEqual(st('lydian'), '0,2,4,6,7,9,11');
  assert.strictEqual(st('mixolydian'), '0,2,4,5,7,9,10');
  assert.strictEqual(st('locrian'), '0,1,3,5,6,8,10');
  assert.strictEqual(st('harmonicMinor'), '0,2,3,5,7,8,11');
  assert.strictEqual(st('melodicMinor'), '0,2,3,5,7,9,11');
  assert.strictEqual(st('blues'), '0,3,5,6,7,10');
  assert.strictEqual(st('wholeTone'), '0,2,4,6,8,10');
  assert.strictEqual(st('diminished'), '0,1,3,4,6,7,9,10');
  assert.strictEqual(st('hirajoshi'), '0,2,3,7,8');
  assert.strictEqual(H.SCALES.length, 19);
  for (const s of H.SCALES) {
    assert.ok(['Common', 'Modes', 'Exotic'].includes(s.group) && s.hint, s.id);
    assert.strictEqual(s.steps[0], 0);
    assert.ok(s.steps.every((v, i) => !i || v > s.steps[i - 1]) && s.steps.every((v) => v < 12), s.id);
  }
  assert.strictEqual(H.scaleById('nope').id, 'major');
});

test('diatonic chords for Dorian, Phrygian and Mixolydian', () => {
  const row = (root, id) => H.scaleChords(root, id).map((c) => c.rn + ':' + c.r + c.q).join(' ');
  assert.strictEqual(row(2, 'dorian'), 'i:2min ii:4min bIII:5maj IV:7maj v:9min vi°:11dim bVII:0maj');
  assert.strictEqual(row(4, 'phrygian'), 'i:4min bII:5maj bIII:7maj iv:9min v°:11dim bVI:0maj bvii:2min');
  assert.strictEqual(row(7, 'mixolydian'), 'I:7maj ii:9min iii°:11dim IV:0maj v:2min vi:4min bVII:5maj');
  assert.strictEqual(row(0, 'major'), 'I:0maj ii:2min iii:4min IV:5maj V:7maj vi:9min vii°:11dim');
  // non-heptatonic: every triad / 7th that fits entirely
  const pent = H.scaleChords(0, 'majPent'), set = new Set(H.scaleById('majPent').steps);
  assert.ok(pent.some((c) => c.r === 0 && c.q === 'maj') && pent.some((c) => c.r === 9 && c.q === 'min'));
  assert.ok(pent.every((c) => H.CHORD_IV[c.q].every((i) => set.has((c.deg + i) % 12))));
  assert.ok(H.scaleChords(0, 'blues').some((c) => c.r === 0 && c.q === 'm7'));
});

test('tuning step frequencies', () => {
  const c19 = H.tuningCents('19tet');
  assert.strictEqual(c19.length, 19);
  for (let k = 1; k < 19; k++) assert.ok(Math.abs(c19[k] - c19[k - 1] - 1200 / 19) < 1e-9);
  assert.ok(Math.abs(H.tuningCents('24tet')[1] - 50) < 1e-9 && H.tuningCents('31tet').length === 31);
  // JI: ratios exact relative to the key root
  const ji = H.tuningCents('ji'), r = (c) => 2 ** (c / 1200);
  assert.ok(Math.abs(r(ji[4]) - 5 / 4) < 1e-12 && Math.abs(r(ji[7]) - 3 / 2) < 1e-12 && Math.abs(r(ji[9]) - 5 / 3) < 1e-12);
  const g = H.tuningGrid('ji', 2, 48, 84);   // D root
  const d4 = g.pts.find((m) => Math.abs(m - 62) < 1e-9), fs = g.pts.find((m) => Math.abs(m - 66) < 0.3);
  assert.ok(d4 != null && Math.abs(H.midiToHz(fs) / H.midiToHz(d4) - 5 / 4) < 1e-9);
  // Pythagorean fifth = 3/2
  assert.ok(Math.abs(r(H.tuningCents('pyth')[7]) - 3 / 2) < 1e-12);
  // tuned chords: JI major third exactly 5/4, 19-TET thirds on 19-TET steps
  const jc = H.tunedChord('ji', 0, 0, [0, 4, 7]);
  assert.ok(Math.abs(H.midiToHz(jc[1]) / H.midiToHz(jc[0]) - 5 / 4) < 1e-9 && Math.abs(H.midiToHz(jc[2]) / H.midiToHz(jc[0]) - 3 / 2) < 1e-9);
  const tc = H.tunedChord('19tet', 0, 0, [0, 4, 7]);
  for (const m of tc) { const st = (m - 48) * 100 / (1200 / 19); assert.ok(Math.abs(st - Math.round(st)) < 1e-9); }
  assert.deepStrictEqual(H.tunedChord('12tet', 0, 2, [0, 3, 7]), [50, 53, 57]);
  assert.strictEqual(H.tuningSnap('12tet', 0, 60.5), 61);   // ties go up, like Math.round
  assert.deepStrictEqual(H.scaleClasses('19tet', [0, 2, 4, 5, 7, 9, 11]), [0, 3, 6, 8, 11, 14, 17]);
});

test('.scl file format', () => {
  const lines = (id) => H.sclText(id).split('\n').filter((l) => l.length && l[0] !== '!');
  const ji = lines('ji');
  assert.ok(/Just intonation/.test(ji[0]));
  assert.strictEqual(+ji[1].trim(), 12);
  assert.strictEqual(ji.length, 2 + 12);
  assert.strictEqual(ji[2].trim(), '16/15');
  assert.strictEqual(ji[ji.length - 1].trim(), '2/1');
  const e19 = lines('19tet');
  assert.strictEqual(+e19[1].trim(), 19);
  assert.strictEqual(e19.length, 2 + 19);
  assert.ok(e19.slice(2, -1).every((l) => /^ \d+\.\d+$/.test(l)));   // cents carry a decimal point
  assert.ok(Math.abs(parseFloat(e19[2]) - 1200 / 19) < 1e-4);
  assert.strictEqual(lines('slendro').length, 2 + 5);
  assert.ok(H.sclText('pelog').endsWith(' 2/1\n'));
});

test('MIDI bends for a 24-TET quarter tone (per-voice channels)', () => {
  assert.strictEqual(H.bendValue(0.5), 8533);
  assert.strictEqual(H.bendValue(-0.5), 7851);
  // two overlapping notes a quarter tone apart -> two channels, each bent by +-a quarter tone (range +-12)
  const song = { bars: 1, bpm: 120, ts: '4/4', chords: [{ at: 0, chord: [0, 'maj'] }],
    layers: [{ name: 'L', sound: 'pluck', vol: 1, lines: [], notes: [{ s: 0, d: 8, m: 60.5 }, { s: 0, d: 8, m: 63.5 }, { s: 8, d: 4, m: 62 }] }],
    backing: { sound: 'string', vol: 0.5 }, drums: {} };
  const bytes = X.songToMidi(song, { tuned: true, backing: true, chordMidis: () => [48, 51.5, 55] });
  // scan pitch-bend messages: 0xE0|ch, lsb, msb
  const bends = new Map();
  for (let i = 0; i < bytes.length - 2; i++) if ((bytes[i] & 0xf0) === 0xe0 && bytes[i + 1] < 128 && bytes[i + 2] < 128) {
    const ch = bytes[i] & 15, v = bytes[i + 1] | (bytes[i + 2] << 7);
    if (!bends.has(ch)) bends.set(ch, new Set());
    bends.get(ch).add(v);
  }
  const all = [...bends.values()].flatMap((x) => [...x]);
  assert.ok(all.includes(7851) && all.every((v) => v === 8192 || v === 7851 || v === 8533), JSON.stringify([...bends].map(([c, v]) => [c, [...v]])));   // x.5 rounds up: bent down a quarter tone
  const qt = [...bends].filter(([, v]) => v.has(8533) || v.has(7851)).map(([c]) => c);
  assert.ok(qt.length >= 3, 'quarter-tone notes on separate channels: ' + qt);
  assert.strictEqual(X.packVoices([{ a: 0, z: 8 }, { a: 0, z: 8 }, { a: 8, z: 12 }]).length, 2);
});
