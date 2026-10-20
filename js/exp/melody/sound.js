// melody/sound.js - Wave B part B2 "Sound": per-channel insert FX + global send reverb/delay, Shimmer, a drum lane
// (synthesized kit, step sequencer under the canvas), backing chord styles, and play-feel extras (harmony magnet,
// humanize, band sparkle). Data lives in M.song.fx / M.song.drums / M.song.backing.style (plain JSON: autosave,
// share and undo). See MELODY.md. Everything here is Web Audio only: no samples, no worklets.
//
// Signal path (live): layer bus i / backing bus / drum bus -> [insert chain <= 3 fx] -> sum
//                                                          \-> send R -> send reverb (or shimmer) -> sum
//                                                          \-> send D -> send delay -> sum
// Shimmer = a convolution reverb whose tail is fed through a real octave-up pitch shifter (two crossfaded Doppler delay
// taps driven by looping sawtooth/window buffers, i.e. the classic delay-line pitch shifter built from native nodes)
// and back into the reverb, so each pass climbs another octave; a share of the shifted tail is also mixed in directly.
//
// Scheduling: drums + backing styles use a look-ahead scheduler (120 ms) on an audio-clock anchor derived from the
// tick info, so hits are placed sample-accurately with opts.when. Layer notes are played (and scheduled ahead) by the
// engine; humanize moves them through M.hooks.voiceOpts and the magnet bends line voices through M.hooks.pitchMod.
// The drum lane is an M.view.addLane strip, its mixer row an M.ui.mixer.addRow row.
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody, md = NS.model;
  const { clamp, chordMidis } = md;
  const LA = 0.12, HUM_T = 0.015, HUM_V = 0.1, MAX_INS = 3, DRUM_LVL = md.GAIN.DRUMS, MAX_SPARKS = 20;
  const pct = (v) => Math.round(v * 100) + '%';

  // ---------- data ----------
  const SYNC = { '1/16': 0.25, '1/8': 0.5, '1/8d': 0.75, '1/4': 1, '1/4d': 1.5, '1/2': 2 };
  const SHIM_DEF = { size: 0.8, decay: 2.2, amount: 0.55, mix: 0.45 };
  const FX_PRESETS = [
    ['dry', 'Dry', []],
    ['room', 'Room', [{ type: 'reverb', params: { size: 0.15, decay: 4, mix: 0.3 } }]],
    ['hall', 'Hall', [{ type: 'reverb', params: { size: 0.75, decay: 2.4, mix: 0.4 } }]],
    ['shimmer', 'Shimmer', [{ type: 'shimmer', params: { size: 0.8, decay: 2.2, amount: 0.55, mix: 0.45 } }]],
    ['echo', 'Echo', [{ type: 'delay', params: { sync: '1/8d', time: 0.375, feedback: 0.4, tone: 3500, mix: 0.3 } }]],
    ['lofi', 'Lo-fi', [{ type: 'lofi', params: { bits: 6, rate: 7000, mix: 1 } }, { type: 'chorus', params: { rate: 0.35, depth: 0.35, mix: 0.4 } },
      { type: 'filter', params: { type: 'lowpass', cutoff: 3200, q: 0.9, mix: 1 } }]],
    ['warm', 'Warm drive', [{ type: 'drive', params: { amount: 0.4, mix: 1 } }, { type: 'filter', params: { type: 'lowpass', cutoff: 4200, q: 0.5, mix: 1 } }]],
  ];
  const FX_TYPES = ['reverb', 'shimmer', 'delay', 'chorus', 'drive', 'lofi', 'filter'];
  const s1 = (v) => v.toFixed(1), hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz');
  const PARAMS = {   // [key, label, min, max, step, fmt]
    reverb: [['size', 'Size', 0, 1, 0.01, pct], ['decay', 'Decay', 0.5, 8, 0.1, s1], ['mix', 'Mix', 0, 1, 0.01, pct]],
    shimmer: [['size', 'Size', 0, 1, 0.01, pct], ['amount', 'Octave shimmer', 0, 1, 0.01, pct], ['mix', 'Mix', 0, 1, 0.01, pct]],
    delay: [['time', 'Time', 0.02, 1.5, 0.01, (v) => Math.round(v * 1000) + ' ms'], ['feedback', 'Feedback', 0, 0.9, 0.01, pct],
      ['tone', 'Tone', 500, 12000, 50, hz], ['mix', 'Mix', 0, 1, 0.01, pct]],
    chorus: [['rate', 'Rate', 0.05, 5, 0.05, (v) => v.toFixed(2) + ' Hz'], ['depth', 'Depth', 0, 1, 0.01, pct], ['mix', 'Mix', 0, 1, 0.01, pct]],
    drive: [['amount', 'Amount', 0, 1, 0.01, pct], ['mix', 'Mix', 0, 1, 0.01, pct]],
    lofi: [['bits', 'Bits', 2, 12, 1, String], ['rate', 'Rate', 1500, 16000, 100, hz], ['mix', 'Mix', 0, 1, 0.01, pct]],
    filter: [['cutoff', 'Cutoff', 60, 16000, 10, hz], ['q', 'Resonance', 0.1, 12, 0.1, s1], ['mix', 'Mix', 0, 1, 0.01, pct]],
  };
  const typeDefaults = (t) => Object.assign({}, t === 'shimmer' ? SHIM_DEF : VH.fx.DEFAULTS[t], t === 'delay' ? { sync: '1/8' } : null);
  const REV_DEF = { size: 0.7, decay: 2.5, shimmer: 0 }, DLY_DEF = { sync: '1/4', time: 0.5, feedback: 0.35, tone: 4000 };
  const ROWS = [['kick', 'Kick'], ['snare', 'Snare'], ['hat', 'Hat'], ['perc', 'Perc']];
  const DRUM_PRESETS = [
    ['off', 'Off', null],
    ['rock', 'Basic rock', { kit: 'std', len: 16, kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', perc: '................' }],
    ['half', 'Half-time', { kit: 'std', len: 16, kick: 'x.........x.....', snare: '........x.......', hat: 'x.x.x.x.x.x.x.x.', perc: '..............o.' }],
    ['hiphop', 'Hip-hop', { kit: 'std', len: 16, kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo', perc: '.......o.......o' }],
    ['waltz', 'Waltz', { kit: 'std', len: 12, kick: 'x...........', snare: '....x...x...', hat: 'x.o.x.o.x.o.', perc: '............' }],
    ['four', 'Four-on-floor', { kit: 'std', len: 16, kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', perc: '.o.o.o.o.o.o.o.o' }],
    ['brush', 'Brush', { kit: 'brush', len: 16, kick: 'x.......x.......', snare: 'x..ox..ox..ox..o', hat: '....x.......x...', perc: '................' }],
  ];
  const STYLES = [['drone', 'Held'], ['strum', 'Strum'], ['arp', 'Arpeggio'], ['pulse', 'Pulse'], ['broken', 'Broken']];
  // Per-style sub-settings: M.song.backing.styleOpts[style] (plain JSON: autosave, share, undo). Missing = these defaults,
  // which reproduce the original fixed patterns (arp 1/8 up, strum 40 ms down, pulse on quarters, broken bass + chord).
  const STYLE_DEF = {
    arp: { rate: '1/8', pattern: 'up', oct: 1, gate: 0.95 },
    strum: { speed: 40, dir: 'down' },
    pulse: { rate: '1/4', gate: 0.85 },
    broken: { pattern: 'bc' },
  };
  const STYLE_CHOICES = {   // [value, label]
    arp: { rate: [['1/4', '1/4'], ['1/8', '1/8'], ['1/8t', '1/8 T'], ['1/16', '1/16']],
      pattern: [['up', 'Up'], ['down', 'Down'], ['updown', 'Up-down'], ['random', 'Random'], ['played', 'As played']],
      oct: [[1, '1'], [2, '2'], [3, '3']] },
    strum: { dir: [['down', 'Down'], ['up', 'Up'], ['alt', 'Alternate']] },
    pulse: { rate: [['1/2', '1/2'], ['1/4', '1/4'], ['1/8', '1/8']] },
    broken: { pattern: [['bc', 'Bass-chord'], ['bcc', 'Bass-chord-chord'], ['alberti', 'Alberti']] },
  };
  const STYLE_NUM = { gate: [0.25, 1], speed: [10, 80] };
  const STEP16 = { '1/2': 8, '1/4': 4, '1/8': 2, '1/8t': 4 / 3, '1/16': 1 };   // sixteenths per note
  const fit = (s, n) => (String(s || '') + '.'.repeat(n)).slice(0, n).replace(/[^xo.]/g, '.');
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const DEF_PAT = Object.assign({}, DRUM_PRESETS[1][2]);

  // ---------- song accessors (read with defaults; write via the *W variants) ----------
  const fxOf = (S) => (S.fx && typeof S.fx === 'object' ? S.fx : {});
  const DEF_REC = { preset: 'dry', chain: [], rev: 0, dly: 0 };
  function recOf(S, key) {
    const f = fxOf(S), r = key === 'backing' ? f.backing : key === 'drums' ? f.drums : (f.layers || [])[+key.slice(1)];
    return r && typeof r === 'object' ? Object.assign({}, DEF_REC, r, { chain: Array.isArray(r.chain) ? r.chain.filter((x) => x && FX_TYPES.includes(x.type)).slice(0, MAX_INS) : [] }) : DEF_REC;
  }
  function recW(S, key) {
    if (!S.fx || typeof S.fx !== 'object') S.fx = {};
    const f = S.fx, cur = recOf(S, key), r = copy(cur);
    if (key === 'backing') f.backing = r;
    else if (key === 'drums') f.drums = r;
    else { if (!Array.isArray(f.layers)) f.layers = []; const i = +key.slice(1); while (f.layers.length < i) f.layers.push(null); f.layers[i] = r; }
    return r;
  }
  const revOf = (S) => Object.assign({}, REV_DEF, fxOf(S).rev);
  const dlyOf = (S) => Object.assign({}, DLY_DEF, fxOf(S).dly);
  const fxW = (S) => { if (!S.fx || typeof S.fx !== 'object') S.fx = {}; return S.fx; };
  const extra = (S, k, d) => (fxOf(S)[k] != null ? fxOf(S)[k] : d);
  // Drum steps follow the section's time signature: one step per sixteenth (len = md.spb), plus the 12-step grid that
  // 4/4 always allowed. A pattern of another length (the meter changed) adapts: presets are rebuilt for the meter
  // (presetPat), custom patterns are cut / padded.
  const lenOk = (S, n) => n === md.spb(S) || (md.spb(S) === 16 && md.tsOf(S).d === 4 && n === 12);
  function presetPat(id, ts) {
    const p = DRUM_PRESETS.find((x) => x[0] === id);
    if (!p || !p[2]) return null;
    const T = md.TS[ts] || md.TS['4/4'], n = T.spb, kit = p[2].kit;
    if (n === 16 && T.d === 4) return normPat(p[2]);
    const h = { kick: {}, snare: {}, hat: {}, perc: {} }, row = (o) => Array.from({ length: n }, (_, j) => o[j] || '.').join('');
    if (ts === '3/4') return normPat(DRUM_PRESETS.find((x) => x[0] === 'waltz')[2], 12, kit);   // waltz
    if (T.compound) {   // 6/8, 12/8: kick on the first dotted quarter of each pair, snare on the other, hat on the eighths
      T.beats.forEach((b, k) => { (k % 2 ? h.snare : h.kick)[b] = 'x'; });
      for (let j = 0; j < n; j += 2) h.hat[j] = j % 6 ? 'o' : 'x';
    } else {   // 2/4, 5/4, 7/8: kick on the first beat (and every other one), snare between, hat on the eighths
      T.beats.forEach((b, k) => { (k % 2 ? h.snare : h.kick)[b] = 'x'; });
      for (let j = 0; j < n; j += 2) h.hat[j] = 'x';
    }
    if (kit === 'brush') Object.keys(h.hat).forEach((j) => { h.hat[j] = 'o'; });
    return { len: n, kit, kick: row(h.kick), snare: row(h.snare), hat: row(h.hat), perc: row(h.perc) };
  }
  function drumsOf(S) {
    const d = S.drums && typeof S.drums === 'object' ? S.drums : {};
    let pat = normPat(d.pat || DEF_PAT);
    const want = presetPat(d.preset, S.ts);   // a preset is rebuilt for the meter; a custom pattern is cut / padded
    const ts = S.ts || '4/4', was = typeof d.ts === 'string' ? d.ts : '4/4';   // d.ts: the meter the pattern was made for
    if (want && (pat.len !== want.len || was !== ts)) pat = want; else if (!lenOk(S, pat.len)) pat = normPat(pat, md.spb(S));
    const bars = {};
    if (d.bars && typeof d.bars === 'object') for (const k of Object.keys(d.bars)) if (d.bars[k]) bars[k] = normPat(d.bars[k], pat.len);
    return { on: !!d.on, ts: S.ts || '4/4', preset: typeof d.preset === 'string' ? d.preset : 'off', vol: typeof d.vol === 'number' ? clamp(d.vol, 0, md.VOL_MAX) : 0.7,
      vary: !!d.vary, kit: d.kit === 'brush' ? 'brush' : 'std', pat, bars };
  }
  function normPat(p, len, kit) {
    const n = len || (p.len > 0 && p.len <= 24 ? p.len | 0 : 16), o = { len: n };
    if (kit) o.kit = kit;
    ROWS.forEach(([k]) => { o[k] = fit(p[k], n); });
    Object.keys(p).forEach((k) => { if (/^r[1-9]$/.test(k)) o[k] = fit(p[k], n); });   // extra kit rows
    return o;
  }
  const drumsW = (S) => { S.drums = drumsOf(S); return S.drums; };
  const patFor = (d, bar) => (d.vary && d.bars[bar] ? d.bars[bar] : d.pat);
  const styleOf = (S) => (STYLES.some((s) => s[0] === S.backing.style) ? S.backing.style : 'drone');
  // Sub-settings of a style, validated, with defaults for anything missing (old songs have none).
  function styleOptsOf(S, style) {
    const def = STYLE_DEF[style];
    if (!def) return {};
    const all = S.backing && S.backing.styleOpts && typeof S.backing.styleOpts === 'object' ? S.backing.styleOpts : {};
    const src = all[style] && typeof all[style] === 'object' ? all[style] : {}, ch = STYLE_CHOICES[style] || {}, o = Object.assign({}, def);
    for (const k of Object.keys(def)) {
      const v = src[k];
      if (ch[k]) { if (ch[k].some((c) => c[0] === v)) o[k] = v; } else if (typeof v === 'number' && isFinite(v)) o[k] = clamp(v, STYLE_NUM[k][0], STYLE_NUM[k][1]);
    }
    return o;
  }
  function styleOptsW(S, style) {
    if (!S.backing.styleOpts || typeof S.backing.styleOpts !== 'object') S.backing.styleOpts = {};
    return (S.backing.styleOpts[style] = styleOptsOf(S, style));
  }
  const delayTime = (p, bpm) => (p.sync && SYNC[p.sync] ? clamp(SYNC[p.sync] * 60 / bpm, 0.02, 2) : p.time);
  function paramsFor(item, bpm) {
    const p = Object.assign({}, item.params);
    if (item.type === 'delay') p.time = delayTime(Object.assign({ time: 0.3 }, p), bpm);
    return p;
  }

  // ---------- DSP building blocks ----------
  const setP = (c, param, v) => { if (c.currentTime <= 0.001) param.value = v; else param.setTargetAtTime(v, c.currentTime, 0.02); };
  // Octave-up pitch shifter: 2 delay taps whose delay falls at 1 s/s (pitch x2) over a 50 ms window, half a window
  // apart, crossfaded with sin^2 windows that are 0 where each tap's delay jumps back.
  function octaveUp(c) {
    const n = Math.max(256, Math.round(c.sampleRate * 0.05)), W = n / c.sampleRate;
    const ramp = c.createBuffer(1, n, c.sampleRate), win = c.createBuffer(1, n, c.sampleRate);
    const r = ramp.getChannelData(0), w = win.getChannelData(0);
    for (let i = 0; i < n; i++) { const ph = i / n; r[i] = 1 - ph; w[i] = Math.sin(Math.PI * ph) ** 2; }
    const input = c.createGain(), output = c.createGain(), nodes = [input, output], srcs = [];
    const t = c.currentTime + (c.currentTime > 0 ? 0.01 : 0);
    for (let k = 0; k < 2; k++) {
      const d = c.createDelay(0.2), rs = c.createBufferSource(), rg = c.createGain(), ws = c.createBufferSource(), g = c.createGain();
      d.delayTime.value = 0.004; rs.buffer = ramp; rs.loop = true; rg.gain.value = W; ws.buffer = win; ws.loop = true; g.gain.value = 0;
      rs.connect(rg); rg.connect(d.delayTime); ws.connect(g.gain);
      input.connect(d); d.connect(g); g.connect(output);
      rs.start(t, k * W / 2); ws.start(t, k * W / 2);
      nodes.push(d, rg, g); srcs.push(rs, ws);
    }
    return { input, output, dispose() { srcs.forEach((s) => { try { s.stop(); } catch (_) { /* ignore */ } try { s.disconnect(); } catch (_) { /* ignore */ } }); nodes.forEach((x) => { try { x.disconnect(); } catch (_) { /* ignore */ } }); } };
  }
  function shimmer(c, params) {
    const p = Object.assign({}, SHIM_DEF), nodes = [];
    const n = (x) => { nodes.push(x); return x; };
    const input = n(c.createGain()), output = n(c.createGain()), dry = n(c.createGain()), wet = n(c.createGain());
    const hp = n(c.createBiquadFilter()), lp = n(c.createBiquadFilter()), fb = n(c.createGain()), up = n(c.createGain());
    hp.type = 'highpass'; hp.frequency.value = 500; lp.type = 'lowpass'; lp.frequency.value = 9000;
    const rev = VH.fx.create(c, 'reverb', { size: p.size, decay: p.decay, mix: 1 }), sh = octaveUp(c);
    input.connect(dry); dry.connect(output); wet.connect(output);
    input.connect(rev.input); rev.output.connect(wet);
    rev.output.connect(hp); hp.connect(sh.input); sh.output.connect(lp); lp.connect(fb); fb.connect(rev.input);
    lp.connect(up); up.connect(wet);
    let disposed = false;
    const fx = {
      type: 'shimmer', input, output, ctx: c,
      get params() { return Object.assign({}, p); },
      set(np) {
        if (disposed || !np) return fx;
        for (const k of Object.keys(SHIM_DEF)) if (np[k] != null && isFinite(np[k])) p[k] = +np[k];
        rev.set({ size: p.size, decay: p.decay });
        const m = clamp(p.mix, 0, 1), a = clamp(p.amount, 0, 1);
        setP(c, dry.gain, 1 - m); setP(c, wet.gain, m); setP(c, fb.gain, 0.5 * a); setP(c, up.gain, 0.7 * a);
        return fx;
      },
      dispose() {
        if (disposed) return;
        disposed = true; rev.dispose(); sh.dispose();
        nodes.forEach((x) => { try { x.disconnect(); } catch (_) { /* ignore */ } });
      },
    };
    fx.set(Object.assign({}, p, params));
    return fx;
  }
  const makeFx = (c, item, bpm) => (item.type === 'shimmer' ? shimmer(c, item.params) : VH.fx.create(c, item.type, paramsFor(item, bpm)));
  const buildChain = (c, list, bpm) => VH.fx.chain(c, list.map((x) => makeFx(c, x, bpm)));

  // Mixer graph for one context: channels with insert chains + the two global send effects, all into `dest`.
  let graphsAlive = 0;
  function FxGraph(c, dest) {
    graphsAlive++;
    const chans = new Map(), drumBus = c.createGain(); drumBus.gain.value = 0;
    const revIn = c.createGain(), dlyIn = c.createGain(), revOut = c.createGain(), dlyOut = c.createGain();
    revOut.connect(dest); dlyOut.connect(dest);
    let rev = null, revType = '', dly = null, disposed = false;
    function Channel(src) {
      const sR = c.createGain(), sD = c.createGain();
      sR.gain.value = 0; sD.gain.value = 0; sR.connect(revIn); sD.connect(dlyIn);
      let chain = null, sig = null, aSig = '', last = DEF_REC;
      // Automation (export.js X.auto): only while a lane targets this channel, src -> [gain] [panner] [lowpass] -> chain,
      // and the sends go through their own gains (aR / aD, set by the lane) instead of sR / sD. No lane: the plain graph.
      const A = { vol: null, pan: null, cut: null, rev: null, dly: null };
      const pre = () => [A.vol, A.pan, A.cut].filter(Boolean);
      function wire() {
        try { src.disconnect(); } catch (_) { /* ignore */ }
        pre().forEach((n) => { try { n.disconnect(); } catch (_) { /* ignore */ } });
        try { chain.output.disconnect(); } catch (_) { /* ignore */ }
        let h = src;
        for (const n of pre()) { h.connect(n); h = n; }
        h.connect(chain.input);
        chain.output.connect(dest); chain.output.connect(A.rev || sR); chain.output.connect(A.dly || sD);
      }
      function setAuto(kinds) {
        const s2 = kinds ? [...kinds].sort().join(',') : '';
        if (s2 === aSig) return false;
        aSig = s2;
        for (const k of Object.keys(A)) {
          const want = !!(kinds && kinds.has(k));
          if (want && !A[k]) {
            if (k === 'pan') A[k] = c.createStereoPanner ? c.createStereoPanner() : null;   // old WebKit: no pan lane
            else if (k === 'cut') { A[k] = c.createBiquadFilter(); A[k].type = 'lowpass'; A[k].Q.value = 0; A[k].frequency.value = 20000; }
            else { A[k] = c.createGain(); A[k].gain.value = k === 'vol' ? 1 : clamp(+last[k] || 0, 0, 1); if (k === 'rev') A[k].connect(revIn); if (k === 'dly') A[k].connect(dlyIn); }
          } else if (!want && A[k]) { try { A[k].disconnect(); } catch (_) { /* ignore */ } A[k] = null; }
        }
        return true;
      }
      return {
        src,
        get items() { return chain ? chain.items.length : 0; },
        // the automated AudioParams of this channel (null when not automated) + their neutral (no-lane) values
        params() { return { vol: A.vol && A.vol.gain, pan: A.pan && A.pan.pan, cut: A.cut && A.cut.frequency, rev: A.rev && A.rev.gain, dly: A.dly && A.dly.gain }; },
        neutral(k) { return k === 'vol' ? 1 : k === 'pan' ? 0 : k === 'cut' ? 20000 : clamp(+last[k] || 0, 0, 1); },
        get autoSig() { return aSig; },
        update(rec, bpm, kinds) {
          last = rec;
          const list = rec.chain.slice(0, MAX_INS), s = list.map((x) => x.type).join(',');
          const re = setAuto(kinds);
          if (chain && s === sig) { list.forEach((x, i) => chain.items[i].set(paramsFor(x, bpm))); if (re) wire(); }
          else {
            const nc = buildChain(c, list, bpm);
            if (aSig || re) { const old = chain; chain = nc; sig = s; wire(); if (old) old.dispose(); }
            else {
              try { src.disconnect(); } catch (_) { /* ignore */ }
              src.connect(nc.input); nc.output.connect(dest); nc.output.connect(sR); nc.output.connect(sD);
              if (chain) chain.dispose();
              chain = nc; sig = s;
            }
          }
          setP(c, sR.gain, clamp(+rec.rev || 0, 0, 1)); setP(c, sD.gain, clamp(+rec.dly || 0, 0, 1));
        },
        dispose() {
          try { src.disconnect(); } catch (_) { /* ignore */ }
          if (chain) chain.dispose();
          try { sR.disconnect(); } catch (_) { /* ignore */ }
          try { sD.disconnect(); } catch (_) { /* ignore */ }
          Object.keys(A).forEach((k) => { if (A[k]) { try { A[k].disconnect(); } catch (_) { /* ignore */ } A[k] = null; } });
        },
      };
    }
    const g = {
      c, dest, drumBus, chans,
      sends(S) {
        const r = revOf(S), d = dlyOf(S), rt = r.shimmer > 0 ? 'shimmer' : 'reverb';
        const rp = rt === 'shimmer' ? { size: r.size, decay: r.decay, amount: r.shimmer, mix: 1 } : { size: r.size, decay: r.decay, mix: 1 };
        if (!rev || revType !== rt) {
          const old = rev;
          rev = rt === 'shimmer' ? shimmer(c, rp) : VH.fx.create(c, 'reverb', rp); revType = rt;
          revIn.connect(rev.input); rev.output.connect(revOut);
          if (old) { try { revIn.disconnect(old.input); } catch (_) { /* ignore */ } old.dispose(); }
        } else rev.set(rp);
        const dp = { time: delayTime(d, S.bpm), feedback: d.feedback, tone: d.tone, mix: 1 };
        if (!dly) { dly = VH.fx.create(c, 'delay', dp); dlyIn.connect(dly.input); dly.output.connect(dlyOut); } else dly.set(dp);
      },
      channel(key, src, rec, bpm, kinds) {
        if (!src) return;
        let ch = chans.get(key);
        if (ch && ch.src !== src) { ch.dispose(); ch = null; }
        if (!ch) { ch = Channel(src); chans.set(key, ch); }
        ch.update(rec, bpm, kinds);
      },
      prune(keep) { for (const [k, ch] of chans) if (!keep.has(k)) { ch.dispose(); chans.delete(k); } },
      update(S, srcs) {   // srcs: { L0: node, ..., backing: node } (drums use drumBus)
        g.sends(S);
        const keep = new Set(['drums']), AL = NS.exportLib && NS.exportLib.auto, ak = AL ? AL.chanKinds(S) : {};   // automated channels
        for (const k of Object.keys(srcs)) { keep.add(k); g.channel(k, srcs[k], recOf(S, k), S.bpm, ak[k]); }
        g.channel('drums', drumBus, recOf(S, 'drums'), S.bpm, ak.drums);
        g.prune(keep);
        const d = drumsOf(S);
        setP(c, drumBus.gain, d.on ? d.vol * DRUM_LVL : 0);
      },
      stats() { let items = 0; chans.forEach((ch) => { items += ch.items; }); return { chans: chans.size, items, rev: revType, disposed }; },
      dispose() {
        if (disposed) return;
        disposed = true; graphsAlive--;
        chans.forEach((ch) => ch.dispose()); chans.clear();
        if (rev) rev.dispose(); if (dly) dly.dispose();
        [drumBus, revIn, dlyIn, revOut, dlyOut].forEach((x) => { try { x.disconnect(); } catch (_) { /* ignore */ } });
      },
    };
    return g;
  }

  // ---------- drum synthesis (no samples) ----------
  const noiseBufs = new WeakMap();
  function noiseOf(c) {
    let b = noiseBufs.get(c);
    if (!b) {
      b = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseBufs.set(c, b);
    }
    return b;
  }
  // Returns { srcs, t, end } so a caller can cancel hits that have not started yet.
  function drumHit(c, dest, kind, t, vel, kit) {
    const srcs = [], nodes = [], brush = kit === 'brush';
    t = Math.max(t, c.currentTime);
    let end = t;
    const node = (x) => { nodes.push(x); return x; };
    const env = (peak, att, dec) => {
      const g = node(c.createGain());
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att);
      g.gain.exponentialRampToValueAtTime(Math.max(1e-5, peak * 0.001), t + att + dec); g.gain.setValueAtTime(0, t + att + dec + 0.002);
      g.connect(dest); end = Math.max(end, t + att + dec + 0.01);
      return g;
    };
    const filt = (type, f, q) => { const b = node(c.createBiquadFilter()); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    const src = (s, dur) => { s.start(t); s.stop(t + dur); srcs.push(s); return s; };
    const noise = (dur) => { const s = c.createBufferSource(); s.buffer = noiseOf(c); s.loop = true; s.start(t, Math.random() * 0.8); s.stop(t + dur); srcs.push(s); return s; };
    const osc = (type, f, dur) => { const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return src(o, dur); };
    if (kind === 'kick') {
      const dec = brush ? 0.3 : 0.42, o = osc('sine', brush ? 110 : 155, dec + 0.05);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
      o.connect(env((brush ? 0.75 : 1) * vel, 0.002, dec));
      if (!brush) { const n = noise(0.03), f = filt('highpass', 2500); n.connect(f); f.connect(env(0.18 * vel, 0.001, 0.012)); }
    } else if (kind === 'snare') {
      if (brush) { const n = noise(0.4), f = filt('bandpass', 2500, 0.6); n.connect(f); f.connect(env(0.32 * vel, 0.025, 0.22)); }
      else {
        const n = noise(0.3), f = filt('highpass', 1400); n.connect(f); f.connect(env(0.5 * vel, 0.001, 0.18));
        const o = osc('triangle', 190, 0.16); o.frequency.exponentialRampToValueAtTime(160, t + 0.1); o.connect(env(0.32 * vel, 0.001, 0.1));
      }
    } else if (kind === 'hat') {
      const n = noise(brush ? 0.15 : 0.1), f = brush ? filt('bandpass', 5500, 1.2) : filt('highpass', 7500);
      n.connect(f); f.connect(env((brush ? 0.13 : 0.22) * vel, brush ? 0.004 : 0.001, brush ? 0.06 : 0.045));
    } else if (kind === 'tom') {
      const o = osc('sine', brush ? 150 : 175, 0.45); o.frequency.exponentialRampToValueAtTime(brush ? 95 : 105, t + 0.3);
      o.connect(env(0.8 * vel, 0.002, 0.34));
    } else if (kind === 'clap') {   // three quick noise bursts + a short tail
      const n = noise(0.3), f = filt('bandpass', 1300, 1.1), g = node(c.createGain());
      g.gain.setValueAtTime(0, t);
      for (let k = 0; k < 3; k++) { const tk = t + k * 0.011; g.gain.linearRampToValueAtTime(0.55 * vel, tk + 0.001); g.gain.exponentialRampToValueAtTime(0.05 * vel + 1e-5, tk + 0.009); }
      g.gain.linearRampToValueAtTime(0.42 * vel, t + 0.036); g.gain.exponentialRampToValueAtTime(1e-4, t + 0.22); g.gain.setValueAtTime(0, t + 0.225);
      n.connect(f); f.connect(g); g.connect(dest); end = Math.max(end, t + 0.24);
    } else {   // perc: wood block
      osc('triangle', 820, 0.1).connect(env(0.3 * vel, 0.001, 0.06));
      osc('sine', 1240, 0.08).connect(env(0.15 * vel, 0.001, 0.04));
    }
    const last = srcs[srcs.length - 1];
    last.onended = () => { srcs.concat(nodes).forEach((x) => { try { x.disconnect(); } catch (_) { /* ignore */ } }); };
    return { srcs, t, end };
  }


  // ---------- drum kit (rows with their own sounds) ----------
  // song.ext.kit = { id, name, rows: [{ k (pattern key), name, syn (built-in synth drum), sound (VH.sounds id | null),
  // sname (its name when assigned), vol 0..1.5 }] }: a snapshot of a kit, song-wide (the patterns stay per section).
  // Missing = the built-in kick / snare / hat / perc. Saved kits (VH.store 'melody.kits') are song-independent.
  const SYN = [['kick', 'Kick'], ['snare', 'Snare'], ['hat', 'Hat'], ['perc', 'Perc'], ['tom', 'Tom'], ['clap', 'Clap']];
  // GM drum note per row position: kick, snare, closed hat, then other GM percussion (hi wood block, clap, low tom, high tom, crash).
  const GM_ROWS = [36, 38, 42, 76, 39, 45, 50, 49];
  const MAX_ROWS = 8, KITS_KEY = 'melody.kits', SAMPLE_HIT = 0.9;
  const defRows = () => ROWS.map(([k, name]) => ({ k, name, syn: k, sound: null, vol: 1 }));
  const freeKey = (used) => ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'].find((k) => !used.has(k));
  function normRows(rows) {
    const seen = new Set(), out = [];
    (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS).forEach((r) => {
      if (!r || typeof r !== 'object') return;
      let k = /^(kick|snare|hat|perc|r[1-9])$/.test(r.k) ? r.k : null;
      if (!k || seen.has(k)) k = freeKey(seen);
      seen.add(k);
      out.push({ k, name: String(r.name || 'Row').slice(0, 24), syn: SYN.some((x) => x[0] === r.syn) ? r.syn : 'perc',
        sound: typeof r.sound === 'string' && r.sound ? r.sound : null, sname: typeof r.sname === 'string' ? r.sname.slice(0, 40) : undefined,
        vol: r.vol == null || !isFinite(+r.vol) ? 1 : clamp(+r.vol, 0, 1.5) });
    });
    return out;
  }
  function kitOf(S) {
    const x = S && S.ext && S.ext.kit, rows = x && normRows(x.rows);
    if (!rows || !rows.length) return { id: 'std', name: 'Built-in', rows: defRows() };
    return { id: typeof x.id === 'string' ? x.id : 'song', name: String(x.name || 'Song kit').slice(0, 30), rows };
  }
  const savedKits = () => { const a = VH.store.get(KITS_KEY, []); return (Array.isArray(a) ? a : []).filter((k) => k && typeof k.id === 'string' && Array.isArray(k.rows)); };
  // Save (a copy of) kit under its name: an existing kit with that name is replaced. -> the stored kit.
  function saveKit(kit, name) {
    const nm = String(name || kit.name || 'My kit').trim().slice(0, 30) || 'My kit', list = savedKits();
    const old = list.find((k) => k.name === nm), out = { id: old ? old.id : 'kit' + Date.now().toString(36), name: nm, rows: normRows(kit.rows) };
    VH.store.set(KITS_KEY, list.filter((k) => k.id !== out.id).concat(out));
    return out;
  }
  const deleteKit = (id) => VH.store.set(KITS_KEY, savedKits().filter((k) => k.id !== id));
  const kitSoundIds = (S) => kitOf(S).rows.map((r) => r.sound).filter(Boolean);
  // A hit of one drum event: the row's own sound (sampled one-shot / Babel find / CC0 sample) or the built-in synth.
  function playHit(c, dest, e, t, vel) {
    const s = e.sound && VH.sounds.get(e.sound);
    return s ? sampleHit(c, dest, s, t, vel) : drumHit(c, dest, e.drum, t, vel, e.kit);
  }
  function sampleHit(c, dest, s, t, vel) {
    t = Math.max(t, c.currentTime);
    const z = s.sampler && s.sampler.zones && s.sampler.zones[0];
    const m = z ? z.rootMidi : s.rootHz > 0 ? VH.audio.hzToMidi(s.rootHz) : 60;
    let dur = 1.5;
    if (z) { const q = VH.audio.load(z); q.catch(() => {}); if (q.buffer) dur = Math.min(4, q.buffer.duration); }
    const v = VH.audio.trigger(s, VH.audio.midiToHz(m), dur, { gain: SAMPLE_HIT * vel, dest, when: t });
    return { srcs: [{ stop: () => { try { v.stop(0.01); } catch (_) { /* ignore */ } } }], t, end: t + dur, sample: true };
  }
  // Envelope + brightness of a sound for "Kit from Babel finds": { decay, sustain, centroid } (decoded once, cached on .perc).
  async function percOf(s) {
    if (s.perc && isFinite(s.perc.centroid)) return s.perc;
    if (s.kind === 'synth') {
      const sy = s.synth || {}, f0 = s.rootHz || 220, sp = s.spectrum || sy.partials || [[1, 1]], w = sp.reduce((a, p) => a + p[1], 0) || 1;
      return { decay: sy.sustain > 0.2 ? 5 : (sy.attack || 0) + (sy.decay || 0.3), sustain: sy.sustain || 0, centroid: sp.reduce((a, p) => a + p[0] * f0 * p[1], 0) / w };
    }
    const z = s.sampler && s.sampler.zones && s.sampler.zones[0];
    if (!z) return null;
    const buf = await VH.audio.load(z), x = VH.analyze.monoOf(buf, 4), e = VH.analyze.envStats(x, buf.sampleRate);
    return { decay: e.decay, sustain: e.sustain, centroid: VH.analyze.centroid(x, buf.sampleRate) };
  }
  // Kit from the user's saved Babel sounds: the most percussive (fastest decay) up to 8, low to high (kick-like first).
  async function babelKit() {
    const cands = VH.sounds.list().filter((s) => s.source === 'babel');
    const items = (await Promise.all(cands.map((s) => percOf(s).then((p) => (p ? Object.assign({ s }, p) : null)).catch(() => null)))).filter(Boolean);
    const pick = VH.analyze.kitPick(items, MAX_ROWS);
    if (!pick.length) return null;
    return { id: 'babel', name: 'Babel finds', rows: pick.map((it, i) => ({ k: i < ROWS.length ? ROWS[i][0] : 'r' + (i + 1),
      name: String(it.s.name).slice(0, 16), syn: i < ROWS.length ? ROWS[i][0] : 'perc', sound: it.s.id, sname: it.s.name, vol: 1 })) };
  }

  // ---------- events per bar (drums + backing styles), positions in sixteenths within the bar ----------
  function drumEvents(S, bar) {
    const d = drumsOf(S);
    if (!d.on) return [];
    const p = patFor(d, bar), out = [], step = md.spb(S) / p.len;
    // One row per kit row (song.ext.kit; default kick / snare / hat / perc). drum = the built-in synth drum, sound = the
    // row's own sound id (null = synth), gm = the General MIDI note of the row (by position, see GM_ROWS).
    kitOf(S).rows.forEach((r, i) => {
      const row = p[r.k] || '';
      for (let j = 0; j < p.len; j++) {
        const ch = row[j];
        if (ch === 'x' || ch === 'o') out.push({ drum: r.syn, row: r.k, ri: i, p: j * step, vel: (ch === 'x' ? 1 : 0.5) * r.vol, kit: d.kit, sound: r.sound || null, gm: GM_ROWS[i] || 37 });
      }
    });
    return out;
  }
  // Seeded per bar, so 'random' arpeggios are the same live, on every loop pass and in the export.
  function rng(seed) {
    let a = (seed * 2654435761) >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // n arpeggio notes from the chord tones ms (ascending) over o.oct octaves, in o.pattern order.
  // 'played' = the chord as spelled (root, 3rd, 5th, 7th), each tone followed by its octave copies.
  function arpSeq(ms, o, n, bar) {
    const oct = clamp(o.oct | 0 || 1, 1, 3), up = [];
    for (let k = 0; k < oct; k++) ms.forEach((m) => up.push(m + 12 * k));
    let cyc = up;
    if (o.pattern === 'down') cyc = up.slice().reverse();
    else if (o.pattern === 'updown') cyc = up.length > 2 ? up.concat(up.slice(1, -1).reverse()) : up;
    else if (o.pattern === 'played') { cyc = []; ms.forEach((m) => { for (let k = 0; k < oct; k++) cyc.push(m + 12 * k); }); }
    else if (o.pattern === 'random') {
      const r = rng((bar | 0) * 31 + ms[0] + 7), out = [];
      for (let i = 0; i < n; i++) { let j = Math.floor(r() * up.length); if (up.length > 1 && up[j] === out[i - 1]) j = (j + 1) % up.length; out.push(up[j]); }
      return out;
    }
    return Array.from({ length: n }, (_, i) => cyc[i % cyc.length]);
  }
  // Events of one bar: p = sixteenth in the bar, m = midi, dur / dt (offset) in seconds, g = gain.
  // opts = the style's sub-settings (styleOptsOf), bar = bar index (alternating strums, seeded random arps).
  // Style 'drone' is included for offline rendering (live, the engine's own drone plays it).
  // geo = { ts, a, len }: the chord region inside the bar (a = its start in the bar, in sixteenths; default the whole
  // 4/4 bar). The bar's pattern follows the meter (pulse / broken on its beats: 6/8 pulses in dotted quarters, arpeggios
  // on the bar grid) and is windowed to the region; a region starting between onsets re-strikes what sounds there.
  function backingEvents(style, midis, sec16, opts, bar, geo) {
    if (!midis || !midis.length) return [];
    const T = md.TS[geo && geo.ts] || md.TS['4/4'], SPB = T.spb, a = geo && geo.a ? geo.a : 0, z = geo && geo.len != null ? a + geo.len : SPB;
    const o = Object.assign({}, STYLE_DEF[style], opts), reg16 = (z - a) * sec16, ms = midis.slice().sort((x, y) => x - y), all = [];
    const note = (p, m, dur, g, dt) => all.push({ p, m, dur, g, dt: dt || 0 });
    const B = T.beats, beatEnd = (k) => (k + 1 < B.length ? B[k + 1] : SPB);
    if (style === 'strum') {
      const sp = clamp(+o.speed || 40, 10, 80) / 1000, up = o.dir === 'up' || (o.dir === 'alt' && (bar | 0) % 2 === 1);
      (up ? ms.slice().reverse() : ms).forEach((m, k) => note(a, m, reg16 - k * sp, 0.25, k * sp));
      return all;
    }
    if (style !== 'arp' && style !== 'pulse' && style !== 'broken') { ms.forEach((m) => note(a, m, reg16, 0.25)); return all; }
    if (style === 'arp') {
      const step = STEP16[o.rate] || 2, n = Math.round(SPB / step), seq = arpSeq(ms, o, n, bar), gate = clamp(+o.gate || 0.95, 0.25, 1);
      for (let i = 0; i < n; i++) note(i * step, seq[i], step * sec16 * gate, 0.28);
    } else if (style === 'pulse') {
      const gate = clamp(+o.gate || 0.85, 0.25, 1);
      let on;
      if (o.rate === '1/8') on = Array.from({ length: Math.ceil(SPB / 2) }, (_, i) => i * 2);
      else if (o.rate === '1/2') on = B.filter((_, k) => k % 2 === 0);
      else on = B.slice();   // the beat: quarters, dotted quarters in 6/8 + 12/8, 2+2+3 in 7/8
      on.forEach((p, k) => { const len = (k + 1 < on.length ? on[k + 1] : SPB) - p; ms.forEach((m) => note(p, m, len * sec16 * gate, 0.2)); });
    } else if (o.pattern === 'alberti') {   // low, high, middle, high in eighths
      const seq = [ms[0], ms[ms.length - 1], ms[Math.min(1, ms.length - 1)], ms[ms.length - 1]];
      for (let i = 0; i * 2 < SPB; i++) note(i * 2, seq[i % 4], 2 * sec16 * 0.95, 0.24);
    } else if (o.pattern === 'bcc' && SPB === 16 && T.d === 4) {   // 4/4: three even beats per bar (like the Waltz drums)
      const b3 = SPB / 3;
      note(0, ms[0] - 12, b3 * sec16 * 0.95, 0.32);
      [b3, 2 * b3].forEach((p) => ms.forEach((m) => note(p, m, b3 * sec16 * 0.85, 0.2)));
    } else if (o.pattern === 'bcc') {   // bass on the first beat, the chord on the others (a waltz in 3/4)
      B.forEach((p, k) => { const L = beatEnd(k) - p; if (!k) note(p, ms[0] - 12, L * sec16 * 0.95, 0.32); else ms.forEach((m) => note(p, m, L * sec16 * 0.85, 0.2)); });
    } else {   // bass-chord: bass on beats 1, 3, ..., the chord between
      B.forEach((p, k) => { const L = beatEnd(k) - p; if (k % 2 === 0) note(p, ms[0] - 12, L * sec16 * 0.95, 0.32); else ms.forEach((m) => note(p, m, L * sec16 * 0.85, 0.2)); });
    }
    if (a === 0 && z === SPB) return all;
    // window to the region: a chord change between onsets re-strikes the pattern's sounding group at the change
    const inR = all.filter((e) => e.p >= a - 1e-9 && e.p < z - 1e-9);
    if (!inR.some((e) => Math.abs(e.p - a) < 1e-9)) {
      const prev = all.filter((e) => e.p < a).map((e) => e.p), q = prev.length ? Math.max(...prev) : null;
      const nx = inR.length ? inR[0].p : z;
      all.filter((e) => e.p === q).forEach((e) => inR.push({ p: a, m: e.m, dur: Math.min(e.dur, (nx - a) * sec16), g: e.g, dt: 0 }));
    }
    inR.forEach((e) => { e.dur = Math.max(0.03, Math.min(e.dur, (z - e.p) * sec16)); });
    return inR.sort((x, y) => x.p - y.p);
  }
  // The bar holding t16 in song S (section or flat): { a, n, b, ts, drums? }.
  function barOf(S, t16) {
    const bl = md.barsOf(S);
    let k = 0;
    while (k + 1 < bl.length && bl[k + 1].a <= t16 + 1e-9) k++;
    return bl[k];
  }
  // Backing events of chord region r (null without a chord): p relative to the region start. Used by the MIDI export.
  function regionEvents(S, r) {
    const e = S.chords[r];
    if (!e || !e.chord) return null;
    const st = styleOf(S), bl = barOf(S, e.at), a = e.at - bl.a;
    return backingEvents(st, chordMidis(e.chord, S), md.secPer16(S), styleOptsOf(S, st), bl.b, { ts: bl.ts, a, len: md.regionEnd(S, r) - e.at })
      .map((x) => Object.assign(x, { p: x.p - a }));
  }
  // The backing events of song bar b (its first chord over the whole bar; older callers).
  function barEvents(S, b) {
    const ch = md.chordAt(S, b * md.spb(S));
    if (!ch) return null;
    const st = styleOf(S);
    return backingEvents(st, chordMidis(ch, S), md.secPer16(S), styleOptsOf(S, st), b, { ts: S.ts });
  }
  // ±15 ms (true early/late: the engine and the scheduler both look ahead) and ±10 % velocity.
  function humanize(on) {
    if (!on) return { dt: 0, v: 1 };
    return { dt: (Math.random() * 2 - 1) * HUM_T, v: 1 + (Math.random() * 2 - 1) * HUM_V };
  }

  // Offline rendering (B3's export + tests): builds the FX graph in context c into `dest` and schedules drums + backing
  // (every style, including the held drone) for o.loops passes (or o.bars bars) of the song from time o.t0. The song may
  // be a section or a flattened arrangement (md.flatten: every bar has its own meter + drum pattern). Returns inputs
  // for the layer voices.
  function offline(c, song, dest, o) {
    o = o || {};
    const S = song, g = FxGraph(c, dest), sec = md.secPer16(S), t0 = o.t0 || 0, BL = md.barsOf(S), tot = md.tot16(S);
    const loops = o.loops > 0 ? o.loops | 0 : o.bars ? Math.max(1, Math.round(o.bars / BL.length)) : 1;
    const srcs = { backing: c.createGain() }, layerIns = S.layers.map((_, i) => { const n = c.createGain(); n.gain.value = md.layerGain(S, i); srcs['L' + i] = n; return n; });
    srcs.backing.gain.value = S.backing.on ? S.backing.vol : 0;
    g.update(S, srcs);
    const snd = o.backingSound || VH.sounds.get(S.backing.sound) || VH.sounds.get('string'), hum = !!(o.humanize != null ? o.humanize : extra(S, 'humanize', false));
    const log = [];
    VH.audio.withContext(c, () => {
      for (let r = 0; r < loops; r++) {
        const off = t0 + r * tot * sec;
        if (o.drums !== false) for (const bl of BL) {
          const ds = { drums: bl.drums || S.drums, ts: bl.ts, bars: 1, ext: S.ext }, base = off + bl.a * sec;
          for (const e of drumEvents(ds, bl.b)) { const h = humanize(hum); const t = base + e.p * sec + h.dt; playHit(c, g.drumBus, e, t, e.vel * h.v); log.push(['d', e.drum, t, e.row, e.sound]); }
        }
        if (o.backing !== false && S.backing.on) for (const R of md.regions(S)) {
          if (!R.chord) continue;
          const bl = barOf(S, R.a), base = off + bl.a * sec;
          for (const e of backingEvents(styleOf(S), chordMidis(R.chord, S), sec, styleOptsOf(S, styleOf(S)), bl.b, { ts: bl.ts, a: R.a - bl.a, len: R.z - R.a })) {
            const h = humanize(hum), t = base + e.p * sec + e.dt + h.dt;
            VH.audio.trigger(snd, VH.audio.midiToHz(e.m), e.dur, { gain: e.g * h.v, dest: srcs.backing, when: t });
            log.push(['n', e.m, t]);
          }
        }
      }
    });
    return { layerIn: (i) => layerIns[i], backingIn: srcs.backing, drumsIn: g.drumBus, graph: g, events: log, dispose: () => g.dispose() };
  }

  let current = null;   // debug handle of the mounted instance
  NS.sound = {
    FX_PRESETS, DRUM_PRESETS, STYLES, SYNC, PARAMS,
    STYLE_DEF, STYLE_CHOICES, styleOptsOf,
    SYN, GM_ROWS, MAX_ROWS, kitOf, normRows, savedKits, saveKit, deleteKit, kitSoundIds, playHit, babelKit, percOf,
    octaveUp, shimmer, buildChain, makeFx, FxGraph, drumHit, drumEvents, backingEvents, barEvents, regionEvents, presetPat, offline, drumsOf, recOf,
    get graphsAlive() { return graphsAlive; },
    get debug() { return current; },
  };

  // ---------- CSS ----------
  function injectCss() {
    if (document.getElementById('vh-melody-sound')) return;
    const st = document.createElement('style');
    st.id = 'vh-melody-sound';
    st.textContent = `
.mel-drums { flex: none; box-sizing: border-box; max-width: 100%; font-size: 11px; color: var(--muted); -webkit-user-select: none; user-select: none; }
.mel-dr-head { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: nowrap; }
.mel-dr-head .vh-select { width: auto; min-width: 0; max-width: 150px; padding: 2px 6px; font-size: 12px; height: 26px; }
.mel-dr-btn { height: 26px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface-2, #1b2030);
  color: var(--muted); font-size: 12px; cursor: pointer; white-space: nowrap; flex: none; }
.mel-dr-btn[aria-pressed="true"] { color: #07101f; background: var(--accent); border-color: var(--accent); font-weight: 600; }
.mel-dr-btn:focus-visible { outline: 2px solid var(--glow, #9ff); outline-offset: 1px; }
.mel-dr-view { position: relative; overflow: hidden; margin-top: 5px; }
.mel-dr-track { display: grid; grid-auto-rows: 17px; will-change: transform; }
.mel-dr-st { min-width: 0; height: 17px; padding: 0; margin: 0; border: 0 solid transparent; border-width: 0 1px 2px 0; border-radius: 3px;
  background: rgba(255,255,255,0.06); background-clip: padding-box; cursor: pointer; transition: background-color 120ms ease; touch-action: manipulation; }
.mel-dr-st.beat { background-color: rgba(255,255,255,0.11); }
.mel-dr-st.bar { background-color: rgba(255,255,255,0.13); box-shadow: inset 1px 0 0 rgba(255,255,255,0.55); }
.mel-dr-st.own:not(.x):not(.o) { background-color: rgba(0,191,220,0.12); }
.mel-dr-st:hover { background-color: rgba(111,163,255,0.35); }
.mel-dr-st.x { background-color: var(--accent, #6fa3ff); }
.mel-dr-st.o { background-color: rgba(111,163,255,0.5); }
.mel-dr-st.own.x { background-color: #5ad1ff; }
.mel-dr-st.now { box-shadow: inset 0 0 0 2px #fff; }
.mel-dr-st.now.x, .mel-dr-st.now.o { background-color: #9ff; }
.mel-dr-st:focus-visible { outline: 2px solid var(--glow, #9ff); outline-offset: -2px; }
.mel-dr-lbls { position: absolute; left: 0; top: 0; display: grid; grid-auto-rows: 17px; justify-items: start; pointer-events: none; transition: opacity 150ms ease; }
.mel-dr-lb { height: 15px; line-height: 15px; padding: 0 3px; font-size: 9.5px; color: #cfd5e6; background: rgba(11,13,18,0.6); border-radius: 0 3px 3px 0; white-space: nowrap; }
.mel-dr-lb b { font-weight: 600; }
.mel-dr-lb i { font-style: normal; display: none; }
.mel-drums.mel-dr-wide .mel-dr-lb i { display: inline; }
.mel-dr-view:hover .mel-dr-lbls { opacity: 0.2; }
.mel-drums:not(.on) .mel-dr-view, .mel-drums:not(.on) .mel-dr-vary { display: none; }
.mel-dr-pager { display: flex; align-items: center; gap: 2px; margin-left: auto; flex: none; }
.mel-dr-pager .mel-dr-btn { width: 30px; padding: 0; font-size: 15px; line-height: 1; }
.mel-dr-pager .mel-dr-btn:disabled { opacity: 0.35; cursor: default; }
.mel-dr-pg { min-width: 34px; text-align: center; font: 11px var(--mono, monospace); color: var(--text, #d8dce6); }
.mel-drums.mel-dr-paged .mel-dr-head .vh-select { max-width: 112px; }
.mel-drums.mel-dr-paged .mel-dr-track, .mel-drums.mel-dr-paged .mel-dr-lbls { grid-auto-rows: 24px; }
.mel-drums.mel-dr-paged .mel-dr-st { height: 24px; }
.mel-drums.mel-dr-paged .mel-dr-lb { height: 22px; line-height: 22px; }
.mel-drums:not(.on) .mel-dr-pager { display: none; }
.mel-drums .mel-dr-hint { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mel-drums.on .mel-dr-hint { display: none; }
.mel-drums .mel-dr-kitsel { max-width: 120px; }
.mel-kit-pop { position: absolute; left: 50%; transform: translateX(-50%); z-index: 25; width: min(560px, calc(100% - 16px)); max-height: 70%; overflow-y: auto;
  box-sizing: border-box; padding: 10px; background: rgba(20, 24, 36, 0.98); border: 1px solid var(--line); border-radius: 12px; font-size: 12px; color: var(--text); }
.mel-kit-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.mel-kit-head span { color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mel-kit-head .vh-icon-btn { width: 28px; height: 28px; font-size: 13px; }
.mel-kit-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.mel-kit-row input[type="text"], .mel-kit-save input { width: 92px; min-width: 0; height: 26px; box-sizing: border-box; padding: 0 6px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 12px; }
.mel-kit-row .vh-select { flex: 1; min-width: 0; height: 26px; padding: 0 4px; font-size: 12px; }
.mel-kit-vol { width: 70px; flex: none; }
.mel-kit-tools, .mel-kit-save { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.mel-kit-save input { flex: 1; max-width: 180px; }
.mel-dr-btn:disabled { opacity: 0.4; cursor: default; }
.mel-kit-note { margin-top: 8px; color: var(--muted); font-size: 11px; }
@media (max-width: 600px) { .mel-kit-vol { width: 48px; } .mel-kit-row input[type="text"] { width: 64px; } }
.mel-fx-presets { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 4px; }
.mel-fx-presets .vh-btn { padding: 4px 9px; font-size: 12px; }
.mel-fx-adv { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 6px; }
.mel-fx-adv summary { cursor: pointer; color: #aab3c8; font-size: 12px; padding: 3px 0; }
.mel-fx-slot { border-left: 2px solid var(--line); padding-left: 8px; margin: 8px 0; }
.mel-fx-slot .vh-select, .mel-fx-row .vh-select { width: 100%; }
.mel-fx-row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
.mel-fx-row > span { font-size: 12px; color: #aab3c8; min-width: 64px; }
.mel-fx-sub { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; margin: 10px 0 2px; }
.mel-style { display: flex; flex-wrap: wrap; gap: 4px; }
.mel-style .vh-btn { padding: 4px 9px; font-size: 12px; }
.mel-style-desc { margin-top: 6px; }
.mel-style-opts .mel-so { border-left: 2px solid var(--line); padding: 2px 0 2px 10px; margin: 8px 0 2px; }
.mel-so-row { align-items: center; margin: 6px 0; }
.mel-so-row .vh-btn { padding: 4px 9px; font-size: 12px; min-width: 38px; }
.mel-so-row .vh-select { flex: 1; min-width: 0; }
.mel-so .vh-ctl { margin: 6px 0; }
@media (max-width: 460px) {
  .mel-dr-st { height: 19px; }
  .mel-dr-track, .mel-dr-lbls { grid-auto-rows: 19px; }
  .mel-dr-lb { height: 17px; line-height: 17px; }
  .mel-dr-head { gap: 4px; }
  .mel-dr-btn { padding: 0 6px; }
  .mel-dr-head .vh-select { max-width: 112px; }
}`;
    document.head.append(st);
  }

  // ---------- the part ----------
  NS.parts.push((M) => {
    injectCss();
    const ui = VH.ui, E = M.engine;
    let alive = true, graph = null, routedN = -1, chan = 'L' + M.active, advOpen = false;
    const dbg = { magnet: [], hum: [], sched: [], sparkSpawned: 0, routes: 0 };
    current = { dbg, get graph() { return graph; }, stats: () => (graph ? graph.stats() : null), M };

    // ----- routing -----
    function ensureGraph() {
      const c = VH.audio.ctx;
      if (!c || !alive) return null;
      const sum = E.sumBus();
      if (!sum) return null;
      if (!graph || graph.c !== c || graph.dest !== sum) { if (graph) graph.dispose(); graph = FxGraph(c, sum); routedN = -1; }
      return graph;
    }
    function route() {
      const g = ensureGraph();
      if (!g) return;
      const S = M.song, srcs = {};
      S.layers.forEach((_, i) => { const b = M.layerBus(i); if (b) srcs['L' + i] = b; });
      const bb = E.backingBus(); if (bb) srcs.backing = bb;
      g.update(S, srcs);
      routedN = S.layers.length; dbg.routes++;
    }

    // ----- backing styles -----
    let backNotes = [], restrike = false;
    const backImpl = {
      onBar(b, midis, info) {   // per chord region; events are scheduled ahead by the scheduler. After a stop mid-region, re-strike a held strum
        if (!restrike) return;
        restrike = false;
        const S = M.song, c = VH.audio.ctx, r = info && info.region != null ? info.region : md.regionAt(S, E.pos16), ch = md.regionChord(S, r);
        if (!c || styleOf(S) !== 'strum' || !S.backing.on || !ch || sched.anchor == null) return;
        const sec = md.secPer16(S), p = E.pos16, left = (md.regionEnd(S, r) - p) * sec;
        if (left < 0.15) return;
        for (const e of backingEvents('strum', chordMidis(ch, S), sec, styleOptsOf(S, 'strum'), b, { ts: S.ts })) playNote(Object.assign({}, e, { dur: left - e.dt }), c.currentTime + 0.01 + e.dt);
      },
      stop(rel) { backNotes.forEach((x) => x.v.stop(rel)); backNotes = []; restrike = true; },
    };
    let styleSet = 'drone';
    function syncStyle() {
      const st = styleOf(M.song);
      if (st === styleSet) return;
      styleSet = st;
      E.setBacking(st === 'drone' ? null : backImpl);
    }
    function playNote(e, when) {
      const c = VH.audio.ctx, bus = E.backingBus();
      if (!c || !bus) return;
      const v = VH.audio.trigger(M.backingSound(), VH.audio.midiToHz(e.m), Math.max(0.05, e.dur), { gain: e.g * (e.hv || 1), dest: bus, when });
      backNotes.push({ v, t0: when, end: when + e.dur + 1 });
    }

    // ----- look-ahead scheduler (drums + backing styles) -----
    // Positions are the engine's continuous play time (t.cont16, sixteenths since Play); E.segments maps them to song
    // positions, so loop regions, song loops and seeks schedule the right bars. A seek (t.seekId) drops what was queued.
    const sched = { upTo: 0, anchor: null, sec: 0, lastCont: 0, seekId: -1 };
    let hits = [];
    function resetSched() { sched.upTo = 0; sched.anchor = null; sched.lastCont = 0; sched.seekId = -1; }
    function cancelFuture() {
      const c = VH.audio.ctx, now = c ? c.currentTime : 0;
      hits.forEach((h) => { if (h.t > now) h.srcs.forEach((s) => { try { s.stop(0); } catch (_) { /* ignore */ } }); });
      hits = [];
      backNotes = backNotes.filter((x) => { if (x.t0 > now + 0.002) { try { x.v.stop(0.01); } catch (_) { /* ignore */ } return false; } return true; });
    }
    function scheduleRange(a, b) {
      const S = M.song, c = VH.audio.ctx, sec = sched.sec, hum = !!extra(S, 'humanize', false), d = drumsOf(S), st = styleOf(S), SPB = md.spb(S);
      for (const g of E.segments(a, b)) {
        const s0 = g.s, s1 = g.s + g.n;
        for (let bar = Math.floor(s0 / SPB); bar * SPB < s1 && bar < S.bars; bar++) {
          const base = bar * SPB;
          if (d.on && graph) {
            for (const e of drumEvents(S, bar)) {
              const p = base + e.p;
              if (p < s0 - 1e-6 || p >= s1 - 1e-6) continue;   // (float-safe at segment edges)
              const cp = g.c + (p - s0), h = humanize(hum), t = sched.anchor + cp * sec + h.dt;
              hits.push(playHit(c, graph.drumBus, e, t, e.vel * h.v));
              if (dbg.sched.length < 400) dbg.sched.push(['d', e.drum, cp, t, sched.anchor + cp * sec]);
              if (hum && dbg.hum.length < 400) dbg.hum.push([h.dt, h.v]);
            }
          }
          if (st !== 'drone' && S.backing.on) for (const R of md.regions(S)) {
            if (!R.chord || R.a < base || R.a >= base + SPB) continue;
            for (const e of backingEvents(st, chordMidis(R.chord, S), sec, styleOptsOf(S, st), bar, { ts: S.ts, a: R.a - base, len: R.z - R.a })) {
              const p = base + e.p;
              if (p < s0 - 1e-6 || p >= s1 - 1e-6) continue;   // (float-safe at segment edges)
              const cp = g.c + (p - s0), h = humanize(hum), t = sched.anchor + cp * sec + e.dt + h.dt;
              playNote(Object.assign({ hv: h.v }, e), t);
              if (dbg.sched.length < 400) dbg.sched.push(['n', e.m, cp, t, sched.anchor + cp * sec + e.dt]);
            }
          }
        }
      }
    }
    function onTick(t) {
      const c = VH.audio.ctx;
      if (!c || !alive) return;
      const S = M.song;
      if (!graph || routedN !== S.layers.length) route();
      const sec = t.secPer16, cont = t.cont16;
      if (t.seekId !== sched.seekId) {   // play start or a seek: drop what was queued for the old position
        if (sched.seekId !== -1) cancelFuture();
        sched.seekId = t.seekId; sched.anchor = null; sched.upTo = t.seekCont16 || 0;
      }
      if (sched.anchor == null || sec !== sched.sec || Math.abs(sched.anchor + cont * sec - t.ctxTime) > 0.025 || cont < sched.lastCont - 0.01) {
        const seek = sched.anchor != null && (cont < sched.lastCont - 0.01 || cont > sched.upTo + 2);
        sched.anchor = t.ctxTime - cont * sec; sched.sec = sec;
        if (seek) sched.upTo = cont;
      }
      const horizon = cont + LA / sec;
      if (horizon > sched.upTo) { scheduleRange(sched.upTo, horizon); sched.upTo = horizon; }
      sched.lastCont = cont;
      const now = c.currentTime;
      if (hits.length > 64) hits = hits.filter((h) => h.end > now);
      if (backNotes.length > 48) backNotes = backNotes.filter((x) => x.end > now);
      laneTick(t);
      sparkTick(t);
    }

    // ----- engine hooks: harmony magnet (pitchMod on line voices) + humanize (voiceOpts on notes) -----
    const magCache = new Map();
    function magnetMidi(m, L, b) {
      const amt = clamp(+extra(M.song, 'magnet', 0) || 0, 0, 1);
      if (!amt || !(m > 0)) return m;
      const key = b + '|' + L + '|' + Math.round(m * 20);
      let s = magCache.get(key);
      if (s == null) { s = M.bands.snap(m, b, L); if (magCache.size > 4000) magCache.clear(); magCache.set(key, s); }
      const out = m + amt * (s - m);
      if (dbg.magnet.length < 300) dbg.magnet.push([m, s, out, b, L]);
      return out;
    }
    M.addHook('pitchMod', (L, kind, t, ref) => {
      if (!alive || kind !== 'line' || !(+extra(M.song, 'magnet', 0) > 0)) return 0;
      return (magnetMidi(ref.m, L, t.bar) - ref.m) * 100;
    });
    M.addHook('voiceOpts', (L, kind, midi, o) => {
      if (!alive || kind !== 'note' || !extra(M.song, 'humanize', false)) return o;
      const h = humanize(true), c = VH.audio.ctx;
      if (dbg.hum.length < 400) dbg.hum.push([h.dt, h.v]);
      o.when = (o.when != null ? o.when : c ? c.currentTime : 0) + h.dt;
      o.gain *= h.v;
      return o;
    });

    // ----- band sparkle (overlay) -----
    let sparks = [];
    const lastSpark = [];
    const peakCache = new Map();
    function peaksOf(t16, L) {
      const key = md.regionAt(M.song, t16) + '|' + L;
      let pk = peakCache.get(key);
      if (!pk) { pk = M.bandsAt(t16, L).peaks(); peakCache.set(key, pk); }
      return pk;
    }
    function sparkTick(t) {
      const S = M.song;
      if (!extra(S, 'sparkle', true)) { sparks = []; return; }
      const V = M.view;
      sparks = sparks.filter((p) => t.now - p.born < p.life);
      S.layers.forEach((l, L) => {
        if (!md.layerGain(S, L)) return;
        const ms = md.lineAt(l, t.lineIndex).map((q) => q.m);   // every stroke of the layer
        if (!ms.length) { const n = l.notes.find((x) => t.pos16 >= x.s && t.pos16 < x.s + x.d); if (n) ms.push(n.m); }
        if (!ms.length) return;
        const pk = peaksOf(t.pos16, L);   // bright band = within 0.3 semitone of a consonance peak (V < 0.5)
        ms.forEach((m, si) => {
          const key = L + ':' + si;
          const prev = lastSpark[key] || { t: -1e9, k: -1 }, k = Math.round(m);
          if (t.now - prev.t < (k === prev.k ? 420 : 160)) return;
          if (!pk.some((q) => Math.abs(q - m) < 0.3)) return;
          lastSpark[key] = { t: t.now, k };
          const x = V.xOf(t.pos16), y = V.yOf(m);
          for (let i = 0; i < 4; i++) {
            const a = Math.random() * Math.PI * 2, sp = 0.025 + Math.random() * 0.045;
            sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.01, born: t.now, life: 420 + Math.random() * 300, col: l.color, r: 1.2 + Math.random() * 1.3 });
            dbg.sparkSpawned++;
          }
        });
        if (sparks.length > MAX_SPARKS) sparks.splice(0, sparks.length - MAX_SPARKS);
      });
    }
    function sparkDraw(ctx) {
      if (!sparks.length) return;
      const now = performance.now();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of sparks) {
        const age = now - p.born, f = 1 - age / p.life;
        if (f <= 0) continue;
        const x = p.x + p.vx * age, y = p.y + p.vy * age + 0.00002 * age * age, r = p.r * (0.6 + 0.4 * f);
        ctx.globalAlpha = 0.85 * f;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.col; ctx.globalAlpha = 0.45 * f;
        ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    M.on('draw', (ctx) => sparkDraw(ctx));
    current.sparks = () => sparks.length;

    // ----- layer removal keeps the index-keyed per-layer fx aligned (same undo step: fires before the commit) -----
    M.on('layerRemoved', (id, i) => {
      const S = M.song;
      if (S.fx && Array.isArray(S.fx.layers) && S.fx.layers.length > i) S.fx.layers.splice(i, 1);
    });

    // ---------- UI: Effects section ----------
    const sec = M.ui.addPanelSection('Effects', 35, { group: 'sound' });
    const chanSel = ui.select(sec, { label: 'Effects channel', options: [], onChange: (v) => { chan = v; renderFx(); } });
    chanSel.el.classList.add('mel-fx-chan');
    const presetBox = ui.h('div', 'mel-fx-presets'); sec.append(presetBox);
    const presetBtns = FX_PRESETS.map(([id, label]) => {
      const b = ui.button(presetBox, { label, pressed: false, onClick: () => applyPreset(id) });
      b.dataset.preset = id; b.title = label + ' on this channel';
      return b;
    });
    const sendWrap = ui.h('div'); sec.append(sendWrap);
    const adv = ui.h('details', 'mel-fx-adv'); adv.innerHTML = '<summary>Advanced</summary>';
    const advBody = ui.h('div'); adv.append(advBody); sec.append(adv);
    adv.addEventListener('toggle', () => { advOpen = adv.open; if (advOpen) renderAdv(); });
    const chanName = (S, k) => (k === 'backing' ? 'Backing' : k === 'drums' ? 'Drums' : (S.layers[+k.slice(1)] || {}).name || k);
    function liveFx() { route(); M.save(); }
    function slider(parent, o, get, set, label) {
      const s = ui.slider(parent, { label: o.label, min: o.min, max: o.max, step: o.step, value: get(), fmt: o.fmt, onInput: (v) => { set(v); liveFx(); } });
      s.input.addEventListener('change', () => M.commit(label || 'Effect'));
      if (o.disabled) s.input.disabled = true;
      return s;
    }
    function applyPreset(id) {
      const S = M.song, r = recW(S, chan), p = FX_PRESETS.find((x) => x[0] === id);
      r.preset = id; r.chain = copy(p[2]);
      M.commit('Effect: ' + p[1] + ' on ' + chanName(S, chan));
      if (VH.audio.ctx) route();
    }
    function renderFx() {
      const S = M.song;
      const keys = S.layers.map((_, i) => 'L' + i).concat(['backing', 'drums']);
      if (!keys.includes(chan)) chan = 'L' + Math.min(M.active, S.layers.length - 1);
      chanSel.setOptions(keys.map((k) => ({ value: k, label: chanName(S, k) })), chan);
      const r = recOf(S, chan);
      presetBtns.forEach((b) => b.set({ pressed: b.dataset.preset === r.preset }));
      sendWrap.innerHTML = '';
      slider(sendWrap, { label: 'Reverb send', min: 0, max: 1, step: 0.01, fmt: pct }, () => r.rev, (v) => { recW(M.song, chan).rev = v; }, 'Reverb send');
      slider(sendWrap, { label: 'Delay send', min: 0, max: 1, step: 0.01, fmt: pct }, () => r.dly, (v) => { recW(M.song, chan).dly = v; }, 'Delay send');
      if (advOpen) renderAdv();
    }
    function renderAdv() {
      const S = M.song, r = recOf(S, chan);
      advBody.innerHTML = '';
      advBody.append(ui.h('div', 'mel-fx-sub', 'Insert chain · ' + ui.esc(chanName(S, chan))));
      for (let k = 0; k < MAX_INS; k++) {
        if (k > r.chain.length) break;
        const it = r.chain[k], slot = ui.h('div', 'mel-fx-slot');
        advBody.append(slot);
        ui.select(slot, { label: 'Insert ' + (k + 1), value: it ? it.type : '',
          options: [{ value: '', label: k < r.chain.length ? '— remove —' : '+ add effect…' }].concat(FX_TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))),
          onChange: (v) => {
            const w = recW(M.song, chan);
            if (!v) w.chain.splice(k, 1); else w.chain[k] = { type: v, params: typeDefaults(v) };
            w.preset = 'custom'; M.commit('Effect chain'); route(); renderAdv();
          } });
        if (!it) continue;
        if (it.type === 'delay') {
          const row = ui.h('div', 'mel-fx-row', '<span>Sync</span>'); slot.append(row);
          ui.select(row, { label: 'Delay sync', value: it.params.sync || 'free', options: [{ value: 'free', label: 'Free (ms)' }].concat(Object.keys(SYNC).map((s) => ({ value: s, label: s + ' note' }))),
            onChange: (v) => { const w = recW(M.song, chan); w.chain[k].params.sync = v === 'free' ? null : v; w.preset = 'custom'; M.commit('Delay sync'); route(); renderAdv(); } });
        }
        if (it.type === 'filter') {
          const row = ui.h('div', 'mel-fx-row', '<span>Type</span>'); slot.append(row);
          ui.select(row, { label: 'Filter type', value: it.params.type || 'lowpass', options: ['lowpass', 'highpass', 'bandpass'].map((t) => ({ value: t, label: t })),
            onChange: (v) => { const w = recW(M.song, chan); w.chain[k].params.type = v; w.preset = 'custom'; M.commit('Filter type'); route(); } });
        }
        for (const [key, label, min, max, step, fmt] of PARAMS[it.type]) {
          const val = it.params[key] != null ? it.params[key] : typeDefaults(it.type)[key];
          slider(slot, { label, min, max, step, fmt, disabled: it.type === 'delay' && key === 'time' && it.params.sync && SYNC[it.params.sync] },
            () => val, (v) => { const w = recW(M.song, chan); w.chain[k].params[key] = v; w.preset = 'custom'; }, label);
        }
      }
      const rv = revOf(S), dl = dlyOf(S);
      advBody.append(ui.h('div', 'mel-fx-sub', 'Send reverb (shared)'));
      const rw = (k) => (v) => { const f = fxW(M.song); f.rev = Object.assign({}, revOf(M.song), { [k]: v }); };
      slider(advBody, { label: 'Size', min: 0, max: 1, step: 0.01, fmt: pct }, () => rv.size, rw('size'), 'Send reverb');
      slider(advBody, { label: 'Decay', min: 0.5, max: 8, step: 0.1, fmt: s1 }, () => rv.decay, rw('decay'), 'Send reverb');
      slider(advBody, { label: 'Shimmer (octave up)', min: 0, max: 1, step: 0.01, fmt: pct }, () => rv.shimmer, rw('shimmer'), 'Send shimmer');
      advBody.append(ui.h('div', 'mel-fx-sub', 'Send delay (shared)'));
      const row = ui.h('div', 'mel-fx-row', '<span>Time</span>'); advBody.append(row);
      ui.select(row, { label: 'Send delay time', value: dl.sync || '1/4', options: Object.keys(SYNC).map((s) => ({ value: s, label: s + ' note' })),
        onChange: (v) => { const f = fxW(M.song); f.dly = Object.assign({}, dlyOf(M.song), { sync: v }); M.commit('Send delay time'); route(); } });
      const dw = (k) => (v) => { const f = fxW(M.song); f.dly = Object.assign({}, dlyOf(M.song), { [k]: v }); };
      slider(advBody, { label: 'Feedback', min: 0, max: 0.9, step: 0.01, fmt: pct }, () => dl.feedback, dw('feedback'), 'Send delay');
      slider(advBody, { label: 'Tone', min: 500, max: 12000, step: 50, fmt: hz }, () => dl.tone, dw('tone'), 'Send delay');
    }

    // ---------- UI: backing style (+ its own sub-settings) + play feel ----------
    const secStyle = M.ui.addPanelSection('Backing style', 26, { group: 'sound' });
    const styleBox = ui.h('div', 'mel-style'); secStyle.append(styleBox);
    styleBox.setAttribute('role', 'group'); styleBox.setAttribute('aria-label', 'Backing style');
    const STYLE_LABEL = Object.fromEntries(STYLES);
    const styleBtns = STYLES.map(([id, label]) => {
      const b = ui.button(styleBox, { label, pressed: false, onClick: () => { M.song.backing.style = id; M.commit('Backing style: ' + label); syncStyle(); } });
      b.dataset.style = id;
      return b;
    });
    const STYLE_DESC = {
      drone: 'Held: each bar’s chord sustains for the whole bar.',
      strum: 'Strum: the chord once per bar, one string after another.',
      arp: 'Arpeggio: the chord tones one at a time.',
      pulse: 'Pulse: the whole chord repeated on a steady rhythm.',
      broken: 'Broken: the chord split into a bass note and chord hits.',
    };
    const styleDesc = ui.h('div', 'vh-desc mel-style-desc'); secStyle.append(styleDesc);
    const optBox = ui.h('div', 'mel-style-opts'); secStyle.append(optBox);
    const optBlocks = {}, optSyncs = [];
    const setOpt = (st, k, v, undo) => { styleOptsW(M.song, st)[k] = v; if (undo) M.commit(undo); else M.save(); };
    const optBlock = (st) => { const b = ui.h('div', 'mel-so mel-so-' + st); b.dataset.styleOpts = st; optBox.append(b); optBlocks[st] = b; return b; };
    function segOpt(parent, st, k, label) {
      const row = ui.h('div', 'vh-row mel-so-row'); row.append(ui.h('span', 'mel-lbl', ui.esc(label)));
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', STYLE_LABEL[st] + ' ' + label.toLowerCase());
      const bs = STYLE_CHOICES[st][k].map(([v, lb]) => {
        const b = ui.button(row, { label: lb, pressed: false, onClick: () => setOpt(st, k, v, STYLE_LABEL[st] + ' ' + label.toLowerCase() + ': ' + lb) });
        b.dataset.opt = k; b.dataset.v = String(v);
        return b;
      });
      parent.append(row);
      optSyncs.push(() => { const cur = String(styleOptsOf(M.song, st)[k]); bs.forEach((b) => b.set({ pressed: b.dataset.v === cur })); });
    }
    function selOpt(parent, st, k, label, labels) {
      const row = ui.h('div', 'vh-row mel-so-row'); row.append(ui.h('span', 'mel-lbl', ui.esc(label))); parent.append(row);
      const sel = ui.select(row, { label: STYLE_LABEL[st] + ' ' + label.toLowerCase(), options: STYLE_CHOICES[st][k].map(([v, lb]) => ({ value: String(v), label: (labels && labels[v]) || lb })),
        onChange: (v) => { const c = STYLE_CHOICES[st][k].find((x) => String(x[0]) === v); if (c) setOpt(st, k, c[0], STYLE_LABEL[st] + ' ' + label.toLowerCase() + ': ' + c[1]); } });
      sel.el.dataset.opt = k;
      optSyncs.push(() => { sel.value = String(styleOptsOf(M.song, st)[k]); });
    }
    function sliderOpt(parent, st, k, o) {
      const s = ui.slider(parent, { label: o.label, min: o.min, max: o.max, step: o.step, value: styleOptsOf(M.song, st)[k], fmt: o.fmt, onInput: (v) => setOpt(st, k, v) });
      s.input.setAttribute('aria-label', STYLE_LABEL[st] + ' ' + o.label.toLowerCase());
      s.input.dataset.opt = k;
      s.input.addEventListener('change', () => M.commit(STYLE_LABEL[st] + ' ' + o.label.toLowerCase()));
      optSyncs.push(() => s.set(styleOptsOf(M.song, st)[k]));
    }
    { const b = optBlock('arp');
      segOpt(b, 'arp', 'rate', 'Rate'); selOpt(b, 'arp', 'pattern', 'Pattern'); segOpt(b, 'arp', 'oct', 'Octaves');
      sliderOpt(b, 'arp', 'gate', { label: 'Gate', min: 0.25, max: 1, step: 0.01, fmt: pct }); }
    { const b = optBlock('strum');
      sliderOpt(b, 'strum', 'speed', { label: 'Speed', min: 10, max: 80, step: 1, fmt: (v) => Math.round(v) + ' ms' }); segOpt(b, 'strum', 'dir', 'Direction'); }
    { const b = optBlock('pulse');
      segOpt(b, 'pulse', 'rate', 'Rate'); sliderOpt(b, 'pulse', 'gate', { label: 'Gate', min: 0.25, max: 1, step: 0.01, fmt: pct }); }
    { const b = optBlock('broken');
      selOpt(b, 'broken', 'pattern', 'Pattern', { bc: 'Bass, chord', bcc: 'Bass, chord, chord (waltz feel)', alberti: 'Alberti (low, high, mid, high)' }); }
    function syncStyleUI() {
      const st = styleOf(M.song);
      styleBtns.forEach((b) => b.set({ pressed: b.dataset.style === st }));
      styleDesc.textContent = STYLE_DESC[st];
      Object.keys(optBlocks).forEach((k) => { optBlocks[k].hidden = k !== st; });
      optSyncs.forEach((f) => f());
    }
    const secFeel = M.ui.addPanelSection('Play feel', 45, { group: 'sound', collapsed: true });
    const magSl = ui.slider(secFeel, { label: 'Harmony magnet', min: 0, max: 1, step: 0.01, value: 0, fmt: pct,
      desc: 'Pulls line voices toward the nearest bright band while playing (sound only; the drawing is unchanged).',
      onInput: (v) => { fxW(M.song).magnet = v; magCache.clear(); M.save(); } });
    magSl.input.addEventListener('change', () => M.commit('Harmony magnet'));
    const feelRow = ui.h('div', 'vh-row'); secFeel.append(feelRow);
    const humBtn = ui.button(feelRow, { label: 'Humanize', pressed: false, onClick: () => { const f = fxW(M.song); f.humanize = !extra(M.song, 'humanize', false); M.commit('Humanize'); } });
    humBtn.title = 'Loosen timing (±15 ms) and velocity (±10 %) of notes, drums and backing';
    const sparkBtn = ui.button(feelRow, { label: 'Band sparkle', pressed: true, onClick: () => { const f = fxW(M.song); f.sparkle = !extra(M.song, 'sparkle', true); M.commit('Band sparkle'); } });
    sparkBtn.title = 'Tiny sparks when a playing voice sits on a bright band';

    // ---------- drum lane (under the canvas) ----------
    // The step grid spans the whole song like the canvas: bar b's steps sit under bar b at the canvas's x (one column per
    // step, BW / len wide, starting at view.xOf), and the track scrolls with M.view.scrollX. Row labels are small overlays
    // (like the canvas's octave labels), so they never shift the grid. 'Per bar' off: every bar shows and edits the shared
    // pattern; on: a click edits that bar's own copy (bars with their own pattern are tinted).
    const lane = ui.h('div', 'mel-drums');
    lane.setAttribute('role', 'group'); lane.setAttribute('aria-label', 'Drum lane');
    const head = ui.h('div', 'mel-dr-head'), view = ui.h('div', 'mel-dr-view'), track = ui.h('div', 'mel-dr-track mel-dr-grid'), lbls = ui.h('div', 'mel-dr-lbls');
    lbls.setAttribute('aria-hidden', 'true');
    view.append(track, lbls);
    lane.append(head, view);
    const powBtn = ui.h('button', 'mel-dr-btn mel-dr-pow', 'Drums'); powBtn.type = 'button'; powBtn.title = 'Drums on / off';
    const presetSel = ui.select(null, { label: 'Drum pattern', options: [], onChange: (v) => setDrumPreset(v) });
    const varyBtn = ui.h('button', 'mel-dr-btn mel-dr-vary', 'Per bar'); varyBtn.type = 'button';
    varyBtn.title = 'Per bar: a click edits only that bar (its own pattern). Off: every bar plays one pattern';
    const hint = ui.h('span', 'mel-dr-hint', 'pick a beat to add drums under the song');
    // Phones (lane narrower than PAGE_W): one bar at a time with ‹ › paging (follows the playhead while playing), so
    // steps stay >= 18 px wide. Wider: every bar under its canvas bar, aligned to the pixel.
    const PAGE_W = 600;
    const pager = ui.h('div', 'mel-dr-pager', '<button type="button" class="mel-dr-btn" data-d="-1" aria-label="Previous bar">‹</button>' +
      '<span class="mel-dr-pg" aria-live="polite"></span><button type="button" class="mel-dr-btn" data-d="1" aria-label="Next bar">›</button>');
    pager.hidden = true;
    const kitSel = ui.select(null, { label: 'Drum kit', options: [], onChange: (v) => onKitSel(v) });
    kitSel.el.classList.add('mel-dr-kitsel');
    const kitBtn = ui.h('button', 'mel-dr-btn mel-dr-kitbtn', '✎ Kit'); kitBtn.type = 'button';
    kitBtn.title = 'Drum kit: a sound, name and volume per row; add or remove rows; save the kit';
    head.append(powBtn, presetSel.el, kitSel.el, kitBtn, varyBtn, hint, pager);
    let cells = [], cols = [], nowCol = -1, shape = '', focusIdx = 0, page = 0, paged = false;
    pager.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setPage(page + +b.dataset.d);
    });
    function setPage(p) {
      const n = M.song.bars, q = clamp(p | 0, 0, n - 1);
      if (q === page && pager.dataset.n === String(n)) return;
      page = q; layoutLane();
    }
    const laneSlot = M.view.addLane(lane);   // measured: the canvas makes room as the lane grows / shrinks

    function setDrumPreset(id) {
      const S = M.song, d = drumsW(S), p = DRUM_PRESETS.find((x) => x[0] === id);
      if (!p) return;
      d.preset = id;
      if (!p[2]) d.on = false;
      else { const q = presetPat(id, S.ts); d.on = true; d.kit = q.kit || p[2].kit; d.pat = q; d.bars = {}; }
      M.commit('Drums: ' + p[1]);
      route();
    }
    // A new time signature (M.setTimeSig, before its commit): store the drum pattern adapted to the meter (same undo step).
    M.on('timeSig', () => { const S = M.song; if (S.drums && S.drums.pat) drumsW(S); });
    powBtn.addEventListener('click', () => {
      const S = M.song, d = drumsW(S);
      d.on = !d.on;
      if (d.on && d.preset === 'off') d.preset = 'rock';
      M.commit(d.on ? 'Drums on' : 'Drums off'); route();
    });
    varyBtn.addEventListener('click', () => {
      const d = drumsW(M.song);
      d.vary = !d.vary;
      M.commit(d.vary ? 'Drums per bar' : 'Drums: one pattern');
    });
    track.addEventListener('click', (e) => {
      const b = e.target.closest('.mel-dr-st');
      if (!b) return;
      const S = M.song, d = drumsW(S), k = b.dataset.r, j = +b.dataset.j, bar = +b.dataset.b;
      let p = d.pat;
      if (d.vary) { if (!d.bars[bar]) d.bars[bar] = copy(d.pat); p = d.bars[bar]; }
      p[k] = fit(p[k], p.len);
      const on = p[k][j] === '.';
      p[k] = p[k].slice(0, j) + (on ? 'x' : '.') + p[k].slice(j + 1);
      d.preset = 'custom';
      focusIdx = cells.indexOf(b);
      M.commit(d.vary ? 'Drum step (bar ' + (bar + 1) + ')' : 'Drum step');
      if (on && !E.playing && VH.audio.ensure()) { route(); previewRow(k); }
    });
    // keyboard: one tab stop for the grid, arrows move (and scroll the song into view), Enter / Space toggle
    track.addEventListener('keydown', (e) => {
      const i = cells.indexOf(e.target);
      if (i < 0) return;
      const nc = cols.length, r = Math.floor(i / nc), c = i % nc;
      const to = { ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], ArrowUp: [r - 1, c], ArrowDown: [r + 1, c], Home: [r, 0], End: [r, nc - 1] }[e.key];
      if (!to) return;
      e.preventDefault();
      const rr = clamp(to[0], 0, kitOf(M.song).rows.length - 1), cc = clamp(to[1], 0, nc - 1);
      focusCell(rr * nc + cc);
    });
    function focusCell(i) {
      const b = cells[i];
      if (!b) return;
      cells.forEach((x, k) => { x.tabIndex = k === i ? 0 : -1; });
      focusIdx = i;
      const V = M.view, n = cols.length / M.song.bars, x0 = (+b.dataset.b * n + +b.dataset.j) * V.BW / n, w = V.BW / n;
      if (paged) setPage(+b.dataset.b);
      else if (x0 < V.scrollX) V.setScroll(x0 - w); else if (x0 + w > V.scrollX + V.GW) V.setScroll(x0 + 2 * w - V.GW);
      b.focus({ preventScroll: true });
    }
    function layoutLane() {
      const V = M.view, nb = M.song.bars, w = M.el.clientWidth || V.VW;
      paged = w > 0 && w < PAGE_W;
      lane.classList.toggle('mel-dr-paged', paged);
      pager.hidden = !paged;
      if (paged) {
        page = clamp(page, 0, nb - 1);
        track.style.width = V.VW * nb + 'px';
        track.style.transform = 'translateX(' + (-page * V.VW) + 'px)';
        pager.querySelector('.mel-dr-pg').textContent = (page + 1) + '/' + nb;
        pager.dataset.n = nb;
        pager.querySelector('[data-d="-1"]').disabled = page === 0;
        pager.querySelector('[data-d="1"]').disabled = page >= nb - 1;
      } else {
        track.style.width = V.CW + 'px';
        track.style.transform = 'translateX(' + (V.X0 - V.scrollX) + 'px)';   // the time axis starts right of the piano strip
      }
      lane.classList.toggle('mel-dr-wide', paged || (cols.length && V.BW / (cols.length / nb) >= 16));
    }
    current.lanePage = () => (paged ? page : -1);
    function renderLane() {
      const S = M.song, d = drumsOf(S), n = d.pat.len, nc = S.bars * n, K = kitOf(S);
      lane.classList.toggle('on', d.on);
      syncKitSel(K);
      lane.classList.toggle('vary', d.vary);
      powBtn.setAttribute('aria-pressed', String(d.on));
      const opts = DRUM_PRESETS.map(([id, label]) => ({ value: id, label }));
      if (d.preset === 'custom') opts.push({ value: 'custom', label: 'Custom' });
      presetSel.setOptions(opts, d.on ? d.preset : 'off');
      varyBtn.setAttribute('aria-pressed', String(d.vary));
      const beatSet = new Set(md.tsOf(S).beats);
      const lbSig = K.rows.map((r) => r.name).join('|');
      if (lbls.dataset.sig !== lbSig) {   // row labels: the kit's row names
        lbls.dataset.sig = lbSig; lbls.innerHTML = '';
        K.rows.forEach((r) => { const e = ui.h('span', 'mel-dr-lb', '<b></b><i></i>'); e.firstChild.textContent = r.name.slice(0, 1); e.lastChild.textContent = r.name.slice(1); lbls.append(e); });
      }
      const sig = S.bars + 'x' + n + (S.ts || '') + ':' + K.rows.map((r) => r.k).join(',');
      if (shape !== sig) {   // one column per step of every bar; row-major so arrow keys can index
        shape = sig;
        track.innerHTML = ''; cells = []; cols = Array.from({ length: nc }, () => []);
        track.style.gridTemplateColumns = 'repeat(' + nc + ', minmax(0, 1fr))';
        track.dataset.len = n;
        K.rows.forEach(({ k }) => {
          for (let c = 0; c < nc; c++) {
            const bar = Math.floor(c / n), j = c % n;
            const b = ui.h('button', 'mel-dr-st' + (j === 0 ? ' bar' : beatSet.has(j * md.spb(S) / n) ? ' beat' : ''));
            b.type = 'button'; b.dataset.r = k; b.dataset.j = j; b.dataset.b = bar; b.tabIndex = -1;
            track.append(b); cells.push(b); cols[c].push(b);
          }
        });
        nowCol = -1; focusIdx = Math.min(focusIdx, cells.length - 1);
      }
      cells.forEach((b, i) => {
        const k = b.dataset.r, j = +b.dataset.j, bar = +b.dataset.b, own = d.vary && !!d.bars[bar], p = own ? d.bars[bar] : d.pat, ch = (p[k] || '')[j] || '.';
        b.classList.toggle('x', ch === 'x'); b.classList.toggle('o', ch === 'o'); b.classList.toggle('own', own);
        b.setAttribute('aria-pressed', String(ch !== '.'));
        b.setAttribute('aria-label', ((K.rows.find((r) => r.k === k) || {}).name || k) + ', bar ' + (bar + 1) + ', step ' + (j + 1));
        b.tabIndex = i === focusIdx ? 0 : -1;
      });
      layoutLane();
    }
    M.on('layout', layoutLane); M.on('scroll', layoutLane);
    function setNow(c) {
      if (c === nowCol) return;
      if (cols[nowCol]) cols[nowCol].forEach((b) => b.classList.remove('now'));
      nowCol = c;
      if (cols[c]) cols[c].forEach((b) => b.classList.add('now'));
    }
    function laneTick(t) {
      const S = M.song, d = drumsOf(S);
      if (!d.on) { setNow(-1); return; }
      const n = d.pat.len;
      const SPB = md.spb(S);
      setNow(t.bar * n + Math.floor((t.pos16 % SPB) / (SPB / n)));
      if (paged && t.bar !== page) setPage(t.bar);
      current.nowCol = nowCol;
    }


    // ----- drum kit: Kit select (beside the pattern), row editor pop-over, saved kits, Kit from Babel finds -----
    const kitPop = ui.h('div', 'mel-float mel-kit-pop'); kitPop.hidden = true;
    kitPop.setAttribute('role', 'dialog'); kitPop.setAttribute('aria-label', 'Drum kit');
    M.el.append(kitPop);
    const prepped = new Set();
    function prepKit(S) {   // decode the kit's sampled sounds ahead of playback / export
      for (const id of kitSoundIds(S)) if (!prepped.has(id) && VH.sounds.get(id)) { prepped.add(id); VH.sounds.prepare(id).catch(() => {}); }
    }
    function syncKitSel(K) {
      const saved = savedKits(), opts = [{ value: 'std', label: 'Kit: Built-in' }];
      saved.forEach((k) => opts.push({ value: 'kit:' + k.id, label: 'Kit: ' + k.name, group: 'Saved kits' }));
      let v = 'std';
      if (M.song.ext && M.song.ext.kit) {
        if (saved.some((k) => k.id === K.id)) v = 'kit:' + K.id;
        else { v = 'song'; opts.splice(1, 0, { value: 'song', label: 'Kit: ' + K.name + ' (this song)' }); }
      }
      opts.push({ value: '__edit', label: '✎ Edit rows…' }, { value: '__save', label: 'Save kit as…' }, { value: '__babel', label: 'Kit from Babel finds' });
      kitSel.setOptions(opts, v);
      kitSel.select.title = 'Drum kit: ' + K.name;
    }
    const kitW = (S) => {   // the song's own kit snapshot (created from the current kit on the first edit)
      if (!S.ext || typeof S.ext !== 'object') S.ext = {};
      if (!S.ext.kit) S.ext.kit = { id: 'song', name: 'Song kit', rows: defRows() };
      const K = kitOf(S); S.ext.kit = { id: K.id, name: K.name, rows: K.rows };
      return S.ext.kit;
    };
    function useKit(kit, label) {
      const S = M.song;
      if (!S.ext || typeof S.ext !== 'object') S.ext = {};
      if (!kit) delete S.ext.kit; else S.ext.kit = { id: kit.id, name: kit.name, rows: normRows(copy(kit.rows)) };
      const d = drumsW(S);
      if (kit && !d.on) { d.on = true; if (d.preset === 'off') d.preset = 'rock'; }
      M.commit(label || 'Drum kit: ' + (kit ? kit.name : 'Built-in'));
      prepKit(S); route();
    }
    async function kitFromBabel() {
      const k = await babelKit();
      if (!alive) return null;
      if (!k) { M.toast('No saved Babel sounds yet: save some finds in Babel first'); return null; }
      useKit(k, 'Kit from Babel finds');
      M.toast('Kit from Babel finds: ' + k.rows.map((r) => r.name).join(' · '));
      return k;
    }
    function onKitSel(v) {
      if (v === '__edit' || v === '__save') { syncKitSel(kitOf(M.song)); openKit(v === '__save'); return; }
      if (v === '__babel') { syncKitSel(kitOf(M.song)); kitFromBabel(); return; }
      if (v === 'std') useKit(null);
      else if (v.startsWith('kit:')) { const k = savedKits().find((x) => x.id === v.slice(4)); if (k) useKit(k); }
    }
    function previewRow(k) {
      if (!graph) return;
      const S = M.song, K = kitOf(S), i = K.rows.findIndex((r) => r.k === k), r = K.rows[i];
      if (r) playHit(graph.c, graph.drumBus, { drum: r.syn, sound: r.sound, kit: drumsOf(S).kit }, graph.c.currentTime + 0.01, r.vol);
    }
    // Options of a row's sound: built-in synth drums, the user's one-shots, Babel finds, other own sounds, CC0 samples.
    function rowOptions() {
      const out = SYN.map(([k, l]) => ({ value: 'syn:' + k, label: l + ' (built-in)', group: 'Built-in drums' }));
      const all = VH.sounds.list(), own = (s) => s.source !== 'preset' && s.source !== 'sample';
      all.filter((s) => own(s) && s.drum).forEach((s) => out.push({ value: 'snd:' + s.id, label: s.name, group: 'Your one-shots' }));
      all.filter((s) => s.source === 'babel').forEach((s) => out.push({ value: 'snd:' + s.id, label: s.name, group: 'Babel finds' }));
      all.filter((s) => own(s) && !s.drum && s.source !== 'babel').forEach((s) => out.push({ value: 'snd:' + s.id, label: s.name, group: 'Your sounds' }));
      all.filter((s) => s.source === 'sample' && VH.sounds.playOf(s) === 'hit').forEach((s) => out.push({ value: 'snd:' + s.id, label: s.name + (s.private ? ' · local' : ''), group: 'Samples (CC0)' }));
      return out;
    }
    function editRow(i, fn, label) {
      const S = M.song, kit = kitW(S), r = kit.rows[i];
      if (!r) return;
      fn(r, kit);
      kit.rows = normRows(kit.rows);
      M.commit(label);
      prepKit(S); route();
    }
    let kitConfirm = false;
    function renderKit(focusSave) {
      const S = M.song, K = kitOf(S), saved = savedKits().find((k) => k.id === K.id);
      kitPop.innerHTML = '';
      const hd = ui.h('div', 'mel-kit-head', '<b>Drum kit</b> <span></span><button type="button" class="vh-icon-btn mel-kit-x" aria-label="Close">✕</button>');
      hd.querySelector('span').textContent = '· ' + K.name;
      hd.querySelector('.mel-kit-x').addEventListener('click', closeKit);
      kitPop.append(hd);
      const opts = rowOptions();
      K.rows.forEach((r, i) => {
        const row = ui.h('div', 'mel-kit-row');
        row.dataset.k = r.k;
        const nm = ui.h('input', 'mel-kit-name'); nm.type = 'text'; nm.maxLength = 24; nm.value = r.name; nm.setAttribute('aria-label', 'Row ' + (i + 1) + ' name');
        nm.addEventListener('change', () => { const v = nm.value.trim(); if (v) editRow(i, (x) => { x.name = v; }, 'Drum row name'); });
        const sel = ui.select(null, { label: 'Row ' + (i + 1) + ' sound', options: opts, value: r.sound && VH.sounds.get(r.sound) ? 'snd:' + r.sound : 'syn:' + r.syn,
          onChange: (v) => editRow(i, (x) => {
            if (v.startsWith('syn:')) { x.syn = v.slice(4); x.sound = null; x.sname = undefined; } else { const so = VH.sounds.get(v.slice(4)); x.sound = v.slice(4); x.sname = so ? so.name : undefined; }
          }, 'Drum row sound') });
        sel.el.classList.add('mel-kit-snd');
        const vol = ui.h('input', 'mel-kit-vol'); vol.type = 'range'; vol.min = 0; vol.max = 1.5; vol.step = 0.05; vol.value = r.vol;
        vol.setAttribute('aria-label', 'Row ' + (i + 1) + ' volume'); vol.title = 'Volume ' + Math.round(r.vol * 100) + '%';
        vol.addEventListener('input', () => { const k = kitW(M.song); if (k.rows[i]) k.rows[i].vol = +vol.value; vol.title = 'Volume ' + Math.round(vol.value * 100) + '%'; });
        vol.addEventListener('change', () => editRow(i, (x) => { x.vol = +vol.value; }, 'Drum row volume'));
        const play = ui.h('button', 'mel-dr-btn mel-kit-play', '▶'); play.type = 'button'; play.setAttribute('aria-label', 'Play row ' + (i + 1));
        play.addEventListener('click', () => { if (VH.audio.ensure()) { route(); previewRow(r.k); } });
        const del = ui.h('button', 'mel-dr-btn mel-kit-del', '✕'); del.type = 'button'; del.setAttribute('aria-label', 'Remove row ' + (i + 1));
        del.disabled = K.rows.length <= 1;
        del.addEventListener('click', () => { const S2 = M.song, kit = kitW(S2); kit.rows.splice(i, 1); M.commit('Remove drum row'); route(); });
        row.append(nm, sel.el, vol, play, del);
        kitPop.append(row);
      });
      const tools = ui.h('div', 'mel-kit-tools');
      const add = ui.h('button', 'mel-dr-btn mel-kit-add', '＋ Row'); add.type = 'button'; add.disabled = K.rows.length >= MAX_ROWS;
      add.title = 'Add a row (up to ' + MAX_ROWS + ')';
      add.addEventListener('click', () => addRow());
      const bab = ui.h('button', 'mel-dr-btn mel-kit-babel', 'Kit from Babel finds'); bab.type = 'button';
      bab.title = 'The most percussive of your saved Babel sounds, low (kick-like) to high (hat-like)';
      bab.addEventListener('click', () => kitFromBabel());
      tools.append(add, bab);
      kitPop.append(tools);
      const sv = ui.h('div', 'mel-kit-save');
      const nmIn = ui.h('input', 'mel-kit-kitname'); nmIn.type = 'text'; nmIn.maxLength = 30; nmIn.placeholder = 'Kit name';
      nmIn.value = K.id === 'std' || K.id === 'song' ? '' : K.name; nmIn.setAttribute('aria-label', 'Kit name');
      const svb = ui.h('button', 'mel-dr-btn mel-kit-savebtn', 'Save kit'); svb.type = 'button';
      svb.addEventListener('click', () => {
        const nm = nmIn.value.trim() || 'My kit', k = saveKit(kitOf(M.song), nm);
        useKit(k, 'Drum kit: ' + k.name);
        M.toast('Kit “' + k.name + '” saved: pick it from the Kit menu in any song');
      });
      sv.append(nmIn, svb);
      if (saved) {
        const dl = ui.h('button', 'mel-dr-btn mel-kit-delkit', kitConfirm ? 'Delete “' + saved.name + '”? Yes' : 'Delete saved kit'); dl.type = 'button';
        dl.addEventListener('click', () => {
          if (!kitConfirm) { kitConfirm = true; renderKit(); return; }
          kitConfirm = false; deleteKit(saved.id);
          const S2 = M.song; if (S2.ext && S2.ext.kit) { S2.ext.kit.id = 'song'; M.commit('Delete saved kit'); } renderLane(); renderKit();
        });
        sv.append(dl);
        if (kitConfirm) { const no = ui.h('button', 'mel-dr-btn', 'Keep'); no.type = 'button'; no.addEventListener('click', () => { kitConfirm = false; renderKit(); }); sv.append(no); }
      }
      kitPop.append(sv);
      kitPop.append(ui.h('div', 'mel-kit-note', 'Rows play their own sound: a built-in drum, a one-shot you imported, a Babel find or a sample. MIDI export maps rows to General MIDI drums.'));
      if (focusSave) setTimeout(() => nmIn.focus(), 0);
      placeKit();
    }
    function placeKit() {
      if (kitPop.hidden) return;
      const er = M.el.getBoundingClientRect(), lr = lane.getBoundingClientRect();
      kitPop.style.bottom = Math.max(8, er.bottom - lr.top + 6) + 'px';
    }
    function addRow(snd) {
      const S = M.song, kit = kitW(S);
      if (kit.rows.length >= MAX_ROWS) return false;
      const k = freeKey(new Set(kit.rows.map((r) => r.k))), d = drumsW(S);
      [d.pat].concat(Object.values(d.bars)).forEach((p) => { p[k] = fit('', p.len); });   // a fresh, empty row
      kit.rows.push({ k, name: snd ? String(snd.name).slice(0, 16) : 'Perc ' + (kit.rows.length + 1), syn: 'perc', sound: snd ? snd.id : null, sname: snd ? snd.name : undefined, vol: 1 });
      return true;
    }
    function openKit(focusSave) { kitConfirm = false; kitPop.hidden = false; kitBtn.setAttribute('aria-pressed', 'true'); renderKit(focusSave); }
    function closeKit() { kitPop.hidden = true; kitBtn.setAttribute('aria-pressed', 'false'); }
    kitBtn.addEventListener('click', () => { if (kitPop.hidden) openKit(); else closeKit(); });
    const onKitDoc = (e) => { if (!kitPop.hidden && !kitPop.contains(e.target) && !kitBtn.contains(e.target) && !kitSel.el.contains(e.target) && !e.target.closest('.vh-modal-back')) closeKit(); };
    const onKitKey = (e) => { if (e.key === 'Escape' && !kitPop.hidden) { closeKit(); e.stopPropagation(); } };
    document.addEventListener('pointerdown', onKitDoc, true); document.addEventListener('keydown', onKitKey, true);
    M.cleanups.push(() => { document.removeEventListener('pointerdown', onKitDoc, true); document.removeEventListener('keydown', onKitKey, true); });
    M.on('song', () => { prepKit(M.song); if (!kitPop.hidden) renderKit(); });
    M.on('sounds', () => { if (!kitPop.hidden) renderKit(); });
    M.on('layout', placeKit);
    // M.kit: for imports (one-shots become rows) and tests.
    M.kit = {
      get: () => kitOf(M.song), open: openKit, close: closeKit, fromBabel: kitFromBabel, saved: savedKits, use: useKit,
      save: (name) => { const k = saveKit(kitOf(M.song), name); useKit(k, 'Drum kit: ' + k.name); return k; },
      addSounds(ss) {   // one new row per sound (up to 8 rows) -> how many were added; turns the drums on
        let n = 0;
        for (const s of ss || []) if (addRow(s)) n++;
        if (n) { const d = drumsW(M.song); if (!d.on) { d.on = true; if (d.preset === 'off') d.preset = 'rock'; } M.commit(n > 1 ? 'Add ' + n + ' drum rows' : 'Add drum row: ' + ss[0].name); prepKit(M.song); route(); }
        return n;
      },
    };
    current.kitPop = kitPop;

    // ----- mixer row for the drums -----
    M.ui.mixer.addRow({
      id: 'drums', label: 'Drums', color: '#e0b070', muteTitle: 'Mute drums', commit: 'Drum volume',
      get: () => drumsOf(M.song).vol,
      set: (v) => { drumsW(M.song).vol = v; route(); M.save(); },
      mute: { get: () => !drumsOf(M.song).on, set: (m) => { const w = drumsW(M.song); w.on = !m; M.commit(w.on ? 'Drums on' : 'Drums off'); route(); } },
    });

    // ---------- sync ----------
    function syncAll() {
      const S = M.song;
      renderFx(); renderLane(); syncStyleUI();
      magSl.set(+extra(S, 'magnet', 0) || 0);
      humBtn.set({ pressed: !!extra(S, 'humanize', false) });
      sparkBtn.set({ pressed: !!extra(S, 'sparkle', true) });
      syncStyle();
    }
    M.on('song', () => { magCache.clear(); peakCache.clear(); syncAll(); if (VH.audio.ctx) route(); });
    M.on('layer', (i) => { chan = 'L' + i; renderFx(); if (VH.audio.ctx) route(); });
    M.on('sounds', () => { magCache.clear(); peakCache.clear(); });
    M.on('layer', () => peakCache.clear());
    M.on('play', () => { resetSched(); cancelFuture(); route(); });
    M.on('stop', () => { cancelFuture(); resetSched(); setNow(-1); sparks = []; restrike = false; });
    M.onPlayTick(onTick);
    syncAll();

    return {
      destroy() {
        alive = false;
        cancelFuture();
        backNotes.forEach((x) => x.v.stop(0.05)); backNotes = [];
        try { if (styleSet !== 'drone') E.setBacking(null); } catch (_) { /* ignore */ }
        if (graph) { graph.dispose(); graph = null; }
        magCache.clear(); peakCache.clear(); sparks = [];
        laneSlot.remove();
        if (current && current.M === M) current = null;
      },
    };
  });
})();
