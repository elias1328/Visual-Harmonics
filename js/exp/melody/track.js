// melody/track.js - backing track: import a song or beat, find its tempo, beats, chords and key, play it in sync under the
// song, and draw the harmony map from its real partials (M.hooks.bandTrack). See MELODY.md (Backing track).
// The audio stays on this device (VH.store blobs); song.track only references it, and share links / the gallery carry
// the detected chords instead (main.js M.shareCode).
(function () {
  'use strict';
  const VH = window.VH, NS = VH.melody, md = NS.model;
  const MAX_BYTES = 30 * 1024 * 1024, MAX_SEC = 6 * 60, EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|mp4|aac|flac)$/i;
  const LOOKAHEAD = 0.25, TOL = 0.02, HARD = 0.06, NAMES = 'ABCDEFGHIJKLMNOP';
  // Decoded audio + heavy analysis by blob key; kept across remounts (a tab switch) for this page session.
  const mem = new Map();
  const QN = { maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', '7': '7', maj7: 'maj7', m7: 'm7' };
  const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const chordLabel = (c) => (c ? NOTE[c[0]] + QN[c[1]] : '–');
  const volOf = (db) => (db <= -59.9 ? 0 : Math.min(md.VOL_MAX, 10 ** (db / 20)));
  const dbOf = (v) => (v > 0.001 ? Math.max(-60, Math.min(6, 20 * Math.log10(v))) : -60);
  const isAudio = (f) => !!f && (EXT.test(f.name || '') || /^audio\//.test(f.type || ''));

  // Section k's start in the track (sixteenths from the track's bar 1), or null when the section is not from the track.
  function startOf(S, k) {
    const tr = S.track, sec = S.sections[k];
    if (!tr || !sec || !tr.secs) return null;
    const v = tr.secs[sec.id];
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  // Track time (s) at sixteenth t16 of section k. Playback maps with the song's tempo (the audio is never stretched),
  // bands with the track's (beat-aligned): equal unless the user moved the tempo away from the detected one.
  function timeAt(S, k, t16, useTrackBpm) {
    const st = startOf(S, k);
    if (st == null) return null;
    const sec16 = useTrackBpm ? 15 / S.track.bpm : md.secPer16(S);
    return S.track.offsetSec + (st + t16) * sec16;
  }

  NS.parts.push((M) => {
    const ui = VH.ui, A = VH.analyze && VH.analyze.track;
    if (!A) return null;
    let alive = true, cur = null, busy = null, removeRow = null, warnedBpm = null;
    // cur = { key, buf (AudioBuffer|null), an (analysis|null), missing, gk (grid key), slots, slotObj[] }

    // ---------- Settings > Song > Backing track ----------
    const sec = M.ui.addPanelSection('Backing track', 12, { group: 'song' });
    sec.classList.add('mel-track-sec');
    const box = ui.h('div', 'mel-track');
    sec.append(box);
    const fileIn = ui.h('input', 'mel-track-file'); fileIn.type = 'file'; fileIn.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a'; fileIn.hidden = true;
    fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (f) importFile(f); });
    sec.append(fileIn);
    const pick = () => fileIn.click();

    function render() {
      const S = M.song, tr = S.track;
      box.innerHTML = '';
      if (busy) {
        box.append(ui.h('div', 'mel-track-name', ''));
        box.lastChild.textContent = busy.name;
        const bar = ui.h('div', 'mel-track-prog', '<i></i>'); bar.firstChild.style.width = Math.round(busy.f * 100) + '%';
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuenow', String(Math.round(busy.f * 100)));
        box.append(bar, ui.h('div', 'vh-desc mel-track-status', ''));
        box.lastChild.textContent = busy.label + '… ' + Math.round(busy.f * 100) + '%';
        return;
      }
      if (!tr) {
        box.append(ui.h('div', 'vh-desc', 'Import a song or a beat (mp3, wav, ogg, m4a, flac; up to 30 MB and 6 minutes). Melody finds its tempo, beats, chords and key, plays it in sync under your song, and draws the harmony map from the real audio. You can also drop an audio file on the graph.'));
        const r = ui.h('div', 'vh-row'); box.append(r);
        ui.button(r, { label: '⤒ Import backing track…', onClick: pick }).classList.add('mel-track-import');
        box.append(ui.h('div', 'vh-desc mel-track-local', 'The audio stays on this device.'));
        return;
      }
      const nm = ui.h('div', 'mel-track-name'); nm.textContent = '♫ ' + tr.name; box.append(nm);
      const an = tr.analysis || {}, k = an.key;
      const info = ui.h('div', 'vh-desc mel-track-info');
      info.textContent = (Math.round(tr.bpm * 100) / 100) + ' BPM' + (k ? ' · ' + NOTE[k.root] + ' ' + k.mode : '') + (an.nBars ? ' · ' + an.nBars + ' bars' : '') +
        (an.chords ? ' · ' + an.chords : '');
      box.append(info);
      if (cur && cur.missing) {
        box.append(ui.h('div', 'mel-track-warn', 'The audio file is not on this device (it never leaves the device it was imported on). Bands use the chords. Import it again, or remove the track.'));
        const r = ui.h('div', 'vh-row'); box.append(r);
        ui.button(r, { label: '⤒ Import again…', onClick: pick });
        ui.button(r, { label: 'Remove track', onClick: remove }).classList.add('mel-track-remove');
        return;
      }
      if (Math.abs(S.bpm - tr.bpm) > 0.005) {
        const w = ui.h('div', 'mel-track-warn mel-track-bpmwarn');
        w.textContent = 'The song tempo (' + S.bpm + ') differs from the track (' + tr.bpm + ' BPM): the sync assumes the detected tempo, so the bars drift away from the audio.';
        const b = ui.h('button', 'vh-btn'); b.type = 'button'; b.textContent = 'Back to ' + tr.bpm; b.addEventListener('click', () => { M.song.bpm = M.song.track.bpm; M.commit('Tempo from track'); });
        w.append(' ', b); box.append(w);
      }
      // tempo + phase corrections (the beat ticks over the waveform strip under the chord header move at once)
      const r1 = ui.h('div', 'vh-row mel-track-tempo'); box.append(r1);
      const tap = ui.button(r1, { label: 'Tap', onClick: onTap }); tap.title = 'Tap the beat (4+ taps; while playing it also sets the beat phase)'; tap.classList.add('mel-track-tap');
      ui.button(r1, { label: '×2', onClick: () => setTempo(tr.bpm * 2, tr.offsetSec, 'Track tempo ×2') }).title = 'Double the detected tempo';
      ui.button(r1, { label: '÷2', onClick: () => setTempo(tr.bpm / 2, tr.offsetSec, 'Track tempo ÷2') }).title = 'Halve the detected tempo';
      const r2 = ui.h('div', 'vh-row mel-track-nudge'); box.append(r2);
      r2.append(ui.h('span', 'mel-track-lbl', 'Beat offset'));
      { const b = ui.button(r2, { label: '−10', onClick: () => nudge(-0.01) }); b.classList.add('mel-track-nl'); b.title = 'Nudge the beat 10 ms earlier'; }
      const ms = ui.h('input', 'mel-track-ms'); ms.type = 'number'; ms.step = '1'; ms.value = String(Math.round(tr.offsetSec * 1000)); ms.setAttribute('aria-label', 'Beat offset in milliseconds');
      ms.addEventListener('change', () => { const v = +ms.value; if (isFinite(v)) setOffset(v / 1000, 'Track offset'); });
      r2.append(ms, ui.h('span', 'mel-track-lbl', 'ms'));
      { const b = ui.button(r2, { label: '+10', onClick: () => nudge(0.01) }); b.classList.add('mel-track-nr'); b.title = 'Nudge the beat 10 ms later'; }
      // bands from
      const r3 = ui.h('div', 'vh-row mel-track-bands'); box.append(r3);
      r3.append(ui.h('span', 'mel-track-lbl', 'Bands from'));
      [['track', 'Track'], ['chords', 'Chords']].forEach(([v, l]) => {
        const b = ui.button(r3, { label: l, pressed: tr.bands === v, onClick: () => { if (M.song.track.bands === v) return; M.song.track.bands = v; M.commit(v === 'track' ? 'Bands from the track' : 'Bands from the chords'); } });
        b.dataset.v = v; b.classList.add('mel-track-bandbtn');
      });
      const r4 = ui.h('div', 'vh-row'); box.append(r4);
      ui.button(r4, { label: 'Use detected chords', onClick: useChords }).classList.add('mel-track-use');
      ui.button(r4, { label: 'Remove track', onClick: remove }).classList.add('mel-track-remove');
      box.append(ui.h('div', 'vh-desc mel-track-local', M.TRACK_NOTE || 'The backing track stays on your device; listeners hear the detected chords instead.'));
    }
    let renderT = 0;
    const renderSoon = () => { if (!renderT) renderT = M.later(() => { renderT = 0; render(); }, 30); };

    // ---------- import ----------
    async function importFile(file) {
      if (busy) { M.toast('Still reading the last track…'); return false; }
      if (!isAudio(file)) { M.toast('That is not an audio file (mp3, wav, ogg, m4a, flac)'); return false; }
      if (file.size > MAX_BYTES) { M.toast('That file is too big (' + (file.size / 1048576).toFixed(1) + ' MB; the limit is 30 MB)'); return false; }
      busy = { name: file.name, f: 0, label: 'Reading' }; render(); M.ui.drawer.reveal(sec);
      try {
        const ab = await file.arrayBuffer();
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OAC) throw new Error('This browser cannot decode audio');
        const dc = new OAC(1, 1, 44100);
        const buf = await new Promise((res, rej) => { const p = dc.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
        if (!alive) return false;
        if (buf.duration > MAX_SEC + 0.5) throw new Error('it is ' + Math.round(buf.duration / 60 * 10) / 10 + ' minutes long (the limit is 6)');
        const key = 'track:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        try { await VH.store.putBlob(key, file); } catch (err) { console.warn('[melody] track: could not store the file', err); }
        const an = await A.analyze(VH.analyze.monoOf(buf), buf.sampleRate, {
          onProgress: (f, label) => { if (busy) { busy.f = f; busy.label = label; renderSoon(); M.ui.toast('Analysing ' + file.name + '… ' + Math.round(f * 100) + '%', { sticky: true }); } },
          isAlive: () => alive,
        });
        if (!alive) return false;
        try { await VH.store.putBlob(key + ':an', an); } catch (err) { console.warn('[melody] track: could not store the analysis', err); }
        mem.set(key, { buf, an });
        busy = null;
        apply(key, file.name.replace(/\.[^.]+$/, '').slice(0, 120), an);
        return true;
      } catch (err) {
        busy = null; render();
        if (String(err && err.message) === 'cancelled' || !alive) return false;
        console.warn('[melody] track import failed', err);
        M.ui.toast('Could not use that file: ' + (err && err.message ? err.message : 'it could not be decoded'));
        return false;
      }
    }
    // Snap a detected tempo to a whole BPM when it is that close (most beats are made at a whole tempo).
    const snapBpm = (b) => (Math.abs(b - Math.round(b)) < 0.15 ? Math.round(b) : Math.round(b * 100) / 100);
    // The grid for a tempo + bar-1 offset: chords per bar, key, partial slots.
    function gridOf(an, bpm, offset) {
      const T = 60 / bpm, phase = ((offset % T) + T) % T, db = Math.round((offset - phase) / T);
      return A.grid(an.frames, bpm, phase, { dur: an.dur, downbeat: db });
    }
    function summary(g) {
      const seen = [];
      g.bars.slice(0, 8).forEach((b) => b.forEach((e) => { const l = chordLabel(e.c); if (seen[seen.length - 1] !== l) seen.push(l); }));
      return seen.slice(0, 8).join(' ');
    }
    function analysisOf(g) {
      return { nBars: g.nBars, key: { root: g.key.root, mode: g.key.mode }, bars: g.bars.map((b) => b.map((e) => [e.at].concat(e.c ? [e.c[0], e.c[1]] : []))), chords: summary(g) };
    }
    // Replace the sections with "Track A", "Track B", ... (8 bars each; 16 when the track is longer than 128 bars).
    function buildSections(S, tr, g) {
      const total = Math.min(g.nBars, md.MAX_SECTIONS * md.MAX_BARS), per = total > md.MAX_SECTIONS * 8 ? md.MAX_BARS : 8;
      const n = Math.min(md.MAX_SECTIONS, Math.ceil(total / per)), secs = {}, sections = [];
      for (let j = 0; j < n; j++) {
        const bars = Math.min(per, total - j * per), id = 'T' + (j + 1), layers = {};
        S.layers.forEach((l) => { layers[l.id] = { lines: [], notes: [] }; });
        const data = { bars, ts: '4/4', key: g.key.root, mode: g.key.mode, chords: chordsFor(g, j * per, bars), loopRegion: null, tension: 0, drums: {}, vib: null, auto: [], layers };
        sections.push({ id, name: 'Track ' + NAMES[j], color: md.SEC_COLORS[j % md.SEC_COLORS.length], rep: 1, data });
        secs[id] = j * per * 16;
      }
      S.sections = sections; S.cur = 0;
      md.applyContent(S, sections[0].data); sections[0].data = null;
      tr.secs = secs;
      return total < g.nBars ? g.nBars - total : 0;
    }
    function chordsFor(g, b0, bars) {
      const out = [];
      for (let i = 0; i < bars; i++) (g.bars[b0 + i] || [{ at: 0, c: null }]).forEach((e) => out.push({ at: i * 16 + e.at * 4, chord: e.c ? [e.c[0], e.c[1]] : null }));
      return md.normChords({ bars, ts: '4/4', chords: out });
    }
    function apply(key, name, an) {
      const S = M.song, bpm = snapBpm(an.tempo.bpm || 120);
      if (bpm < md.BPM_MIN || bpm > md.BPM_MAX) { M.toast('No steady beat found in that file'); render(); return; }
      const g = A.grid(an.frames, bpm, an.tempo.phase, { dur: an.dur });
      const tr = { blobKey: key, name, offsetSec: Math.round(g.first * 10000) / 10000, bpm, gainDb: -3, mute: false, bands: 'track', secs: {},
        analysis: Object.assign(analysisOf(g), { dur: Math.round(an.dur * 100) / 100, bpm0: Math.round(an.tempo.bpm * 1000) / 1000, offset0: Math.round(g.first * 10000) / 10000 }) };
      const cut = buildSections(S, tr, g);
      S.track = tr; S.bpm = bpm; S.backing.on = false; S.loopRegion = null;
      M.engine.applyMix(); M.engine.restartBacking();
      M.commit('Import backing track');
      M.emit('section', 0);
      M.ui.toast('Backing track: ' + bpm + ' BPM · ' + NOTE[g.key.root] + ' ' + g.key.mode + ' · ' + summary(g) + (cut ? ' (the last ' + cut + ' bars did not fit)' : ''), { action: { label: 'Undo', run: () => M.undo() } });
    }

    // ---------- corrections ----------
    function contentIn(S) {   // any notes or lines in the track's sections?
      for (let k = 0; k < S.sections.length; k++) {
        if (startOf(S, k) == null) continue;
        const s = md.sectionSong(S, k);
        if (s.layers.some((l) => l.notes.length || md.hasLine(l))) return true;
      }
      return false;
    }
    let tapT = 0;
    function setTempo(bpm, offset, label, defer) {
      const S = M.song, tr = S.track, c = cur && cur.an;
      bpm = Math.round(bpm * 100) / 100;
      if (!tr || !c) return;
      if (bpm < md.BPM_MIN || bpm > md.BPM_MAX) { M.toast('Tempo out of range (' + md.BPM_MIN + '–' + md.BPM_MAX + ' BPM)'); return; }
      const g = gridOf(c, bpm, offset);
      tr.bpm = bpm; tr.offsetSec = Math.round(offset * 10000) / 10000; S.bpm = bpm;
      tr.analysis = Object.assign({}, tr.analysis, analysisOf(g));
      if (!contentIn(S)) buildSections(S, tr, g);
      else if (!defer) M.toast('Sections kept (they hold notes); use detected chords or add bars if needed');
      M.forget(tapT); tapT = 0;
      if (defer) {   // tapping: show it now, one undo step once the taps stop
        regrid(); M.markBandsDirty(); M.requestRender(); renderSoon();
        tapT = M.later(() => { tapT = 0; M.commit(label); M.emit('section', M.song.cur); }, 1200);
        return;
      }
      M.commit(label);
      M.emit('section', S.cur);
    }
    function setOffset(off, label) {
      const S = M.song, tr = S.track;
      if (!tr) return;
      tr.offsetSec = Math.round(Math.max(-60, Math.min(600, off)) * 10000) / 10000;
      if (cur && cur.an) tr.analysis = Object.assign({}, tr.analysis, analysisOf(gridOf(cur.an, tr.bpm, tr.offsetSec)));
      M.commit(label);
    }
    let nudgeT = 0;
    function nudge(d) {   // quick repeated nudges join one undo step
      const tr = M.song.track;
      if (!tr) return;
      tr.offsetSec = Math.round((tr.offsetSec + d) * 10000) / 10000;
      regrid(); M.markBandsDirty(); M.requestRender(); renderSoon();
      M.forget(nudgeT); nudgeT = M.later(() => { nudgeT = 0; setOffset(M.song.track ? M.song.track.offsetSec : 0, 'Nudge track'); }, 600);
    }
    let taps = [];
    function onTap() {
      const E = M.engine, now = performance.now() / 1000;
      const tp = E.playing && playingSrc() ? trackNow() : null;
      if (taps.length && now - taps[taps.length - 1].w > 2.5) taps = [];
      taps.push({ w: now, t: tp });
      if (taps.length > 12) taps.shift();
      if (taps.length < 4) { M.toast('Tap ' + (4 - taps.length) + ' more'); return; }
      const d = []; for (let i = 1; i < taps.length; i++) d.push(taps[i].w - taps[i - 1].w);
      d.sort((a, b) => a - b);
      const P = d[d.length >> 1], bpm = Math.round(60 / P * 10) / 10, tr = M.song.track;
      let off = tr.offsetSec;
      const tt = taps.filter((x) => x.t != null).map((x) => x.t);
      if (tt.length >= 3) {   // beat phase from the taps (circular mean), kept near the old bar 1
        let cs = 0, sn = 0; tt.forEach((t) => { const a = 2 * Math.PI * t / P; cs += Math.cos(a); sn += Math.sin(a); });
        const ph = ((Math.atan2(sn, cs) / (2 * Math.PI) * P) % P + P) % P;
        off = ph + Math.round((tr.offsetSec - ph) / P) * P;
      }
      M.toast('Tapped ' + bpm + ' BPM');
      setTempo(bpm, off, 'Tap tempo', true);
    }
    // "Use detected chords": the detected chords into every track section (auto-fit moves clashing notes).
    function useChords() {
      const S = M.song, tr = S.track;
      if (!tr || !tr.analysis || !Array.isArray(tr.analysis.bars)) return;
      const g = { bars: tr.analysis.bars.map((b) => b.map((e) => ({ at: e[0], c: e.length > 2 ? [e[1], e[2]] : null }))) };
      S.sections.forEach((x, k) => {
        const st = startOf(S, k);
        if (st == null) return;
        const s = md.sectionSong(S, k), ch = chordsFor(g, Math.round(st / 16), s.bars);
        if (k === S.cur) S.chords = ch; else x.data.chords = ch;
        const key = tr.analysis.key;
        if (key) { if (k === S.cur) { S.key = key.root; S.mode = key.mode; } else { x.data.key = key.root; x.data.mode = key.mode; } }
      });
      M.commit('Use detected chords', { chords: S.chords.map((_, i) => i), source: 'chord' });
    }
    function remove() {
      const S = M.song;
      if (!S.track) return;
      S.track = null; S.backing.on = true;
      M.engine.applyMix(); M.engine.restartBacking();
      M.commit('Remove backing track');
      M.ui.toast('Backing track removed: the backing chords play again', { action: { label: 'Undo', run: () => M.undo() } });
    }

    // ---------- loading + grid (after an import, undo / redo, reload) ----------
    function regrid() {
      const tr = M.song.track;
      if (!tr || !cur || !cur.an) { if (cur) cur.slots = null; return; }
      const gk = tr.bpm + '@' + tr.offsetSec;
      if (cur.gk === gk) return;
      cur.gk = gk;
      cur.slots = A.slots(cur.an.frames, tr.bpm, tr.offsetSec, cur.an.dur);
      cur.slotObj = new Array(cur.slots.n);
    }
    function slotAt(i) {
      const s = cur.slots;
      if (i < 0 || i >= s.n) return null;
      let o = cur.slotObj[i];
      if (o !== undefined) return o;
      const hz = [], a = [];
      for (let j = 0; j < s.max; j++) { const f = s.hz[i * s.max + j]; if (f > 0) { hz.push(f); a.push(Math.sqrt(s.a[i * s.max + j])); } }
      o = cur.slotObj[i] = hz.length ? { key: cur.gk + ':' + i, hz, a } : null;
      return o;
    }
    function bandHook(t16) {
      const S = M.song, T = timeAt(S, S.cur, t16, true);
      if (T == null || !cur || !cur.slots) return null;
      return slotAt(Math.floor((T - cur.slots.t0) / cur.slots.dt + 1e-6));
    }
    let loadingKey = null;
    async function load(key) {
      if (loadingKey === key) return;
      loadingKey = key;
      cur = { key, buf: null, an: null, missing: false, gk: '', slots: null };
      const m = mem.get(key);
      if (m) { cur.buf = m.buf; cur.an = m.an; loadingKey = null; refresh(); return; }
      try {
        const [blob, an] = await Promise.all([VH.store.getBlob(key), VH.store.getBlob(key + ':an').catch(() => null)]);
        if (!alive || !cur || cur.key !== key) return;
        if (!blob) { cur.missing = true; loadingKey = null; refresh(); return; }
        const ab = await blob.arrayBuffer(), OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const buf = await new Promise((res, rej) => { const p = new OAC(1, 1, 44100).decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
        let a2 = an && an.frames ? an : null;
        if (!a2) a2 = await A.analyze(VH.analyze.monoOf(buf), buf.sampleRate, { isAlive: () => alive });
        if (!alive || !cur || cur.key !== key) return;
        mem.set(key, { buf, an: a2 });
        cur.buf = buf; cur.an = a2;
      } catch (err) {
        if (!alive) return;
        console.warn('[melody] track: could not load the audio', err);
        if (cur && cur.key === key) cur.missing = true;
      }
      loadingKey = null;
      refresh();
    }
    // Bring everything in line with M.song.track (import, undo / redo, load, tempo / offset / mute edits).
    function refresh() {
      const S = M.song, tr = S.track;
      if (!tr) {
        if (cur) { cur = null; stopAll(0.03); }
        M.hooks.bandTrack = null;
        if (removeRow) { removeRow(); removeRow = null; }
        M.markBandsDirty(); render();
        return;
      }
      if (!cur || cur.key !== tr.blobKey) { stopAll(0.03); load(tr.blobKey); }
      regrid();
      const on = tr.bands === 'track' && cur && cur.slots;
      if (M.hooks.bandTrack !== (on ? bandHook : null)) M.hooks.bandTrack = on ? bandHook : null;
      M.markBandsDirty();
      if (!removeRow) removeRow = M.ui.mixer.addRow({
        id: 'track', label: 'Track', color: '#e8a25c',
        get: () => (M.song.track ? volOf(M.song.track.gainDb) : 0),
        set: (v) => { if (M.song.track) { M.song.track.gainDb = Math.round(dbOf(v) * 10) / 10; applyGain(); } },
        commit: 'Track volume', muteTitle: 'Mute the backing track',
        mute: { get: () => !!(M.song.track && M.song.track.mute), set: (m) => { if (!M.song.track) return; M.song.track.mute = m; applyGain(); M.commit(m ? 'Mute track' : 'Unmute track'); } },
      });
      else M.ui.mixer.refresh();
      applyGain(); render();
    }

    // ---------- playback in sync with the playhead ----------
    // A look-ahead scheduler on engine.segments: each segment of song time [s, s + n) must sound track time
    // timeAt(s) .. at audio time w. A running source that already plays that (within TOL) is kept, else a new source
    // starts exactly at w (loop wraps, Song-mode passes, seeks) and the old one stops there. Drift beyond TOL for 3
    // frames (a slow frame, a tempo change) or beyond HARD at once re-syncs.
    let bus = null, srcs = [], bad = 0;
    const log = [];
    function ensureBus() {
      const mb = M.engine.masterBus();
      if (!mb) return null;
      if (!bus || bus.context !== mb.context) { bus = mb.context.createGain(); bus.connect(mb); applyGain(); }
      return bus;
    }
    function applyGain() {
      const tr = M.song.track;
      if (bus) bus.gain.setTargetAtTime(tr && !tr.mute ? volOf(tr.gainDb) : 0, bus.context.currentTime, 0.015);
    }
    function stopSrc(x, at, fade) {
      if (x.stopAt <= at + 1e-4) return;
      x.stopAt = at;
      try {
        if (fade) { x.g.gain.setValueAtTime(1, at); x.g.gain.linearRampToValueAtTime(0, at + fade); x.n.stop(at + fade); } else x.n.stop(at);
      } catch (_) { /* already stopped */ }
    }
    function stopAll(fade) {
      if (!bus) { srcs = []; return; }
      const now = bus.context.currentTime;
      srcs.forEach((x) => stopSrc(x, Math.max(now, x.when), fade || 0.02));
      srcs = [];
    }
    function startSrc(at, off) {
      const c = bus.context, buf = cur.buf;
      if (off < 0) { at -= off; off = 0; }
      if (off >= buf.duration - 0.01) return null;
      const n = c.createBufferSource(), g = c.createGain();
      n.buffer = buf; n.connect(g); g.connect(bus);
      const x = { n, g, when: at, off, stopAt: Infinity };
      n.onended = () => { const k = srcs.indexOf(x); if (k >= 0) srcs.splice(k, 1); try { g.disconnect(); } catch (_) { /* ignore */ } };
      n.start(at, off);
      srcs.push(x);
      return x;
    }
    const posOf = (x, at) => x.off + (at - x.when);
    function playingSrc() { if (!bus) return null; const now = bus.context.currentTime; return srcs.find((x) => x.when <= now + 1e-3 && x.stopAt > now) || null; }
    function trackNow() { const x = playingSrc(); return x ? posOf(x, bus.context.currentTime) : null; }
    M.onPlayTick((t) => {
      const S = M.song, tr = S.track;
      if (!tr || !cur || !cur.buf) { if (srcs.length) stopAll(0.03); return; }
      if (!ensureBus() || !t.ctxTime) return;
      let seg0 = null;
      const sec16 = t.secPer16, now = bus.context.currentTime, segs = M.engine.segments(t.cont16, t.cont16 + LOOKAHEAD / sec16);
      segs.forEach((g, i) => {
        const w = t.ctxTime + (g.c - t.cont16) * sec16, Tg = timeAt(S, S.cur, g.s), next = segs[i + 1];
        const end = next ? w + g.n * sec16 : Infinity;
        if (Tg == null) { srcs.forEach((x) => stopSrc(x, Math.max(now, w), 0.02)); return; }
        // the source that plays song time g.s at w (closest one); the current segment tolerates jitter for a few frames
        let x = null, err = Infinity;
        srcs.forEach((q) => { if (q.stopAt > w + 0.002 && q.when < w + g.n * sec16) { const e = Math.abs(posOf(q, w) - Tg); if (e < err) { err = e; x = q; } } });
        if (err < TOL) { if (i === 0) bad = 0; } else if (i === 0 && err < HARD && bad < 3) bad++; else x = null;
        if (!x) {
          const at = Math.max(w, now + 0.005), cut = at > w + 0.002;   // late (a seek, a re-sync): a short fade
          srcs.forEach((q) => { if (q.stopAt > at) stopSrc(q, at, cut ? 0.012 : 0); });
          x = startSrc(at, Tg + (at - w));
          bad = 0;
        }
        if (x && end < Infinity && x.stopAt > end + 1e-4) stopSrc(x, end, 0);
        if (i === 0) seg0 = x;
      });
      // drift log (tests): where the source sounding the playhead is vs where the playhead is (start-time maths)
      const Tp = timeAt(S, S.cur, t.pos16);
      if (seg0 && Tp != null) { log.push({ ctx: t.ctxTime, seek: t.seekId, wrapped: t.wrapped, drift: posOf(seg0, t.ctxTime) - Tp }); if (log.length > 3000) log.shift(); }
    });
    M.on('stop', () => stopAll(0.03));
    M.on('seek', () => { bad = 3; });

    // ---------- export (WAV / MP3): export.js emits 'renderAudio' with the song's bars ----------
    M.on('renderAudio', (x) => {
      const S = M.song, tr = S.track;
      if (!tr || !cur || !cur.buf || tr.mute) return;
      const g = x.ctx.createGain(); g.gain.value = volOf(tr.gainDb); g.connect(x.dest);
      const sec16 = x.sec16, pieces = [];
      for (let r = 0; r < x.loops; r++) {
        for (const b of x.bars) {
          const T = timeAt(S, b.k, b.b * b.n, false), t0 = (r * x.tot16 + b.t16) * sec16, d = b.n * sec16;
          if (T == null) continue;
          const p = pieces[pieces.length - 1];
          if (p && Math.abs(p.t0 + p.d - t0) < 1e-6 && Math.abs(p.T + p.d - T) < 1e-4) p.d += d; else pieces.push({ t0, T, d });
        }
      }
      pieces.forEach((p) => {
        let at = p.t0, off = p.T, d = p.d;
        if (off < 0) { at -= off; d += off; off = 0; }
        if (d <= 0 || off >= cur.buf.duration) return;
        const n = x.ctx.createBufferSource(); n.buffer = cur.buf; n.connect(g); n.start(at, off, Math.min(d, cur.buf.duration - off));
      });
    });

    // ---------- waveform strip + beat ticks under the chord header ----------
    let waveP = null;   // { w, k, path }: the strip's bars for the current view
    M.on('draw', (ctx, view) => {
      const S = M.song, tr = S.track;
      if (!tr || !cur || !cur.an || !cur.an.wave) return;
      const st = startOf(S, S.cur);
      if (st == null) return;
      const y0 = view.HDR, h = 16, U = view.U(), tot = md.tot16(S), w = cur.an.wave, res = cur.an.waveRes || 0.01;
      const x0 = Math.max(0, Math.floor(view.scrollX)), x1 = Math.min(Math.ceil(view.scrollX + view.GW), Math.ceil(view.xOf(tot)));
      ctx.save();
      ctx.fillStyle = 'rgba(6, 8, 18, 0.62)'; ctx.fillRect(x0, y0, x1 - x0, h);
      ctx.fillStyle = 'rgba(232, 162, 92, 0.85)';
      // the bars only change with the view or the sync: one cached path instead of a fillRect per pixel every frame
      const wk = [x0, x1, U, y0, S.cur, timeAt(S, S.cur, 0), timeAt(S, S.cur, 1)].join(',');
      if (!waveP || waveP.w !== w || waveP.k !== wk) {
        let pk = 0; for (let i = 0; i < w.length; i++) if (w[i] > pk) pk = w[i];
        pk = pk || 1;
        const path = new Path2D();
        for (let x = x0; x < x1; x++) {
          const ta = timeAt(S, S.cur, x / U), tb = timeAt(S, S.cur, (x + 1) / U);
          let m = 0;
          for (let i = Math.max(0, Math.floor(ta / res)); i <= Math.min(w.length - 1, Math.floor(tb / res)); i++) if (w[i] > m) m = w[i];
          const hh = Math.max(0.5, (m / pk) * (h - 2));
          path.rect(x, y0 + h / 2 - hh / 2, 1, hh);
        }
        waveP = { w, k: wk, path };
      }
      ctx.fill(waveP.path);
      // the song's beats (where the sync puts the track's beats): ticks, taller on bar lines
      const spb = md.spb(S);
      for (let b = 0; b <= tot; b += 4) {
        const x = view.xOf(b);
        if (x < x0 - 1 || x > x1 + 1) continue;
        const bar = b % spb === 0;
        ctx.fillStyle = bar ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)';
        ctx.fillRect(Math.round(x), y0, bar ? 2 : 1, bar ? h : 6);
      }
      ctx.restore();
    });

    // ---------- drop: "Backing track or instrument?" ----------
    M.askDrop = (fs, asSounds) => {
      if (fs.length !== 1) return asSounds(fs);
      const D = ui.modal('mel-track-ask', 'Backing track or instrument?');
      const p = ui.h('p', 'vh-desc'); p.textContent = fs[0].name + ': use it as a backing track (Melody follows its beat and chords), or as an instrument / sound?';
      D.body.append(p);
      const b1 = ui.h('button', 'vh-btn mel-ask-track'); b1.type = 'button'; b1.textContent = 'Backing track';
      const b2 = ui.h('button', 'vh-btn mel-ask-sound'); b2.type = 'button'; b2.textContent = 'Instrument / sound';
      b1.addEventListener('click', () => { D.close(); importFile(fs[0]); });
      b2.addEventListener('click', () => { D.close(); asSounds(fs); });
      D.foot.append(b1, b2);
      b1.focus();
      return null;
    };

    // tempo slider moved away from the track: warn once per change (the sync assumes the detected tempo)
    const watch = () => {
      const S = M.song, tr = S.track;
      if (tr && Math.abs(S.bpm - tr.bpm) > 0.005) {
        if (warnedBpm !== S.bpm) { warnedBpm = S.bpm; M.ui.toast('The track was detected at ' + tr.bpm + ' BPM: the sync assumes that tempo'); render(); }
      } else if (warnedBpm != null) { warnedBpm = null; render(); }
      M.later(watch, 700);
    };
    M.later(watch, 700);

    M.on('song', refresh);
    refresh();
    NS.trackPart = {   // tests / console
      importFile, useChords, remove, setTempo, nudge, setOffset,
      get cur() { return cur; }, get busy() { return busy; }, log, srcs: () => srcs.slice(), trackNow, timeAt: (k, t16, b) => timeAt(M.song, k, t16, b),
      ready: () => !!(cur && cur.buf && cur.an && !busy),
    };
    return {
      destroy() {
        alive = false; stopAll(0.02);
        if (bus) { try { bus.disconnect(); } catch (_) { /* ignore */ } bus = null; }
        M.hooks.bandTrack = null; delete M.askDrop;
        if (NS.trackPart && NS.trackPart.importFile === importFile) NS.trackPart = null;
      },
    };
  });
})();
