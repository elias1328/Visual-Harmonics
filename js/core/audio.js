// audio.js - the shared audio engine (window.VH.audio). See PLAN.md §2 and §4b.
// ensure() creates the AudioContext; call it ONLY from user-gesture handlers.
// voice(sound, freq, opts) -> { setFreq(f, glideSec), setGain(g), stop(releaseSec) } sustained note.
// trigger(sound, freq, durSec, opts) -> one-shot; returns the same handle, so stop(rel) cuts it early.
// opts: { gain = 0.3, loud (false = skip the sound's loudness match), dest (AudioNode; its context is used), when (absolute ctx time), tone: { bright: -1..1 } }
// withContext(ctx, fn): voice/trigger called synchronously inside fn target ctx (e.g. an OfflineAudioContext).
// startAt(ctx, when): the time a voice asked for `when` really starts (live: never before a safe lead); isLive(ctx).
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  let ctx = null, master = null, limiter = null, glue = null, noiseBuf = null, bound = null;
  const live = new Set(), releasing = new Set(), buffers = new Map(), outs = new WeakMap(), noises = new WeakMap();
  const counters = { starts: 0, xfades: 0 };
  const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
  const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const XF = 0.06, ZONE_DRIFT = 4, LOOP_FADE = 0.03;

  // Output stage, for any context: master gain -> glue compressor -> safety limiter -> makeup trim -> destination.
  // Levels: every sound is loudness-matched (sound.loud: -18 dB K-RMS at gain 1, see VH.sounds), so MASTER sets how loud
  // a typical mix is: Melody's demo song lands around -15 dB K-RMS, peaking near -2 dBFS. A gentle glue compressor
  // (-10 dBFS, 3:1, 5 ms) tames dense mixes (many layers + drums) so the limiter (-2 dBFS, hard knee, 20:1, 1 ms attack,
  // gentle release) stays a safety net that rarely acts.
  // Blink's DynamicsCompressorNode adds automatic makeup gain, (1 / gain at 0 dBFS)^0.6 = 0.6 * -T * (1 - 1/R) dB with a
  // hard knee; TRIM takes both back out, so the stage is exactly unity below the thresholds.
  // A fresh DynamicsCompressorNode also starts with ~10 dB of reduction that releases over ~0.2 s, which would duck the
  // first notes (of a just-created live context or an export). So for its first WARM seconds the output takes a dry path
  // (delayed by the compressors' 6 ms look-ahead each, so the paths line up; soft-clipped above -3 dBFS so nothing loud
  // escapes) and then crossfades into them.
  const MASTER = 3.6, WARM = 0.3, LOOKAHEAD = 0.006;
  const GLUE = { threshold: -10, knee: 0, ratio: 3, attack: 0.005, release: 0.25 };
  const LIM = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.25 };
  const makeupDb = (p) => 0.6 * -p.threshold * (1 - 1 / p.ratio);
  const TRIM = 10 ** (-(makeupDb(GLUE) + makeupDb(LIM)) / 20);
  let clipCurve = null;
  function softClip(c) {   // unity up to 0.7, then a tanh knee (0.9 at full scale)
    if (!clipCurve) {
      clipCurve = new Float32Array(4097);
      for (let i = 0; i < clipCurve.length; i++) {
        const x = i / 2048 - 1, a = Math.abs(x);   // the curve spans input -1..1 (beyond: its end values)
        clipCurve[i] = a < 0.7 ? x : Math.sign(x) * (0.7 + 0.25 * Math.tanh((a - 0.7) / 0.25));
      }
    }
    const w = c.createWaveShaper(); w.curve = clipCurve; return w;
  }
  function comp(c, p) { const n = c.createDynamicsCompressor(); for (const k of Object.keys(p)) n[k].value = p[k]; return n; }
  function makeOut(c) {
    const glue = comp(c, GLUE), lim = comp(c, LIM);
    const g = c.createGain(), trim = c.createGain(), dry = c.createDelay(0.05), dryG = c.createGain(), t = c.currentTime;
    g.gain.value = MASTER; trim.gain.value = 0;
    dry.delayTime.value = 2 * Math.floor(LOOKAHEAD * c.sampleRate) / c.sampleRate;
    trim.gain.setValueAtTime(0, t + WARM); trim.gain.linearRampToValueAtTime(TRIM, t + WARM + 0.1);
    dryG.gain.setValueAtTime(1, t + WARM); dryG.gain.linearRampToValueAtTime(0, t + WARM + 0.1);
    g.connect(glue); glue.connect(lim); lim.connect(trim); trim.connect(c.destination);
    const clip = softClip(c);
    g.connect(dry); dry.connect(clip); clip.connect(dryG); dryG.connect(c.destination);
    return { master: g, glue, limiter: lim };
  }
  function makeNoise(c) {
    const b = c.createBuffer(1, Math.round(c.sampleRate * 3.2), c.sampleRate), ch = b.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    return b;
  }
  function ensure() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      ({ master, limiter, glue } = makeOut(ctx));
      noiseBuf = makeNoise(ctx);
    }
    // 'suspended' (autoplay policy) or WebKit's 'interrupted' (iOS: a call, Siri, another app took the audio session).
    if (ctx.state !== 'running' && ctx.state !== 'closed') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    return ctx;
  }
  // Unlock on any user gesture until the context runs, not only on gestures that play a note: WebKit lets resume() start
  // audio only inside a gesture handler, so a context first created (or interrupted) outside one - after an await, a
  // timer, a backgrounded tab - would stay silent. Capture phase, so handlers that stop propagation can't block it.
  if (root.addEventListener && root.document) {
    const MODS = /^(Shift|Control|Alt|Meta|Tab|Escape|CapsLock|Fn)$/;   // not a gesture that may start audio
    const unlock = (e) => {
      if (ctx && ctx.state === 'running') return;
      if (e.type === 'keydown' && (MODS.test(e.key) || e.ctrlKey || e.metaKey || e.altKey)) return;
      ensure();
    };
    ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click'].forEach((t) => root.addEventListener(t, unlock, true));
    // Back from a background tab: a context the browser suspended / interrupted meanwhile resumes (where allowed
    // without a gesture; otherwise the next gesture does it).
    root.document.addEventListener('visibilitychange', () => {
      if (root.document.hidden || !ctx || ctx.state === 'running' || ctx.state === 'closed') return;
      const p = ctx.resume(); if (p && p.catch) p.catch(() => {});
    });
  }
  function outsOf(c) {
    if (c === ctx) return { master, limiter, glue };
    if (!outs.has(c)) outs.set(c, makeOut(c));
    return outs.get(c);
  }
  const outFor = (c) => outsOf(c).master;
  function noiseFor(c) {
    if (c === ctx) return noiseBuf;
    if (!noises.has(c)) noises.set(c, makeNoise(c));
    return noises.get(c);
  }
  // Run fn with voice/trigger targeting c (and its own master + limiter). Schedule synchronously inside fn;
  // samplers must be loaded first (VH.sounds.prepare / VH.audio.load). Returns fn's result.
  // OfflineAudioContext.startRendering() -> Promise<AudioBuffer>. Old WebKit returns nothing and fires oncomplete.
  function render(c) {
    return new Promise((res, rej) => {
      c.oncomplete = (e) => res(e.renderedBuffer);
      const p = c.startRendering();
      if (p && p.then) p.then(res, rej);
    });
  }
  function withContext(c, fn) {
    const prev = bound;
    bound = { ctx: c, out: outFor(c) };
    try { return fn(c, bound.out); } finally { bound = prev; }
  }
  // Where a new voice goes: explicit dest > withContext > the live context.
  function target(o) {
    if (o && o.dest && o.dest.context) return { c: o.dest.context, out: o.dest };
    if (bound) return { c: bound.ctx, out: bound.out };
    return ctx ? { c: ctx, out: master } : null;
  }

  // ---------- sample buffers (decoded once, shared by all contexts) ----------
  function decode(ab) {
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;   // decoding needs no gesture
    const c = ctx || (OAC ? new OAC(1, 1, 44100) : null);
    if (!c) return Promise.reject(new Error('Web Audio is not available'));
    // Old WebKit only has the callback form (it returns undefined); newer engines return a Promise as well.
    return new Promise((res, rej) => { const p = c.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
  }
  const loopable = (z, buf) => z && z.loopEnd > z.loopStart && z.loopStart >= 0 && (!buf || z.loopEnd <= buf.duration);
  // Crossfade the tail before loopEnd into the material before loopStart, once per buffer, so the seam is click-free.
  function bakeLoop(zone, buf) {
    if (buf.__vhLoop || !loopable(zone, buf) || !(VH.analyze && VH.analyze.bakeLoopFade)) return;
    const sr = buf.sampleRate, s = Math.round(zone.loopStart * sr), e = Math.round(zone.loopEnd * sr);
    for (let c = 0; c < buf.numberOfChannels; c++) VH.analyze.bakeLoopFade(buf.getChannelData(c), s, e, Math.round(LOOP_FADE * sr));
    buf.__vhLoop = [zone.loopStart, zone.loopEnd];
  }
  function load(zone) {
    const key = zone.blobKey ? 'blob:' + zone.blobKey : zone.url;
    if (!buffers.has(key)) {
      const p = (zone.blobKey ? VH.store.getBlob(zone.blobKey).then((b) => b.arrayBuffer())
        : fetch(zone.url).then((r) => { if (!r.ok) throw new Error(r.status + ' ' + zone.url); return r.arrayBuffer(); }))
        .then(decode)
        .then((buf) => { bakeLoop(zone, buf); p.buffer = buf; return buf; });
      p.catch(() => buffers.delete(key));
      buffers.set(key, p);
    }
    const p = buffers.get(key);
    if (p.buffer) bakeLoop(zone, p.buffer);
    return p;
  }
  function nearestZone(sound, freq) {
    const zs = (sound.sampler && sound.sampler.zones) || [], m = hzToMidi(freq);
    return zs.reduce((b, z) => (!b || Math.abs(z.rootMidi - m) < Math.abs(b.rootMidi - m) ? z : b), null);
  }

  // ---------- voices ----------
  const SILENT = { setFreq() {}, setGain() {}, stop() {}, silent: true };
  function track(v) { live.add(v); return v; }
  function retire(v, endTime, c) {
    live.delete(v); releasing.add(v);
    c = c || ctx;
    const ms = Math.max(0, (endTime - (c ? c.currentTime : 0)) * 1000) + 80;
    if (c && c !== ctx) { releasing.delete(v); return; }   // offline renders: nothing to wait for
    setTimeout(() => releasing.delete(v), ms);
  }
  // src -> [tone shelves] -> env -> lvl -> out
  function chain(c, out, gain, tone) {
    const env = c.createGain(), lvl = c.createGain();
    env.gain.value = 0; lvl.gain.value = gain;
    env.connect(lvl); lvl.connect(out);
    let input = env;
    const bands = VH.sounds && VH.sounds.toneBands ? VH.sounds.toneBands(tone) : [];
    for (let i = bands.length - 1; i >= 0; i--) {
      const f = c.createBiquadFilter();
      f.type = bands[i].type; f.frequency.value = bands[i].freq; f.gain.value = bands[i].gain;
      f.connect(input); input = f;
    }
    return { env, lvl, input };
  }
  // Release from whatever the envelope is at t. (A linear ramp after cancelAndHoldAtTime(future t) ramps from
  // the previous event in Chrome, i.e. fades the whole note; setTargetAtTime starts from the value at t.)
  function release(param, rel, t, shape) {
    holdAt(param, t, shape);
    param.setTargetAtTime(0, t, rel / 5);   // < 1 % left when the sources stop at t + rel
  }
  // cancelAndHoldAtTime(t) keeps the envelope shape up to t. Firefox lacks it, and cancelScheduledValues(t) drops a ramp
  // still running at t, so the value falls back to the event before it (a note released mid-attack went silent, a pluck
  // released mid-decay jumped back to full level). Without it, re-add the cut ramp so it ends at t with the envelope's
  // value there. shape = { t0, a, d, s, peak } of the attack (linear 0 -> peak) / decay (s <= 0: exponential to 0.0005).
  function holdAt(param, t, shape) {
    if (param.cancelAndHoldAtTime) { param.cancelAndHoldAtTime(t); return; }
    param.cancelScheduledValues(t);
    if (!shape || !(t > shape.t0)) return;
    const { t0, a, d, s } = shape, peak = shape.peak ?? 1;
    if (t < t0 + a) param.linearRampToValueAtTime(peak * (t - t0) / a, t);
    else if (s <= 0 && t < t0 + a + d) param.exponentialRampToValueAtTime(peak * Math.pow(0.0005 / peak, (t - t0 - a) / d), t);
  }
  const toneFor = (sound, o) => (VH.sounds && VH.sounds.toneOf ? VH.sounds.toneOf(sound, o.tone) : o.tone);
  // Start time of a voice. The live audio thread renders ahead of currentTime (up to a device buffer, ~baseLatency), so
  // events for a time it already rendered arrive late: the source starts at once but the 0 -> 1 attack ramp is partly
  // over by then, i.e. the note begins with a jump (a click). So a live start is never earlier than a safe lead.
  // Offline contexts render in step with their events (unchanged: when, or 5 ms after currentTime).
  const leadOf = (c) => Math.min(0.05, Math.max(0.012, (c.baseLatency || 0) * 1.5 + 0.004));
  function startAt(c, when) {
    const ok = when != null && isFinite(when);
    if (c !== ctx) return ok && when > c.currentTime ? when : c.currentTime + 0.005;
    const e = c.currentTime + leadOf(c);
    return ok && when > e ? when : e;
  }

  function synthVoice(sound, freq, gain, T, o) {
    const c = T.c, s = sound.synth || {}, nyq = c.sampleRate / 2 - 1, t0 = startAt(c, o.when), main = c === ctx;
    const parts = (s.partials && s.partials.length ? s.partials : [[1, 1]]).slice(0, 24);
    const A = Math.max(0.002, s.attack ?? 0.01), D = Math.max(0.01, s.decay ?? 0.3);
    const S = Math.max(0, Math.min(1, s.sustain ?? 0.8)), noise = Math.max(0, Math.min(1, s.noise || 0));
    const { env, lvl, input } = chain(c, T.out, gain, toneFor(sound, o));
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + A);
    if (S > 0) env.gain.setTargetAtTime(S, t0 + A, D / 3);
    else { env.gain.exponentialRampToValueAtTime(0.0005, t0 + A + D); env.gain.setValueAtTime(0, t0 + A + D + 0.01); }
    const mix = c.createGain(); mix.gain.value = 1 - noise; mix.connect(input);
    const srcs = [], oscs = [];
    let lfoGain = null;
    if (s.wobble > 0.5) {   // vibrato: LFO into every oscillator's detune, ±30 cents
      const lfo = c.createOscillator(); lfoGain = c.createGain();
      lfo.frequency.value = s.wobble; lfoGain.gain.value = 30;
      lfo.connect(lfoGain); lfo.start(t0); srcs.push(lfo);
    }
    const sum = parts.reduce((a, p) => a + p[1], 0) || 1, glideC = (s.glide || 0) * 100;
    for (const [r, a] of parts) {
      const osc = c.createOscillator(), pg = c.createGain();
      osc.frequency.value = Math.min(freq * r, nyq);
      pg.gain.value = freq * r < nyq ? a / sum : 0;
      if (glideC) { osc.detune.setValueAtTime(0, t0); osc.detune.linearRampToValueAtTime(glideC, t0 + A + D); }
      if (lfoGain) lfoGain.connect(osc.detune);
      osc.connect(pg); pg.connect(mix); osc.start(t0);
      srcs.push(osc); oscs.push({ o: osc, pg, r, a });
    }
    counters.starts += srcs.length;
    let bp = null;
    if (noise > 0.01) {   // band-passed hiss around the pitch
      const n = c.createBufferSource(), ng = c.createGain();
      bp = c.createBiquadFilter();
      n.buffer = noiseFor(c); n.loop = true; bp.type = 'bandpass'; bp.Q.value = 3;
      bp.frequency.value = Math.min(freq, nyq); ng.gain.value = noise * 2.2;
      n.connect(bp); bp.connect(ng); ng.connect(env); n.start(t0); srcs.push(n);
    }
    let stopT = Infinity;
    const v = {
      t0, ctx: c,
      // `at` (optional, absolute ctx time) lets offline renders schedule pitch changes up front.
      setFreq(f, glideSec = 0.015, at) {
        const t = Math.max(c.currentTime, at || 0), tc = Math.max(0.001, glideSec / 3);
        if (t >= stopT || !(f > 0)) return;   // allowed until the release begins
        for (const x of oscs) {
          x.o.frequency.setTargetAtTime(Math.min(f * x.r, nyq), t, tc);
          x.pg.gain.setTargetAtTime(f * x.r < nyq ? x.a / sum : 0, t, tc);
        }
        if (bp) bp.frequency.setTargetAtTime(Math.min(f, nyq), t, tc);
      },
      setGain(g) { if (c.currentTime < stopT) lvl.gain.setTargetAtTime(g, c.currentTime, 0.01); },
      // May be called again with an earlier time (e.g. to cut a trigger() note short); later calls are ignored.
      stop(rel, when) {
        rel = Math.max(0.01, rel ?? s.release ?? 0.2);
        const t = Math.max(c.currentTime, when || 0, t0);
        if (t >= stopT) return;
        stopT = t;
        release(env.gain, rel, t, { t0, a: A, d: D, s: S });
        srcs.forEach((x) => { try { x.stop(t + rel + 0.02); } catch (_) { /* already stopped */ } });
        retire(v, t + rel + 0.02, c);
      },
    };
    return main ? track(v) : v;
  }

  // ---------- synth.v2: subtractive voice (VH.synth model) ----------
  // oscs (native / PeriodicWave / additive bank / noise, each with unison) -> 24 dB filter (2 biquads; env + LFO on
  // their detune, cents) -> panner -> tremolo -> [tone] -> amp env -> lvl -> out. Legato setFreq glides every source.
  const waves = new WeakMap();   // ctx -> Map(key -> PeriodicWave)
  function periodicWave(c, parts) {
    if (!waves.has(c)) waves.set(c, new Map());
    const m = waves.get(c), key = JSON.stringify(parts);
    if (!m.has(key)) {
      const n = Math.min(64, Math.max(...parts.map((p) => Math.round(p[0])))) + 1, re = new Float32Array(n), im = new Float32Array(n);
      for (const [r, a] of parts) { const k = Math.round(r); if (k >= 1 && k < n) im[k] += a; }
      m.set(key, c.createPeriodicWave(re, im));
    }
    return m.get(key);
  }
  const NATIVE = { sine: 'sine', saw: 'sawtooth', square: 'square', triangle: 'triangle' };
  const v2Count = () => { let n = 0; for (const v of live) if (v.v2) n++; return n; };
  function synthV2Voice(sound, freq, gain, T, o) {
    const Y = VH.synth, c = T.c, m = Y.normalize(sound.synth), main = c === ctx, t0 = startAt(c, o.when), nyq = c.sampleRate / 2 - 1;
    const ae = m.ampEnv, fe = m.filtEnv, F = m.filter, trim = o.loud === false ? 1 : m.gain;
    const { env, lvl, input } = chain(c, T.out, gain * trim, toneFor(sound, o));
    // CPU guard: thin out unison when many v2 voices are live.
    const nLive = main ? v2Count() : 0, uMax = nLive > 20 ? 1 : nLive > 12 ? 2 : 7;
    // amp envelope
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + ae.a);
    if (ae.s > 0) env.gain.setTargetAtTime(ae.s, t0 + ae.a, ae.d / 3);
    else { env.gain.exponentialRampToValueAtTime(0.0005, t0 + ae.a + ae.d); env.gain.setValueAtTime(0, t0 + ae.a + ae.d + 0.01); }
    // amp LFO (tremolo) and pan stages
    const trem = c.createGain(); trem.connect(input);
    let pan = null;
    if (c.createStereoPanner) { pan = c.createStereoPanner(); pan.connect(trem); }
    // filter: two cascaded biquads
    const kt = (f) => Math.min(nyq, F.cutoff * (f / Y.NOMINAL_ROOT) ** F.keyTrack);
    const filts = Y.stageQ(F).map((q) => {
      const b = c.createBiquadFilter(); b.type = F.type; b.Q.value = Y.nodeQ(F.type, q); b.frequency.value = kt(freq); return b;
    });
    filts[0].connect(filts[1]); filts[1].connect(pan || trem);
    const fenv = F.envAmt * 1200;   // cents at full envelope
    if (fenv) for (const b of filts) {
      b.detune.setValueAtTime(0, t0);
      b.detune.linearRampToValueAtTime(fenv, t0 + fe.a);
      b.detune.setTargetAtTime(fenv * fe.s, t0 + fe.a, fe.d / 3);
    }
    // sources
    const srcs = [], tuned = [];   // tuned: { o (osc node), mul, g (gain node or null), a (amp) }
    const sumLv = Math.max(1, m.oscs.reduce((a, x) => a + (x.wave === 'noise' ? 0 : x.level), 0));
    const mix = c.createGain(); mix.gain.value = 1 / sumLv; mix.connect(filts[0]);
    for (const x of m.oscs) {
      if (!(x.level > 0)) continue;
      const og = c.createGain(); og.gain.value = x.level; og.connect(mix);
      if (x.wave === 'noise') {
        const n = c.createBufferSource(), buf = noiseFor(c);
        n.buffer = buf; n.loop = true; n.connect(og); n.start(t0, Math.random() * (buf.duration - 0.1)); srcs.push(n);
        continue;
      }
      const mul = Y.oscMul(x), add = Y.additive(x);
      let parts = null, psum = 1;
      if (add) {
        parts = Y.waveHarmonics(x, 16).map(([r, a]) => [r ** x.stretch, a]);
        psum = parts.reduce((a, p) => a + p[1], 0) || 1;
      }
      let u = Math.min(x.unison, uMax);
      if (add) u = Math.max(1, Math.min(u, Math.floor(48 / parts.length)));
      og.gain.value = x.level / Math.sqrt(u);
      for (let i = 0; i < u; i++) {
        const cents = u > 1 ? x.spread * (i / (u - 1) - 0.5) : 0;
        let dst = og;
        if (u > 1 && x.spread > 0 && c.createStereoPanner) {   // spread unison voices across the stereo field
          const sp = c.createStereoPanner(); sp.pan.value = 0.7 * (i / (u - 1) * 2 - 1); sp.connect(og); dst = sp;
        }
        const mk = (r, a) => {
          const osc = c.createOscillator(), fr = freq * mul * r;
          if (x.wave === 'partials' && !add) osc.setPeriodicWave(periodicWave(c, x.partials));
          else if (!add) osc.type = NATIVE[x.wave];
          osc.frequency.value = Math.min(fr, nyq); osc.detune.value = cents;
          let g = null;
          if (add) { g = c.createGain(); g.gain.value = fr < nyq ? a / psum : 0; osc.connect(g); g.connect(dst); } else osc.connect(dst);
          osc.start(t0); srcs.push(osc); tuned.push({ o: osc, mul: mul * r, g, a: a / psum });
        };
        if (add) for (const [r, a] of parts) mk(r, a); else mk(1, 1);
      }
    }
    // LFOs
    for (const l of m.lfos) {
      if (!(l.depth > 0)) continue;
      const lfo = c.createOscillator(), lg = c.createGain();
      lfo.type = l.shape; lfo.frequency.value = l.rate; lfo.connect(lg); lfo.start(t0); srcs.push(lfo);
      const d = l.depth * Y.LFO_SCALE[l.target];
      if (l.target === 'pitch') { lg.gain.value = d; tuned.forEach((x) => lg.connect(x.o.detune)); }
      else if (l.target === 'cutoff') { lg.gain.value = d; filts.forEach((b) => lg.connect(b.detune)); }
      else if (l.target === 'amp') { lg.gain.value = d / 2; trem.gain.value = 1 - d / 2; lg.connect(trem.gain); }
      else if (pan) { lg.gain.value = d; lg.connect(pan.pan); }
    }
    counters.starts += srcs.length;
    let stopT = Infinity, cur = freq;
    const v = {
      t0, ctx: c, v2: true,
      get freq() { return cur; },
      get sources() { return srcs.length; }, uMax,
      // Legato: glides every oscillator (and the keytracked cutoff); never retriggers. Default glide: synth.glide.
      setFreq(f, glideSec, at) {
        const t = Math.max(c.currentTime, at || 0);
        if (t >= stopT || !(f > 0)) return;
        const tc = Math.max(0.001, (glideSec ?? (m.glide || 0.015)) / 3);
        for (const x of tuned) {
          x.o.frequency.setTargetAtTime(Math.min(f * x.mul, nyq), t, tc);
          if (x.g) x.g.gain.setTargetAtTime(f * x.mul < nyq ? x.a : 0, t, tc);
        }
        if (F.keyTrack) for (const b of filts) b.frequency.setTargetAtTime(kt(f), t, tc);
        cur = f;
      },
      setGain(g) { if (c.currentTime < stopT) lvl.gain.setTargetAtTime(g * trim, c.currentTime, 0.01); },
      stop(rel, when) {
        rel = Math.max(0.01, rel ?? ae.r);
        const t = Math.max(c.currentTime, when || 0, t0);
        if (t >= stopT) return;
        stopT = t;
        release(env.gain, rel, t, { t0, a: ae.a, d: ae.d, s: ae.s });
        if (fenv) for (const b of filts) {
          holdAt(b.detune, t, { t0, a: fe.a, d: fe.d, s: 1, peak: fenv });
          b.detune.setTargetAtTime(0, t, fe.r / 3);
        }
        const tEnd = t + rel + 0.02;
        srcs.forEach((x) => { try { x.stop(tEnd); } catch (_) { /* already stopped */ } });
        retire(v, tEnd, c);
      },
    };
    return main ? track(v) : v;
  }

  // Legato sampler voice: one looping buffer source per "layer"; setFreq glides playbackRate (never retriggers);
  // drifting > 4 semitones from the zone root crossfades (60 ms) into the nearest zone.
  function zoneGain(z) { const g = z && z.gain; return g > 0 && isFinite(g) ? g : 1; }
  function samplerVoice(sound, freq, gain, T, o) {
    let zone = nearestZone(sound, freq);
    if (!zone) return SILENT;
    const c = T.c, main = c === ctx, t0 = startAt(c, o.when);
    const relDef = (sound.sampler && sound.sampler.release) ?? 0.3;
    const { env, lvl, input } = chain(c, T.out, gain, toneFor(sound, o));
    let layer = null, fading = [], ended = false, stopT = Infinity, relInfo = null, f = freq, lastXf = -1, starts = 0;
    function mkLayer(z, buf, t, offset, rateFrom, fadeIn) {
      const src = c.createBufferSource(), g = c.createGain(), rootF = midiToHz(z.rootMidi);
      src.buffer = buf;
      if (loopable(z, buf)) { src.loop = true; src.loopStart = z.loopStart; src.loopEnd = z.loopEnd; }
      src.playbackRate.setValueAtTime(rateFrom / rootF, t);
      const zg = zoneGain(z);   // per-zone loudness match (manifest zone.gain)
      if (fadeIn) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(zg, t + XF); }
      else g.gain.setValueAtTime(zg, t);
      src.connect(g); g.connect(input);
      src.start(t, Math.max(0, Math.min(offset, buf.duration - 0.01)));
      starts++; counters.starts++;
      const L = { src, g, zone: z, rootF, t, offset, zg };
      src.onended = () => {
        if (layer === L && !ended && stopT === Infinity) { ended = true; live.delete(v); }
        try { g.disconnect(); } catch (_) { /* ignore */ }
      };
      return L;
    }
    function stopLayers(t) {
      for (const L of [layer].concat(fading)) if (L) { try { L.src.stop(t); } catch (_) { /* ignore */ } }
    }
    function begin(buf) {   // decoded later than t0 (first use of a zone): start at a safe time, never in the past
      if (ended || layer) return;
      const t = startAt(c, t0);
      if (relInfo && t >= relInfo.t) { ended = true; live.delete(v); return; }   // cut before it could start
      layer = mkLayer(zone, buf, t, 0, f, false);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.005);
      if (relInfo) { release(env.gain, relInfo.rel, Math.max(relInfo.t, t + 0.005)); stopLayers(relInfo.t + relInfo.rel + 0.02); }
    }
    function crossfadeTo(z, nf, t, tc) {
      const p = load(z);
      if (!p.buffer) { p.catch(() => {}); return; }   // switch on a later setFreq once decoded
      const old = layer, buf = p.buffer, pos = t - old.t + old.offset;   // seconds into the note (approx.)
      // Enter a looped zone at its steady sustain so a glide never replays the louder attack/body.
      const offset = loopable(z, buf) ? z.loopStart : pos;
      old.g.gain.setValueAtTime(old.zg, t); old.g.gain.linearRampToValueAtTime(0, t + XF);
      try { old.src.stop(t + XF + 0.02); } catch (_) { /* ignore */ }
      fading = fading.filter((L) => L.t + XF + 0.05 > t).concat(old);
      layer = mkLayer(z, buf, t, offset, f, true);
      layer.src.playbackRate.setTargetAtTime(nf / layer.rootF, t, tc);
      zone = z; lastXf = t; counters.xfades++;
      if (stopT < Infinity) stopLayers(stopT + relInfo.rel + 0.02);
    }
    const p = load(zone);
    if (p.buffer) begin(p.buffer);
    else p.then(begin).catch(() => { ended = true; live.delete(v); });
    const v = {
      t0, ctx: c,
      get starts() { return starts; },
      get zone() { return zone; },
      setFreq(nf, glideSec = 0.015, at) {
        if (!(nf > 0)) return;
        const t = Math.max(c.currentTime, at || 0);
        if (!layer || ended || t >= stopT) { if (!layer) f = nf; return; }   // glides until the release begins
        const tc = Math.max(0.001, glideSec / 3), m = hzToMidi(nf);
        // before the source starts, its setValueAtTime(rate, start) would override an earlier target: glide from the start
        layer.src.playbackRate.setTargetAtTime(nf / layer.rootF, Math.max(t, layer.t), tc);
        for (const L of fading) L.src.playbackRate.setTargetAtTime(nf / L.rootF, t, tc);
        if (Math.abs(m - zone.rootMidi) > ZONE_DRIFT && t - lastXf > XF) {
          const z = nearestZone(sound, nf);
          if (z && z !== zone && Math.abs(z.rootMidi - m) < Math.abs(zone.rootMidi - m)) crossfadeTo(z, nf, t, tc);
        }
        f = nf;
      },
      setGain(g) { if (c.currentTime < stopT && !ended) lvl.gain.setTargetAtTime(g, c.currentTime, 0.01); },
      // Release defaults to sound.sampler.release. Like synth voices, an earlier stop overrides a later one.
      stop(rel, when) {
        if (ended) { live.delete(v); return; }
        rel = Math.max(0.01, rel ?? relDef);
        const t = Math.max(c.currentTime, when || 0, t0);
        if (t >= stopT) return;
        stopT = t; relInfo = { rel, t };
        if (layer) { release(env.gain, rel, t, { t0: layer.t, a: 0.005, d: 0, s: 1 }); stopLayers(t + rel + 0.02); }
        retire(v, t + rel + 0.02, c);
      },
    };
    return main ? track(v) : v;
  }

  // Every voice is scaled by the sound's loudness match (sound.loud, see VH.sounds); opts.loud === false skips it
  // (used when measuring). setGain(g) keeps the same scale.
  function voice(sound, freq, opts) {
    const o = opts || {}, T = target(o);
    if (!T || !sound || !(freq > 0)) return SILENT;
    let k = 1;
    if (o.loud !== false) {
      if (!(sound.loud > 0) && VH.sounds && VH.sounds.ensureLoud) VH.sounds.ensureLoud(sound);   // user sounds: lazily
      k = VH.sounds && VH.sounds.loudOf ? VH.sounds.loudOf(sound) : 1;
    }
    const gain = (o.gain != null ? o.gain : 0.3) * k;
    const v = sound.kind === 'sampler' ? samplerVoice(sound, freq, gain, T, o)
      : sound.synth && sound.synth.v === 2 && VH.synth ? synthV2Voice(sound, freq, gain, T, o) : synthVoice(sound, freq, gain, T, o);
    if (k !== 1 && !v.silent) { const sg = v.setGain; v.setGain = (g) => sg(g * k); }
    return v;
  }
  function trigger(sound, freq, durSec, opts) {
    const v = voice(sound, freq, opts);
    if (!v.silent) v.stop(undefined, v.t0 + Math.max(0.02, durSec || 0.5));
    return v;
  }
  function stopAll(rel = 0.05) { [...live].forEach((v) => v.stop(rel)); }

  VH.audio = {
    ensure, voice, trigger, stopAll, load, decode, render, withContext, midiToHz, hzToMidi, startAt,
    isLive: (c) => !!c && c === ctx,
    // For experiments with their own synth (babel): register a handle with stop() so it is counted/stopped.
    track, retire,
    get ctx() { return (bound && bound.ctx) || ctx; },
    get out() { return (bound && bound.out) || master; },
    get noise() { return noiseBuf; },
    // The output limiter of a context (live or offline); its .reduction shows how hard it works.
    limiterFor: (c) => (c ? outsOf(c).limiter : limiter),
    glueFor: (c) => (c ? outsOf(c).glue : glue),
    stats() { return { v2Live: v2Count(), live: live.size, releasing: releasing.size, state: ctx ? ctx.state : 'none', starts: counters.starts, xfades: counters.xfades }; },
  };
})(this);
