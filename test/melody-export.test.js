// MIDI writer + WAV encoder of js/exp/melody/export.js (pure part; the browser part is skipped in Node).
const test = require('node:test');
const assert = require('node:assert');
const X = require('../js/exp/melody/export.js');

// ---- mini SMF parser ----
function parseMidi(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  assert.strictEqual(str(0), 'MThd');
  assert.strictEqual(dv.getUint32(4), 6);
  const fmt = dv.getUint16(8), ntr = dv.getUint16(10), div = dv.getUint16(12);
  let p = 14; const tracks = [];
  for (let k = 0; k < ntr; k++) {
    assert.strictEqual(str(p), 'MTrk', 'track ' + k + ' header');
    const len = dv.getUint32(p + 4), end = p + 8 + len; p += 8;
    const ev = []; let t = 0, run = 0, sawEnd = false;
    const vlq = () => { let v = 0, b; do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < end) {
      t += vlq();
      let st = u8[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) {
        const type = u8[p++], l = vlq(), data = u8.slice(p, p + l); p += l;
        ev.push({ t, meta: type, data });
        if (type === 0x2f) { sawEnd = true; assert.strictEqual(p, end, 'end of track is last'); }
      } else {
        run = st;
        const hi = st & 0xf0, n = hi === 0xc0 || hi === 0xd0 ? 1 : 2, d = u8.slice(p, p + n); p += n;
        ev.push({ t, st: hi, ch: st & 15, d });
      }
    }
    assert.strictEqual(p, end, 'track length matches');
    assert.ok(sawEnd, 'end-of-track meta');
    tracks.push(ev);
  }
  assert.strictEqual(p, u8.length, 'no trailing bytes');
  return { fmt, ntr, div, tracks };
}

const NaNs = (n) => new Float32Array(n).fill(NaN);
function song() {
  const line = NaNs(4 * 48);
  for (let i = 0; i < 24; i++) line[i] = 60 + i / 23 * 4;          // glide C4 -> E4 over half a bar
  for (let i = 48; i < 96; i++) line[i] = 60 + (i - 48) / 47 * 20;  // a 20-semitone sweep: must restart the note
  return {
    bars: 4, bpm: 100, chords: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']],
    layers: [
      { name: 'Layer 1', sound: 'flute', vol: 0.8, line, notes: [] },
      { name: 'Layer 2', sound: 'pluck', vol: 0.5, line: NaNs(192), notes: [{ s: 0, d: 4, m: 64 }, { s: 4, d: 2, m: 67.3 }, { s: 8, d: 8, m: 72 }] },
      { name: 'Layer 3', sound: 'string', vol: 0.5, line: NaNs(192), notes: [{ s: 0, d: 16, m: 48 }] },
    ],
    backing: { sound: 'string', vol: 0.4 },
    drums: { pattern: { kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] } },
  };
}
const soundOf = (S) => (i) => ({ id: S.layers[i].sound, name: S.layers[i].sound[0].toUpperCase() + S.layers[i].sound.slice(1) });
function pairs(evs) {   // note on/off pairing per (channel, key); returns { notes, open }
  const open = new Map(), notes = [];
  for (const e of evs) {
    if (e.st !== 0x90 && e.st !== 0x80) continue;
    const k = e.ch + ':' + e.d[0], on = e.st === 0x90 && e.d[1] > 0;
    if (on) { assert.ok(!open.has(k), 'no double note-on ' + k + ' at ' + e.t); open.set(k, e.t); } else {
      assert.ok(open.has(k), 'note-off without note-on ' + k);
      notes.push({ ch: e.ch, key: e.d[0], t0: open.get(k), t1: e.t }); open.delete(k);
    }
  }
  return { notes, open: open.size };
}

