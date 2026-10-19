// melody/main.js - builds the Melody context M (see MELODY.md), wires model / bands / view / engine / tools / ui,
// undo history (M.commit), autosave, share links, keyboard, the frame loop, Wave B parts, and registers the experiment.
(function () {
  'use strict';
  const PUBLIC_URL = 'https://elias1328.github.io/Visual-Harmonics/';
  const VH = window.VH, ui = VH.ui, NS = VH.melody, md = NS.model;
  const { LPB, SPB, MAX_LAYERS, COLORS, clamp, serialize, parse, namesOf } = md;
  const hist = { past: [], future: [] };   // undo history survives tab switches (the song itself is autosaved). Entries: { s, label }
  let inst = null;

  function create(el) {
    const saved = parse(VH.store.get('melody.song', null)), shareSub = /^s=/.test(VH.app.sub || ''), inbox0 = VH.store.get('melody.inbox', null);
    let alive = true, S = saved || parse(md.defaultSong()), active = 0, soundsReady = false, dirty = true;
    // First visit (demo song + tutorial, see onboard.js): no autosave, no share link, nothing in the inbox, tutorial not
    // done, and the first Melody mount of this page session. Never overrides an autosave or a share link.
    const firstVisit = !saved && !shareSub && !(Array.isArray(inbox0) && inbox0.length) && !VH.store.get('melody.tutorial', null) && !NS.mountedOnce;
    NS.mountedOnce = true;
    const upgraded = S.migratedIds > 0 || S.migratedLines > 0;   // autosave from before layer ids: save it back in the new format
    const cleanups = [], timers = new Set(), subs = new Map(), parts = [];
    const hookFns = { voiceOpts: [], pitchMod: [], beforeCommit: [] };
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); return t; };
    const forget = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };

    // ---------- the context ----------
    const M = {
      el, model: md, hist, cleanups, later, forget,
      // Engine hooks (see MELODY.md, Hooks). voiceOpts / pitchMod run every registered fn (M.addHook); bandExtras is one slot.
      hooks: {
        bandExtras: null,
        voiceOpts(L, kind, midi, o) {
          for (const f of hookFns.voiceOpts) {
            try { const r = f(L, kind, o.midi, o); if (r && typeof r === 'object') o = r; } catch (err) { console.error('[melody] voiceOpts hook', err); }
          }
          return o;
        },
        pitchMod(L, kind, t, ref) {
          let c = 0;
          for (const f of hookFns.pitchMod) {
            try { const v = +f(L, kind, t, ref); if (isFinite(v)) c += v; } catch (err) { console.error('[melody] pitchMod hook', err); }
          }
          return c;
        },
      },
      // M.addHook('voiceOpts' | 'pitchMod' | 'beforeCommit', fn) -> off(). Released on unmount with M.
      addHook(name, fn) {
        const list = hookFns[name];
        if (!list || typeof fn !== 'function') throw new Error('[melody] unknown hook ' + name);
        list.push(fn);
        return () => { const k = list.indexOf(fn); if (k >= 0) list.splice(k, 1); };
      },
      get song() { return S; },
      get active() { return active; },
      requestRender() { dirty = true; },
      on(evt, cb) { if (!subs.has(evt)) subs.set(evt, new Set()); subs.get(evt).add(cb); return () => subs.get(evt).delete(cb); },
      emit(evt, ...args) {
        const set = subs.get(evt);
        if (set) for (const cb of [...set]) { try { cb(...args); } catch (err) { console.error('[melody] ' + evt + ' listener', err); } }
      },
      onPlayTick: (cb) => M.on('tick', cb),
      layerBus: (i) => M.engine.layerBus(i),
      bandsAt: (t16, L) => M.bands.at(t16, L),
      invalidateBands: () => M.bands.invalidate(),
      // The harmony map must be redrawn (e.g. bandExtras inputs changed). Columns are cached by value, so unchanged
      // bars cost nothing; `bars` (optional) documents which ones changed.
      markBandsDirty: (bars) => { void bars; M.bands.dirty = true; M.requestRender(); },
      lastCommit: null,
      firstVisit,
      placing: null,   // { ch, from } while an incoming chord waits for a bar-header click
    };

    // ---------- sounds ----------
    let sndOf = [], backSnd = null;
    const prepared = new Set();
    const fallback = () => VH.sounds.get('string');
    function prepare(s) {
      if (s && s.kind === 'sampler' && !prepared.has(s.id) && VH.sounds.prepare) {
        prepared.add(s.id);
        VH.sounds.prepare(s.id).then(() => { if (alive) M.soundsChanged(); }).catch(() => {});
      }
    }
    function resolveSounds() {
      sndOf = S.layers.map((l) => { const s = VH.sounds.get(l.sound); prepare(s); return s || fallback(); });
      const b = VH.sounds.get(S.backing.sound); prepare(b); backSnd = b || fallback();
    }
    M.soundOf = (L) => sndOf[L] || VH.sounds.get((S.layers[L] || {}).sound) || fallback();
    M.backingSound = () => backSnd || fallback();
    M.usesSound = (id, exceptLayer) => S.backing.sound === id || S.layers.some((l, i) => i !== exceptLayer && l.sound === id);
    M.soundsChanged = () => { if (!alive) return; resolveSounds(); M.bands.refresh(); M.ui.sync(); M.emit('sounds'); };
    function checkMissing() {
      if (!soundsReady) return;
      const miss = [];
      S.layers.forEach((l) => { if (!VH.sounds.get(l.sound)) { miss.push(l.name); l.sound = 'string'; } });
      if (!VH.sounds.get(S.backing.sound)) { miss.push('the backing'); S.backing.sound = 'string'; }
      if (!miss.length) return;
      M.toast('A sound in this song isn’t available here, so ' + miss.join(' + ') + ' now use' + (miss.length > 1 ? '' : 's') + ' String');
      lastSnap = snap();
      afterChange();
    }

    // ---------- edits, undo, persistence ----------
    const snap = () => JSON.stringify(serialize(S, false));
    let lastSnap = snap();
    function afterChange() {
      if (active >= S.layers.length) active = S.layers.length - 1;
      resolveSounds(); M.bands.refresh(); M.bands.dirty = true; M.engine.applyMix();
      M.view.relayout(); M.ui.sync(); M.save(); M.emit('song', S);
    }
    // Record an undo point if the song changed since the last commit. Mutate M.song first, then commit(label, opts).
    // opts: true (keep a share hash; legacy) or { keepHash, chords: [bars whose chord changed], source: 'chord' | 'generate' | ... }.
    // 'beforeCommit' hooks run first with { label, chords, source, song, info }; they may mutate the song (same undo
    // step) and change label / info. The final context is M.lastCommit.
    M.commit = function (label, opts) {
      const o = opts === true ? { keepHash: true } : opts && typeof opts === 'object' ? opts : {};
      const cx = { label: label || 'Edit', chords: Array.isArray(o.chords) ? o.chords : [], source: o.source || '', song: S, info: null };
      for (const f of hookFns.beforeCommit) { try { f(cx); } catch (err) { console.error('[melody] beforeCommit hook', err); } }
      S.layers.forEach(md.pruneStrokes);   // strokes emptied by an edit disappear
      M.lastCommit = cx;
      const keepHash = !!o.keepHash;
      label = cx.label;
      const now = snap();
      if (now === lastSnap) { M.ui.sync(); M.save(); return false; }
      hist.past.push({ s: lastSnap, label: label || 'Edit' }); if (hist.past.length > 120) hist.past.shift();
      hist.future.length = 0; lastSnap = now;
      if (!keepHash && /\/s=/.test(location.hash)) { try { history.replaceState(null, '', '#melody'); } catch (_) { /* ignore */ } }
      afterChange();
      return true;
    };
    function applySnap(str) {
      const old = S.chords, o = JSON.parse(str);
      ['grid', 'loop', 'snap'].forEach((k) => { o[k] = S[k]; });
      S = parse(o); lastSnap = snap();
      M.engine.stopAll();
      afterChange(); checkMissing();
      const b = S.chords.findIndex((c, i) => JSON.stringify(c) !== JSON.stringify(old[i] || null));
      if (b >= 0) M.engine.previewChord(b);   // chord changed by undo/redo -> preview the first changed bar
    }
    // Drop uncommitted live edits (e.g. a drag cancelled by a two-finger pinch): back to the last committed song, no step.
    M.revert = () => { if (snap() !== lastSnap) applySnap(lastSnap); };
    M.undo = () => { if (!hist.past.length) return; const e = hist.past.pop(); hist.future.push({ s: snap(), label: e.label }); applySnap(e.s); };
    M.redo = () => { if (!hist.future.length) return; const e = hist.future.pop(); hist.past.push({ s: snap(), label: e.label }); applySnap(e.s); };
    let saveT = 0;
    const saveNow = () => { forget(saveT); saveT = 0; VH.store.set('melody.song', serialize(S, true)); };
    M.save = () => { forget(saveT); saveT = later(saveNow, 300); };

    // ---------- actions ----------
    M.setActive = (i) => { active = clamp(i | 0, 0, S.layers.length - 1); M.bands.refresh(); M.bands.dirty = true; M.ui.sync(); M.emit('layer', active); };
    M.setLayerSound = (L, id, noCommit) => {
      if (!VH.sounds.get(id) || !S.layers[L]) return;
      S.layers[L].sound = id;
      VH.store.set('melody.sound', id);
      M.engine.stopLayer(L);
      if (noCommit) afterChange(); else M.commit('Instrument');
    };
    M.setLayerMode = (L) => { const l = S.layers[L]; l.mode = l.mode === 'notes' ? 'line' : 'notes'; M.commit('Draw mode'); };
    M.setBackingSound = (id) => { if (!VH.sounds.get(id)) return; S.backing.sound = id; M.engine.restartBacking(); M.commit('Backing instrument'); };
    // o.extra(song): more edits merged into the same undo step. beforeCommit hooks see { chords: [b], source: 'chord' }.
    M.setChord = (b, ch, o) => {
      S.chords[b] = ch;
      if (o && typeof o.extra === 'function') { try { o.extra(S); } catch (err) { console.error('[melody] setChord extra', err); } }
      M.commit('Chord', { chords: [b], source: 'chord' });
      M.engine.previewChord(b);
    };
    M.setBars = (n) => {
      if (n === S.bars) return;
      const old = S.bars, tot = n * SPB;
      S.chords = Array.from({ length: n }, (_, b) => { const c = S.chords[b < old ? b : b % old]; return c ? c.slice() : null; });
      S.layers.forEach((l) => {
        l.lines.forEach((st) => {
          const v = new Float32Array(n * LPB).fill(NaN);
          v.set(st.v.subarray(0, Math.min(st.v.length, v.length)));
          st.v = v;
        });
        md.pruneStrokes(l);
        l.notes = l.notes.filter((x) => x.s < tot);
        l.notes.forEach((x) => { x.d = Math.min(x.d, tot - x.s); });
      });
      S.bars = n;
      S.loopRegion = md.regionOf(S);
      M.engine.cue = null;
      M.engine.restartBacking();
      M.commit('Bars');
    };
    M.addLayer = (o) => {
      if (S.layers.length >= MAX_LAYERS) { M.toast('Up to ' + MAX_LAYERS + ' layers'); return -1; }
      const i = S.layers.length, used = new Set(S.layers.map((l) => l.color)), names = new Set(S.layers.map((l) => l.name));
      let k = i + 1; while (names.has('Layer ' + k)) k++;
      const l = md.newLayer(i, Object.assign({ name: 'Layer ' + k, color: COLORS.find((c) => !used.has(c)) || COLORS[i % COLORS.length],
        sound: S.layers[active].sound, mode: 'line' }, o), S.bars);
      l.id = md.nextLayerId(S.layers);
      S.layers.push(l);
      active = i;
      M.emit('layerAdded', l.id, i);   // before the commit: listeners' song edits join this undo step
      M.commit('Add layer');
      M.emit('layer', active);
      return i;
    };
    M.removeLayer = (i) => {
      if (S.layers.length < 2 || !S.layers[i]) return;
      M.engine.layerRemoved(i);
      const id = S.layers[i].id;
      S.layers.splice(i, 1);
      if (active > i || active >= S.layers.length) active = Math.max(0, active - 1);
      M.emit('layerRemoved', id, i);   // after the splice, before the commit: index-keyed part data shifts in the same undo step
      M.commit('Delete layer');
      M.emit('layer', active);
    };

    // Loop region [a, b) in whole bars (null clears). Saved with the song (undo, autosave, share links).
    M.setLoopRegion = (r) => {
      const v = r ? md.regionOf({ loopRegion: r, bars: S.bars }) : null, had = md.regionOf(S);
      if (JSON.stringify(v) === JSON.stringify(had)) return;
      S.loopRegion = v; M.engine.cue = null;
      M.commit(v ? 'Loop bars ' + (v[0] + 1) + (v[1] - v[0] > 1 ? '–' + v[1] : '') : 'Clear loop region');
      if (v && M.engine.playing) { const p = M.engine.pos16; if (p < v[0] * SPB || p >= v[1] * SPB) M.engine.seek(v[0] * SPB); }
      M.toast(v ? 'Looping bar' + (v[1] - v[0] > 1 ? 's ' + (v[0] + 1) + '–' + v[1] : ' ' + (v[0] + 1)) + ' · ✕ clears' : 'Loop region cleared');
    };
    // Replace the whole song. label = an undo step with that label (Ctrl+Z brings the old song back); none = no step.
    // prep(song) may edit the new song (its sounds and bands are ready then) before it is recorded.
    M.replaceSong = (obj, label, prep) => {
      const ns = parse(obj);
      if (!ns) return false;
      if (M.engine.playing) M.engine.stop();
      M.engine.cue = null; M.cancelPlacing();
      S = ns; active = 0;
      M.engine.stopAll();
      if (prep) { resolveSounds(); M.bands.refresh(); try { prep(S); } catch (err) { console.error('[melody] replaceSong prep', err); } }
      if (label) { if (!M.commit(label)) afterChange(); } else { lastSnap = snap(); afterChange(); }
      checkMissing();
      M.emit('layer', active);
      return true;
    };
    M.newSong = () => {
      const o = md.defaultSong();
      o.layers = [{ sound: S.layers[0] ? S.layers[0].sound : 'string', mode: 'line' }];
      o.bpm = S.bpm;
      return M.replaceSong(o, 'New song');
    };

    // ---------- inbox: items other experiments send (VH.store 'melody.inbox', see MELODY.md "Inbox") ----------
    const chordLabel = (ch) => namesOf(S)[ch[0]] + ' ' + ch[1];
    M.startPlacing = (ch, from) => {
      M.placing = { ch: [ch[0], ch[1]], from: from || '' };
      el.classList.add('mel-placing');
      M.ui.toast(chordLabel(ch) + (from ? ' from ' + from : '') + ': click a bar to place it (Esc cancels)',
        { sticky: true, action: { label: 'Cancel', run: () => M.cancelPlacing(true) } });
      M.requestRender();
    };
    M.cancelPlacing = (say) => {
      if (!M.placing) return false;
      M.placing = null; el.classList.remove('mel-placing');
      if (M.ui) M.ui.toast(say ? 'Chord not placed' : null);
      return true;
    };
    M.placeChordAt = (b) => {
      const p = M.placing;
      if (!p || !(b >= 0 && b < S.bars)) return;
      M.placing = null; el.classList.remove('mel-placing');
      M.picker.close();
      M.setChord(b, p.ch.slice());   // previews it; auto-fit (B1) joins the same undo step
      M.ui.toast(chordLabel(p.ch) + ' in bar ' + (b + 1) + (M.lastCommit && /fit/i.test(M.lastCommit.label) ? ' · notes fitted' : ''),
        { action: undoAction(M.hist.past.length) });
    };
    function undoAction(depth) {   // a toast "Undo" that only undoes the step it announced
      return { label: 'Undo', run: () => { if (M.hist.past.length === depth) M.undo(); } };
    }
    function prettyFrom(id) {
      const e = id && VH.app.experiments.find((x) => x.id === id);
      return e ? e.title : id ? String(id) : '';
    }
    function consumeInbox() {
      const items = VH.store.get('melody.inbox', null);
      if (!Array.isArray(items) || !items.length) return;
      VH.store.set('melody.inbox', []);
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const from = typeof it.from === 'string' && it.from ? prettyFrom(it.from) : prettyFrom(VH.app.prev);
        if (it.type === 'chord') {
          const c = it.chord;
          if (Array.isArray(c) && md.QI[c[1]] != null && isFinite(c[0])) M.startPlacing([((c[0] | 0) % 12 + 12) % 12, c[1]], from);
          else console.warn('[melody] inbox: bad chord', c);
        } else if (it.type === 'sound' && typeof it.soundId === 'string') {
          const id = it.soundId;
          VH.sounds.ready.then(() => {
            if (!alive) return;
            const snd = VH.sounds.get(id), L = active, l = S.layers[L];
            if (!snd || !l) { M.toast('That sound isn’t available here'); return; }
            l.sound = id;
            VH.store.set('melody.sound', id);
            M.engine.stopLayer(L);
            M.commit('Instrument' + (from ? ' from ' + from : ''));
            M.ui.toast('Now playing ' + snd.name + ' on ' + l.name, { action: undoAction(M.hist.past.length) });
          });
        }
      }
    }
    M.consumeInbox = consumeInbox;

    // ---------- share ----------
    M.share = async function () {
      M.ui.hideShareBox();
      const code = await VH.store.encodeShare(serialize(S, true));
      if (!alive) return;
      // Links made while running locally (localhost / file://) point at the public site so they work for anyone.
      const local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
      const base = local ? PUBLIC_URL : location.href.split('#')[0];
      const url = base + '#melody/s=' + code;
      try { history.replaceState(null, '', '#melody/s=' + code); } catch (_) { /* ignore */ }
      let ok = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch (_) { ok = false; }
      if (!alive) return;
      if (ok) { M.toast('Link copied'); return; }
      M.ui.showShareBox(url);
      M.toast('Copy the link below');
    };
    function loadShare(sub) {
      const m = /^s=(.+)$/.exec(sub || '');
      if (!m) return;
      VH.store.decodeShare(m[1]).then((o) => {
        if (!alive) return;
        const ns = o && parse(o);
        if (!ns) { M.toast('That share link couldn’t be read'); return; }
        S = ns; active = 0;
        M.engine.stopAll();
        if (!M.commit('Load shared song', true)) afterChange();
        M.toast('Loaded a shared song · Ctrl+Z goes back');
        checkMissing();
      });
    }

    // ---------- build ----------
    const { box, caption, dock } = ui.layout(el);
    M.bands = NS.Bands(M);
    M.engine = NS.Engine(M);
    M.view = NS.View(M, box);
    M.tools = NS.Tools(M);
    M.ui = NS.UI(M, el, dock, caption);
    M.toast = (msg) => M.ui.toast(msg);
    resolveSounds(); M.bands.refresh();
    cleanups.push(M.view.fit());
    M.bands.computeBg(); M.ui.sync();

    // Wave B parts (separate files): VH.melody.parts.push((M) => ({ destroy() {} }))
    for (const factory of NS.parts) {
      try { const p = factory(M); if (p) parts.push(p); } catch (err) { console.error('[melody] part failed to start', err); }
    }

    // ---------- keys ----------
    function onKey(e) {
      const t = e.target, tag = t && t.tagName, typing = (tag === 'INPUT' && t.type === 'text') || tag === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing) {
        const k = (e.key || '').toLowerCase();
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) M.redo(); else M.undo(); return; }
        if (k === 'y') { e.preventDefault(); M.redo(); return; }
      }
      if (e.key === 'Escape') { if (M.cancelPlacing(true)) return; M.ui.closeFloats(); return; }
      const editable = tag === 'TEXTAREA' || (t && t.isContentEditable) || (tag === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type));
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat && !editable && tag !== 'SELECT' && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); M.ui.toggleSnap(); return;
      }
      if (e.code !== 'Space' || e.repeat || typing || tag === 'SELECT' || (t && t.closest && t.closest('.mel-pop, .mel-float'))) return;
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      M.engine.toggle();
    }
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    // ---------- frame loop ----------
    let raf = 0, lastT = performance.now();
    M.on('play', () => M.view.setScroll(M.engine.phase * M.view.CW - M.view.VW * 0.2));
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
      if (M.bands.dirty) { M.bands.computeBg(); dirty = true; }
      if (M.engine.playing) {
        M.engine.step(now, dt);
        if (M.engine.playing) M.view.follow(M.engine.phase);
        dirty = true;
      }
      if (dirty) { dirty = false; M.view.draw(); }
    }

    // ---------- start ----------
    cleanups.push(VH.sounds.onChange(() => M.soundsChanged()));
    VH.sounds.ready.then(() => { if (!alive) return; soundsReady = true; M.soundsChanged(); checkMissing(); });
    raf = requestAnimationFrame(frame);
    if (upgraded) M.save();
    loadShare(VH.app.sub);
    consumeInbox();

    return {
      M,
      onRoute(sub) { loadShare(sub); consumeInbox(); },
      song: () => JSON.stringify(serialize(S, true)),
      get active() { return active; },
      destroy() {
        alive = false;
        cancelAnimationFrame(raf); raf = 0;
        M.engine.destroy();
        M.emit('unmount');
        parts.forEach((p) => { try { if (p.destroy) p.destroy(); } catch (err) { console.error('[melody] part destroy', err); } });
        if (saveT) saveNow();
        timers.forEach((t) => clearTimeout(t)); timers.clear();
        cleanups.forEach((f) => f());
        subs.clear();
      },
    };
  }

  // Small read-only hooks for tests / the console.
  NS.song = () => (inst && inst.song ? inst.song() : null);
  NS.hist = hist;
  Object.defineProperty(NS, 'active', { configurable: true, get: () => (inst ? inst.active : -1) });
  Object.defineProperty(NS, 'ctx', { configurable: true, get: () => (inst ? inst.M : null) });

  // Shortcut sheet ("?", app.js): Melody's keys.
  if (VH.ui.shortcuts) {
    VH.ui.shortcuts.register('melody', [
      { keys: 'Space', label: 'Play / stop' },
      { keys: 'P', label: 'Pen: draw a free line' },
      { keys: 'L', label: 'Line: straight glide (hold Shift for whole semitones)' },
      { keys: 'N', label: 'Notes: click to place, drag right to lengthen' },
      { keys: 'V', label: 'Select: click or drag a box (Shift adds), drag to move' },
      { keys: 'E', label: 'Eraser' },
      { keys: 'S', label: 'Snap to bright bands on / off' },
      { keys: 'Ctrl+Z', label: 'Undo' },
      { keys: 'Ctrl+Shift+Z / Ctrl+Y', label: 'Redo' },
      { keys: 'Delete / Backspace', label: 'Delete the selection' },
      { keys: 'Ctrl+C / Ctrl+X / Ctrl+V', label: 'Copy, cut, paste (at the pointer or playhead)' },
      { keys: 'Ctrl+A', label: 'Select the whole layer' },
      { keys: 'Esc', label: 'Close a menu, clear the selection, cancel placing a chord' },
    ]);
  }

  VH.registerExperiment({
    id: 'melody', title: 'Melody', icon: '✎',
    hint: 'Draw on the bright bands: they fit each chord. Tap a chord to change it, or try Notes.',
    mount(el) { inst = create(el); },
    onRoute(sub) { if (inst && inst.onRoute) inst.onRoute(sub); },
    unmount() { if (inst && inst.destroy) inst.destroy(); inst = null; },
  });
})();
