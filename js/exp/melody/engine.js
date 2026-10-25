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
  const { chordMidis, layerGain, GAIN } = md;
  const MIN_GAP = 70;            // ms between re-triggers of a hit sound on a line
  const LOOKAHEAD = 0.08;        // s: notes are scheduled this far ahead (>= 30 ms, so humanize can move them earlier)
  const BG_AHEAD = 1.5;          // s: extra look-ahead while the page is hidden (no rAF there; timers may fire only once a second)
  const LATE = 0.15;             // s: after a stall, notes at most this late still start (later ones are dropped)
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
    const S = () => M.song;
    E.playOf = (s) => VH.ui.playOf(s);
    E.secPer16 = () => md.secPer16(S());
    E.secPerBar = () => md.secPerBar(S());
    Object.defineProperty(E, 'pos16', { get: () => E.phase * md.tot16(S()) });
    Object.defineProperty(E, 'bar', { get: () => md.barAt(S(), E.pos16) });
    Object.defineProperty(E, 'region', { get: () => md.regionAt(S(), E.pos16) });
    // Playback mode: 'section' loops the current section (and its loop region); 'song' plays the arrangement from the
    // current section on, switching sections at their ends (M.nextPass). E.pass = the arrangement item playing.
    const songMode = () => M.playMode === 'song';
    E.pass = -1;
    // Extra look-ahead (s) for every scheduler (notes, drums, backing styles, automation, track) while the page is hidden.
    Object.defineProperty(E, 'bgAhead', { get: () => (typeof document !== 'undefined' && document.hidden ? BG_AHEAD : 0) });
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
      return { ctx: c, master, sum, backing, layers: [], out };
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
      let added = false;
      while (buses.layers.length < S().layers.length) { const g = actx.createGain(); g.gain.value = 0; g.connect(buses.sum); buses.layers.push(g); added = true; }
      if (added) applyMix(true);   // only new buses jump to their level; mix changes fade (applyMix(false), no clicks)
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
    // Master automation (export.js X.auto): a gain after the master bus, only while a master-volume lane exists.
    // on -> its AudioParam (live context), off -> removes it (null).
    E.autoMaster = function (on) {
      const b = on ? ensureBuses() : buses;
      if (!b) return null;
      if (on && !b.am) { const am = b.ctx.createGain(); try { b.master.disconnect(); } catch (_) { /* ignore */ } b.master.connect(am); am.connect(b.out); b.am = am; }
      else if (!on && b.am) { try { b.master.disconnect(); } catch (_) { /* ignore */ } try { b.am.disconnect(); } catch (_) { /* ignore */ } b.master.connect(b.out); b.am = null; }
      return b.am ? b.am.gain : null;
    };
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
    }
    E.applyMix = () => applyMix(false);

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
      const v = VH.audio.voice(sound, H.midiToHz(o.midi + cents / 100), { gain: o.gain, dest: bus || undefined, when: o.when });
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
          return { base: o.gain, m: o.midi, cents: 0, v: VH.audio.voice(snd, H.midiToHz(o.midi), { gain: o.gain, dest: bus || undefined, when: o.when }) };
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
    E.previewChord = function (b) {   // b = chord region index (== bar while no bar is split)
      const ch = md.regionChord(S(), b);
      if (!ch || !VH.audio.ensure()) return;
      const snd = M.backingSound(), bus = E.masterBus();
      const nw = performance.now(); chordMidis(ch, S()).forEach((m) => E.previews.push({ L: -1, m, until: nw + 600 }));
      M.requestRender();
      chordMidis(ch, S()).forEach((m) => VH.audio.trigger(snd, H.midiToHz(m), 0.6, { gain: G_PREVIEW, dest: bus || undefined }));
    };
    E.previews = [];   // keys lit by gesture previews (view.js piano): { L (-1 = chord), m, until (performance.now ms) }
    E.previewNote = function (L, m, dur) {
      if (!VH.audio.ensure()) return;
      const nw = performance.now(); E.previews = E.previews.filter((p) => p.until > nw - 300);
      E.previews.push({ L, m, until: nw + (dur || 0.3) * 1000 }); M.requestRender();
      const snd = M.soundOf(L), bus = E.layerBus(L);
      VH.audio.trigger(snd, H.midiToHz(m), dur || 0.3, { gain: G_PNOTE, dest: bus || undefined });
    };

    // ---------- transport ----------
    // Position: E.phase (0..1 of the song). cont = continuous play time in sixteenths since Play (never jumps: loops and
    // seeks don't reset it), so look-ahead schedulers can map "cont" to song positions with E.segments(). A loop region
    // (song.loopRegion = [a, b) bars) loops only those bars. Without one, Section mode loops the section shown; Song mode
    // plays the arrangement and starts over at its end when song.loop is on. In Song mode a region loops in the section
    // where Play / a seek / the region itself was set (armK), so passing through other sections' regions never traps it.
    let cont = 0, seekId = 0, seekCont = 0, lastBar = -1, countIn = 0;
    let lastCt = -1, lag = 0, stall = 0;   // audio clock at the last step; audio time not yet followed (s); clock frozen for (s)
    let armK = -1;   // Song mode: the section whose loop region applies
    E.armRegion = () => { armK = S().cur; };
    // ---------- count-in (Settings > Song > Count-in, VH.store 'melody.countIn'): one bar of clicks, accent on beat 1 ----------
    // x/4: a click per quarter; x/8: per eighth (accent on 1, the other beat starts medium). E.countLog = [[time, level]].
    E.countLog = [];
    function startCountIn() {
      const c = liveCtx(), s = S(), T = md.tsOf(s), sec16 = md.secPer16(s);
      if (!c || !VH.audio.out) return;
      const unit = T.d === 8 ? 2 : 4, n = T.spb / unit, t0 = c.currentTime + 0.05;
      E.countLog = [];
      for (let k = 0; k < n; k++) {
        const p = k * unit, lvl = k === 0 ? 2 : T.beats.includes(p) ? 1 : 0, t = t0 + p * sec16;
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.value = lvl === 2 ? 1760 : lvl === 1 ? 1320 : 990;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lvl === 2 ? 0.5 : lvl ? 0.32 : 0.22, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.06);
        o.connect(g); g.connect(VH.audio.out); o.start(t); o.stop(t + 0.08);
        o.onended = () => { try { g.disconnect(); } catch (_) { /* ignore */ } };
        E.countLog.push([t, lvl]);
      }
      countIn = 0.05 + T.spb * sec16;
    }
    Object.defineProperty(E, 'counting', { get: () => countIn > 0 });
    E.cue = null;   // start position (sixteenths) for the next Play, set by a seek while stopped; null = region start or 0
    function range() {
      const s = S(), n = md.spb(s), tot = md.tot16(s), r = songMode() && s.cur !== armK ? null : md.regionOf(s);
      return r ? [r[0] * n, r[1] * n, true, tot] : [0, tot, false, tot];
    }
    E.loopRange = () => { const [a, b, on] = range(); return { a16: a, b16: b, on }; };
    Object.defineProperty(E, 'cont16', { get: () => cont });
    Object.defineProperty(E, 'seekId', { get: () => seekId });
    // Song segments that continuous time [c0, c1) will play, from the current position and loop rules (assuming no
    // seek): [{ c, s, n }] = cont start, song start (sixteenths), length. Used by look-ahead schedulers.
    E.segments = function (c0, c1) {
      const [a, b, reg, tot] = range(), out = [];
      let c = cont, p = E.pos16;
      // c0 may lie up to a frame in the past (events queued at a seek / Play): walk back within the current run
      const back = Math.min(cont - c0, 4), floor = reg && p >= a && p < b ? a : 0;
      if (back > 0 && p - back >= floor - 1e-6) { c -= back; p = Math.max(floor, p - back); }   // (float-safe at the run start)
      for (let k = 0; k < 64 && c < c1; k++) {
        const end = reg && p < b ? b : tot, cEnd = c + Math.max(0, end - p);
        const lo = Math.max(c, c0), hi = Math.min(cEnd, c1);
        if (hi > lo) out.push({ c: lo, s: p + (lo - c), n: hi - lo });
        if (songMode() && !reg) break;   // Song mode: the next section's events follow its switch
        c = cEnd; p = reg ? a : 0;
      }
      return out;
    };
    E.play = function () {
      VH.audio.ensure(); ensureBuses();
      const [a, , reg, tot] = range(), st = E.cue != null ? Math.max(0, Math.min(tot - 1e-6, E.cue)) : reg ? a : 0;
      E.phase = st / tot; prevPos = st; cont = 0; seekCont = 0; ahead = 0; seekId++; backingBar = -1; lastBar = -1; E.playing = true;
      lastCt = -1; lag = 0; stall = 0; armK = S().cur;
      E.pass = songMode() ? (() => { const its = md.arrangement(S()), f = M.view && M.view.song ? M.view.focus : -1; return its[f] && its[f].k === S().cur ? f : its.findIndex((it) => it.k === S().cur); })() : -1;   // Song view: start at the occurrence last pointed at
      countIn = 0;
      if (VH.store.get('melody.countIn', false) === true) startCountIn();
      M.emit('play');
    };
    E.stop = function () {
      E.stopAll(); E.playing = false; countIn = 0; E.pass = -1;
      M.emit('stop');
    };
    E.toggle = () => (E.playing ? E.stop() : E.play());
    // Jump to sixteenth t16. Playing: playback continues from there (notes scheduled for the old position are cut).
    // Stopped: sets the cue, so the next Play starts there.
    E.seek = (t16) => {
      const tot = md.tot16(S());
      t16 = Math.max(0, Math.min(tot - 1e-6, +t16 || 0));
      if (!E.playing) { E.cue = t16; E.phase = t16 / tot; M.emit('seek', t16); M.requestRender(); return; }
      E.phase = t16 / tot; prevPos = E.pos16; ahead = cont; seekCont = cont; backingBar = -1; seekId++; armK = S().cur;
      const c = liveCtx();   // notes scheduled ahead for the old position must not play
      if (c) noteV = noteV.filter((x) => { if (x.t0 > c.currentTime + 0.002) { cut(x, 0.01); return false; } return true; });
      M.emit('seek', t16);
    };
    // Called once per animation frame (main.js; while the page is hidden, by a background timer). The transport follows
    // the audio clock whenever it runs: frame time only smooths it (small drift is eased out, a gap such as a throttled
    // background tick is taken at once), so the playhead never drifts from what is heard.
    E.step = function (now, dt) {
      if (!E.playing) return;
      const ac = liveCtx();
      if (ac && ac.state === 'running') {
        const ct = ac.currentTime;
        stall = lastCt >= 0 && ct === lastCt ? stall + dt : 0;
        if (stall > 1) lag = 0;   // a clock that doesn't move while 'running' (no output device): frame time only
        else if (lastCt >= 0) { lag += ct - lastCt - dt; const d = Math.max(0, dt + (Math.abs(lag) > 0.05 ? lag : lag * 0.1)); lag -= d - dt; dt = d; }
        lastCt = ct;
      } else { lastCt = -1; lag = 0; stall = 0; }
      if (countIn > 0) {   // count-in: the clicks play, the song waits
        countIn -= dt;
        if (countIn > 0) return;
        dt = Math.min(dt, -countIn); countIn = 0;
      }
      let s = S(), [a, b, reg, tot] = range(), adv = dt / md.secPer16(s);
      let pos = E.phase * tot + adv;
      cont += adv;
      if (reg && prevPos < b && pos >= b) pos = a + (pos - b);   // loop the region
      else if (pos >= tot && songMode() && !reg) {   // next pass of the arrangement (may switch the section shown)
        const over = pos - tot;
        if (!M.nextPass()) { E.stop(); E.phase = 0; return; }
        s = S(); tot = md.tot16(s); pos = Math.min(over, tot - 1e-6);
        // schedulers restart at the new section's start (a moment ago): nothing at its downbeat is lost
        seekCont = cont - over; ahead = seekCont; seekId++; backingBar = -1; prevPos = 0;
      } else if (pos >= tot) pos = (reg ? a : 0) + (pos - tot);   // Section mode loops the section (or its region)
      E.phase = Math.max(0, Math.min(0.999999, pos / tot));
      tick(now);
    };
    // Schedule the notes starting in continuous time [c0, c1) at their audio time.
    function scheduleNotes(s, c0, c1, actx, sec16) {
      const now = actx.currentTime, segs = E.segments(c0, c1);
      if (!segs.length) return;
      s.layers.forEach((l, L) => {
        if (!layerGain(s, L)) return;
        const snd = M.soundOf(L);
        if (l.arp) {   // arpeggio layer: its notes / lines play as steps (md.arpEvents), not as held voices
          const peaksAt = (t) => { const at = M.bandsAt(t, L); return at ? (at.matchPeaks ? at.matchPeaks() : at.peaks()).map((m) => md.gridSnap(s, m)) : []; };
          for (const g of segs) {
            for (const e of md.arpEvents(s, L, g.s, g.s + g.n, l.arp.from === 'bands' ? peaksAt : null)) {
              const when = now + (g.c + (e.t - g.s) - cont) * sec16, dur = e.d * sec16, n = { s: e.t, d: e.d, m: e.m };
              const p = play(L, 'note', snd, e.m, G_NOTE, Math.max(now, when), n, null);
              const t0 = p.v.t0 != null ? p.v.t0 : Math.max(now, p.o.when != null ? p.o.when : when);
              p.v.stop(undefined, t0 + dur);
              noteV.push({ L, n, v: p.v, base: p.o.gain, m: p.o.midi, cents: 0, t0, t1: t0 + dur, arp: true });
            }
          }
          return;
        }
        if (!l.notes.length) return;
        for (const g of segs) {
          for (const n of l.notes) {
            if (n.s < g.s - 1e-6 || n.s >= g.s + g.n - 1e-6) continue;
            const when = now + (g.c + (n.s - g.s) - cont) * sec16, dur = n.d * sec16;
            const p = play(L, 'note', snd, n.m, G_NOTE, Math.max(now, when), n, null);
            const t0 = p.v.t0 != null ? p.v.t0 : Math.max(now, p.o.when != null ? p.o.when : when);   // the voice's actual start
            p.v.stop(undefined, t0 + dur);
            noteV.push({ L, n, v: p.v, base: p.o.gain, m: p.o.midi, cents: 0, t0, t1: t0 + dur });
          }
        }
      });
    }
    function tick(now) {
      const s = S(), tot = md.tot16(s), pos = E.phase * tot, b = md.barAt(s, pos), rg = md.regionAt(s, pos);
      const i = Math.min(tot * 3 - 1, Math.floor(pos * 3)), actx = liveCtx(), sec16 = md.secPer16(s);
      const wrapped = pos < prevPos, [ra, rb] = range();
      if (actx) ensureBuses();
      if (actx && rg !== backingBar) {   // the backing follows chord regions (several per bar when a bar is split)
        backingBar = rg;
        const ch = md.regionChord(s, rg), a16 = s.chords[rg] ? s.chords[rg].at : 0, z16 = md.regionEnd(s, rg);
        try { backing().onBar(b, ch ? chordMidis(ch, s) : null, { now, ctxTime: actx.currentTime, secPerBar: md.secPerBar(s), region: rg, a16, z16, secs: (z16 - pos) * sec16 }); }
        catch (err) { console.error('[melody] backing', err); }
      }
      if (b !== lastBar) { lastBar = b; M.emit('bar', b); }
      const info = { now, pos16: pos, prevPos16: prevPos, wrapped, bar: b, region: rg, lineIndex: i, phase: E.phase, pass: E.pass,
        cont16: cont, seekId, seekCont16: seekCont, loopA16: ra, loopB16: rb,
        ctxTime: actx ? actx.currentTime : 0, secPer16: sec16, timeOf: (t16) => (actx ? actx.currentTime + (t16 - pos) * sec16 : 0) };
      // Fell behind (a stall): start late notes only up to LATE. Notes from the run start (Play, seek, a Song-mode pass:
      // ahead = that moment, up to a step ago) are kept, so a note at time 0 / a section start always plays.
      const late = (LATE + E.bgAhead) / sec16;
      if (ahead < cont - late) ahead = cont - late;
      if (actx) {
        const target = cont + (LOOKAHEAD + E.bgAhead) / sec16;
        if (target > ahead) { scheduleNotes(s, ahead, target, actx, sec16); ahead = target; }
      }
      prevPos = pos;
      if (actx) {
        const ct = actx.currentTime;
        noteV = noteV.filter((x) => {
          if (ct >= x.t1) return false;
          if (ct < x.t0) return true;
          if (x.arp) return true;
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
          const audible = layerGain(s, L) > 0 && !l.arp, snd = M.soundOf(L), hit = E.playOf(snd) === 'hit';
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
