// Randomize panel (generate.js NS.gen) and layer arpeggios (model.js arpEvents, export.js MIDI).
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || { VH: {} };
const store = require('../js/core/store.js');
require('../js/exp/melody/model.js');
const X = require('../js/exp/melody/export.js');
require('../js/exp/melody/generate.js');
const NS = global.window.VH.melody, md = NS.model, G = NS.gen;

const base = (o) => Object.assign({ v: 5, key: 0, mode: 'major', bars: 4, ts: '4/4', bpm: 120, chords: [[0, 0, 'maj'], [16, 7, 'maj'], [32, 9, 'min'], [48, 5, 'maj']],
  layers: [{ id: 'l1', name: 'Layer 1', color: '#ffc93c', sound: 'string', mode: 'notes', vol: 0.8, lines: [], notes: [[0, 16, 60]] }, { id: 'l2', name: 'Layer 2', color: '#7dff8a', sound: 'pluck', mode: 'line', vol: 0.8, lines: [], notes: [] }],
  backing: { sound: 'string', vol: 0.36, on: true, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, o);
const ALL = { key: 1, chords: 1, lens: 1, bars: 1, tempo: 1, backInst: 1, backStyle: 1, drums: 1, sounds: 1 };
const ctxFor = (S) => ({ setBars(n) { S.bars = n; S.chords = S.chords.filter((e) => e.at < n * 16); }, show() {}, setSound(L, id) { S.layers[L].sound = id; },
  setDrums(id) { S.drums = Object.assign({}, S.drums, { preset: id, on: id !== 'off' }); }, melody() {},
  sounds: ['string', 'pluck', 'sine', 'organ', 'bell'], backSounds: ['string', 'pad', 'organ'], styles: ['drone', 'strum', 'arp', 'pulse', 'broken'], drums: ['off', 'rock', 'waltz', 'four'] });
const run = (o, parts, extra) => { const S = md.parse(base(extra)); G.randomizeSong(S, md, Object.assign({ seed: 'abc', parts, scope: 'section' }, o), ctxFor(S)); return S; };
const ser = (S) => JSON.stringify(md.serialize(S, true));

test('C3: 200 default progressions in C major use at least 10 different valid chords', () => {
  const S = md.parse(base()), seen = new Set(), valid = new Set(md.QUALS.map((q) => q[0]));
  for (const tuning of ['12tet', 'ji', '19tet']) {
    S.tuning = tuning;
    for (let i = 0; i < 200; i++) {
      const ev = G.progression(S, md, G.mulberry32(i));
      for (const e of ev) {
        assert.ok(valid.has(e.chord[1]) && e.chord[0] >= 0 && e.chord[0] < 12, 'valid chord ' + e.chord);
        assert.ok(md.chordMidis(e.chord, S).every((m) => isFinite(m)), 'tuned chord tones');
        if (tuning === '12tet') seen.add(md.chordName(e.chord, md.namesOf(S)));
      }
    }
  }
  assert.ok(seen.size >= 10, 'distinct chords: ' + seen.size + ' ' + [...seen].join(' '));
  for (const mode of ['minor', 'dorian', 'majPent', 'blues']) {
    const T = md.parse(base({ mode }));
    for (let i = 0; i < 40; i++) G.progression(T, md, G.mulberry32(i)).forEach((e) => assert.ok(valid.has(e.chord[1])));
  }
});

test('C4: same seed + options = identical song; another seed differs', () => {
  const a = ser(run({}, ALL)), b = ser(run({}, ALL)), c = ser(run({ seed: 'abd' }, ALL));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(ser(run({ seed: '42' }, ALL)), ser(run({ seed: 42 }, ALL)));
});

test('C5: each checkbox only changes its own part', () => {
  const keep = (S) => ({ key: S.key, mode: S.mode, bpm: S.bpm, bars: S.bars, chords: JSON.stringify(S.chords), layers: JSON.stringify(md.serialize(S).layers), backing: JSON.stringify(S.backing), drums: JSON.stringify(S.drums) });
  const o0 = keep(md.parse(base()));
  const diff = (S) => Object.keys(o0).filter((k) => keep(S)[k] !== o0[k]);
  const has = (S, ks) => ks.every((k) => diff(S).includes(k));
  const only = (S, ks) => diff(S).every((k) => ks.includes(k));
  for (let n = 0; n < 6; n++) {
    const seed = 's' + n;
    let S = run({ seed }, { chords: 1 }); assert.ok(only(S, ['chords']), 'chords: ' + diff(S));
    S = run({ seed }, { lens: 1 }); assert.ok(only(S, ['chords']), 'lens: ' + diff(S));
    S = run({ seed }, { key: 1 }); assert.ok(only(S, ['key', 'mode']), 'key: ' + diff(S));
    S = run({ seed }, { tempo: 1 }); assert.ok(only(S, ['bpm']), 'tempo: ' + diff(S));
    S = run({ seed }, { sounds: 1 }); assert.ok(only(S, ['layers']), 'sounds: ' + diff(S));
    S = run({ seed }, { backInst: 1 }); assert.ok(only(S, ['backing']), 'backInst: ' + diff(S));
    S = run({ seed }, { backStyle: 1 }); assert.ok(only(S, ['backing']), 'backStyle: ' + diff(S));
    S = run({ seed }, { drums: 1 }); assert.ok(only(S, ['drums']), 'drums: ' + diff(S));
    S = run({ seed }, { bars: 1 }); assert.ok(only(S, ['bars', 'chords', 'layers']), 'bars: ' + diff(S));
  }
  // a part gives the same result whatever else is checked
  const a = run({ seed: 'z' }, { chords: 1 }), b = run({ seed: 'z' }, { chords: 1, tempo: 1, sounds: 1, backStyle: 1, drums: 1 });
  assert.strictEqual(JSON.stringify(a.chords), JSON.stringify(b.chords));
  assert.ok(has(run({ seed: 'z' }, ALL), ['bpm']));
});

test('Chord lengths: bars can split, chords stay valid', () => {
  let splits = 0;
  for (let n = 0; n < 30; n++) {
    const S = run({ seed: 'L' + n, spice: 0.9 }, { chords: 1, lens: 1 });
    S.chords.forEach((e) => { if (e.at % 16) splits++; assert.ok(e.chord && md.QI[e.chord[1]] != null); });
    assert.strictEqual(S.chords[0].at, 0);
  }
  assert.ok(splits > 10);
});

// ---------- arpeggio ----------
const arpSong = (arp, notes, lines) => {
  const lay = { id: 'l1', name: 'A', color: '#ffc93c', sound: 'pluck', mode: 'notes', vol: 0.8, notes: notes || [[0, 16, 60]], lines: lines || [] };
  if (arp) lay.arp = arp;
  return base({ layers: [lay] });
};

test('C6: Up 1/16 on a one-bar note = 16 steps, in MIDI too; chord tones of the region', () => {
  const S = md.parse(arpSong({ pat: 'up', rate: '1/16', oct: 1, from: 'chord' }));
  const ev = md.arpEvents(S, 0, 0, 16);
  assert.strictEqual(ev.length, 16);
  assert.deepStrictEqual(ev.slice(0, 5).map((e) => e.m), [60, 64, 67, 72, 60]);   // C E G C' then round again
  assert.deepStrictEqual(ev.map((e) => e.t), Array.from({ length: 16 }, (_, i) => i));
  const midi = X.songToMidi(md.flatten(S), { mode: 'mixed', soundOf: () => ({ id: 'pluck', name: 'Pluck' }) });
  let on = 0, p = 14;
  const dv = new DataView(midi.buffer, midi.byteOffset, midi.byteLength);
  for (let i = 0; i < midi.length - 2; i++) if ((midi[i] & 0xf0) === 0x90 && midi[i + 2] > 0 && midi[i + 1] >= 60 && midi[i + 1] <= 72 && (midi[i] & 15) !== 9) on++;
  assert.ok(on >= 16, 'note-ons in the file: ' + on);
  const rates = { '1/8': 8, '1/16': 16, '1/16t': 24, '1/32': 32 };
  for (const [rate, n] of Object.entries(rates)) assert.strictEqual(md.arpEvents(md.parse(arpSong({ pat: 'up', rate, oct: 1, from: 'chord' })), 0, 0, 16).length, n, rate);
  const down = md.arpEvents(md.parse(arpSong({ pat: 'down', rate: '1/16', oct: 2, from: 'chord' })), 0, 0, 16).map((e) => e.m);
  assert.strictEqual(down[0], Math.max(...down.slice(0, 7)));
  const ud = md.arpEvents(md.parse(arpSong({ pat: 'updown', rate: '1/16', oct: 1, from: 'chord' })), 0, 0, 16).map((e) => e.m);
  assert.deepStrictEqual(ud.slice(0, 7), [60, 64, 67, 72, 67, 64, 60]);
  const r1 = md.arpEvents(md.parse(arpSong({ pat: 'random', rate: '1/16', oct: 2, from: 'chord' })), 0, 0, 16).map((e) => e.m);
  const r2 = md.arpEvents(md.parse(arpSong({ pat: 'random', rate: '1/16', oct: 2, from: 'chord' })), 0, 0, 16).map((e) => e.m);
  assert.deepStrictEqual(r1, r2);
  assert.ok(new Set(r1).size > 2);
  // windows add up to the whole (live look-ahead)
  const parts = [].concat(md.arpEvents(S, 0, 0, 5.3), md.arpEvents(S, 0, 5.3, 16));
  assert.strictEqual(parts.length, 16);
});

test('Bands mode uses the peaks above the note, brightest few', () => {
  const S = md.parse(arpSong({ pat: 'up', rate: '1/16', oct: 1, from: 'bands' }));
  const ev = md.arpEvents(S, 0, 0, 8, () => [67, 55, 64, 71, 62, 69, 65]);
  assert.deepStrictEqual(ev.slice(0, 5).map((e) => e.m), [60, 62, 64, 67, 71]);
  assert.ok(ev.every((e) => e.m >= 60 && e.m <= 72));
});

test('C7: a line arp follows the line pitch', () => {
  const v = new Float32Array(192).fill(NaN);
  for (let i = 0; i < 96; i++) v[i] = 60 + i / 95 * 12;   // slides C4 -> C5 over two bars
  const S = md.parse(arpSong({ pat: 'up', rate: '1/8', oct: 1, from: 'chord' }, [], [{ id: 's1', segs: md.segs(v) }]));
  const ev = md.arpEvents(S, 0, 0, 32);
  assert.ok(ev.length >= 15);
  const sv = S.layers[0].lines[0].v, at = (t) => sv[Math.floor(t * 3 + 1e-6)];
  for (const e of ev) assert.ok(e.m >= at(e.t) - 1e-9 && e.m <= at(e.t) + 12 + 1e-9, 'step ' + e.t + ' within an octave above the line pitch ' + at(e.t) + ': ' + e.m);
  assert.ok(ev.filter((e) => e.m === at(e.t) || Math.abs(e.m - at(e.t)) < 1e-9).length >= 3, 'starts from the line pitch');
  assert.ok(ev[ev.length - 1].m > ev[0].m + 8);
  assert.ok(ev.every((e) => e.t < 32));
});

test('C8: layers without arp serialize as before; the arp round-trips and survives share codes', async () => {
  const old = md.serialize(md.parse(arpSong(null)), true);
  assert.ok(old.layers.every((l) => !('arp' in l)));
  assert.ok(!JSON.stringify(old).includes('arp'));
  assert.strictEqual(md.parse(arpSong({ pat: 'off' })).layers[0].arp, undefined);
  assert.strictEqual(md.parse(arpSong({ pat: 'bogus' })).layers[0].arp, undefined);
  const S = md.parse(arpSong({ pat: 'updown', rate: '1/16t', oct: 2, from: 'bands' }));
  const code = await store.encodeShare(md.serialize(S, true));
  const back = md.parse(await store.decodeShare(code));
  assert.deepStrictEqual(back.layers[0].arp, { pat: 'updown', rate: '1/16t', oct: 2, from: 'bands' });
  assert.deepStrictEqual(md.parse(arpSong({ pat: 'up', rate: 'x', oct: 7, from: '?' })).layers[0].arp, { pat: 'up', rate: '1/16', oct: 1, from: 'chord' });
  assert.deepStrictEqual(md.flatten(S).layers[0].arp, S.layers[0].arp);
});
