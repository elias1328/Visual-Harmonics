// melody/engine.js - playback. Frame-driven (rAF) transport; every layer plays into its own GainNode bus:
//   layer buses + backing bus -> sum -> [insert chain, e.g. FX] -> master -> VH.audio.out
// Line mode: 'glide' sounds glide legato on one voice; 'hit' sounds re-trigger only when the line crosses a semitone,
// at most once per MIN_GAP ms of audio-clock time. Notes are scheduled LOOKAHEAD s ahead on the audio clock (opts.when), so parts can move
// them earlier or later through M.hooks.voiceOpts. Every play tick the engine asks M.hooks.pitchMod for a cents offset
// of each of its own voices (vibrato, magnet...). The backing (drone) plays the chord per bar with its own instrument.
// The buses belong to the LIVE AudioContext only; offline renders get their own through layerBusFor(ctx, i).
// See MELODY.md (M.engine, Hooks).
(function () {
  'use strict';
  const VH = window.VH, H = VH.harmony, NS = VH.melody, md = NS.model;
  const { LPB, SPB, chordMidis, layerGain, GAIN } = md;
  const MIN_GAP = 70;            // ms between re-triggers of a hit sound on a line
  const LOOKAHEAD = 0.08;        // s: notes are scheduled this far ahead (>= 30 ms, so humanize can move them earlier)
  const G_LINE = GAIN.LINE, G_NOTE = GAIN.NOTE, G_BACK = GAIN.BACK, G_PREVIEW = GAIN.PREVIEW_CHORD, G_PNOTE = GAIN.PREVIEW_NOTE;
  const LiveAC = window.AudioContext || window.webkitAudioContext;

  NS.Engine = function (M) {
    const E = { playing: false, phase: 0, MIN_GAP, LOOKAHEAD };
    let prevPos = 0, ahead = 0, backingBar = -1, buses = null, insert = null, backingImpl = null, live = null;
    // lineV[L] = Map(stroke id -> { v, base, m, semi, cents }): one voice per line stroke (strokes may overlap);
    // lastHit[L] = Map(stroke id -> audio ms of the last re-trigger) for 'hit' sounds.
    let lineV = [], noteV = [], lastHit = [], droneV = [];
    const offBuses = new WeakMap();   // offline context -> its own bus set (layerBusFor)
    // Does the core honour opts.dest? (A2's core API adds withContext with it.) If not, mix with per-voice gain.
    const routed = () => typeof VH.audio.withContext === 'function';
    const S = () => M.song;
    E.playOf = (s) => VH.ui.playOf(s);
    E.secPer16 = () => md.secPer16(S());
    E.secPerBar = () => md.secPerBar(S());
    Object.defineProperty(E, 'pos16', { get: () => E.phase * S().bars * SPB });
    Object.defineProperty(E, 'bar', { get: () => Math.min(S().bars - 1, Math.floor(E.phase * S().bars)) });
    // The live AudioContext, never an OfflineAudioContext (VH.audio.ctx returns the bound one inside withContext).
    function liveCtx() {
      const c = VH.audio.ctx;
      if (c && c !== live && (!LiveAC || c instanceof LiveAC)) live = c;
      return live;
    }
    Object.defineProperty(E, 'ctx', { get: liveCtx });

    // ---------- buses (live context only) ----------
    function connectSum() {
      const b = buses;
      try { b.sum.disconnect(); } catch (_) { /* ignore */ }
      if (insert && insert.input && insert.output) {
        b.sum.connect(insert.input);
        try { insert.output.disconnect(); } catch (_) { /* ignore */ }
        insert.output.connect(b.master);
      } else b.sum.connect(b.master);
    }
    function makeBuses(c, out) {
      const master = c.createGain(), sum = c.createGain(), backing = c.createGain();
      master.connect(out); backing.connect(sum);
      return { ctx: c, master, sum, backing, layers: [] };
    }
    function ensureBuses() {
      const actx = liveCtx();
      if (!actx) return null;
      if (!buses || buses.ctx !== actx) {
        if (VH.audio.ctx !== actx) return null;   // inside withContext before the live buses exist: never build them there
        if (!VH.audio.out) return null;
        buses = makeBuses(actx, VH.audio.out);
        connectSum();
      }
      while (buses.layers.length < S().layers.length) { const g = actx.createGain(); g.gain.value = 0; g.connect(buses.sum); buses.layers.push(g); }
      applyMix(true);
      return buses;
    }
    E.layerBus = (i) => { const b = ensureBuses(); return b ? b.layers[i] || null : null; };
    E.backingBus = () => { const b = ensureBuses(); return b ? b.backing : null; };
    E.sumBus = () => { const b = ensureBuses(); return b ? b.sum : null; };
    E.masterBus = () => { const b = ensureBuses(); return b ? b.master : null; };
    // Bus set for any context: the live buses for the live context, else a separate set (built once per context,
    // gains from the song mix, master -> that context's VH.audio output). For offline rendering.
    E.busesFor = function (c) {
      if (!c) return null;
      if (c === liveCtx()) return ensureBuses();
      let b = offBuses.get(c);
      if (!b) {
        b = VH.audio.withContext(c, (cc, out) => makeBuses(cc, out));
        b.sum.connect(b.master);
        offBuses.set(c, b);
      }
      const s = S();
      while (b.layers.length < s.layers.length) { const g = c.createGain(); g.connect(b.sum); b.layers.push(g); }
      b.layers.forEach((g, L) => { g.gain.value = L < s.layers.length ? layerGain(s, L) : 0; });
      b.backing.gain.value = E.backingGain(); b.master.gain.value = s.master;
      return b;
    };
    E.layerBusFor = (c, i) => { const b = E.busesFor(c); return b ? b.layers[i] || null : null; };
    E.setInsert = (chain) => { insert = chain || null; if (buses) connectSum(); };
    E.gainOf = (L) => layerGain(S(), L);
    E.backingGain = () => (S().backing.on ? S().backing.vol : 0);
    function setParam(p, v, now) { if (now) { p.cancelScheduledValues(0); p.value = v; } else p.setTargetAtTime(v, buses.ctx.currentTime, 0.015); }
    // Push vol / mute / solo / backing / master to the buses (and to live voices when the core can't route).
    function applyMix(now) {
      const s = S();
      if (buses) {
        buses.layers.forEach((g, L) => setParam(g.gain, L < s.layers.length ? layerGain(s, L) : 0, now));
        setParam(buses.backing.gain, E.backingGain(), now);
        setParam(buses.master.gain, s.master, now);
      }
      if (!routed()) {
        lineV.forEach((mp, L) => { if (mp) mp.forEach((x) => x.v.setGain(gainFor(L, x.base))); });
        noteV.forEach((x) => x.v.setGain(gainFor(x.L, x.base)));
        droneV.forEach((x) => x.v.setGain(backGain(x.base)));
      }
    }
    E.applyMix = () => applyMix(false);
    const gainFor = (L, base) => (routed() ? base : base * layerGain(S(), L) * S().master);
    const backGain = (base) => (routed() ? base : base * E.backingGain() * S().master);

    // ---------- hooks ----------
    // opts { midi, gain, when } through M.hooks.voiceOpts (may change all three); returns the final opts.
    function hookOpts(L, kind, midi, o) {
      o.midi = midi;
      const f = M.hooks && M.hooks.voiceOpts;
      if (typeof f !== 'function') return o;
      try { const r = f(L, kind, midi, o); return r && typeof r === 'object' ? r : o; } catch (err) { console.error('[melody] voiceOpts hook', err); return o; }
    }
    function pitchMod(L, kind, t, ref) {
      const f = M.hooks && M.hooks.pitchMod;
      if (typeof f !== 'function') return 0;
      try { const c = +f(L, kind, t, ref); return isFinite(c) ? c : 0; } catch (err) { console.error('[melody] pitchMod hook', err); return 0; }
    }
    // Start a layer voice ('note' | 'line'); base = the engine's gain before hooks.
    function play(L, kind, sound, midi, base, when, ref, t) {
      const bus = E.layerBus(L), o = hookOpts(L, kind, midi, { gain: base, when });
      const cents = t ? pitchMod(L, kind, t, ref) : 0;
      const v = VH.audio.voice(sound, H.midiToHz(o.midi + cents / 100), { gain: gainFor(L, o.gain), dest: bus || undefined, when: o.when });
      return { v, o, cents };
    }
    E.layerRemoved = (i) => {   // drop a layer's bus + voices (indices shift down); called by M.removeLayer
      stopLine(i, 0.04);
      lineV.splice(i, 1); lastHit.splice(i, 1);
      noteV = noteV.filter((x) => { if (x.L === i) { cut(x, 0.05); return false; } if (x.L > i) x.L--; return true; });
      if (buses && buses.layers[i]) { try { buses.layers[i].disconnect(); } catch (_) { /* ignore */ } buses.layers.splice(i, 1); }
      applyMix(false);
    };

    // ---------- voices ----------
    function stopLine(L, rel) { const mp = lineV[L]; if (mp) { mp.forEach((x) => x.v.stop(rel)); lineV[L] = null; } }
    E.lineVoices = () => lineV.reduce((a, mp) => a + (mp ? mp.size : 0), 0);   // live line voices (tests)
    function cut(x, rel) {   // stop a scheduled note; one that has not started yet is silenced first, so it never blips
      const c = x.v.ctx;
      if (c && x.t0 > c.currentTime + 0.002) x.v.setGain(0);
      x.v.stop(rel);
    }
    function stopNotes(rel) { noteV.forEach((x) => cut(x, rel)); noteV = []; }
    const drone = {   // default backing: hold the bar's chord on the backing instrument
      onBar(b, midis) {
        drone.stop(0.12);
        if (!midis || !S().backing.on) return;
        const snd = M.backingSound(), bus = E.backingBus();
        droneV = midis.map((m) => {
          const o = hookOpts(-1, 'backing', m, { gain: G_BACK });
          return { base: o.gain, m: o.midi, cents: 0, v: VH.audio.voice(snd, H.midiToHz(o.midi), { gain: backGain(o.gain), dest: bus || undefined, when: o.when }) };
        });
      },
      stop(rel) { droneV.forEach((x) => x.v.stop(rel)); droneV = []; },
    };
    const backing = () => backingImpl || drone;
    E.setBacking = (impl) => { backing().stop(0.08); backingImpl = impl || null; backingBar = -1; };
    E.restartBacking = () => { backing().stop(0.1); backingBar = -1; };
    E.stopAll = function () {
      S().layers.forEach((_, L) => stopLine(L, 0.04)); lineV = [];
      try { backing().stop(0.08); } catch (err) { console.error('[melody] backing stop', err); }
      stopNotes(0.05); backingBar = -1;
    };
    E.stopLayer = (L) => stopLine(L, 0.05);

    // Gesture-only previews.
    E.previewChord = function (b) {
      const ch = S().chords[b];
      if (!ch || !VH.audio.ensure()) return;
      const snd = M.backingSound(), bus = E.masterBus();
      const nw = performance.now(); chordMidis(ch).forEach((m) => E.previews.push({ L: -1, m, until: nw + 600 }));
      M.requestRender();
      chordMidis(ch).forEach((m) => VH.audio.trigger(snd, H.midiToHz(m), 0.6, { gain: G_PREVIEW * (routed() ? 1 : S().master), dest: bus || undefined }));
    };
    E.previews = [];   // keys lit by gesture previews (view.js piano): { L (-1 = chord), m, until (performance.now ms) }
    E.previewNote = function (L, m, dur) {
      if (!VH.audio.ensure()) return;
      const nw = performance.now(); E.previews = E.previews.filter((p) => p.until > nw - 300);
      E.previews.push({ L, m, until: nw + (dur || 0.3) * 1000 }); M.requestRender();
      const snd = M.soundOf(L), bus = E.layerBus(L);
      VH.audio.trigger(snd, H.midiToHz(m), dur || 0.3, { gain: routed() ? G_PNOTE : G_PNOTE * S().master, dest: bus || undefined });
    };

    // ---------- transport ----------
    // Position: E.phase (0..1 of the song). cont = continuous play time in sixteenths since Play (never jumps: loops and
    // seeks don't reset it), so look-ahead schedulers can map "cont" to song positions with E.segments(). A loop region
    // (song.loopRegion = [a, b) bars) loops only those bars; without one the whole song loops when song.loop is on.
    let cont = 0, seekId = 0, seekCont = 0;
    E.cue = null;   // start position (sixteenths) for the next Play, set by a seek while stopped; null = region start or 0
    function range() {
      const s = S(), tot = s.bars * SPB, r = md.regionOf(s);
      return r ? [r[0] * SPB, r[1] * SPB, true, tot] : [0, tot, false, tot];
    }
    E.loopRange = () => { const [a, b, on] = range(); return { a16: a, b16: b, on }; };
    Object.defineProperty(E, 'cont16', { get: () => cont });
    Object.defineProperty(E, 'seekId', { get: () => seekId });
    // Song segments that continuous time [c0, c1) will play, from the current position and loop rules (assuming no
    // seek): [{ c, s, n }] = cont start, song start (sixteenths), length. Used by look-ahead schedulers.
    E.segments = function (c0, c1) {
      const s = S(), [a, b, reg, tot] = range(), out = [];
      let c = cont, p = E.pos16;
      // c0 may lie up to a frame in the past (events queued at a seek / Play): walk back within the current run
      const back = Math.min(cont - c0, 4), floor = reg && p >= a && p < b ? a : 0;
      if (back > 0 && p - back >= floor) { c -= back; p -= back; }
      for (let k = 0; k < 64 && c < c1; k++) {
        const end = reg && p < b ? b : tot, cEnd = c + Math.max(0, end - p);
        const lo = Math.max(c, c0), hi = Math.min(cEnd, c1);
        if (hi > lo) out.push({ c: lo, s: p + (lo - c), n: hi - lo });
        if (!reg && !s.loop) break;
        c = cEnd; p = reg ? a : 0;
      }
      return out;
    };
    E.play = function () {
      VH.audio.ensure(); ensureBuses();
      const [a, , reg, tot] = range(), st = E.cue != null ? Math.max(0, Math.min(tot - 1e-6, E.cue)) : reg ? a : 0;
      E.phase = st / tot; prevPos = st; cont = 0; seekCont = 0; ahead = 0; seekId++; backingBar = -1; E.playing = true;
      M.emit('play');
    };
    E.stop = function () {
      E.stopAll(); E.playing = false;
      M.emit('stop');
    };
    E.toggle = () => (E.playing ? E.stop() : E.play());
    // Jump to sixteenth t16. Playing: playback continues from there (notes scheduled for the old position are cut).
    // Stopped: sets the cue, so the next Play starts there.
    E.seek = (t16) => {
      const tot = S().bars * SPB;
      t16 = Math.max(0, Math.min(tot - 1e-6, +t16 || 0));
      if (!E.playing) { E.cue = t16; E.phase = t16 / tot; M.emit('seek', t16); M.requestRender(); return; }
      E.phase = t16 / tot; prevPos = E.pos16; ahead = cont; seekCont = cont; backingBar = -1; seekId++;
      const c = liveCtx();   // notes scheduled ahead for the old position must not play
      if (c) noteV = noteV.filter((x) => { if (x.t0 > c.currentTime + 0.002) { cut(x, 0.01); return false; } return true; });
      M.emit('seek', t16);
    };
    E.step = function (now, dt) {   // called once per animation frame
      if (!E.playing) return;
      const s = S(), [a, b, reg, tot] = range(), adv = dt / md.secPer16(s);
      let pos = E.phase * tot + adv;
      cont += adv;
      if (reg && prevPos < b && pos >= b) pos = a + (pos - b);   // loop the region
      else if (pos >= tot) {
        if (s.loop || reg) pos = (reg ? a : 0) + (pos - tot);
        else { E.stop(); E.phase = E.cue != null ? E.cue / tot : 0; return; }
      }
      E.phase = Math.max(0, Math.min(0.999999, pos / tot));
      tick(now);
    };
    // Schedule the notes starting in continuous time [c0, c1) at their audio time.
    function scheduleNotes(s, c0, c1, actx, sec16) {
      const now = actx.currentTime, segs = E.segments(c0, c1);
      if (!segs.length) return;
      s.layers.forEach((l, L) => {
        if (!layerGain(s, L) || !l.notes.length) return;
        const snd = M.soundOf(L);
        for (const g of segs) {
          for (const n of l.notes) {
            if (n.s < g.s || n.s >= g.s + g.n) continue;
            const when = now + (g.c + (n.s - g.s) - cont) * sec16, dur = n.d * sec16;
            const p = play(L, 'note', snd, n.m, G_NOTE, Math.max(now, when), n, null);
            const t0 = Math.max(now, p.o.when != null ? p.o.when : when);
            p.v.stop(undefined, t0 + dur);
            noteV.push({ L, n, v: p.v, base: p.o.gain, m: p.o.midi, cents: 0, t0, t1: t0 + dur });
          }
        }
      });
    }
    function tick(now) {
      const s = S(), tot = s.bars * SPB, pos = E.phase * tot, b = Math.min(s.bars - 1, Math.floor(E.phase * s.bars));
      const i = Math.min(s.bars * LPB - 1, Math.floor(E.phase * s.bars * LPB)), actx = liveCtx(), sec16 = md.secPer16(s);
      const wrapped = pos < prevPos, [ra, rb] = range();
      if (actx) ensureBuses();
      if (actx && b !== backingBar) {
        backingBar = b;
        try { backing().onBar(b, s.chords[b] ? chordMidis(s.chords[b]) : null, { now, ctxTime: actx.currentTime, secPerBar: md.secPerBar(s) }); }
        catch (err) { console.error('[melody] backing', err); }
        M.emit('bar', b);
      }
      const info = { now, pos16: pos, prevPos16: prevPos, wrapped, bar: b, lineIndex: i, phase: E.phase,
        cont16: cont, seekId, seekCont16: seekCont, loopA16: ra, loopB16: rb,
        ctxTime: actx ? actx.currentTime : 0, secPer16: sec16, timeOf: (t16) => (actx ? actx.currentTime + (t16 - pos) * sec16 : 0) };
      if (ahead < cont) ahead = cont;   // fell behind (slow frame): never schedule into the past
      if (actx) {
        const target = cont + LOOKAHEAD / sec16;
        if (target > ahead) { scheduleNotes(s, ahead, target, actx, sec16); ahead = target; }
      }
      prevPos = pos;
      if (actx) {
        const ct = actx.currentTime;
        noteV = noteV.filter((x) => {
          if (ct >= x.t1) return false;
          if (ct < x.t0) return true;
          const c = pitchMod(x.L, 'note', info, x.n);   // vibrato etc. on started notes
          if (c !== x.cents) { x.v.setFreq(H.midiToHz(x.m + c / 100), 0.02); x.cents = c; }
          return true;
        });
        droneV.forEach((x) => {
          const c = pitchMod(-1, 'backing', info, { m: x.m });
          if (c !== x.cents) { x.v.setFreq(H.midiToHz(x.m + c / 100), 0.02); x.cents = c; }
        });
        s.layers.forEach((l, L) => {
          // one voice per stroke: glide sounds play legato within a stroke's run; hit sounds re-trigger per stroke
          const audible = layerGain(s, L) > 0, snd = M.soundOf(L), hit = E.playOf(snd) === 'hit';
          const mp = lineV[L] || (lineV[L] = new Map()), hits = lastHit[L] || (lastHit[L] = new Map()), seen = new Set();
          if (audible) for (const st of md.strokes(l)) {
            const m = st.v[i];
            if (isNaN(m)) continue;
            const k = st.id, x = mp.get(k), ref = { i, m, k };
            seen.add(k);
            if (!hit) {
              if (!x) { const p = play(L, 'line', snd, m, G_LINE, undefined, ref, info); mp.set(k, { v: p.v, base: p.o.gain, m, semi: Math.round(m), cents: p.cents }); }
              else {
                const c = pitchMod(L, 'line', info, ref);
                x.v.setFreq(H.midiToHz(m + c / 100), c || x.cents ? 0.02 : 0.045); x.m = m; x.cents = c;
              }
              continue;
            }
            // the re-trigger gap is measured on the audio clock (when the voices actually start), not on frame time
            const semi = Math.round(m), at = actx.currentTime * 1000, gapOk = !(at - (hits.has(k) ? hits.get(k) : -1e9) < MIN_GAP);
            if ((!x || semi !== x.semi) && gapOk) {
              if (x) x.v.stop(0.12);
              const p = play(L, 'line', snd, m, G_LINE, undefined, ref, info);
              mp.set(k, { v: p.v, base: p.o.gain, m, semi, cents: p.cents });
              hits.set(k, at);
            } else if (x) {
              const c = pitchMod(L, 'line', info, ref);
              x.v.setFreq(H.midiToHz(m + c / 100), c || x.cents ? 0.02 : 0.03); x.m = m; x.cents = c;
            }
          }
          mp.forEach((x, k) => { if (!seen.has(k)) { x.v.stop(hit ? 0.25 : 0.03); mp.delete(k); } });
        });
      }
      M.emit('tick', info);
    }
    E.destroy = function () {
      E.playing = false; E.stopAll();
      if (buses) {
        [buses.master, buses.sum, buses.backing].concat(buses.layers).forEach((g) => { try { g.disconnect(); } catch (_) { /* ignore */ } });
        buses = null;
      }
    };
    return E;
  };
})();
