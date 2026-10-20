// Automation lanes (js/exp/melody/export.js X.auto): curve interpolation, playback ramps, value mapping and the MIDI CC export.
const test = require('node:test');
const assert = require('node:assert');
const X = require('../js/exp/melody/export.js');
const A = X.auto;

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, a + ' vs ' + b);

test('valueAt: linear, smooth (cosine ease), holds before / after, empty', () => {
  const P = [[0, 0], [16, 1], [32, 0.5]];
  near(A.valueAt(P, -4), 0);
  near(A.valueAt(P, 8), 0.5);
  near(A.valueAt(P, 16), 1);
  near(A.valueAt(P, 24), 0.75);
  near(A.valueAt(P, 99), 0.5);
  const S = [[0, 0, 1], [16, 1]];
  near(A.valueAt(S, 8), 0.5);                        // ease is symmetric
  near(A.valueAt(S, 4), (1 - Math.cos(Math.PI / 4)) / 2);
  assert.ok(A.valueAt(S, 4) < 0.25 && A.valueAt(S, 12) > 0.75);
  assert.ok(Number.isNaN(A.valueAt([], 3)));
  near(A.valueAt([[8, 0.3], [8, 0.9]], 8), 0.9);      // a vertical step takes the later value
});

test('real / fmt: lane values in real units', () => {
  near(A.real('vol', 0.5), 0.5);
  near(A.real('pan', 0), -1); near(A.real('pan', 1), 1);
  near(A.real('cut', 0), A.CUT_LO); near(A.real('cut', 1), A.CUT_HI);
  near(A.norm('cut', A.real('cut', 0.37)), 0.37, 1e-12);
  assert.strictEqual(A.fmt('vol', 0.5), '−6.0 dB');
  assert.strictEqual(A.fmt('vol', 1), '0.0 dB');
  assert.strictEqual(A.fmt('vol', 0), '−∞ dB');
  assert.strictEqual(A.fmt('pan', 0.5), 'C');
  assert.strictEqual(A.fmt('pan', 0.2), 'L 60');
  assert.strictEqual(A.fmt('pan', 0.9), 'R 80');
  assert.match(A.fmt('cut', 0.5), /^894 Hz$/);
  assert.match(A.fmt('cut', 1), /kHz$/);
  assert.strictEqual(A.fmt('rev', 0.33), '33%');
});

test('targets: per section lanes, owners must exist; chanKinds maps to FxGraph channels', () => {
  const S = { bars: 4, ts: '4/4', cur: 0, layers: [{ id: 'l1' }, { id: 'l3' }],
    auto: [{ id: 'a1', target: 'l3.pan', points: [] }, { id: 'a2', target: 'master.vol', points: [[0, 1]] }],
    sections: [{ data: null }, { data: { auto: [{ id: 'a1', target: 'l1.cut', points: [[0, 1]] }, { id: 'a2', target: 'l9.vol', points: [] }, { id: 'a3', target: 'drums.vol', points: [] }] } }] };
  assert.deepStrictEqual(A.targets(S), ['drums.vol', 'l1.cut', 'l3.pan', 'master.vol']);
  const k = A.chanKinds(S);
  assert.deepStrictEqual(Object.keys(k).sort(), ['L0', 'L1', 'drums']);
  assert.ok(k.L1.has('pan') && k.L0.has('cut'));
  assert.ok(A.hasMaster(S));
  assert.strictEqual(A.parseTarget('backing.pan'), null);
  assert.deepStrictEqual(A.parseTarget('l2.rev'), { own: 'l2', layer: 'l2', kind: 'rev', chan: null });
});

