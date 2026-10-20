// sounds.js - the shared Sound format + library (window.VH.sounds). See PLAN.md §2 and §4b.
// Built-in synth presets, sampler presets from assets/samples/manifest.json, and user sounds (VH.store).
// Also the pure sound helpers: playOf (glide/hit), the tone filter (toneBands/toneResponse), spectrumOf, derive.
// Node: module.exports = VH.sounds (no manifest loading; storage falls back to memory).
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  if (!VH.store && typeof require === 'function') { try { VH.store = require('./store.js'); } catch (_) { /* browser */ } }
  if (!VH.synth && typeof require === 'function') { try { VH.synth = require('./synth.js'); } catch (_) { /* browser */ } }
  const isV2 = (s) => !!(s && s.kind === 'synth' && s.synth && s.synth.v === 2);
  // Public CC0 set + an optional local-only (gitignored) set. Either may be missing.
  // The private set is only probed on a local dev server, so the published site never logs a 404 for it.
  const isLocal = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const MANIFESTS = [{ url: 'assets/samples/manifest.json' }].concat(isLocal ? [{ url: 'assets/samples-private/manifest.json', private: true }] : []);
  const DEFAULT_SPECTRUM = Array.from({ length: 8 }, (_, k) => [k + 1, Math.round(0.88 ** k * 1000) / 1000]);

  // ---------- helpers ----------
  const harm = (n, roll, stretch = 1) => Array.from({ length: n }, (_, k) => [(k + 1) ** stretch, roll ** k]);
  // <= 16 entries, finite, ratio > 0, loudest = 1, sorted by ratio.
  function normSpectrum(sp) {
    const ok = (sp || []).filter((p) => Array.isArray(p) && p[0] > 0 && p[1] > 0 && isFinite(p[0]) && isFinite(p[1]));
    if (!ok.length) return null;
    const top = ok.slice().sort((a, b) => b[1] - a[1]).slice(0, 16), max = top[0][1];
    return top.map(([r, a]) => [r, a / max]).sort((a, b) => a[0] - b[0]);
  }
  function synth(id, name, family, partials, env) {
    return {
      id, name, family, play: 'glide', source: 'preset', kind: 'synth',
      synth: Object.assign({ partials, attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.3, glide: 0, noise: 0, wobble: 0 }, env),
      spectrum: normSpectrum(partials),
    };
  }
  // Additive "Custom" sound from the Overtones / Stretch / Brightness sliders.
  function custom(p) {
    const s = synth('custom', 'Custom', 'custom', harm(p.n, p.roll, p.stretch), { attack: 0.02, decay: 0.2, sustain: 0.9, release: 0.25 });
    s.source = 'preset'; s.params = { n: p.n, stretch: p.stretch, roll: p.roll };
    s.loud = inferLoud(s) || undefined;
    return s;
  }

  const PRESETS = [
    synth('string', 'String', 'strings', harm(12, 0.88), { attack: 0.03, decay: 0.4, sustain: 0.85, release: 0.35 }),
    synth('sine', 'Sine', 'pure', [[1, 1]], { attack: 0.01, sustain: 1, release: 0.2 }),
    synth('clarinet', 'Clarinet', 'winds', [[1, 1], [2, 0.08], [3, 0.55], [4, 0.06], [5, 0.33], [6, 0.05], [7, 0.2], [9, 0.12], [11, 0.06]],
      { attack: 0.04, decay: 0.2, sustain: 0.9, release: 0.15 }),
    synth('bell', 'Bell', 'bells', [[0.5, 0.35], [1, 1], [1.183, 0.55], [1.506, 0.4], [2, 0.5], [2.514, 0.22], [2.662, 0.2], [3.011, 0.15], [4.166, 0.1], [5.433, 0.06]],
      { attack: 0.002, decay: 2.6, sustain: 0, release: 0.8 }),
    synth('organ', 'Organ', 'keys', [[1, 1], [2, 0.8], [3, 0.5], [4, 0.5], [6, 0.3], [8, 0.35], [10, 0.12], [12, 0.1]],
      { attack: 0.015, decay: 0.05, sustain: 1, release: 0.08 }),
    synth('pluck', 'Pluck', 'plucked', harm(10, 0.72), { attack: 0.003, decay: 0.9, sustain: 0, release: 0.15 }),
    synth('glass', 'Glass', 'bells', [[1, 1], [2.32, 0.42], [4.25, 0.25], [6.63, 0.12]], { attack: 0.06, decay: 1.5, sustain: 0.35, release: 0.9 }),
    synth('pad', 'Pad', 'pads', harm(8, 0.68), { attack: 0.6, decay: 0.8, sustain: 0.85, release: 1.2, noise: 0.04 }),
  ];
  // Loudness match of the presets (see "loudness" below; measured at C4 with test/loudness, keep in sync with the presets).
  const PRESET_LOUD = { string: 0.573, sine: 0.179, clarinet: 0.385, bell: 1.093, organ: 0.403, pluck: 1.675, glass: 0.429, pad: 0.54 };
  PRESETS.forEach((s) => { s.loud = PRESET_LOUD[s.id]; });

  // ---------- play style: 'glide' (sustained, legato lines) | 'hit' (struck / plucked / percussive) ----------
  const HIT = new Set(['keys', 'piano', 'plucked', 'pluck', 'harp', 'pizz', 'pizzicato', 'guitar', 'lute', 'mallets', 'mallet',
    'marimba', 'xylophone', 'glockenspiel', 'bells', 'bell', 'celesta', 'kalimba', 'percussion', 'perc', 'drums', 'drum',
    'kick', 'tom', 'snare', 'metal', 'stutter', 'laser', 'zap', 'chirp']);
  const GLIDE = new Set(['strings', 'organ', 'woodwind', 'winds', 'wind', 'flute', 'brass', 'tremolo', 'choir', 'vowel', 'voice',
    'pads', 'pad', 'drone', 'breath', 'buzz', 'mush', 'chord', 'pure', 'custom', 'synth']);
  // Explicit sound.play wins; otherwise derive it from the family (then from the envelope for synths).
  function playOf(s) {
    if (!s) return 'glide';
    if (s.play === 'glide' || s.play === 'hit') return s.play;
    const fam = String(s.family || '').toLowerCase();
    if (HIT.has(fam)) return 'hit';
    if (isV2(s) && VH.synth) return VH.synth.playOf(s.synth);   // v2 synths: from the amp envelope
    if (GLIDE.has(fam)) return 'glide';
    if (s.kind === 'synth') return s.synth && s.synth.sustain === 0 ? 'hit' : 'glide';
    return 'hit';
  }

  // ---------- tone filter: { bright: -1..1 } = a lowshelf + highshelf tilt ----------
  // Shared by the audio engine (real BiquadFilterNodes) and spectrumOf (their exact magnitude response).
  const clamp1 = (v) => Math.max(-1, Math.min(1, +v || 0));
  // The effective tone of a sound: its own stored tone (derived sounds) plus an extra tone on top.
  function toneOf(sound, tone) {
    return { bright: clamp1(((sound && sound.tone && sound.tone.bright) || 0) + ((tone && tone.bright) || 0)) };
  }
  // The BiquadFilterNode settings for a tone ([] when neutral).
  function toneBands(tone) {
    const b = clamp1(tone && tone.bright);
    if (Math.abs(b) < 1e-3) return [];
    return [{ type: 'lowshelf', freq: 250, gain: -6 * b }, { type: 'highshelf', freq: 2500, gain: 12 * b }];
  }
  // Biquad coefficients (Audio EQ Cookbook; shelves with S = 1, as in the Web Audio spec), normalised to a0 = 1.
  function biquad(type, f0, gainDb, sr, Q) {
    const A = 10 ** (gainDb / 40), w0 = 2 * Math.PI * f0 / sr, c = Math.cos(w0);
    const sA = 2 * Math.sqrt(A) * Math.sin(w0) / 2 * Math.SQRT2;
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * c + sA); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sA);
      a0 = (A + 1) + (A - 1) * c + sA; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sA;
    } else if (type === 'highshelf') {
      b0 = A * ((A + 1) + (A - 1) * c + sA); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sA);
      a0 = (A + 1) - (A - 1) * c + sA; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sA;
    } else {   // highpass
      const al = Math.sin(w0) / (2 * (Q || Math.SQRT1_2));
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function biquadMag(q, hz, sr) {
    const w = 2 * Math.PI * hz / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = q.b0 + q.b1 * c1 + q.b2 * c2, ni = -(q.b1 * s1 + q.b2 * s2), dr = 1 + q.a1 * c1 + q.a2 * c2, di = -(q.a1 * s1 + q.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  // |H(f)| of one Web Audio shelf biquad.
  const shelfMag = (type, f0, gainDb, hz, sr) => biquadMag(biquad(type, f0, gainDb, sr), hz, sr);
  // Linear gain of the tone filter at hz.
  function toneResponse(tone, hz, sr = 48000) {
    if (!(hz > 0) || hz >= sr / 2) return 1;
    return toneBands(tone).reduce((g, b) => g * shelfMag(b.type, b.freq, b.gain, hz, sr), 1);
  }

  // ---------- loudness ----------
  // Every sound carries `loud`: the gain that brings it to a common perceived level (LOUD_REF_DB K-weighted RMS for a
  // voice at gain 1, at its comfortable pitch, held 1.5 s, judged over the first second). The engine multiplies every
  // voice by it (VH.audio voice/trigger). Built-ins: measured offline with measure(), stored in the manifests and
  // PRESET_LOUD below. User sounds: measured when saved (Babel), else lazily on first use (ensureLoud).
  // K-weighting here is approximate: a 60 Hz high-pass + a +4 dB high shelf at 1.5 kHz.
  const LOUD_REF_DB = -18;
  const kFilters = (sr) => [biquad('highpass', 60, 0, sr, Math.SQRT1_2), biquad('highshelf', 1500, 4, sr)];
  function runBiquad(x, q) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = q.b0 * x[i] + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  const kWeight = (x, sr) => kFilters(sr).reduce((y, q) => runBiquad(y, q), x);
  // |K(f)|: the K-weighting magnitude at hz.
  const kMag = (hz, sr = 48000) => (hz > 0 && hz < sr / 2 ? kFilters(sr).reduce((g, q) => g * biquadMag(q, hz, sr), 1) : 0);
  // K-weighted RMS (linear) of mono samples x over [t0, t1) seconds (filtered from the start, so state is warm).
  function kRms(x, sr, t0 = 0, t1 = Infinity) {
    const y = kWeight(x, sr), a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(y.length, Math.floor(t1 * sr));
    let s = 0;
    for (let i = a; i < b; i++) s += y[i] * y[i];
    return b > a ? Math.sqrt(s / (b - a)) : 0;
  }
  const toDb = (v) => 20 * Math.log10(Math.max(1e-9, Math.abs(v)));
  const fromDb = (db) => 10 ** (db / 20);
  const clampLoud = (g) => Math.round(Math.max(0.1, Math.min(10, g)) * 1000) / 1000;
  // The gain that brings a sound measured at krDb (K-RMS dBFS at gain 1) to LOUD_REF_DB.
  const loudFor = (krDb) => (isFinite(krDb) ? clampLoud(fromDb(LOUD_REF_DB - krDb)) : 1);
  const loudOf = (s) => (s && s.loud > 0 && isFinite(s.loud) ? s.loud : 1);
  // Steady-state K-weighted power of an additive synth at f0 (partial amps are normalised by their sum, as in the engine).
  function partialPower(parts, f0 = 262, sr = 48000) {
    const sum = (parts || []).reduce((a, p) => a + p[1], 0) || 1;
    return (parts || []).reduce((a, [r, amp]) => a + ((amp / sum) ** 2 / 2) * kMag(r * f0, sr) ** 2, 0);
  }
  // loud for a synth whose partials changed from `from` to `to` (equal K-weighted power), within 0.1..10.
  function loudScaled(loud, from, to) {
    const p0 = partialPower(from), p1 = partialPower(to);
    return clampLoud((loud || 1) * (p0 > 0 && p1 > 0 ? Math.sqrt(p0 / p1) : 1));
  }
  // The pitch a sound is measured at: C4, kept inside a sampler's recorded range.
  function comfortMidi(s) {
    const zs = (s && s.sampler && s.sampler.zones) || [];
    if (!zs.length) return 60;
    const r = zs.map((z) => z.rootMidi);
    return Math.max(Math.min(...r), Math.min(Math.max(...r), 60));
  }
  // Render a sound offline through the real engine and measure it: -> Promise<{ db, loud, midi }> (null if impossible).
  function measure(s) {
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!s || !OAC || !VH.audio || !VH.audio.withContext) return Promise.resolve(null);
    const sr = 44100, midi = comfortMidi(s), zs = (s.sampler && s.sampler.zones) || [];
    return Promise.all(zs.map((z) => VH.audio.load(z).catch(() => null))).then(() => {
      const c = new OAC(1, Math.ceil(sr * 1.05), sr), g = c.createGain();
      g.connect(c.destination);
      VH.audio.withContext(c, () => {
        const v = VH.audio.voice(s, 440 * 2 ** ((midi - 69) / 12), { gain: 1, dest: g, when: 0, loud: false });
        v.stop(undefined, 1.5);
      });
      return c.startRendering();
    }).then((buf) => {
      const db = toDb(kRms(buf.getChannelData(0), sr, 0, 1));
      return { db, loud: loudFor(db), midi };
    });
  }
  // loud known without rendering: built-ins have it; derived sounds take their base's (synths rescaled to the new
  // partials); the Custom synth takes String's (its default partials) rescaled the same way. Else null.
  function inferLoud(s) {
    if (!s) return null;
    if (s.loud > 0) return s.loud;
    const base = s.derivedFrom ? get(s.derivedFrom) : s.params && s.kind === 'synth' ? PRESETS[0] : null;
    if (!base || base === s || !(base.loud > 0)) return null;
    if (s.kind === 'synth' && base.kind === 'synth') return loudScaled(base.loud, base.synth.partials, s.synth.partials);
    return base.loud;
  }
  // Give a user sound its loud (inferred, else measured once in the background) and store it. Built-ins are untouched.
  const pendingLoud = new Set();
  function ensureLoud(s) {
    if (!s || s.loud > 0 || !s.id || pendingLoud.has(s.id)) return;
    const u = user.find((x) => x.id === s.id);
    if (!u) return;
    const inf = inferLoud(u);
    if (inf) { u.loud = s.loud = inf; persist(); return; }
    pendingLoud.add(s.id);
    measure(u).then((r) => {
      if (r && !(u.loud > 0)) { u.loud = s.loud = r.loud; if (user.includes(u)) persist(); }
    }).catch(() => {});   // one attempt per session (pendingLoud keeps the id)
  }

  // ---------- state ----------
  let samples = [];                    // sampler presets from the manifest
  let user = (VH.store ? VH.store.get('sounds', []) : []).filter(valid);
  user.forEach((s) => { if (!s.play) s.play = playOf(s); });
  const persist = () => { if (VH.store) VH.store.set('sounds', user); };
  const subs = new Set();
  const status = { samples: 'loading', note: '' };

  function valid(s) {
    return s && typeof s.id === 'string' && (s.kind === 'synth' ? s.synth && (Array.isArray(s.synth.partials) || (s.synth.v === 2 && Array.isArray(s.synth.oscs)))
      : s.kind === 'sampler' ? s.sampler && Array.isArray(s.sampler.zones) : false);
  }
  const emit = () => subs.forEach((cb) => { try { cb(); } catch (e) { setTimeout(() => { throw e; }); } });
  const all = () => {
    const ids = new Set(user.map((s) => s.id));   // a saved sound may override a built-in id (e.g. 'custom')
    return PRESETS.filter((s) => !ids.has(s.id)).concat(samples.filter((s) => !ids.has(s.id)), user);
  };

  function list() { return all(); }
  function get(id) { return all().find((s) => s.id === id) || null; }
  function save(sound) {
    const s = Object.assign({}, sound);
    if (!s.id) s.id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    s.source = s.source || 'import';
    if (isV2(s) && VH.synth) {   // v2: normalised model + compat fields; spectrum and play come from the settings
      s.synth = VH.synth.toSynth(s.synth);
      s.spectrum = s.synth.partials.map((p) => p.slice());
      s.play = VH.synth.playOf(s.synth);
    }
    s.spectrum = normSpectrum(s.spectrum) || (s.kind === 'synth' ? normSpectrum(s.synth.partials) : null);
    if (!valid(s)) throw new Error('invalid sound');
    if (!s.play) s.play = playOf(s);
    if (!(s.loud > 0)) s.loud = inferLoud(s) || undefined;
    user = user.filter((u) => u.id !== s.id).concat(s);
    persist();
    emit();
    return s;
  }
  function remove(id) {
    const before = user.length;
    user = user.filter((u) => u.id !== id);
    if (user.length !== before) { persist(); emit(); }
  }
  function onChange(cb) { subs.add(cb); return () => subs.delete(cb); }

  // The spectrum to use for harmony math (never null). With a tone (the sound's own stored tone plus the
  // optional `tone` argument), each partial is scaled by the tone filter's magnitude at ratio * 262 Hz
  // (a nominal C4 root) and the result is renormalised to max 1. Neutral tone -> the stored spectrum, unchanged.
  const NOMINAL_ROOT = 262;
  // v2 synths: the analytic spectrum of their settings (VH.synth.spectrum), cached per synth object.
  const v2Spec = new WeakMap();
  function v2Spectrum(s) {
    if (!v2Spec.has(s.synth)) v2Spec.set(s.synth, VH.synth.spectrum(VH.synth.normalize(s.synth)));
    return v2Spec.get(s.synth);
  }
  function spectrumOf(s, tone) {
    const sp = isV2(s) && VH.synth ? v2Spectrum(s) : s && s.spectrum && s.spectrum.length ? s.spectrum : DEFAULT_SPECTRUM, t = toneOf(s, tone);
    if (!toneBands(t).length) return sp;
    return normSpectrum(sp.map(([r, a]) => [r, a * toneResponse(t, r * NOMINAL_ROOT)])) || sp;
  }

  // derive(baseId, { partials?, stretch?, roll?, tone? }) -> a saved user sound "<base> (custom)", source 'custom'.
  // Synths: `partials` replace the base partials; otherwise stretch (ratio r -> r^stretch) and roll
  // (amp *= roll^(r-1), like the Custom sliders) are applied to the ORIGINAL base partials.
  // Samplers only take `tone`. Deriving from a derived sound edits that same sound (stable id '<base>-custom').
  // The stored `spectrum` stays untoned; `tone` is kept on the sound and applied by the engine and spectrumOf.
  function derive(baseId, opts) {
    const o = opts || {}, b0 = get(baseId);
    if (!b0) throw new Error('unknown sound ' + baseId);
    const base = (b0.derivedFrom && get(b0.derivedFrom)) || b0;
    const out = {
      id: base.id + '-custom', name: String(base.name || base.id).replace(/ \(custom\)$/, '') + ' (custom)', family: base.family,
      play: playOf(base), source: 'custom', kind: base.kind, derivedFrom: base.id,   // loud: inferred in save()
      tone: { bright: clamp1(o.tone ? o.tone.bright : (b0.tone && b0.tone.bright) || 0) },
    };
    if (base.private) out.private = true;
    if (base.kind === 'synth') {
      const st = o.stretch ?? 1, roll = o.roll ?? 1, own = Array.isArray(o.partials) && o.partials.length > 0;
      const parts = own ? o.partials.map((p) => [+p[0], +p[1]])
        : base.synth.partials.map(([r, a]) => [r ** st, a * roll ** (r - 1)]);
      const bs = isV2(base)   // a v2 base becomes a plain additive synth with its amp envelope
        ? { attack: base.synth.ampEnv.a, decay: base.synth.ampEnv.d, sustain: base.synth.ampEnv.s, release: base.synth.ampEnv.r, glide: 0, noise: 0, wobble: 0 }
        : base.synth;
      out.synth = Object.assign({}, bs, { partials: parts });
      out.spectrum = normSpectrum(parts);
      out.derive = { stretch: st, roll, partials: own };
    } else {
      out.sampler = { zones: base.sampler.zones.map((z) => Object.assign({}, z)), release: base.sampler.release };
      out.spectrum = base.spectrum ? base.spectrum.map((p) => p.slice()) : null;
      if (base.rootHz) out.rootHz = base.rootHz;
    }
    return save(out);
  }

  // Decode a sampler's zones; if it has no spectrum yet, analyze its middle zone. Resolves to the sound.
  function prepare(id) {
    const s = get(id);
    if (!s || s.kind !== 'sampler') return Promise.resolve(s);
    const zs = s.sampler.zones.slice().sort((a, b) => a.rootMidi - b.rootMidi), mid = zs[Math.floor(zs.length / 2)];
    return Promise.all(zs.map((z) => VH.audio.load(z).catch(() => null))).then((bufs) => {
      const buf = bufs[zs.indexOf(mid)];
      ensureLoud(s);
      if (!s.spectrum && buf && VH.analyze) {
        const r = VH.analyze.fromBuffer(buf);
        if (r.rootHz > 0) { s.spectrum = normSpectrum(r.spectrum); emit(); }
      }
      return s;
    });
  }

  // ---------- manifest ----------
  function fromManifest(inst, priv) {
    const zones = (inst.zones || []).filter((z) => z && (z.url || z.blobKey) && isFinite(z.rootMidi));
    if (!inst.id || !zones.length) return null;
    return {
      private: priv || undefined,
      id: inst.id, name: inst.name || inst.id, family: inst.family || 'samples', source: 'sample', kind: 'sampler',
      play: playOf({ play: inst.play, family: inst.family, kind: 'sampler' }),
      sampler: { zones, release: inst.release ?? 0.3 }, spectrum: normSpectrum(inst.spectrum),
      loud: inst.loud > 0 && isFinite(inst.loud) ? inst.loud : undefined,
      quality: inst.quality, notes: inst.notes,
    };
  }
  const load = (m) => fetch(m.url, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j && Array.isArray(j.instruments) ? j.instruments.map((i) => fromManifest(i, m.private)).filter(Boolean) : null))
    .catch(() => null);
  const ready = new Promise((resolve) => {
    const done = (state, note) => { status.samples = state; status.note = note || ''; emit(); resolve(); };
    if (!root.location || root.location.protocol === 'file:' || typeof fetch !== 'function') {
      done('file', 'Sampled instruments need a local web server (python -m http.server).');
      return;
    }
    Promise.all(MANIFESTS.map(load)).then((sets) => {
      const seen = new Set();
      samples = [];
      for (const set of sets) for (const s of set || []) {
        if (seen.has(s.id)) s.id = 'local-' + s.id;   // keep ids unique across the two libraries
        seen.add(s.id); samples.push(s);
      }
      if (!samples.length) done('missing', 'No sample library found.');
      else done('ok');
    });
  });


  // ---------- fallback for a missing sound (share links with imported sounds) ----------
  // A spectrum as a 17-slot vector: harmonics 1..16 (within 3 %) + one slot for everything inharmonic.
  function spectrumVec(sp) {
    const v = new Float64Array(17);
    for (const [r, a] of sp || []) { const k = Math.round(r); if (k >= 1 && k <= 16 && Math.abs(r / k - 1) < 0.03) v[k - 1] += a; else v[16] += a; }
    return v;
  }
  // Cosine similarity of two spectra (0..1).
  function spectralSim(a, b) {
    const x = spectrumVec(a), y = spectrumVec(b);
    let d = 0, nx = 0, ny = 0;
    for (let i = 0; i < 17; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
    return nx > 0 && ny > 0 ? d / Math.sqrt(nx * ny) : 0;
  }
  // The built-in sound closest to info = { play, spectrum } (same play type first, then spectral similarity).
  // cands: defaults to the public built-ins (synth presets + CC0 samples). Never null while presets exist.
  function closest(info, cands) {
    const i = info || {}, play = i.play === 'hit' ? 'hit' : 'glide', sp = i.spectrum && i.spectrum.length ? i.spectrum : DEFAULT_SPECTRUM;
    const pool = cands || all().filter((s) => !s.private && ((s.source === 'preset' && s.id !== 'custom') || s.source === 'sample'));
    let best = null, bv = -Infinity;
    for (const s of pool) {
      const v = (playOf(s) === play ? 1 : 0) + spectralSim(sp, s.spectrum || (s.synth && s.synth.partials) || DEFAULT_SPECTRUM);
      if (v > bv) { bv = v; best = s; }
    }
    return best || PRESETS[0];
  }

  // Share links: the exact definition of a v2 synth (VH.synth.portable / fromPortable).
  const portable = (s) => (VH.synth ? VH.synth.portable(s) : null);
  const fromPortable = (d) => (VH.synth ? VH.synth.fromPortable(d) : null);

  VH.sounds = { portable, fromPortable, isV2, spectrumVec, spectralSim, closest, list, get, save, remove, onChange, ready, prepare, spectrumOf, custom, normSpectrum, status, DEFAULT_SPECTRUM,
    derive, playOf, toneOf, toneBands, toneResponse, fromManifest, NOMINAL_ROOT,
    LOUD_REF_DB, kWeight, kRms, kMag, toDb, fromDb, loudFor, loudOf, partialPower, loudScaled, comfortMidi, measure, inferLoud, ensureLoud };
  if (typeof module !== 'undefined' && module.exports) module.exports = VH.sounds;
})(this);