test('MIDI mixed: format 0, tempo, RPN bend range, paired notes, chosen layers only', () => {
  const S = song();
  const m = parseMidi(X.songToMidi(S, { mode: 'mixed', layers: [0, 1], backing: false, drums: false, soundOf: soundOf(S) }));
  assert.strictEqual(m.fmt, 0); assert.strictEqual(m.ntr, 1); assert.strictEqual(m.div, X.PPQ);
  const ev = m.tracks[0];
  const tempo = ev.find((e) => e.meta === 0x51);
  assert.ok(tempo, 'tempo meta');
  assert.strictEqual((tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2], 600000);   // 100 BPM
  const ts = ev.find((e) => e.meta === 0x58); assert.deepStrictEqual([...ts.data], [4, 2, 24, 8]);
  const names = ev.filter((e) => e.meta === 0x04).map((e) => Buffer.from(e.data).toString('utf8'));
  assert.deepStrictEqual(names, ['Layer 1 – Flute', 'Layer 2 – Pluck']);
  const chans = new Set(ev.filter((e) => e.st === 0x90).map((e) => e.ch));
  assert.deepStrictEqual([...chans].sort(), [0, 1], 'two layers on separate channels; layer 3 excluded');
  for (const ch of chans) {   // RPN 0 = 12 semitones, then null RPN, before any note
    const cc = ev.filter((e) => e.st === 0xb0 && e.ch === ch).map((e) => [e.d[0], e.d[1]]);
    assert.deepStrictEqual(cc.slice(0, 6), [[101, 0], [100, 0], [6, 12], [38, 0], [101, 127], [100, 127]]);
    const firstOn = ev.findIndex((e) => e.st === 0x90 && e.ch === ch), rpn = ev.findIndex((e) => e.st === 0xb0 && e.ch === ch && e.d[0] === 6);
    assert.ok(rpn < firstOn, 'bend range set before the first note');
  }
  const { notes, open } = pairs(ev);
  assert.strictEqual(open, 0, 'every note-on has a note-off');
  const l2 = notes.filter((n) => n.ch === 1).map((n) => [n.key, n.t0, n.t1]);
  assert.deepStrictEqual(l2, [[64, 0, 4 * X.T16], [67, 4 * X.T16, 6 * X.T16], [72, 8 * X.T16, 16 * X.T16]]);
  const b = ev.filter((e) => e.st === 0xe0 && e.ch === 1 && e.t === 4 * X.T16).pop();
  const bv = b.d[0] | (b.d[1] << 7);
  assert.ok(Math.abs((bv - 8192) / 8191 * 12 - 0.3) < 0.01, 'microtonal bend ' + bv);
});

test('MIDI line glides become pitch bends; leaving the +-12 range restarts the note', () => {
  const S = song();
  const m = parseMidi(X.songToMidi(S, { mode: 'mixed', layers: [0], soundOf: soundOf(S) }));
  const ev = m.tracks[0], { notes, open } = pairs(ev);
  assert.strictEqual(open, 0);
  const ch0 = notes.filter((n) => n.ch === 0);
  assert.strictEqual(ch0[0].t0, 0); assert.strictEqual(ch0[0].t1, 24 * X.TLINE); assert.strictEqual(ch0[0].key, 60);
  assert.strictEqual(ch0.length, 3, 'sweep split once');
  assert.strictEqual(ch0[1].key, 60); assert.ok(ch0[2].key >= 72, 'restarted above the bend range');
  const bends = ev.filter((e) => e.st === 0xe0 && e.t > 0 && e.t < 24 * X.TLINE);
  assert.ok(bends.length > 40, 'dense bends: ' + bends.length);
  const gaps = bends.slice(1).map((e, i) => e.t - bends[i].t);
  assert.ok(Math.min(...gaps) >= X.TBEND - 1 && X.TBEND === X.PPQ / 64, '~1/64-beat resolution');
  const last = bends[bends.length - 1], v = last.d[0] | (last.d[1] << 7);
  assert.ok(Math.abs((v - 8192) / 8191 * 12 - 4) < 0.25, 'glide reaches +4 semitones: ' + v);
  for (const e of ev.filter((x) => x.st === 0xe0)) { const x = e.d[0] | (e.d[1] << 7); assert.ok(x >= 0 && x <= 16383); }
});