test('ramp: breakpoints, jumps at piece edges, neutral gaps, dense steps for smooth + cutoff', () => {
  const pcs = [{ a: 0, n: 16, pts: [[0, 0], [8, 1]] }, { a: 32, n: 16, pts: [[0, 0.5]] }];
  assert.deepStrictEqual(A.ramp(pcs, 0, 48, 'vol', 1), [[0, 0, true], [8, 1, false], [16, 1, false], [16, 1, true], [32, 1, false], [32, 0.5, true], [48, 0.5, false]]);
  // a window inside one linear segment: start + end only, on the curve
  assert.deepStrictEqual(A.ramp(pcs, 2, 6, 'vol', 1), [[2, 0.25, true], [6, 0.75, false]]);
  // pan maps to -1..1
  assert.deepStrictEqual(A.ramp([{ a: 0, n: 16, pts: [[0, 0], [16, 1]] }], 0, 16, 'pan', 0).map((x) => x[1]), [-1, 1]);
  // smooth segment: sub-steps every 1/4 sixteenth, exactly on the eased curve
  const sm = A.ramp([{ a: 0, n: 16, pts: [[0, 0, 1], [4, 1]] }], 0, 4, 'vol', 1);
  assert.strictEqual(sm.length, 17);
  sm.forEach(([t, v]) => near(v, A.valueAt([[0, 0, 1], [4, 1]], t), 1e-12));
  // cutoff: dense (the Hz curve is exponential in the lane value), values on the curve
  const cu = A.ramp([{ a: 0, n: 16, pts: [[0, 0], [16, 1]] }], 0, 16, 'cut', 20000);
  assert.ok(cu.length > 60);
  cu.forEach(([t, v]) => near(v, A.real('cut', t / 16), 1e-6));
  // no pieces: neutral
  assert.deepStrictEqual(A.ramp([], 0, 16, 'rev', 0.3), [[0, 0.3, true], [16, 0.3, false]]);
});

test('slice: a loop-region slice keeps the curve (edges become points)', () => {
  const [ln] = A.slice([{ id: 'a1', target: 'l1.vol', points: [[0, 0], [32, 1]] }], 8, 24);
  assert.deepStrictEqual(ln.points, [[0, 0.25], [16, 0.75]]);
  const [sm] = A.slice([{ id: 'a1', target: 'l1.vol', points: [[0, 0, 1], [32, 1]] }], 8, 24);
  for (const [t, v] of sm.points) near(v, A.valueAt([[0, 0, 1], [32, 1]], t + 8), 0.001);
});

// ---- MIDI: minimal SMF reader (channel events + sysex) ----
function events(u8) {
  let p = 14, t = 0, run = 0;
  const out = [];
  const str = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  while (p < u8.length) {
    assert.strictEqual(str(p), 'MTrk');
    const len = (u8[p + 4] << 24) | (u8[p + 5] << 16) | (u8[p + 6] << 8) | u8[p + 7], end = p + 8 + len;
    p += 8; t = 0;
    const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end) {
      t += vlq();
      let st = u8[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) { p++; const l = vlq(); p += l; continue; }
      if (st === 0xf0) { const l = vlq(); out.push({ t, sys: Array.from(u8.slice(p, p + l)) }); p += l; continue; }
      run = st;
      const hi = st & 0xf0, n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
      out.push({ t, st: hi, ch: st & 15, d: Array.from(u8.slice(p, p + n)) });
      p += n;
    }
    assert.strictEqual(p, end);
  }
  return out;
}
const song = (auto) => ({ bars: 2, ts: '4/4', bpm: 120, chords: [[0, 'maj'], [7, 'maj']], drums: {}, backing: { sound: 'string', vol: 0.5 },
  fx: { layers: [{ rev: 0.4, dly: 0.2 }] },
  layers: [{ id: 'l1', name: 'Lead', sound: 'string', vol: 0.8, line: new Float32Array(96).fill(NaN), notes: [{ s: 0, d: 32, m: 60 }] }], auto });

