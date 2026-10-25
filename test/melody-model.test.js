// Song model (js/exp/melody/model.js): view prefs survive parse (undo / reload), the stroke limit, backing style options.
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || { VH: {} };
const store = require('../js/core/store.js');
require('../js/exp/melody/model.js');
const md = global.window.VH.melody.model;

const base = (o) => Object.assign({ v: 5, key: 0, mode: 'major', bars: 2, ts: '4/4', bpm: 100, chords: [[0, 0, 'maj'], [16, 7, 'maj']],
  layers: [{ id: 'l1', name: 'Layer 1', color: '#ffc93c', sound: 'string', mode: 'line', vol: 0.8, lines: [], notes: [] }],
  backing: { sound: 'string', vol: 0.36, on: true, style: 'drone' }, master: 1, fx: {}, drums: {}, ext: {} }, o);
const strokesOf = (n) => Array.from({ length: n }, (_, k) => ({ id: 's' + (k + 1), segs: [[k, 60 + (k % 12), 60.5 + (k % 12)]] }));

test('parse keeps the view prefs grid / loop / snap (undo and reload restore them)', () => {
  const S = md.parse(base({ grid: 16, loop: false, snap: true }));
  assert.deepStrictEqual([S.grid, S.loop, S.snap], [16, false, true]);
  const D = md.parse(base({}));   // defaults for songs without them
  assert.deepStrictEqual([D.grid, D.loop, D.snap], [8, true, false]);
  // undo (main.js applySnap) re-parses a snapshot that lacks the prefs, with the live values put back
  const snapStr = JSON.stringify(md.serialize(S, false));
  assert.strictEqual(JSON.parse(snapStr).snap, undefined);
  const o = JSON.parse(snapStr); ['grid', 'loop', 'snap'].forEach((k) => { o[k] = S[k]; });
  assert.strictEqual(md.parse(o).snap, true);
  assert.deepStrictEqual(md.serialize(md.parse(md.serialize(S, true)), true).snap, true);
});

test('a layer holds 64 line strokes; an old 8-stroke song parses identically', () => {
  assert.strictEqual(md.MAX_STROKES, 64);
  const S = md.parse(base({ layers: [Object.assign(base({}).layers[0], { lines: strokesOf(70) })] }));
  assert.strictEqual(S.layers[0].lines.length, 64);
  assert.strictEqual(md.nextStrokeId(S.layers[0]), 's65');
  const old = base({ layers: [Object.assign(base({}).layers[0], { lines: strokesOf(8) })] });
  const a = md.serialize(md.parse(old), true), b = md.serialize(md.parse(JSON.parse(JSON.stringify(a))), true);
  assert.deepStrictEqual(a.layers[0].lines, old.layers[0].lines);
  assert.deepStrictEqual(b, a);
});

test('backing arpeggio rate (1/32) round-trips through serialize / parse and a share code; old songs unchanged', async () => {
  const S = md.parse(base({ backing: { sound: 'pluck', vol: 0.4, on: true, style: 'arp', styleOpts: { arp: { rate: '1/32', pattern: 'up', oct: 2, gate: 0.6 } } } }));
  const code = await store.encodeShare(md.serialize(S, true));
  const back = md.parse(await store.decodeShare(code));
  assert.deepStrictEqual(back.backing.styleOpts, { arp: { rate: '1/32', pattern: 'up', oct: 2, gate: 0.6 } });
  const plain = md.serialize(md.parse(base({ backing: { sound: 'pluck', vol: 0.4, on: true, style: 'arp' } })), true);
  assert.strictEqual('styleOpts' in plain.backing, false, 'no options written for a song that has none (default rate 1/8)');
});