test('MIDI separate: format 1, conductor + one named track per part, drums on channel 10', () => {
  const S = song();
  const u8 = X.songToMidi(S, { mode: 'separate', layers: [0, 2], backing: true, drums: true, loops: 2, soundOf: soundOf(S) });
  const m = parseMidi(u8);
  assert.strictEqual(m.fmt, 1); assert.strictEqual(m.ntr, 5);
  assert.ok(m.tracks[0].some((e) => e.meta === 0x51), 'tempo in conductor track');
  assert.ok(!m.tracks[0].some((e) => e.st === 0x90), 'no notes in conductor');
  const names = m.tracks.slice(1).map((t) => Buffer.from(t.find((e) => e.meta === 0x03).data).toString('utf8'));
  assert.deepStrictEqual(names.map((n) => n.split(' – ')[0]), ['Layer 1', 'Layer 3', 'Backing chords', 'Drums']);
  const drums = m.tracks[4].filter((e) => e.st === 0x90);
  assert.ok(drums.every((e) => e.ch === 9));
  assert.deepStrictEqual([...new Set(drums.map((e) => e.d[0]))].sort(), [36, 38]);
  assert.strictEqual(drums.length, 2 * 4 * 6, '2 loops x 4 bars x 6 hits');
  const back = pairs(m.tracks[3]);
  assert.strictEqual(back.open, 0); assert.strictEqual(back.notes.length, 2 * 4 * 3);
  for (const t of m.tracks.slice(1)) assert.strictEqual(pairs(t).open, 0);
});

test('drumHits reads several pattern shapes', () => {
  assert.deepStrictEqual(X.drumHits({}, 4), []);
  assert.deepStrictEqual(X.drumHits({ on: false, pattern: { kick: [1] } }, 4), []);
  const a = X.drumHits({ tracks: [{ name: 'Hi-hat', steps: [1, 1, 1, 1, 1, 1, 1, 1] }] }, 2);
  assert.strictEqual(a.length, 16); assert.strictEqual(a[1].t16, 2); assert.strictEqual(a[0].note, 42);
  const b = X.drumHits({ lanes: { snare: new Array(32).fill(0).map((_, i) => (i === 20 ? 0.5 : 0)) } }, 4);
  assert.deepStrictEqual(b.map((h) => h.t16), [20, 52]); assert.strictEqual(b[0].vel, 60);
});

test('drumHits reads the B2 format (string lanes, per-bar variations)', () => {
  const pat = { len: 16, kick: 'x.......x.......', snare: '....o.......x...', hat: '................', perc: '..............x.' };
  assert.deepStrictEqual(X.drumHits({ on: false, pat }, 2), []);
  const h = X.drumHits({ on: true, pat, vary: true, bars: { 1: { len: 12, kick: 'x...........', snare: '', hat: '', perc: '' } } }, 2);
  assert.deepStrictEqual(h.map((x) => [x.t16, x.note, x.vel]), [[0, 36, 110], [4, 38, 55], [8, 36, 110], [12, 38, 110], [14, 76, 110], [16, 36, 110]]);
});

test('MIDI: B1 vibrato (song.ext.edit.vib) becomes pitch-bend wobble', () => {
  const S = song();
  S.layers[0].line = NaNs(192); for (let i = 0; i < 48; i++) S.layers[0].line[i] = 62;
  S.ext = { edit: { vib: { 0: { l: [[0, 48, 50, 5]], n: [] }, 1: { l: [], n: [[8, 72, 30, 6]] } } } };
  const ev = parseMidi(X.songToMidi(S, { mode: 'mixed', layers: [0, 1], soundOf: soundOf(S) })).tracks[0];
  const semis = (e) => ((e.d[0] | (e.d[1] << 7)) - 8192) / 8191 * 12;
  const b0 = ev.filter((e) => e.st === 0xe0 && e.ch === 0 && e.t < 48 * X.TLINE).map(semis);
  assert.ok(Math.max(...b0) > 0.45 && Math.min(...b0) < -0.45, 'line wobbles +-50 cents: ' + Math.max(...b0).toFixed(2));
  const b1 = ev.filter((e) => e.st === 0xe0 && e.ch === 1 && e.t > 8 * X.T16 && e.t < 16 * X.T16).map(semis);
  assert.ok(b1.length > 20 && Math.max(...b1) > 0.25 && Math.max(...b1) < 0.31, 'note wobbles +-30 cents');
  const plain = ev.filter((e) => e.st === 0xe0 && e.ch === 1 && e.t > 0 && e.t < 4 * X.T16);
  assert.strictEqual(plain.length, 0, 'notes without vibrato get no wobble');
});