test('MIDI CC: CC7 volume (x fader), CC10 pan, CC74 cutoff, CC91 reverb, CC93 delay; master volume SysEx', () => {
  const S = song([{ id: 'a1', target: 'l1.vol', points: [[0, 0], [32, 1]] }, { id: 'a2', target: 'l1.pan', points: [[0, 0], [32, 1]] },
    { id: 'a3', target: 'l1.cut', points: [[0, 0.5]] }, { id: 'a4', target: 'l1.rev', points: [[0, 1], [16, 0]] }, { id: 'a5', target: 'l1.dly', points: [[16, 0.5]] },
    { id: 'a6', target: 'backing.vol', points: [[0, 0.5]] }, { id: 'a7', target: 'master.vol', points: [[0, 1], [32, 0]] }]);
  const ev = events(X.songToMidi(S, { layers: [0], backing: true, drums: false }));
  const cc = (n, ch) => ev.filter((e) => e.st === 0xb0 && e.d[0] === n && (ch == null || e.ch === ch));
  const lead = ev.find((e) => e.st === 0x90).ch, back = ev.filter((e) => e.st === 0x90 && e.ch !== lead)[0].ch;
  // CC7: the setup value (fader 0.8) then the lane x fader: 0 at the start ... 102 at the end; ticks 240 per sixteenth
  const v7 = cc(7, lead);
  assert.strictEqual(v7[0].d[1], 102);
  assert.strictEqual(v7[1].t, 0); assert.strictEqual(v7[1].d[1], 0);
  assert.strictEqual(v7[v7.length - 1].d[1], 102);
  const mid = v7.filter((e) => e.t === 16 * 240)[0];
  assert.strictEqual(mid.d[1], Math.round(0.5 * 0.8 * 127));
  assert.ok(v7.every((e, i) => i < 2 || e.d[1] >= v7[i - 1].d[1]), 'monotonic ramp');
  assert.ok(v7.slice(1).every((e, i, a) => !i || e.d[1] !== a[i - 1].d[1]), 'only changes are written');
  const p10 = cc(10, lead);
  assert.deepStrictEqual([p10[0].d[1], p10[p10.length - 1].d[1]], [0, 127]);
  assert.ok(p10.some((e) => e.t === 16 * 240 && e.d[1] === 64));
  assert.deepStrictEqual(cc(74, lead).map((e) => e.d[1]), [64]);
  const r91 = cc(91, lead);
  assert.deepStrictEqual([r91[0].d[1], r91[r91.length - 1].d[1]], [127, 0]);
  assert.deepStrictEqual(cc(93, lead).map((e) => e.d[1]), [64]);
  assert.deepStrictEqual(cc(7, back).map((e) => e.d[1]), [64, 32]);   // setup (0.5) then 0.5 x 0.5
  const sys = ev.filter((e) => e.sys);
  assert.deepStrictEqual(sys[0].sys, [0x7f, 0x7f, 0x04, 0x01, 0x7f, 0x7f, 0xf7]);
  assert.deepStrictEqual(sys[sys.length - 1].sys.slice(4, 6), [0, 0]);
  // CC events come after the channel setup at tick 0, and before the first note
  const i7 = ev.indexOf(v7[1]), iOn = ev.findIndex((e) => e.st === 0x90 && e.ch === lead);
  assert.ok(ev.indexOf(v7[0]) < i7 && i7 < iOn);
});

test('MIDI: loops repeat the lane; a section without a lane is neutral (flattened songs); no lanes = no extra events', () => {
  const S = song([{ id: 'a1', target: 'l1.pan', points: [[0, 0], [32, 1]] }]);
  const ev = events(X.songToMidi(S, { layers: [0], loops: 2 }));
  const p = ev.filter((e) => e.st === 0xb0 && e.d[0] === 10);
  assert.ok(p.some((e) => e.t === 32 * 240 && e.d[1] === 0), 'the second pass restarts the curve');
  const F = Object.assign(song([]), { flat: { tot: 64, bars: [], ts: [] }, bars: 4, flatAuto: { 'l1.vol': [{ a: 0, n: 32, pts: [[0, 0], [32, 1]] }] } });
  const ev2 = events(X.songToMidi(F, { layers: [0] }));
  const v = ev2.filter((e) => e.st === 0xb0 && e.d[0] === 7);
  assert.strictEqual(v[v.length - 1].d[1], 102);   // neutral in the second section = the fader
  const plain = X.songToMidi(song([]), { layers: [0] }), none = X.songToMidi(Object.assign(song([]), { auto: undefined }), { layers: [0] });
  assert.deepStrictEqual(Array.from(plain), Array.from(none));
  assert.strictEqual(events(plain).filter((e) => e.st === 0xb0 && [10, 74, 91, 93].includes(e.d[0])).length, 0);
});
