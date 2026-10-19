// melody/main.js - builds the Melody context M (see MELODY.md), wires model / bands / view / engine / tools / ui,
// undo history (M.commit), autosave, share links, keyboard, the frame loop, Wave B parts, and registers the experiment.
(function () {
  'use strict';
  const PUBLIC_URL = 'https://elias1328.github.io/Visual-Harmonics/';
  const VH = window.VH, ui = VH.ui, NS = VH.melody, md = NS.model;
  const { MAX_LAYERS, COLORS, clamp, serialize, parse, namesOf } = md;
  const hist = { past: [], future: [] };   // undo history survives tab switches (the song itself is autosaved). Entries: { s, label }
  let inst = null;

  function create(el) {
    const saved = parse(VH.store.get('melody.song', null)), shareSub = /^s=/.test(VH.app.sub || ''), inbox0 = VH.store.get('melody.inbox', null);
    let alive = true, S = saved || parse(md.defaultSong()), active = 0, soundsReady = false, dirty = true;
    // First visit (demo song + tutorial, see onboard.js): no autosave, no share link, nothing in the inbox, tutorial not
    // done, and the first Melody mount of this page session. Never overrides an autosave or a share link.
    const firstVisit = !saved && !shareSub && !(Array.isArray(inbox0) && inbox0.length) && !VH.store.get('melody.tutorial', null) && !NS.mountedOnce;
    NS.mountedOnce = true;
    const upgraded = S.migratedIds > 0 || S.migratedLines > 0 || S.migratedSections > 0;   // autosave from before layer ids: save it back in the new format
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
    // A sound this song uses that is not on this device (a share link with imported sounds, a deleted sound): the closest
    // built-in by play type + spectrum (from the link's ext.snd snapshot, see M.share), named in a toast. Drum-kit rows
    // fall back to the built-in synth drum.
    function checkMissing() {
      if (!soundsReady) return;
      const info = (S.ext && S.ext.snd) || {}, miss = [];
      const sub = (id, who) => {
        const f = VH.sounds.closest(info[id]), was = (info[id] && info[id].name) || 'A sound';
        miss.push(was + ' → ' + f.name + ' (' + who + ')');
        return f.id;
      };
      S.layers.forEach((l) => { if (!VH.sounds.get(l.sound)) l.sound = sub(l.sound, l.name); });
      if (!VH.sounds.get(S.backing.sound)) S.backing.sound = sub(S.backing.sound, 'backing');
      const kit = S.ext && S.ext.kit;
      if (kit && Array.isArray(kit.rows)) kit.rows.forEach((r) => { if (r && r.sound && !VH.sounds.get(r.sound)) { miss.push((r.sname || r.name) + ' → built-in ' + (r.syn || 'perc') + ' (drums)'); r.sound = null; } });
      M.missing = miss;
      if (!miss.length) return;
      M.toast('Not on this device, so the closest built-in plays instead: ' + miss.join(', '));
      lastSnap = snap();
      afterChange();
    }
    // Sounds of the user's own (imported, Babel, tone copies) used by song S: [{ id, name, play, spectrum }].
    M.ownSounds = function (song) {
      const T = song || S, ids = new Set(T.layers.map((l) => l.sound).concat(T.backing.sound));
      const kit = T.ext && T.ext.kit;
      if (kit && Array.isArray(kit.rows)) kit.rows.forEach((r) => r && r.sound && ids.add(r.sound));
      return [...ids].map((id) => VH.sounds.get(id)).filter((x) => x && x.source !== 'preset' && x.source !== 'sample');
    };
    M.SHARE_NOTE = 'Your own sounds aren’t included in the link; listeners will hear the closest built-in instrument.';

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
      const old = S.chords, o = JSON.parse(str), cur0 = S.cur;
      ['grid', 'loop', 'snap'].forEach((k) => { o[k] = S[k]; });
      S = parse(o); lastSnap = snap();
      M.engine.stopAll();
      afterChange(); checkMissing();
      const b = S.chords.findIndex((c, i) => JSON.stringify(c) !== JSON.stringify(old[i] || null));
      if (o.cur !== cur0) M.emit('section', S.cur);
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
    // b = chord region index (== bar while no bar is split; see md.regionAt). o.extra(song): more edits merged into the
    // same undo step. beforeCommit hooks see { chords: [b], source: 'chord' }.
    M.setChord = (b, ch, o) => {
      if (!S.chords[b]) return;
      S.chords[b].chord = ch ? [ch[0], ch[1]] : null;
      if (o && typeof o.extra === 'function') { try { o.extra(S); } catch (err) { console.error('[melody] setChord extra', err); } }
      M.commit('Chord', { chords: [b], source: 'chord' });
      M.engine.previewChord(b);
    };
    // Chord regions: split at t16 (the new region keeps the chord; returns its index) / merge region r into the one
    // before it (it takes that chord; auto-fit runs on the merged region). Bar starts never merge.
    M.splitChord = (t16) => {
      const r = md.splitAt(S, t16);
      if (r < 0) return -1;
      M.commit('Split chord');
      return r;
    };
    M.mergeChord = (r) => {
      if (!md.mergeAt(S, r)) return false;
      M.commit('Merge chords', { chords: [r - 1], source: 'chord' });
      return true;
    };
    M.setBars = (n) => {
      if (n === S.bars) return;
      n = clamp(n | 0, 1, md.MAX_BARS);
      if (n === S.bars) return;
      const old = S.bars, spb = md.spb(S), tot = n * spb;
      // new bars repeat the chords (and splits) of the bars before them
      const ev = [];
      for (let b = 0; b < n; b++) {
        const src = b < old ? b : b % old;
        S.chords.forEach((e) => { if (e.at >= src * spb && e.at < (src + 1) * spb) ev.push({ at: e.at - src * spb + b * spb, chord: e.chord ? e.chord.slice() : null }); });
      }
      S.chords = ev;
      S.layers.forEach((l) => {
        l.lines.forEach((st) => {
          const v = new Float32Array(tot * 3).fill(NaN);
          v.set(st.v.subarray(0, Math.min(st.v.length, v.length)));
          st.v = v;
        });
        md.pruneStrokes(l);
        l.notes = l.notes.filter((x) => x.s < tot);
        l.notes.forEach((x) => { x.d = Math.min(x.d, tot - x.s); });
      });
      S.bars = n;
      md.normChords(S);
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
        sound: S.layers[active].sound, mode: 'line' }, o), S.bars, S.ts);
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
      S.sections.forEach((x) => {   // other sections: drop the layer's content, shift their index-keyed vibrato
        if (!x.data) return;
        delete x.data.layers[id];
        const v = x.data.vib;
        if (v && typeof v === 'object') {
          const nv = {};
          Object.keys(v).forEach((q) => { const n = +q; if (n < i) nv[n] = v[q]; else if (n > i) nv[n - 1] = v[q]; });
          x.data.vib = nv;
        }
      });
      M.commit('Delete layer');
      M.emit('layer', active);
    };

    // Loop region [a, b) in whole bars (null clears). Saved with the song (undo, autosave, share links).
    M.setLoopRegion = (r) => {
      const v = r ? md.regionOf({ loopRegion: r, bars: S.bars }) : null, had = md.regionOf(S);
      if (JSON.stringify(v) === JSON.stringify(had)) return;
      S.loopRegion = v; M.engine.cue = null;
      M.commit(v ? 'Loop bars ' + (v[0] + 1) + (v[1] - v[0] > 1 ? '–' + v[1] : '') : 'Clear loop region');
      const n = md.spb(S);
      if (v && M.engine.playing) { const p = M.engine.pos16; if (p < v[0] * n || p >= v[1] * n) M.engine.seek(v[0] * n); }
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

    // ---------- time signature (current section) ----------
    // Content keeps its place within each bar; whatever falls past the new bar end is dropped (chord splits too).
    M.setTimeSig = (ts) => {
      if (!md.TS[ts] || ts === (S.ts || '4/4')) return;
      const n0 = md.spb(S), n1 = md.TS[ts].spb, keep = (t) => t % n0 < n1, map = (t) => Math.floor(t / n0) * n1 + (t % n0);
      S.chords = S.chords.filter((e) => keep(e.at)).map((e) => ({ at: map(e.at), chord: e.chord }));
      S.layers.forEach((l) => {
        l.lines.forEach((st) => {
          const v = new Float32Array(S.bars * n1 * 3).fill(NaN);
          for (let i = 0; i < st.v.length; i++) if (keep(i / 3)) { const j = Math.floor(i / (n0 * 3)) * n1 * 3 + (i % (n0 * 3)); if (j < v.length) v[j] = st.v[i]; }
          st.v = v;
        });
        md.pruneStrokes(l);
        l.notes = l.notes.filter((x) => keep(x.s)).map((x) => { const s = map(x.s), end = Math.floor(x.s / n0) * n1 + n1; return { s, d: Math.max(1, Math.min(x.d, end - s)), m: x.m }; });
      });
      S.ts = ts;
      md.normChords(S);
      M.engine.cue = null; M.engine.restartBacking();
      M.emit('timeSig', ts);   // before the commit: parts adapt their data (drum steps) in the same undo step
      M.commit('Time ' + ts);
      if (M.engine.playing) M.engine.seek(0);
    };

    // ---------- sections + arrangement (see MELODY.md "Sections") ----------
    // Switching the section shown is not an undo step (the history stays clean when nothing was pending); every
    // section operation (add, duplicate, delete, rename, recolor, reorder, repeat) is one.
    M.playMode = VH.store.get('melody.playMode', 'section') === 'song' ? 'song' : 'section';
    M.setPlayMode = (m) => { M.playMode = m === 'song' ? 'song' : 'section'; VH.store.set('melody.playMode', M.playMode); if (M.engine.playing) M.engine.pass = M.playMode === 'song' ? md.arrangement(S).findIndex((it) => it.k === S.cur) : -1; M.ui.sync(); M.emit('section', S.cur); };
    function showSection(k) {
      const clean = snap() === lastSnap;
      if (!md.selectSection(S, k)) return false;
      if (clean) lastSnap = snap();
      M.engine.cue = null; M.cancelPlacing();
      if (M.picker) M.picker.close();
      afterChange();
      M.emit('section', k);
      return true;
    }
    // Click on an arrangement block: edit that section (while playing: it plays from its start).
    M.selectSection = (k) => {
      if (k === S.cur || !S.sections[k]) return false;
      const playing = M.engine.playing;
      if (playing) M.engine.stopAll();
      showSection(k);
      if (playing) { M.engine.pass = M.playMode === 'song' ? md.arrangement(S).findIndex((it) => it.k === k) : -1; M.engine.seek(0); }
      return true;
    };
    // Song playback: move to the next arrangement pass (switching the section shown). false = the song ended.
    M.nextPass = () => {
      const items = md.arrangement(S);
      let p = M.engine.pass + 1;
      if (p >= items.length) { if (!S.loop) return false; p = 0; }
      M.engine.pass = p;
      if (items[p].k !== S.cur) showSection(items[p].k);
      M.emit('pass', p);
      return true;
    };
    function nameFor(base) {
      const names = new Set(S.sections.map((x) => x.name));
      if (base) { let k = 2; while (names.has(base + ' ' + k)) k++; return base + ' ' + k; }
      return md.SEC_NAMES.find((n) => !names.has(n)) || ('Section ' + (S.sections.length + 1));
    }
    M.addSection = (dup) => {
      if (S.sections.length >= md.MAX_SECTIONS) { M.toast('Up to ' + md.MAX_SECTIONS + ' sections'); return -1; }
      const cur = S.sections[S.cur], used = new Set(S.sections.map((x) => x.color));
      const data = dup ? md.copyContent(md.liveContent(S)) : md.emptyContent(S, S.bars, S.ts || '4/4');
      if (!dup) data.drums = md.copyContent(md.liveContent(S)).drums;   // a new section keeps the groove (no notes, tonic chords)
      const x = { id: md.nextSecId(S.sections), name: dup ? nameFor(cur.name.replace(/ \d+$/, '')) : nameFor(),
        color: dup ? cur.color : md.SEC_COLORS.find((c) => !used.has(c)) || md.SEC_COLORS[S.sections.length % md.SEC_COLORS.length], rep: 1, data };
      const k = S.cur + 1;
      if (M.engine.playing) M.engine.stop();
      S.sections.splice(k, 0, x);
      md.selectSection(S, k);
      M.engine.cue = null;
      M.commit(dup ? 'Duplicate section' : 'Add section');
      M.emit('section', k);
      return k;
    };
    M.deleteSection = (k) => {
      if (S.sections.length < 2 || !S.sections[k]) return false;
      if (M.engine.playing) M.engine.stop();
      if (k === S.cur) md.selectSection(S, k + 1 < S.sections.length ? k + 1 : k - 1);
      const curX = S.sections[S.cur];
      S.sections.splice(k, 1);
      S.cur = S.sections.indexOf(curX);
      M.commit('Delete section');
      M.emit('section', S.cur);
      return true;
    };
    M.moveSection = (from, to) => {
      to = clamp(to | 0, 0, S.sections.length - 1);
      if (from === to || !S.sections[from]) return false;
      const curX = S.sections[S.cur], [x] = S.sections.splice(from, 1);
      S.sections.splice(to, 0, x);
      S.cur = S.sections.indexOf(curX);
      M.commit('Reorder sections');
      M.emit('section', S.cur);
      return true;
    };
    M.renameSection = (k, name) => {
      const x = S.sections[k], n = String(name || '').trim().slice(0, 20);
      if (!x || !n || n === x.name) return;
      x.name = n; M.commit('Rename section'); M.emit('section', S.cur);
    };
    M.recolorSection = (k, color) => {
      const x = S.sections[k];
      if (!x || !/^#[0-9a-f]{6}$/i.test(color) || x.color === color) return;
      x.color = color; M.commit('Section color'); M.emit('section', S.cur);
    };
    M.setRepeat = (k, n) => {
      const x = S.sections[k], r = clamp(Math.round(+n) || 1, 1, md.MAX_REP);
      if (!x || x.rep === r) return;
      x.rep = r; M.commit('Repeat ×' + r); M.emit('section', S.cur);
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
      if (!p || !(b >= 0 && b < S.chords.length)) return;
      M.placing = null; el.classList.remove('mel-placing');
      M.picker.close();
      M.setChord(b, p.ch.slice());   // previews it; auto-fit (B1) joins the same undo step
      M.ui.toast(chordLabel(p.ch) + ' in bar ' + (Math.floor(S.chords[b].at / md.spb(S)) + 1) + (M.lastCommit && /fit/i.test(M.lastCommit.label) ? ' · notes fitted' : ''),
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
      if (VH.track) VH.track('share-link');
      // Imported audio can't travel in a link: carry each own sound's name, play type and spectrum (ext.snd) so the
      // receiver can pick the closest built-in (checkMissing).
      const o = serialize(S, true), own = M.ownSounds(S);
      if (own.length) {
        const r3 = (v) => Math.round(v * 1000) / 1000;
        o.ext = Object.assign({}, o.ext, { snd: Object.fromEntries(own.map((x) => [x.id, { name: x.name, play: VH.sounds.playOf(x),
          spectrum: (x.spectrum || []).slice().sort((a, b) => b[1] - a[1]).slice(0, 8).map((q) => [r3(q[0]), r3(q[1])]) }])) });
      }
      const code = await VH.store.encodeShare(o);
      if (!alive) return;
      // Links made while running locally (localhost / file://) point at the public site so they work for anyone.
      const local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
      const base = local ? PUBLIC_URL : location.href.split('#')[0];
      const url = base + '#melody/s=' + code;
      try { history.replaceState(null, '', '#melody/s=' + code); } catch (_) { /* ignore */ }
      let ok = false;
      try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch (_) { ok = false; }
      if (!alive) return;
      const note = own.length ? ' · ' + M.SHARE_NOTE : '';
      M.ui.showShareNote(own.length ? M.SHARE_NOTE : '');
      if (ok) { M.toast('Link copied' + note); return; }
      M.ui.showShareBox(url);
      M.toast('Copy the link below' + note);
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