test('WAV header and samples', () => {
  const sr = 44100, n = 1000, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = Math.sin(i / 10); R[i] = i === 5 ? 2 : -1; }
  const w = X.encodeWav([L, R], sr), dv = new DataView(w.buffer);
  const s = (o) => String.fromCharCode(...w.slice(o, o + 4));
  assert.strictEqual(w.length, 44 + n * 4);
  assert.strictEqual(s(0), 'RIFF'); assert.strictEqual(dv.getUint32(4, true), w.length - 8);
  assert.strictEqual(s(8), 'WAVE'); assert.strictEqual(s(12), 'fmt '); assert.strictEqual(dv.getUint32(16, true), 16);
  assert.strictEqual(dv.getUint16(20, true), 1); assert.strictEqual(dv.getUint16(22, true), 2);
  assert.strictEqual(dv.getUint32(24, true), sr); assert.strictEqual(dv.getUint32(28, true), sr * 4);
  assert.strictEqual(dv.getUint16(32, true), 4); assert.strictEqual(dv.getUint16(34, true), 16);
  assert.strictEqual(s(36), 'data'); assert.strictEqual(dv.getUint32(40, true), n * 4);
  assert.strictEqual(dv.getInt16(44 + 5 * 4 + 2, true), 32767, 'clipped');
  assert.strictEqual(dv.getInt16(44 + 2, true), -32768);
  assert.ok(Math.abs(dv.getInt16(44 + 20 * 4, true) / 32767 - Math.sin(2)) < 1e-3);
});

test('vlq encoding', () => {
  assert.deepStrictEqual(X.vlq(0), [0]); assert.deepStrictEqual(X.vlq(127), [127]);
  assert.deepStrictEqual(X.vlq(128), [0x81, 0]); assert.deepStrictEqual(X.vlq(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
});

test('MIDI: overlapping line strokes get a channel each (own pitch bends); Separate keeps one track per layer', () => {
  const NaNs = (n) => new Float32Array(n).fill(NaN);
  const a = NaNs(192), b = NaNs(192);
  for (let i = 0; i < 96; i++) a[i] = 60 + i / 95 * 4;        // glide C4 -> E4
  for (let i = 24; i < 120; i++) b[i] = 67 - (i - 24) / 95 * 3; // overlapping glide G4 -> E4
  const song = { bars: 4, bpm: 120, chords: [null, null, null, null],
    layers: [{ name: 'L1', sound: 'string', vol: 0.8, lines: [{ id: 's1', v: a }, { id: 's2', v: b }], notes: [] }],
    backing: { sound: 'string', vol: 0.4 }, drums: {} };
  const m = parseMidi(X.songToMidi(song, { mode: 'mixed', backing: false, drums: false }));
  const ev = m.tracks[0], ons = ev.filter((e) => e.st === 0x90 && e.d[1] > 0), bends = ev.filter((e) => e.st === 0xe0 && e.t > 0);
  const chs = [...new Set(ons.map((e) => e.ch))].sort();
  assert.strictEqual(chs.length, 2, 'two channels for two simultaneous voices');
  assert.ok(!chs.includes(9), 'channel 10 skipped');
  for (const c of chs) assert.ok(bends.filter((e) => e.ch === c).length > 10, 'channel ' + c + ' has its own bends');
  // non-overlapping strokes share one channel
  const c2 = NaNs(192); for (let i = 120; i < 150; i++) c2[i] = 62;
  const song2 = Object.assign({}, song, { layers: [{ name: 'L1', sound: 'string', vol: 0.8, lines: [{ id: 's1', v: a }, { id: 's3', v: c2 }], notes: [] }] });
  const m2 = parseMidi(X.songToMidi(song2, { mode: 'mixed' }));
  assert.strictEqual(new Set(m2.tracks[0].filter((e) => e.st === 0x90).map((e) => e.ch)).size, 1);
  const s = parseMidi(X.songToMidi(song, { mode: 'separate' }));
  assert.strictEqual(s.ntr, 2, 'conductor + one layer track');
  assert.strictEqual(new Set(s.tracks[1].filter((e) => e.st === 0x90).map((e) => e.ch)).size, 2);
});
