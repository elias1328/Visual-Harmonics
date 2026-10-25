// Per-section backing override (section.back): model round-trip, share code, flatten + MIDI program change; old songs unchanged.
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || { VH: {} };
const store = require('../js/core/store.js');
require('../js/exp/melody/model.js');
const X = require('../js/exp/melody/export.js');
const md = global.window.VH.melody.model;

const base = (o) => Object.assign({ v: 5, key: 0, mode: 'major', bars: 2, ts: '4/4', bpm: 100, chords: [[0, 0, 'maj'], [16, 7, 'maj']],
  layers: [{ id: 'l1', name: 'Layer 1', color: '#ffc93c', sound: 'string', mode: 'line', vol: 0.8, lines: [], notes: [] }],
  backing: { sound: 'string', vol: 0.36, on: true, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, o);
const two = (backB) => base({ sections: [{ id: 'S1', name: 'A', rep: 1 }, Object.assign({ id: 'S2', name: 'B', rep: 1, bars: 2, chords: [[0, 5, 'maj'], [16, 0, 'maj']] }, backB ? { back: backB } : {})], cur: 0 });

test('section.back parses, serializes only when set, and round-trips a share code', async () => {
  const S = md.parse(two({ sound: 'pluck', style: 'arp' }));
  assert.deepStrictEqual(S.sections[1].back, { sound: 'pluck', style: 'arp' });
  assert.strictEqual(S.sections[0].back, undefined);
  assert.deepStrictEqual([md.backOf(S, 0).sound, md.backOf(S, 0).over, md.backOf(S, 1).sound, md.backOf(S, 1).style, md.backOf(S, 1).over], ['string', false, 'pluck', 'arp', true]);
  const code = await store.encodeShare(md.serialize(S, true));
  const back = md.parse(await store.decodeShare(code));
  assert.deepStrictEqual(back.sections[1].back, { sound: 'pluck', style: 'arp' });
  const old = md.serialize(md.parse(two(null)), true);
  assert.ok(old.sections.every((x) => !('back' in x)), 'old songs write no override');
  assert.strictEqual(md.parse(two({ junk: 1 })).sections[1].back, undefined);
});

test('MIDI: a section with its own backing instrument sends a program change at its start', () => {
  const S = md.parse(two({ sound: 'pluck' }));
  const F = md.flatten(S);
  assert.deepStrictEqual(F.flat.bars.map((b) => b.sec), [0, 0, 1, 1]);
  const snd = { string: { id: 'string', name: 'Strings' }, pluck: { id: 'pluck', name: 'Guitar' } };
  const bytes = X.songToMidi(F, { mode: 'mixed', layers: [], backing: true, drums: false, backingSound: snd.string, backingSoundOf: (k) => snd[md.backOf(S, k).sound] });
  const progs = [];
  for (let i = 0; i < bytes.length - 1; i++) if ((bytes[i] & 0xf0) === 0xc0) progs.push(bytes[i + 1]);
  assert.ok(progs.includes(X.gmProgram(snd.string)) && progs.includes(X.gmProgram(snd.pluck)), 'both programs: ' + progs);
  const same = X.songToMidi(md.flatten(md.parse(two(null))), { mode: 'mixed', layers: [], backing: true, drums: false, backingSound: snd.string, backingSoundOf: () => snd.string });
  let n = 0; for (let i = 0; i < same.length - 1; i++) if ((same[i] & 0xf0) === 0xc0 && same[i + 1] === X.gmProgram(snd.string)) n++;
  assert.strictEqual(n, 1, 'no extra program changes without an override');
});
