// fx.js - audio effects (window.VH.fx). See PLAN.md §4b. Pure Web Audio nodes, no files, no worklets.
// create(ctx, type, params) -> { type, input, output, params, set(params), dispose() }
// chain(ctx, [fx | type | { type, params }, ...]) -> the same shape, the effects connected in series.
// Every effect has a dry/wet `mix` (0..1). Types and params (defaults):
//   reverb { size 0.5 (0..1 -> 0.4..4.4 s generated impulse), decay 3, mix 0.3 }
//   delay  { time 0.3 s, feedback 0.35, tone 4500 Hz (feedback lowpass), mix 0.3 }
//   chorus { rate 0.8 Hz, depth 0.5 (0..1 -> 0..6 ms), mix 0.5 }
//   drive  { amount 0.5 (0..1), mix 1 }
//   lofi   { bits 8 (1..16), rate 8000 Hz (an anti-image lowpass at rate/2), mix 1 }
//   filter { type 'lowpass', cutoff 2000 Hz, q 0.7, gain 0 (dB, shelf/peaking types), mix 1 }
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  const DEFAULTS = {
    reverb: { size: 0.5, decay: 3, mix: 0.3 },
    delay: { time: 0.3, feedback: 0.35, tone: 4500, mix: 0.3 },
    chorus: { rate: 0.8, depth: 0.5, mix: 0.5 },
    drive: { amount: 0.5, mix: 1 },
    lofi: { bits: 8, rate: 8000, mix: 1 },
    filter: { type: 'lowpass', cutoff: 2000, q: 0.7, gain: 0, mix: 1 },
  };
  const TYPES = Object.keys(DEFAULTS);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, +v));
  const ramp = (param, v, c) => param.setTargetAtTime(v, c.currentTime, 0.02);

  // Stereo exponentially decaying noise, slightly low-passed over time (darker tail).
  function impulse(c, seconds, decay) {
    const n = Math.max(1, Math.round(c.sampleRate * seconds)), buf = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n, k = 0.15 + 0.8 * t;   // one-pole smoothing grows along the tail
        lp += (Math.random() * 2 - 1 - lp) * (1 - k);
        d[i] = lp * (1 - t) ** decay;
      }
    }
    return buf;
  }
  function driveCurve(amount) {
    const k = 1 + amount * 20, n = 2048, curve = new Float32Array(n), norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(k * x) / norm; }
    return curve;
  }
  function crushCurve(bits) {
    const steps = 2 ** (Math.round(clamp(bits, 1, 16)) - 1), n = 65536, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.round(x * steps) / steps; }
    return curve;
  }

  function create(c, type, params) {
    if (!DEFAULTS[type]) throw new Error('unknown fx type ' + type);
    const p = Object.assign({}, DEFAULTS[type]), nodes = [], oscs = [];
    const node = (n) => { nodes.push(n); return n; };
    const input = node(c.createGain()), output = node(c.createGain()), dry = node(c.createGain()), wet = node(c.createGain());
    input.connect(dry); dry.connect(output); wet.connect(output);
    let apply;   // (changed params, first?) -> void

    if (type === 'reverb') {
      const conv = node(c.createConvolver());
      input.connect(conv); conv.connect(wet);
      let ir = '';
      apply = () => {
        const key = p.size + '/' + p.decay;
        if (key !== ir) { ir = key; conv.buffer = impulse(c, 0.4 + 4 * clamp(p.size, 0, 1), clamp(p.decay, 0.5, 10)); }
      };
    } else if (type === 'delay') {
      const d = node(c.createDelay(2)), fb = node(c.createGain()), lp = node(c.createBiquadFilter());
      lp.type = 'lowpass';
      input.connect(d); d.connect(wet); d.connect(lp); lp.connect(fb); fb.connect(d);
      apply = (first) => {
        const set = first ? (a, v) => { a.value = v; } : (a, v) => ramp(a, v, c);
        set(d.delayTime, clamp(p.time, 0.001, 2)); set(fb.gain, clamp(p.feedback, 0, 0.95)); set(lp.frequency, clamp(p.tone, 200, 20000));
      };
    } else if (type === 'chorus') {
      const lfo = node(c.createOscillator()), d1 = node(c.createDelay(0.1)), d2 = node(c.createDelay(0.1));
      const g1 = node(c.createGain()), g2 = node(c.createGain()), half = node(c.createGain());
      d1.delayTime.value = 0.018; d2.delayTime.value = 0.024; half.gain.value = 0.6;
      lfo.connect(g1); lfo.connect(g2); g1.connect(d1.delayTime); g2.connect(d2.delayTime);
      input.connect(d1); input.connect(d2); d1.connect(half); d2.connect(half); half.connect(wet);
      lfo.start(); oscs.push(lfo);
      apply = (first) => {
        const dep = clamp(p.depth, 0, 1) * 0.006;
        if (first) { lfo.frequency.value = clamp(p.rate, 0.01, 20); g1.gain.value = dep; g2.gain.value = -dep; return; }
        ramp(lfo.frequency, clamp(p.rate, 0.01, 20), c); ramp(g1.gain, dep, c); ramp(g2.gain, -dep, c);
      };
    } else if (type === 'drive') {
      const pre = node(c.createGain()), sh = node(c.createWaveShaper()), post = node(c.createGain());
      sh.oversample = '4x';
      input.connect(pre); pre.connect(sh); sh.connect(post); post.connect(wet);
      apply = () => {
        const a = clamp(p.amount, 0, 1);
        sh.curve = driveCurve(a); pre.gain.value = 1; post.gain.value = 1 / Math.sqrt(1 + a * 20);   // roughly level-matched
      };
    } else if (type === 'lofi') {
      const lp1 = node(c.createBiquadFilter()), lp2 = node(c.createBiquadFilter()), sh = node(c.createWaveShaper());
      lp1.type = lp2.type = 'lowpass'; lp1.Q.value = lp2.Q.value = 0.7;
      input.connect(sh); sh.connect(lp1); lp1.connect(lp2); lp2.connect(wet);
      let bits = -1;
      apply = () => {
        if (p.bits !== bits) { bits = p.bits; sh.curve = crushCurve(bits); }
        const fc = clamp(p.rate / 2, 100, c.sampleRate / 2 - 1);
        lp1.frequency.value = fc; lp2.frequency.value = fc;
      };
    } else {   // filter
      const f = node(c.createBiquadFilter());
      input.connect(f); f.connect(wet);
      apply = (first) => {
        f.type = p.type || 'lowpass';
        const set = first ? (a, v) => { a.value = v; } : (a, v) => ramp(a, v, c);
        set(f.frequency, clamp(p.cutoff, 10, c.sampleRate / 2 - 1)); set(f.Q, clamp(p.q, 0.0001, 40)); set(f.gain, clamp(p.gain || 0, -40, 40));
      };
    }
    const applyMix = (first) => {
      const m = clamp(p.mix, 0, 1);
      if (first) { dry.gain.value = 1 - m; wet.gain.value = m; } else { ramp(dry.gain, 1 - m, c); ramp(wet.gain, m, c); }
    };

    let disposed = false;
    const fx = {
      type, input, output, ctx: c,
      get params() { return Object.assign({}, p); },
      get disposed() { return disposed; },
      get nodeCount() { return disposed ? 0 : nodes.length; },
      set(np) {
        if (disposed || !np) return fx;
        for (const k of Object.keys(np)) if (k in DEFAULTS[type] && np[k] != null) p[k] = np[k];
        apply(false); applyMix(false);
        return fx;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        oscs.forEach((o) => { try { o.stop(); } catch (_) { /* ignore */ } });
        nodes.forEach((n) => { try { n.disconnect(); } catch (_) { /* ignore */ } });
        nodes.length = 0;
      },
    };
    if (params) for (const k of Object.keys(params)) if (k in DEFAULTS[type] && params[k] != null) p[k] = params[k];
    apply(true); applyMix(true);
    return fx;
  }

  // Effects in series. Items may be fx objects, type strings or { type, params }. An empty list is a passthrough.
  function chain(c, list) {
    const items = (list || []).map((x) => (typeof x === 'string' ? create(c, x) : x && x.input ? x : create(c, x.type, x.params)));
    const input = c.createGain(), output = c.createGain();
    let prev = input;
    for (const fx of items) { prev.connect(fx.input); prev = fx.output; }
    prev.connect(output);
    let disposed = false;
    return {
      type: 'chain', input, output, items, ctx: c,
      set(i, np) { if (items[i]) items[i].set(np); },
      dispose() {
        if (disposed) return;
        disposed = true;
        items.forEach((fx) => fx.dispose());
        try { input.disconnect(); } catch (_) { /* ignore */ }
        try { output.disconnect(); } catch (_) { /* ignore */ }
      },
    };
  }

  VH.fx = { create, chain, TYPES, DEFAULTS };
})(this);
