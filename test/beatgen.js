// Synthetic backing tracks for the backing-track tests (Node + browser): a pad with harmonic partials, an 808-style
// sine bass on the chord roots (with a pitch drop), kick / snare / hats. makeBeat(o) -> { x: Float32Array, sr, beats,
// downbeats, chords }; wavBytes(x, sr) -> Uint8Array (16-bit mono PCM). Deterministic (seeded noise).
(function (root) {
  'use strict';
  const IV = { maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10] };
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; }; }
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);

  // o = { bpm, bars, chords: [[root, q], ...] (cycled per bar), lead (s of silence first), heavy, sr, seed }
  function makeBeat(o) {
    const sr = o.sr || 44100, bpm = o.bpm || 90, bars = o.bars || 8, lead = o.lead == null ? 0.25 : o.lead, beat = 60 / bpm;
    const tail = 1.0, n = Math.ceil((lead + bars * 4 * beat + tail) * sr), x = new Float32Array(n), rnd = rng(o.seed || 7);
    const chords = o.chords || [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']], heavy = !!o.heavy;
    const add = (t0, dur, fn) => { const a = Math.max(0, Math.round(t0 * sr)), b = Math.min(n, Math.round((t0 + dur) * sr)); for (let i = a; i < b; i++) x[i] += fn((i - a) / sr); };
    const out = { beats: [], downbeats: [], chords: [] };
    for (let b = 0; b < bars; b++) {
      const ch = chords[b % chords.length], t0 = lead + b * 4 * beat, barLen = 4 * beat;
      out.downbeats.push(t0); out.chords.push(ch);
      for (let k = 0; k < 4; k++) out.beats.push(t0 + k * beat);
      // pad: chord tones voiced from C4 up, 8 harmonics (1/k), soft attack + release
      const tones = IV[ch[1]].map((iv) => 60 + ((ch[0] + iv) % 12));
      tones.forEach((m, j) => {
        const f = hz(m), ph = j * 1.3;
        add(t0, barLen + 0.08, (t) => {
          const env = Math.min(1, t / 0.04) * Math.min(1, (barLen + 0.08 - t) / 0.08);
          let s = 0;
          for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f * h * t * (1 + 0.0004 * j) + ph * h) / h;
          return 0.05 * env * s;
        });
      });
      // 808: sine on the root (E1..D#2), pitch drop from +5 semitones in 40 ms; beat 1 and the "and" of 2 (heavy: also 3.5)
      const fb = hz(28 + ((ch[0] - 4 + 12) % 12)), hits = heavy ? [0, 1.5, 2.5, 3.5] : [0, 1.5, 2.5];
      hits.forEach((p) => {
        let ph = 0, last = 0;
        add(t0 + p * beat, 0.7 * beat * (p ? 0.9 : 1.4), (t) => {
          const f = fb * 2 ** (5 / 12 * Math.exp(-t / 0.04));
          ph += 2 * Math.PI * f * (t - last); last = t;
          return 0.32 * Math.exp(-t / 0.5) * Math.min(1, t / 0.003) * Math.sin(ph);
        });
      });
      // kick: 150 -> 45 Hz click-sine on 1 and 3 (heavy: also the "and" of 3)
      (heavy ? [0, 2, 2.5] : [0, 2]).forEach((p) => {
        let ph = 0, last = 0;
        add(t0 + p * beat, 0.25, (t) => { const f = 45 + 105 * Math.exp(-t / 0.03); ph += 2 * Math.PI * f * (t - last); last = t; return 0.55 * Math.exp(-t / 0.08) * Math.sin(ph); });
      });
      // snare: noise burst + 190 Hz body on 2 and 4
      [1, 3].forEach((p) => {
        let lp = 0;
        add(t0 + p * beat, 0.2, (t) => { const w = rnd(); lp += 0.5 * (w - lp); return (heavy ? 0.42 : 0.3) * Math.exp(-t / 0.05) * (w - lp + 0.6 * Math.sin(2 * Math.PI * 190 * t)); });
      });
      // hats: high-passed noise on eighths (heavy: sixteenths, accents on the eighths)
      const step = heavy ? 0.25 : 0.5;
      for (let p = 0; p < 4; p += step) {
        let prev = 0; const acc = (p * 2) % 1 === 0 ? 1 : 0.55;
        add(t0 + p * beat, 0.05, (t) => { const w = rnd(), y = w - prev; prev = w; return 0.09 * acc * Math.exp(-t / 0.012) * y; });
      }
    }
    let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
    if (pk > 0.95) for (let i = 0; i < n; i++) x[i] *= 0.95 / pk;
    return Object.assign(out, { x, sr, bpm, lead, bars });
  }

  // Click track: short 2 kHz bursts at lead + k * 60 / bpm.
  function clicks(bpm, secs, sr, lead) {
    sr = sr || 22050; lead = lead || 0.1;
    const n = Math.round(secs * sr), x = new Float32Array(n), times = [];
    for (let t = lead; t < secs - 0.05; t += 60 / bpm) {
      times.push(t);
      const a = Math.round(t * sr);
      for (let i = 0; i < 0.02 * sr && a + i < n; i++) x[a + i] += 0.8 * Math.exp(-i / sr / 0.004) * Math.sin(2 * Math.PI * 2000 * i / sr);
    }
    return { x, sr, times };
  }

  function wavBytes(x, sr) {
    const n = x.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    return new Uint8Array(buf);
  }

  const api = { makeBeat, clicks, wavBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VHBeatGen = api;
})(this);
