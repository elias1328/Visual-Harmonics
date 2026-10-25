// melody/ui.js - dock, Settings panel sections, chord picker, layer menu, mixer strip, tone controls, toast, share box.
// Parts extend it through M.ui.addDockButton / addPanelSection / addTool. See MELODY.md (M.ui).
(function () {
  'use strict';
  const VH = window.VH, ui = VH.ui, NS = VH.melody, md = NS.model;
  const { MAX_LAYERS, BPM_MIN, BPM_MAX, clamp, namesOf, chordName, scaleOf, diatonic, QUALS } = md;
  const TONE_DEF = { stretch: 1, bright: 0 };

  NS.UI = function (M, el, dock, caption) {
    const U = { dock, el };
    const later = M.later;

    // ---------- dock ----------
    const playBtn = ui.dockButton(dock, { icon: '▶', label: 'Play', title: 'Play / stop (Space)', onClick: () => M.engine.toggle() });
    const instSel = ui.soundPicker(dock, { title: 'Instrument of the active layer', value: M.song.layers[0].sound, mode: 'line',
      onChange: (id) => M.setLayerSound(M.active, id), onImport: (ss) => imported(ss) });
    // Imported sounds (picker, or audio files dropped on the graph): instruments go on the active layer (or the backing),
    // one-shots become new drum-lane rows (sound.js M.kit).
    function imported(ss, backing) {
      if (!ss || !ss.length) return;
      const inst = ss.filter((s) => !s.drum), drums = ss.filter((s) => s.drum), msg = [];
      if (drums.length && M.kit) { const n = M.kit.addSounds(drums); msg.push(n ? drums.map((s) => s.name).join(', ') + ' added to the drum kit' : 'The drum kit is full (8 rows)'); }
      if (inst.length) {
        if (backing) M.setBackingSound(inst[0].id); else M.setLayerSound(M.active, inst[0].id);
        msg.push('Now playing ' + inst[0].name + ' on ' + (backing ? 'the backing' : (M.song.layers[M.active] || {}).name));
      }
      if (msg.length) U.toast(msg.join(' · '));
    }
    // A dropped file may also be a backing track (track.js asks "Backing track or instrument?" via M.askDrop).
    const asSounds = (fs) => ui.importSounds(fs).then((ss) => imported(ss));
    M.cleanups.push(ui.dropTarget(M.view.cv, (fs) => (typeof M.askDrop === 'function' ? M.askDrop(fs, asSounds) : asSounds(fs))));
    const layEl = ui.h('div', 'vh-dock-btn mel-layers'), chipBox = ui.h('span', 'ic'), layLb = ui.h('span', 'lb');
    layEl.title = 'Layers: tap to switch, tap the active one for its menu';
    layEl.append(chipBox, layLb); dock.append(layEl);
    let chips = [];
    const addChip = ui.h('button', 'mel-chip mel-add', '+'); addChip.type = 'button';
    addChip.title = 'Add a layer'; addChip.setAttribute('aria-label', 'Add a layer');
    addChip.addEventListener('click', (e) => { e.stopPropagation(); M.addLayer(); });
    layEl.addEventListener('click', () => M.setActive((M.active + 1) % M.song.layers.length));
    function buildChips() {
      chips.forEach((c) => c.remove());
      chips = M.song.layers.map((l, i) => {
        const b = ui.h('button', 'mel-chip'); b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); if (i === M.active) layerMenu.toggle(i, b); else M.setActive(i); });
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); M.setActive(i); layerMenu.open(i, b); });
        chipBox.insertBefore(b, addChip);
        return b;
      });
    }
    chipBox.append(addChip);
    // One Tool button: shows the current tool, opens a small pop-over with every tool and its key.
    const toolBtn = ui.dockButton(dock, { icon: '✎', label: 'Draw', title: 'Tool', onClick: () => toolPop.toggle() });
    toolBtn.classList.add('mel-toolbtn');
    toolBtn.setAttribute('aria-haspopup', 'true'); toolBtn.setAttribute('aria-expanded', 'false');
    const mixBtn = ui.dockButton(dock, { icon: '≡', label: 'Mixer', title: 'Mixer: layer volumes, mute, solo', pressed: false, onClick: () => mixer.toggle() });
    mixBtn.setAttribute('aria-expanded', 'false');
    ui.dockButton(dock, { icon: '⤴', label: 'Share', title: 'Copy a link to this song', onClick: () => M.share() }).classList.add('mel-dock-share');
    const dr = ui.drawer(el, dock, { title: 'Melody' });
    U.drawer = dr;

    U.addDockButton = function (o) { const b = ui.dockButton(dock, o); dock.insertBefore(b, dr.button); return b; };
    U.addTool = function (tool) {
      const t = M.tools.add(tool);
      syncTools();
      return t;
    };
    // Tool pop-over items: by default every registered tool; a part (B1) can supply its palette + pick function
    // with U.configureTools({ items: [[id, icon, label, key, title], ...], pick(id) }).
    let toolCfg = null;
    U.configureTools = (cfg) => { toolCfg = cfg && Array.isArray(cfg.items) ? cfg : null; syncTools(); };
    const toolItems = () => (toolCfg ? toolCfg.items.filter((x) => M.tools.list.some((t) => t.id === x[0]))
      : M.tools.list.map((t) => [t.id, t.icon || '•', t.label || t.id, '', t.title || t.label || t.id]));
    function syncTools() {
      const cur = M.tools.current, it = cur && toolItems().find((x) => x[0] === cur.id);
      const icon = it ? it[1] : cur ? cur.icon || '✎' : '✎', label = it ? it[2] : cur ? cur.label || cur.id : 'Draw';
      toolBtn.set({ icon, label });
      toolBtn.title = 'Tool: ' + label + (it && it[3] ? ' (' + it[3] + ')' : '') + ' · click to choose';
      toolBtn.setAttribute('aria-label', 'Tool: ' + label);
      toolBtn.dataset.tool = cur ? cur.id : '';
      if (!tpop.hidden) renderToolPop();
    }
    U.setTool = (id) => { M.tools.set(id); syncTools(); };
    U.pickTool = (id) => { if (toolCfg && toolCfg.pick) toolCfg.pick(id); else U.setTool(id); };
    U.syncTools = () => syncTools();

    // ---------- Settings panel sections (ordered) ----------
    // addPanelSection(title, order = 60, { group, collapsed, advanced }) or addPanelSection({ title, order, group, ... }).
    // group: 'song' | 'sound' | 'mix' | 'edit' | 'export' (tabs of the Settings panel; anything else -> 'General').
    U.addPanelSection = function (title, order, opts) {
      const o = title && typeof title === 'object' ? Object.assign({}, title) : Object.assign({ title, order }, opts);
      return dr.addSection(o);
    };
    U.panel = dr.body;
    U.openPanel = (group) => dr.open(group);

    // Song: key, bars, tempo, loop (Generate and "How to read it" join this tab)
    const sSong = U.addPanelSection('Song', 10, { group: 'song' });
    const keyRow = ui.h('div', 'vh-row mel-keyrow');
    const keySel = ui.h('select', 'vh-select'), modeSel = ui.h('select', 'vh-select');
    keySel.setAttribute('aria-label', 'Key'); modeSel.setAttribute('aria-label', 'Scale');
    // Key = root + scale, per section (a song can modulate). Scales grouped Common / Modes / Exotic, each with a mood hint.
    modeSel.innerHTML = md.SCALE_GROUPS.map((g) => '<optgroup label="' + g + '">' + VH.harmony.SCALES.filter((x) => x.group === g)
      .map((x) => '<option value="' + x.id + '" title="' + ui.esc(x.hint) + '">' + ui.esc(x.name) + '</option>').join('') + '</optgroup>').join('');
    modeSel.classList.add('mel-scale');
    keySel.title = 'Key root of the section shown'; modeSel.title = 'Scale of the section shown';
    keyRow.append(ui.h('span', 'mel-lbl', 'Key'), keySel, modeSel); sSong.append(keyRow);
    const scaleHint = ui.h('div', 'vh-desc mel-scalehint'); sSong.append(scaleHint);
    const fillKeys = () => {
      const S = M.song, n = namesOf(S), sc = scaleOf(S);
      keySel.innerHTML = n.map((x, i) => '<option value="' + i + '">' + x + '</option>').join(''); keySel.value = S.key;
      scaleHint.textContent = sc.name.replace(/ \(.*\)$/, '') + ': ' + sc.hint + (S.sections.length > 1 ? ' · this section' : '');
    };
    keySel.addEventListener('change', () => { M.song.key = +keySel.value; M.commit('Key'); });
    modeSel.addEventListener('change', () => { M.song.mode = modeSel.value; M.commit('Scale: ' + scaleOf(M.song).name.replace(/ \(.*\)$/, '')); });
    // Tuning (song-wide): the pitch grid, snap targets, the strip and the backing's chord tones follow it.
    const tunRow = ui.h('div', 'vh-row mel-keyrow mel-tunrow'); sSong.append(tunRow);
    tunRow.append(ui.h('span', 'mel-lbl', 'Tuning'));
    const tunSel = ui.select(tunRow, { label: 'Tuning of the song', value: md.tuningOf(M.song),
      options: md.TUNINGS.map((t) => ({ value: t.id, label: t.name })), onChange: (v) => { M.song.tuning = v; M.commit('Tuning: ' + VH.harmony.tuningById(v).name); } });
    tunSel.el.classList.add('mel-tuning');
    const sclBtn = ui.button(tunRow, { label: '⤓ .scl', onClick: () => {
      const id = md.tuningOf(M.song), url = URL.createObjectURL(new Blob([VH.harmony.sclText(id)], { type: 'text/plain' })), a = document.createElement('a');
      a.href = url; a.download = 'visual-harmonics-' + id + '.scl'; a.rel = 'noopener'; a.style.display = 'none';
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
      U.lastScl = { id, name: a.download };
    } });
    sclBtn.classList.add('mel-scl'); sclBtn.title = 'Download tuning (.scl): a Scala file of this tuning for synths and DAWs';
    const tunHint = ui.h('div', 'vh-desc mel-tunhint'); sSong.append(tunHint);
    const syncTuning = () => {
      const t = VH.harmony.tuningById(M.song.tuning);
      tunSel.value = t.id;
      tunHint.textContent = t.id === '12tet' ? 'Bands are physics, so they work in any tuning: try 19-TET or just intonation.'
        : t.name + ': ' + t.hint + '. Rows, snap and the backing use its steps (from the key root); export plays it exactly (MIDI with pitch bends).';
    };
    const seg = (parent, label, vals, fmt, on) => {
      const row = ui.h('div', 'vh-row mel-seg'); row.append(ui.h('span', 'mel-lbl', label));
      const bs = vals.map((v) => ui.button(row, { label: fmt(v), pressed: false, onClick: () => on(v) }));
      parent.append(row);
      return (cur) => bs.forEach((b, i) => b.set({ pressed: vals[i] === cur }));
    };
    // Bars + time signature belong to the section shown (Song: the arrangement strip above the chords)
    const meterRow = ui.h('div', 'vh-row mel-keyrow mel-meter'); sSong.append(meterRow);
    meterRow.append(ui.h('span', 'mel-lbl', 'Bars'));
    const barsSel = ui.select(meterRow, { label: 'Bars in this section', value: M.song.bars,
      options: Array.from({ length: md.MAX_BARS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), onChange: (v) => M.setBars(+v) });
    meterRow.append(ui.h('span', 'mel-lbl', 'Time'));
    const tsSel = ui.select(meterRow, { label: 'Time signature of this section', value: M.song.ts || '4/4',
      options: md.TS_LIST.map((t) => ({ value: t, label: t })), onChange: (v) => M.setTimeSig(v) });
    barsSel.el.classList.add('mel-bars'); tsSel.el.classList.add('mel-ts');
    const syncBars = (n) => { barsSel.value = String(n); tsSel.value = M.song.ts || '4/4'; };
    const tempoSl = ui.slider(sSong, { label: 'Tempo', min: BPM_MIN, max: BPM_MAX, step: 1, value: M.song.bpm, fmt: (v) => v + ' BPM',
      desc: 'Quarter notes per minute, for the whole song. Bars and time signature belong to the section shown.', onInput: (v) => { M.song.bpm = v; VH.store.set('melody.bpm', v); M.save(); } });
    tempoSl.input.addEventListener('change', () => M.commit('Tempo'));
    const tenSl = ui.slider(sSong, { label: 'Tension', min: 0, max: 1, step: 0.01, value: M.song.tension || 0, fmt: (v) => md.tensionName(v) + ' \u00b7 ' + Math.round(v * 100) + '%',
      desc: 'What the map highlights, for the section shown. Calm: the most consonant notes. Color: spicy 7ths, 9ths, 11ths and 13ths. Tense: the roughest clashes. Snap, auto-fit and the dice follow it; playback and export are unchanged.',
      onInput: (v) => M.setTension(v) });
    tenSl.input.addEventListener('change', () => M.setTension(+tenSl.input.value, true));
    const pRow = ui.h('div', 'vh-row mel-seg'); pRow.append(ui.h('span', 'mel-lbl', 'Play')); sSong.append(pRow);
    const loopBtn = ui.button(pRow, { label: 'Loop', pressed: M.song.loop, onClick: () => { M.song.loop = !M.song.loop; U.sync(); M.save(); } });
    loopBtn.title = 'Play the song in a loop';
    const countOn = () => VH.store.get('melody.countIn', false) === true;
    const countBtn = ui.button(pRow, { label: 'Count-in', pressed: countOn(), onClick: () => { VH.store.set('melody.countIn', !countOn()); countBtn.set({ pressed: countOn() }); } });
    countBtn.title = 'Metronome count-in: one bar of clicks (accent on beat 1) before playback starts';
    countBtn.classList.add('mel-countin');
    const regRow = ui.h('div', 'vh-row mel-regrow'); sSong.append(regRow);
    const regTxt = ui.h('span', 'vh-desc mel-regtxt');
    regRow.append(regTxt);
    const regClear = ui.button(regRow, { label: 'Clear loop region', onClick: () => M.setLoopRegion(null) });
    function syncRegion() {
      const r = md.regionOf(M.song);
      regTxt.textContent = r ? 'Loop region: bar' + (r[1] - r[0] > 1 ? 's ' + (r[0] + 1) + '–' + r[1] : ' ' + (r[0] + 1)) + ' (only these play)'
        : 'Drag across the chord strip to loop some bars; click its empty space to jump there.';
      regClear.hidden = !r;
    }

    // Edit tab: grid + snap
    const sGrid = U.addPanelSection('Grid & snap', 10, { group: 'edit' });
    const syncGrid = seg(sGrid, 'Grid', md.GRIDS, (v) => md.GRID_LABEL[v], (g) => { M.song.grid = g; U.sync(); M.save(); });
    const snRow = ui.h('div', 'vh-row mel-seg'); snRow.append(ui.h('span', 'mel-lbl', 'Snap')); sGrid.append(snRow);
    const snapPanelBtn = ui.button(snRow, { label: 'Snap to bright bands', title: 'Snap to bright bands (S)', pressed: M.song.snap, onClick: () => U.toggleSnap(true) });
    snapPanelBtn.title = 'Pitches snap to the brightest band nearby (key: S)';
    snapPanelBtn.classList.add('mel-snapbtn');
    U.toggleSnap = (quiet) => {
      M.song.snap = !M.song.snap; U.sync(); M.save();
      if (!quiet) U.toast('Snap to bright bands: ' + (M.song.snap ? 'on' : 'off') + ' (S)');
    };
    sGrid.append(ui.h('div', 'vh-desc', 'Grid: the note length in Notes mode.'));

    // Export tab: share link (Export… joins this tab)
    const sShare = U.addPanelSection('Share', 10, { group: 'export' });
    const shRow = ui.h('div', 'vh-row'); sShare.append(shRow);
    ui.button(shRow, { label: '⤴ Copy share link', onClick: () => M.share() }).title = 'Copy a link to this song (also in the dock)';
    if (VH.gallery && VH.gallery.openPublish) ui.button(shRow, { label: '☁ Publish to gallery', onClick: () => M.publish() }).classList.add('mel-publish');
    sShare.append(ui.h('div', 'vh-desc', 'The link holds the whole song, so anyone who opens it hears what you hear.'));
    // Songs with the user's own sounds: their audio can't travel in a link (main.js M.SHARE_NOTE).
    const shNote = ui.h('div', 'vh-desc mel-share-note'); sShare.append(shNote);
    const syncShareNote = () => { const own = M.unsharedSounds ? M.unsharedSounds() : (M.ownSounds ? M.ownSounds() : []); shNote.textContent = own.length ? M.SHARE_NOTE : ''; shNote.hidden = !own.length; };
    M.on('song', syncShareNote); M.on('sounds', syncShareNote); setTimeout(syncShareNote, 0);

    // Backing (independent instrument for the chords)
    const sBack = U.addPanelSection('Backing', 25, { group: 'sound' });
    sBack.append(ui.h('div', 'vh-desc', 'Holds each bar’s chord on its own instrument. Its overtones also shape the bands.'));
    const bRow = ui.h('div', 'vh-row'); sBack.append(bRow);
    const backBtn = ui.button(bRow, { label: 'Chord backing', pressed: M.song.backing.on, onClick: () => {
      M.song.backing.on = !M.song.backing.on; M.engine.applyMix(); M.engine.restartBacking(); M.commit('Backing on/off'); } });
    const backSel = ui.soundPicker(sBack, { title: 'Backing instrument', value: M.song.backing.sound, onChange: (id) => M.setBackingSound(id), onImport: (ss) => imported(ss, true) });
    backSel.el.classList.add('mel-backsel');
    const backSl = ui.slider(sBack, { label: 'Backing volume', min: 0, max: md.VOL_MAX, step: 0.01, value: M.song.backing.vol, fmt: md.volLabel,
      onInput: (v) => { M.song.backing.vol = v; M.engine.applyMix(); M.save(); } });
    backSl.input.addEventListener('change', () => M.commit('Backing volume'));
    backSl.input.title = 'Double-click: 100 %';
    backSl.input.addEventListener('dblclick', () => { backSl.set(1); M.song.backing.vol = 1; M.engine.applyMix(); M.commit('Backing volume'); });

    // Tone of the active layer's instrument
    const sTone = U.addPanelSection('Instrument tone', 22, { group: 'sound' });
    const toneHead = ui.h('div', 'vh-desc mel-tone-head'); sTone.append(toneHead);
    const toneSl = {
      n: ui.slider(sTone, { label: 'Overtones', min: 1, max: 16, step: 1, value: 8, onInput: (v) => toneInput('n', v) }),
      stretch: ui.slider(sTone, { label: 'Stretch', min: 0.9, max: 1.1, step: 0.001, value: 1, fmt: (v) => 'k^' + v.toFixed(3), onInput: (v) => toneInput('stretch', v) }),
      bright: ui.slider(sTone, { label: 'Brightness', min: -1, max: 1, step: 0.01, value: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2), onInput: (v) => toneInput('bright', v) }),
    };
    Object.values(toneSl).forEach((s) => s.input.addEventListener('change', () => { flushTone(); M.commit('Tone'); }));
    const toneNote = ui.h('div', 'vh-desc mel-tone-note'); sTone.append(toneNote);
    const tRow = ui.h('div', 'vh-row'); sTone.append(tRow);
    const toneReset = ui.button(tRow, { label: 'Reset', onClick: () => resetTone() });
    toneReset.title = 'Back to the original instrument';

    // Harmony
    const sHarm = U.addPanelSection('Harmony map', 60, { group: 'edit' });
    const hRow = ui.h('div', 'vh-row'); sHarm.append(hRow);
    const othersBtn = ui.button(hRow, { label: 'Bands include other layers', pressed: M.song.bandsOthers, onClick: () => {
      M.song.bandsOthers = !M.song.bandsOthers; M.bands.invalidate(); M.commit('Bands include other layers'); } });
    sHarm.append(ui.h('div', 'vh-desc', 'Off: bands compare the active layer with the chord. On: the other layers’ notes count too.'));
    const sRow = ui.h('div', 'vh-row'); sHarm.append(sRow);
    const showScaleBtn = ui.button(sRow, { label: 'Show scale', pressed: M.view.showScale, onClick: () => {
      M.view.setShowScale(!M.view.showScale); } });
    M.view.onScale = () => showScaleBtn.set({ pressed: M.view.showScale });
    showScaleBtn.classList.add('mel-showscale');
    sHarm.append(ui.h('div', 'vh-desc', 'A faint tint on the rows and keys of the section’s scale.'));

    // Map look (view preferences; the same controls sit in the 🎨 chip pop-over on the map)
    const sLook = U.addPanelSection('Map look', 58, { group: 'edit' });
    M.view.buildLook(sLook);

    // Edit
    const sEdit = U.addPanelSection('Undo & clear', 50, { group: 'edit' });
    const eRow = ui.h('div', 'vh-row'); sEdit.append(eRow);
    const undoBtn = ui.button(eRow, { label: '↶ Undo', onClick: () => M.undo() });
    const redoBtn = ui.button(eRow, { label: '↷ Redo', onClick: () => M.redo() });
    ui.button(eRow, { label: 'Clear layer', onClick: () => { const l = M.song.layers[M.active]; l.lines = []; l.notes = []; M.commit('Clear layer'); } });
    ui.button(eRow, { label: 'Clear all', onClick: () => { M.song.layers.forEach((l) => { l.lines = []; l.notes = []; }); M.commit('Clear all'); } });
    const sNote = U.addPanelSection('', 85, { group: 'sound' });
    ui.samplesNote(sNote);
    U.addPanelSection('How to read it', 90, { group: 'song', collapsed: true }).append(ui.h('div', 'vh-desc',
      'X = time, Y = pitch C3–C6. Brightness = how smoothly a pitch blends with that bar’s chord: the active layer’s overtones ' +
      'against the chord played by the backing instrument, so every pairing has its own map. Tap a chord name to change it. ' +
      'Line mode: draw freely. Notes mode: click to place a note, drag right to lengthen, click a note to delete it. ' +
      'Tap the active layer dot for rename / mute / solo / delete. Space = play / stop, Ctrl+Z = undo.'));

    // ---------- floating panels (chord picker, layer menu, mixer) + toast + share box ----------
    const pop = ui.h('div', 'mel-pop'); pop.hidden = true; pop.setAttribute('role', 'dialog');
    const lmenu = ui.h('div', 'mel-float mel-layermenu'); lmenu.hidden = true; lmenu.setAttribute('role', 'dialog');
    const mix = U.addPanelSection('Mixer', 10, { group: 'mix' }); mix.classList.add('mel-mixer');
    const shareBox = ui.h('div', 'mel-sharebox', '<span>Copy this link:</span><input type="text" readonly aria-label="Share link"><button type="button" class="vh-btn mel-sb-pub" hidden>Publish to gallery</button><button type="button" class="vh-btn mel-sb-done">Done</button><div class="mel-share-note" hidden></div>');
    shareBox.hidden = true;
    const toastEl = ui.h('div', 'mel-toast', '<span class="t"></span><button type="button" class="a"></button>'); toastEl.setAttribute('role', 'status');
    const toastTxt = toastEl.firstChild, toastAct = toastEl.lastChild;
    let toastRun = null;
    toastAct.hidden = true;
    toastAct.addEventListener('click', () => { const f = toastRun; hideToast(); if (f) f(); });
    el.append(pop, lmenu, shareBox, toastEl);
    let toastT = 0;
    function hideToast() { M.forget(toastT); toastT = 0; toastEl.classList.remove('on', 'act'); toastRun = null; }
    // toast(msg, { sticky, action: { label, run } }): sticky stays until replaced or toast(null); an action adds a button.
    U.toast = function (msg, o) {
      o = o || {};
      if (msg == null) { hideToast(); return; }
      const hint = document.querySelector('.vh-stage > .vh-hint');   // the load hint sits in the same spot
      if (hint) hint.classList.add('gone');
      toastTxt.textContent = msg;
      const a = o.action && o.action.label ? o.action : null;
      toastRun = a ? a.run : null;
      toastAct.textContent = a ? a.label : ''; toastAct.hidden = !a;
      // just under the chord header strip, so chord names stay visible and clickable (e.g. while placing a chord)
      const er = el.getBoundingClientRect(), cr = M.view.cv.getBoundingClientRect(), k = cr.height / M.view.TH || 1;
      if (cr.height > 0) toastEl.style.top = Math.round(Math.max(8, cr.top - er.top + M.view.Y0 * k + 8)) + 'px';
      toastEl.classList.add('on'); toastEl.classList.toggle('act', !!a); toastEl.classList.toggle('sticky', !!o.sticky);
      M.forget(toastT); toastT = 0;
      if (!o.sticky) toastT = later(() => { toastEl.classList.remove('on', 'act'); toastRun = null; }, a ? 6000 : 2600);
    };
    U.toastEl = toastEl;
    shareBox.querySelector('.mel-sb-done').addEventListener('click', () => { shareBox.hidden = true; });
    const sbPub = shareBox.querySelector('.mel-sb-pub');
    sbPub.hidden = !(VH.gallery && VH.gallery.openPublish);
    sbPub.addEventListener('click', () => { shareBox.hidden = true; M.publish(); });
    shareBox.querySelector('input').addEventListener('focus', (e) => e.target.select());
    U.showShareBox = (url) => { const inp = shareBox.querySelector('input'); inp.value = url; shareBox.hidden = false; inp.focus(); inp.select(); };
    U.hideShareBox = () => { shareBox.hidden = true; };
    U.showShareNote = (txt) => { const n = shareBox.querySelector('.mel-share-note'); n.textContent = txt || ''; n.hidden = !txt; };
    function floatAbove(box, anchor) {   // place a floating panel above the dock, centred on the anchor
      const er = el.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), dr0 = dock.getBoundingClientRect(), w = box.offsetWidth;
      box.style.left = clamp(ar.left - er.left + ar.width / 2 - w / 2, 8, Math.max(8, er.width - w - 8)) + 'px';
      box.style.bottom = (er.bottom - dr0.top + 8) + 'px';
      box.style.maxHeight = Math.max(140, dr0.top - er.top - 16) + 'px';
    }

    // tool pop-over (dock Tool button)
    const tpop = ui.h('div', 'mel-float mel-toolpop'); tpop.hidden = true; tpop.setAttribute('role', 'menu'); tpop.setAttribute('aria-label', 'Tools');
    el.append(tpop);
    function renderToolPop() {
      const cur = M.tools.current;
      tpop.innerHTML = '';
      toolItems().forEach(([id, icon, label, key, title]) => {
        const b = ui.h('button', '', '<span class="i"></span><span class="l"></span><kbd></kbd>'), on = !!cur && cur.id === id;
        b.type = 'button'; b.dataset.id = id; b.setAttribute('role', 'menuitemradio');
        b.children[0].textContent = icon; b.children[1].textContent = label; b.children[2].textContent = key || '';
        b.children[2].hidden = !key;
        b.title = title || label; b.setAttribute('aria-label', label + ' tool' + (key ? ' (' + key + ')' : ''));
        b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-checked', String(on));
        tpop.append(b);
      });
    }
    tpop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      U.pickTool(b.dataset.id);
      toolPop.close(); toolBtn.focus({ preventScroll: true });
    });
    tpop.addEventListener('keydown', (e) => {
      const bs = [...tpop.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      const j = { ArrowDown: i + 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bs.length - 1 }[e.key];
      if (j == null || !bs.length) return;
      e.preventDefault(); e.stopPropagation(); bs[(j + bs.length) % bs.length].focus();
    });
    const toolPop = U.toolPop = {
      get isOpen() { return !tpop.hidden; },
      open() {
        picker.close(); layerMenu.close();
        renderToolPop(); tpop.hidden = false; floatAbove(tpop, toolBtn);
        toolBtn.setAttribute('aria-expanded', 'true'); toolBtn.set({ pressed: true });
        const f = tpop.querySelector('[aria-pressed="true"]') || tpop.querySelector('button');
        if (f) f.focus({ preventScroll: true });
      },
      close() { if (tpop.hidden) return; tpop.hidden = true; toolBtn.setAttribute('aria-expanded', 'false'); toolBtn.set({ pressed: false }); },
      toggle() { if (tpop.hidden) toolPop.open(); else toolPop.close(); },
    };

    // chord picker
    let popBar = -1;
    function renderPicker() {
      const S = M.song, b = popBar, names = namesOf(S), cur = md.regionChord(S, b), sc = scaleOf(S), e = S.chords[b] || { at: 0 };
      const n = md.spb(S), bar = Math.floor(e.at / n), split = e.at % n || md.regionEnd(S, b) % n || (S.chords[b + 1] && md.barAt(S, S.chords[b + 1].at) === bar);
      const beat = md.tsOf(S).beats.indexOf(e.at % n), where = 'Bar ' + (bar + 1) + (split ? ' · ' + (beat >= 0 ? 'beat ' + (beat + 1) : 'at ' + (e.at % n) + '/16') : '');
      const pcs = new Set(sc.steps.map((st) => (S.key + st) % 12)), qs = md.scaleChords(S);
      const same = (r, q) => cur && cur[0] === r && cur[1] === q;
      let h = '<div class="mel-pop-head"><span><b>' + where + '</b> · ' + ui.esc(chordName(cur, names)) + '</span>' +
        '<button type="button" class="vh-icon-btn x" aria-label="Close">✕</button></div>' +
        '<div class="mel-sub">In ' + ui.esc(md.scaleLabel(S)) + (sc.steps.length !== 7 ? ' <span>· chords that fit the scale</span>' : '') + '</div><div class="mel-quick' + (qs.length > 7 ? ' many' : '') + '">';
      qs.forEach(({ r, q, rn }) => {
        h += '<button type="button" class="q' + (same(r, q) ? ' cur' : '') + '" data-r="' + r + '" data-q="' + q + '" data-rn="' + ui.esc(rn) + '"><b>' +
          chordName([r, q], names) + '</b><i>' + rn + '</i></button>';
      });
      h += '</div><div class="mel-sub">Any chord <span>· tinted = all notes in the scale</span></div><div class="mel-grid"><span></span>';
      QUALS.forEach((q) => { h += '<span class="qh">' + q[0] + '</span>'; });
      for (let r = 0; r < 12; r++) {
        h += '<span class="rh">' + names[r] + '</span>';
        QUALS.forEach(([q, , iv]) => {
          const inKey = iv.every((i) => pcs.has((r + i) % 12)), nm = chordName([r, q], names);
          h += '<button type="button" class="c' + (inKey ? ' in' : '') + (same(r, q) ? ' cur' : '') + '" data-r="' + r + '" data-q="' + q +
            '" title="' + nm + ': ' + iv.map((i) => names[(r + i) % 12]).join(' ') + '">' + nm + '</button>';
        });
      }
      h += '</div><button type="button" class="vh-btn mel-none' + (cur ? '' : ' cur') + '" data-none="1">No chord</button>';
      pop.innerHTML = h;
      pop.setAttribute('aria-label', 'Chord for ' + where.toLowerCase());
    }
    function positionPicker() {
      if (pop.hidden) return;
      const V = M.view, er = el.getBoundingClientRect(), cr = V.cv.getBoundingClientRect(), k = cr.width / V.VW || 1, pw = pop.offsetWidth;
      const e = M.song.chords[popBar] || { at: 0 }, mid = (e.at + md.regionEnd(M.song, popBar)) / 2;
      const left = clamp(cr.left - er.left + V.sx(V.xOf(mid)) * k - pw / 2, 8, Math.max(8, er.width - pw - 8));
      const top = cr.top - er.top + V.Y0 * k + 4;
      pop.style.left = left + 'px'; pop.style.top = top + 'px'; pop.style.maxHeight = Math.max(160, er.height - top - 10) + 'px';
    }
    const picker = M.picker = {
      get isOpen() { return !pop.hidden; },
      get bar() { return popBar; },
      open(b) {
        layerMenu.close(); toolPop.close();
        popBar = b; M.view.highlightBar = b; renderPicker(); pop.hidden = false; positionPicker(); M.requestRender();
        const f = pop.querySelector('.q.cur') || pop.querySelector('.q');
        if (f) f.focus({ preventScroll: true });
      },
      close() { if (pop.hidden) return; pop.hidden = true; popBar = -1; M.view.highlightBar = -1; M.requestRender(); },
      toggle(b) {
        if (!pop.hidden && popBar === b) picker.close();
        else { const wasClosed = pop.hidden; picker.open(b); if (wasClosed) M.engine.previewChord(b); }
      },
    };
    M.on('layout', positionPicker); M.on('scroll', positionPicker);
    pop.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('x')) { picker.close(); return; }
      const b = popBar;
      picker.close();
      M.setChord(b, t.dataset.none ? null : [+t.dataset.r, t.dataset.q]);
    });

    // layer menu: rename / mode / mute / solo / delete
    let menuL = -1, menuAnchor = null;
    function renderMenu() {
      const S = M.song, l = S.layers[menuL];
      if (!l) { layerMenu.close(); return; }
      lmenu.innerHTML = '<div class="mel-pop-head"><span class="mel-dot" style="background:' + l.color + '"></span>' +
        '<input type="text" class="mel-name" maxlength="24" aria-label="Layer name"><button type="button" class="vh-icon-btn x" aria-label="Close">✕</button></div>' +
        '<div class="vh-row"><button type="button" class="vh-btn" data-a="mode"></button><button type="button" class="vh-btn" data-a="mute"></button>' +
        '<button type="button" class="vh-btn" data-a="solo"></button></div>' +
        '<div class="vh-row"><button type="button" class="vh-btn mel-danger" data-a="del">Delete layer</button></div>';
      const inp = lmenu.querySelector('.mel-name');
      inp.value = l.name;
      inp.addEventListener('input', () => { l.name = inp.value.slice(0, 24) || 'Layer ' + (menuL + 1); syncChips(); M.save(); });
      inp.addEventListener('change', () => M.commit('Rename layer'));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); layerMenu.close(); } });
      const set = (a, label, pressed) => { const b = lmenu.querySelector('[data-a="' + a + '"]'); b.textContent = label; if (pressed != null) b.setAttribute('aria-pressed', String(pressed)); return b; };
      set('mode', l.mode === 'notes' ? '♩ Notes' : '∿ Line');
      set('mute', 'Mute', l.mute); set('solo', 'Solo', l.solo);
      const del = lmenu.querySelector('[data-a="del"]');
      del.disabled = S.layers.length < 2;
      if (del.disabled) del.title = 'A song needs at least one layer';
      lmenu.setAttribute('aria-label', 'Layer ' + (menuL + 1) + ' menu');
    }
    lmenu.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('x')) { layerMenu.close(); return; }
      const L = menuL, l = M.song.layers[L];
      if (!l) return;
      const a = t.dataset.a;
      if (a === 'mode') M.setLayerMode(L);
      else if (a === 'mute') { l.mute = !l.mute; M.engine.applyMix(); M.commit(l.mute ? 'Mute layer' : 'Unmute layer'); }
      else if (a === 'solo') { l.solo = !l.solo; M.engine.applyMix(); M.commit(l.solo ? 'Solo layer' : 'Unsolo layer'); }
      else if (a === 'del') { layerMenu.close(); M.removeLayer(L); return; }
      renderMenu();
    });
    const layerMenu = U.layerMenu = {
      get isOpen() { return !lmenu.hidden; },
      open(L, anchor) {
        picker.close(); toolPop.close();
        menuL = L; menuAnchor = anchor || layEl; renderMenu(); lmenu.hidden = false; floatAbove(lmenu, menuAnchor);
      },
      close() { lmenu.hidden = true; menuL = -1; },
      toggle(L, anchor) { if (!lmenu.hidden && menuL === L) layerMenu.close(); else layerMenu.open(L, anchor); },
    };

    // mixer strip
    function mixRow(name, color, value, onInput, onCommit, btns, key) {
      const r = ui.h('div', 'mel-mixrow');
      r.dataset.key = key;
      const dot = ui.h('span', 'mel-dot'); dot.style.background = color || 'transparent';
      const nm = ui.h('span', 'mel-mixname'); nm.textContent = name; nm.title = name;
      // 0..150 %, 100 % = unity; the tooltip shows the gain in dB; double-click resets to 100 %.
      const rg = ui.h('input'); rg.type = 'range'; rg.min = 0; rg.max = md.VOL_MAX; rg.step = 0.01; rg.value = value;
      rg.setAttribute('aria-label', name + ' volume');
      const tip = () => { rg.title = name + ': ' + md.volLabel(+rg.value) + ' · double-click: 100 %'; rg.setAttribute('aria-valuetext', md.volLabel(+rg.value)); };
      tip();
      rg.addEventListener('input', () => { tip(); onInput(+rg.value); });
      rg.addEventListener('change', onCommit);
      rg.addEventListener('dblclick', () => { rg.value = 1; tip(); onInput(1); onCommit(); });
      r.append(dot, nm, rg);
      (btns || []).forEach((b) => r.append(b));
      return r;
    }
    function mixBtnEl(label, title, pressed, on) {
      const b = ui.h('button', 'mel-ms'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
      b.setAttribute('aria-pressed', String(!!pressed)); b.addEventListener('click', on);
      return b;
    }
    function renderMixer() {
      const S = M.song, E = M.engine, a = document.activeElement;
      // keep keyboard focus on the same control across re-renders (a slider commits on every arrow key)
      const fr = a && mix.contains(a) && a.closest('.mel-mixrow'), fk = fr ? [fr.dataset.key, a.tagName === 'INPUT' ? '' : a.textContent] : null;
      mix.innerHTML = '';
      S.layers.forEach((l, L) => {
        const row = mixRow(l.name, l.color, l.vol, (v) => { l.vol = v; E.applyMix(); M.requestRender(); M.save(); }, () => M.commit('Layer volume'), [
          mixBtnEl('M', 'Mute ' + l.name, l.mute, () => { l.mute = !l.mute; E.applyMix(); M.commit('Mute'); }),
          mixBtnEl('S', 'Solo ' + l.name, l.solo, () => { l.solo = !l.solo; E.applyMix(); M.commit('Solo'); }),
        ], 'L' + L);
        row.dataset.layer = L;
        if (E.gainOf(L) === 0) row.classList.add('quiet');
        mix.append(row);
      });
      const bs = M.backingSound();
      const bRow = mixRow('Backing · ' + (bs ? bs.name : S.backing.sound), '#9aa3b8', S.backing.vol,
        (v) => { S.backing.vol = v; E.applyMix(); backSl.set(v); M.save(); }, () => M.commit('Backing volume'), [
          mixBtnEl('M', 'Mute backing', !S.backing.on, () => { S.backing.on = !S.backing.on; E.applyMix(); E.restartBacking(); M.commit('Backing on/off'); }),
        ], 'back');
      bRow.classList.add('mel-mix-back'); if (!S.backing.on) bRow.classList.add('quiet');
      mix.append(bRow);
      extraRows.forEach((o) => {   // part rows (M.ui.mixer.addRow), between the backing and the master
        try {
          const muted = o.mute ? !!o.mute.get() : false;
          const btns = o.mute ? [mixBtnEl('M', o.muteTitle || 'Mute ' + o.label, muted, () => { o.mute.set(!o.mute.get()); renderMixer(); })] : [];
          const r = mixRow(o.label, o.color || '#9aa3b8', clamp(+o.get() || 0, 0, md.VOL_MAX), (v) => o.set(v),
            () => (typeof o.commit === 'function' ? o.commit() : M.commit(o.commit || o.label + ' volume')), btns, 'x-' + o.id);
          r.classList.add('mel-mix-' + o.id); r.dataset.row = o.id;
          if (muted || (o.quiet && o.quiet())) r.classList.add('quiet');
          mix.append(r);
        } catch (err) { console.error('[melody] mixer row ' + o.id, err); }
      });
      const mRow = mixRow('Master', '#ffffff', S.master, (v) => { S.master = v; E.applyMix(); M.save(); }, () => M.commit('Master volume'), null, 'master');
      mRow.classList.add('mel-mix-master');
      mix.append(mRow);
      if (fk) {
        const r = [...mix.querySelectorAll('.mel-mixrow')].find((x) => x.dataset.key === fk[0]);
        const t = r && (fk[1] ? [...r.querySelectorAll('button')].find((b) => b.textContent === fk[1]) : r.querySelector('input'));
        if (t) t.focus({ preventScroll: true });
      }
    }
    // Extra mixer rows from parts: { id, label, color?, get() -> 0..1, set(v) (live, while dragging), muteTitle?,
    // commit?: undo label | fn (on release; default '<label> volume'), mute?: { get() -> bool, set(bool) } (set commits),
    // quiet?() -> bool }. Returns remove(). Rows re-render with the mixer (open, sync).
    const extraRows = [];
    const mixer = U.mixer = {
      addRow(o) {
        if (!o || !o.id || typeof o.get !== 'function' || typeof o.set !== 'function') throw new Error('[melody] mixer.addRow needs { id, label, get, set }');
        o = Object.assign({ label: o.id }, o);
        extraRows.push(o);
        renderMixer();
        return () => { const k = extraRows.indexOf(o); if (k >= 0) extraRows.splice(k, 1); renderMixer(); };
      },
      refresh() { renderMixer(); },
      // The mixer lives on the Settings panel's Mix tab; the dock's Mixer button opens the panel straight there.
      get isOpen() { return dr.isOpen && dr.group === 'mix'; },
      open() { picker.close(); layerMenu.close(); renderMixer(); dr.open('mix'); },
      close() { if (mixer.isOpen) dr.close(); },
      toggle() { if (mixer.isOpen) mixer.close(); else mixer.open(); },
    };
    dr.onChange(() => { const on = mixer.isOpen; mixBtn.set({ pressed: on }); mixBtn.setAttribute('aria-expanded', String(on)); });

    function onDocDown(e) {   // click outside closes floating panels
      const t = e.target;
      if (!pop.hidden && !pop.contains(t) && t !== M.view.cv) picker.close();
      if (!shareBox.hidden && !shareBox.contains(t)) shareBox.hidden = true;
      if (!lmenu.hidden && !lmenu.contains(t) && !layEl.contains(t)) layerMenu.close();
      if (!tpop.hidden && !tpop.contains(t) && !toolBtn.contains(t)) toolPop.close();
    }
    document.addEventListener('pointerdown', onDocDown, true);
    M.cleanups.push(() => document.removeEventListener('pointerdown', onDocDown, true));
    U.closeFloats = () => {
      const any = !pop.hidden || !lmenu.hidden || !shareBox.hidden || !tpop.hidden, tool = !tpop.hidden;
      picker.close(); layerMenu.close(); toolPop.close(); shareBox.hidden = true;
      if (U.closeSecMenu) U.closeSecMenu();
      if (M.tools && M.tools.closeMenu) M.tools.closeMenu();
      if (tool) toolBtn.focus({ preventScroll: true });
      return any;
    };

    // ---------- tone: derived copy of the selected instrument ----------
    const tones = () => VH.store.get('melody.tones', {});
    function toneInfo(s) {
      const map = tones();
      if (s && map[s.id] && VH.sounds.get(map[s.id].base)) return { baseId: map[s.id].base, p: Object.assign({}, map[s.id]), derived: true };
      const from = s && s.source === 'custom' && (s.derivedFrom || s.base);
      if (from && VH.sounds.get(from)) return { baseId: from, p: Object.assign(defaults(VH.sounds.get(from)), { bright: (s.tone && s.tone.bright) || 0 }), derived: true };
      return { baseId: s ? s.id : null, p: defaults(s), derived: false };
    }
    function defaults(s) {
      const n = s && s.kind === 'synth' ? clamp((s.synth.partials || []).length || 1, 1, 16) : 8;
      return Object.assign({ n }, TONE_DEF);
    }
    function derivePartials(parts, p) {
      const src = (parts && parts.length ? parts : [[1, 1]]).slice().sort((a, b) => a[0] - b[0]), last = src[src.length - 1];
      const out = src.slice(0, p.n).map((x) => [x[0], x[1]]);
      for (let j = 1; out.length < p.n; j++) out.push([last[0] + j, last[1] * 0.8 ** j]);
      return out.map(([r, a]) => [Math.round(r ** p.stretch * 10000) / 10000, Math.round(a * Math.pow(r, p.bright) * 10000) / 10000]);
    }
    let tonePending = null, toneTimer = 0, toneEditing = null;
    function toneInput(k, v) {
      const s = M.soundOf(M.active);
      if (!toneEditing) { const ti = toneInfo(s); toneEditing = { baseId: ti.baseId, p: ti.p }; }
      toneEditing.p[k] = v;
      tonePending = toneEditing;
      if (!toneTimer) toneTimer = later(() => { toneTimer = 0; flushTone(); }, 70);
    }
    function flushTone() {
      if (toneTimer) { M.forget(toneTimer); toneTimer = 0; }
      const t = tonePending; tonePending = null;
      if (!t) { toneEditing = null; return; }
      const base = VH.sounds.get(t.baseId);
      if (!base) { U.toast('The original instrument isn’t available, so its tone can’t be edited'); toneEditing = null; return; }
      const opts = base.kind === 'synth' ? { partials: derivePartials(base.synth.partials, t.p) } : { tone: { bright: t.p.bright } };
      const done = (d) => {
        if (!d || !d.id) return;
        const map = tones(), L = M.active, prev = M.song.layers[L].sound;
        map[d.id] = Object.assign({ base: t.baseId }, t.p);
        if (prev !== d.id && map[prev] && map[prev].base === t.baseId && !M.usesSound(prev, L)) { delete map[prev]; try { VH.sounds.remove(prev); } catch (_) { /* ignore */ } }
        VH.store.set('melody.tones', map);
        if (prev !== d.id) M.setLayerSound(L, d.id, true);
        else M.soundsChanged();
      };
      try {
        const r = VH.sounds.derive(t.baseId, opts);
        if (r && typeof r.then === 'function') r.then(done).catch((err) => console.error('[melody] derive', err)); else done(r);
      } catch (err) { console.error('[melody] derive failed', err); U.toast('Couldn’t make a custom copy of ' + base.name); }
      if (!toneTimer) later(() => { if (!tonePending && !toneTimer) { toneEditing = null; syncTone(); } }, 400);
    }
    function resetTone() {
      flushTone(); toneEditing = null;
      const L = M.active, s = M.soundOf(L), ti = toneInfo(s);
      if (!ti.derived || !VH.sounds.get(ti.baseId)) { syncTone(); return; }
      const old = s.id, map = tones();
      M.setLayerSound(L, ti.baseId, true);
      if (!M.usesSound(old)) { delete map[old]; VH.store.set('melody.tones', map); try { VH.sounds.remove(old); } catch (_) { /* ignore */ } }
      M.commit('Reset tone');
      syncTone();
    }
    function syncTone() {
      const s = M.soundOf(M.active), ti = toneInfo(s), base = VH.sounds.get(ti.baseId) || s, sampler = base && base.kind === 'sampler';
      const lay = M.song.layers[M.active];
      toneHead.innerHTML = 'Shapes <b>' + ui.esc(base ? base.name : '?') + '</b> on ' + ui.esc(lay.name) +
        (ti.derived ? ' · edited copy: <b>' + ui.esc(s.name) + '</b>' : '. Moving a slider makes an edited copy.');
      const p = ti.p;
      if (!toneEditing) { toneSl.n.set(p.n); toneSl.stretch.set(p.stretch); toneSl.bright.set(p.bright); }   // don't fight a drag
      toneSl.n.input.disabled = toneSl.stretch.input.disabled = !!sampler;
      toneNote.textContent = sampler ? 'Recorded instrument: only Brightness can change; its overtones and stretch are fixed in the recording.' : '';
      toneNote.hidden = !sampler;
      toneReset.disabled = !ti.derived;
    }
    U.syncTone = syncTone;

    // ---------- sync ----------
    function syncChips() {
      const S = M.song;
      if (chips.length !== S.layers.length) buildChips();
      chips.forEach((b, i) => {
        const l = S.layers[i], s = M.soundOf(i), on = i === M.active;
        const txt = l.name + ' · ' + (s ? s.name : l.sound) + ' · ' + (l.mode === 'notes' ? 'Notes' : 'Line') + (l.mute ? ' · muted' : '') + (l.solo ? ' · solo' : '');
        b.style.setProperty('--c', l.color);
        b.classList.toggle('on', on); b.classList.toggle('muted', md.layerGain(S, i) === 0);
        b.title = txt + (on ? ' (tap for menu)' : ''); b.setAttribute('aria-label', txt); b.setAttribute('aria-pressed', String(on));
      });
      addChip.hidden = S.layers.length >= MAX_LAYERS;
      layLb.textContent = S.layers[M.active].name;
    }
    U.sync = function () {
      const S = M.song, l = S.layers[M.active];
      instSel.setMode(l.mode === 'line' ? 'line' : undefined);
      instSel.set(l.sound);
      syncChips();
      snapPanelBtn.set({ pressed: S.snap });
      syncRegion(); syncTools();
      fillKeys(); modeSel.value = S.mode; syncTuning();
      syncBars(S.bars); syncGrid(S.grid);
      tenSl.set(S.tension || 0); if (M.view && M.view.syncTension) M.view.syncTension();
      if (U.renderArr) U.renderArr();
      loopBtn.set({ pressed: S.loop });
      backBtn.set({ pressed: S.backing.on }); backSel.set(S.backing.sound); backSl.set(S.backing.vol);
      othersBtn.set({ pressed: S.bandsOthers });
      tempoSl.set(S.bpm);
      undoBtn.disabled = !M.hist.past.length; redoBtn.disabled = !M.hist.future.length;
      const lp = M.hist.past[M.hist.past.length - 1], lf = M.hist.future[M.hist.future.length - 1];
      undoBtn.title = 'Undo' + (lp && lp.label ? ': ' + lp.label : '') + ' (Ctrl+Z)';
      redoBtn.title = 'Redo' + (lf && lf.label ? ': ' + lf.label : '') + ' (Ctrl+Shift+Z / Ctrl+Y)';
      if (!M.engine.playing) idleCaption();
      if (!pop.hidden) renderPicker();
      if (!lmenu.hidden) renderMenu();
      renderMixer();
      syncTone();
      M.requestRender();
    };
    let lastCap = '';
    function setCaption(html) { if (html !== lastCap) { lastCap = html; caption.innerHTML = html; } }
    function idleCaption() {
      setCaption(M.song.layers[M.active].mode === 'notes'
        ? 'Notes: click to place · drag right to lengthen · click a note to delete · Space = play'
        : 'stopped · Space = play / stop · Ctrl+Z = undo · ? = shortcuts');
    }
    M.on('tick', (t) => {
      const S = M.song, names = namesOf(S);
      const rg = t.region != null ? t.region : t.bar, sn = S.sections.length > 1 ? ui.esc(S.sections[S.cur].name) + ' · ' : '';
      let html = sn + 'bar ' + (t.bar + 1) + ' · <b>' + chordName(md.regionChord(S, rg), names) + '</b>';
      S.layers.forEach((l, L) => {
        const q = md.lineAt(l, t.lineIndex), nm = q.length ? q.map((x) => x.m).sort((a, b) => b - a)[0] : (l.notes.find((n) => t.pos16 >= n.s && t.pos16 < n.s + n.d) || {}).m;
        let txt = '—';
        if (nm != null && !isNaN(nm)) {
          const k = Math.round(nm), c = Math.round((nm - k) * 100), cs = M.bands.consonance(nm, rg, L);
          txt = VH.harmony.noteName(k) + (c ? (c > 0 ? '+' : '') + c + '¢' : '') + (isNaN(cs) ? '' : ' ' + cs.toFixed(2));
        }
        html += '<span class="vh-sw" style="background:' + l.color + '"></span>' + txt;
      });
      setCaption(html);
    });
    M.on('play', () => { playBtn.set({ icon: '■', label: 'Stop', pressed: true }); });
    M.on('stop', () => { playBtn.set({ icon: '▶', label: 'Play', pressed: false }); idleCaption(); M.requestRender(); });
    M.on('tools', syncTools);
    M.on('tool', syncTools);

    // ---------- arrangement strip (above the chord header): the song's sections in order ----------
    // [Section | Song] play mode · one block per section (name, ×repeat; the shown one outlined, the playing one lit)
    // · "+" (new / duplicate). Click a block = edit that section; click the shown one = its menu (rename, color,
    // repeat, duplicate, delete); drag a block = reorder. One slim row that scrolls sideways when narrow.
    const arr = ui.h('div', 'mel-arr');
    arr.setAttribute('role', 'toolbar'); arr.setAttribute('aria-label', 'Song sections');
    const modeBox = ui.h('div', 'mel-arr-mode');
    const modeBtns = [['section', 'Section', 'Play loops the section shown (and its loop region)'], ['song', 'Song', 'Play runs the whole arrangement and follows it']].map(([v, label, title]) => {
      const b = ui.h('button', 'mel-arr-m', label); b.type = 'button'; b.dataset.v = v; b.title = title;
      b.addEventListener('click', () => M.setPlayMode(v));
      modeBox.append(b); return b;
    });
    const blocks = ui.h('div', 'mel-arr-blocks');
    const addBtn = ui.h('button', 'mel-arr-add', '+'); addBtn.type = 'button'; addBtn.title = 'Add a section'; addBtn.setAttribute('aria-label', 'Add a section');
    arr.append(modeBox, blocks, addBtn);
    M.view.addLane(arr, { top: true, height: 28 });
    const smenu = ui.h('div', 'mel-secmenu mel-float'); smenu.hidden = true; smenu.setAttribute('role', 'dialog');
    el.append(smenu);
    function closeSecMenu() { smenu.hidden = true; }
    U.closeSecMenu = closeSecMenu;
    function placeMenu(anchor) {
      smenu.hidden = false;
      const er = el.getBoundingClientRect(), r = anchor.getBoundingClientRect();
      smenu.style.left = clamp(r.left - er.left, 6, Math.max(6, er.width - smenu.offsetWidth - 6)) + 'px';
      smenu.style.top = (r.bottom - er.top + 4) + 'px';
    }
    function openAddMenu() {
      smenu.innerHTML = '';
      smenu.setAttribute('aria-label', 'Add a section');
      [['New empty section', () => M.addSection(false)], ['Duplicate “' + M.song.sections[M.song.cur].name + '”', () => M.addSection(true)]].forEach(([label, run], i) => {
        const b = ui.h('button', 'mel-cm-item mel-sm-' + (i ? 'dup' : 'new'), ui.esc(label)); b.type = 'button';
        b.addEventListener('click', () => { closeSecMenu(); run(); });
        smenu.append(b);
      });
      placeMenu(addBtn);
    }
    addBtn.addEventListener('click', () => { if (!smenu.hidden && smenu.dataset.k === 'add') { closeSecMenu(); return; } smenu.dataset.k = 'add'; openAddMenu(); });
    function openSecMenu(k, anchor) {
      const S = M.song, x = S.sections[k];
      if (!x) return;
      smenu.dataset.k = String(k);
      smenu.setAttribute('aria-label', 'Section ' + x.name);
      smenu.innerHTML = '';
      const nameIn = ui.h('input', 'vh-input mel-sm-name'); nameIn.type = 'text'; nameIn.maxLength = 20; nameIn.value = x.name; nameIn.setAttribute('aria-label', 'Section name');
      nameIn.setAttribute('list', 'mel-sec-names');
      const dl = ui.h('datalist'); dl.id = 'mel-sec-names'; dl.innerHTML = md.SEC_NAMES.map((n) => '<option value="' + n + '">').join('');
      const commitName = () => M.renameSection(k, nameIn.value);
      nameIn.addEventListener('change', commitName);
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); closeSecMenu(); } e.stopPropagation(); });
      const sw = ui.h('div', 'mel-sm-colors');
      md.SEC_COLORS.forEach((c) => {
        const b = ui.h('button', 'mel-sm-sw' + (c === x.color ? ' on' : '')); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Color ' + c);
        b.addEventListener('click', () => { M.recolorSection(k, c); U.openSecMenu(k); });
        sw.append(b);
      });
      const rep = ui.h('div', 'vh-row mel-sm-rep');
      rep.append(ui.h('span', 'mel-lbl', 'Repeat'));
      const dn = ui.button(rep, { label: '−', onClick: () => { M.setRepeat(k, x.rep - 1); U.openSecMenu(k); } });
      rep.append(ui.h('b', 'mel-sm-repn', '×' + x.rep));
      const up = ui.button(rep, { label: '+', onClick: () => { M.setRepeat(k, x.rep + 1); U.openSecMenu(k); } });
      dn.disabled = x.rep <= 1; up.disabled = x.rep >= md.MAX_REP;
      dn.setAttribute('aria-label', 'Fewer repeats'); up.setAttribute('aria-label', 'More repeats');
      const acts = ui.h('div', 'vh-row mel-sm-acts');
      ui.button(acts, { label: 'Duplicate', onClick: () => { closeSecMenu(); if (k !== M.song.cur) M.selectSection(k); M.addSection(true); } }).classList.add('mel-sm-dup');
      const del = ui.button(acts, { label: 'Delete', onClick: () => { closeSecMenu(); M.deleteSection(k); } });
      del.classList.add('mel-sm-del'); del.disabled = S.sections.length < 2;
      smenu.append(nameIn, dl, sw, rep, acts);
      placeMenu(anchor);
    }
    U.openSecMenu = (k) => { const b = blocks.children[k]; if (b) openSecMenu(k, b); };
    const offSec = (e) => { if (!smenu.hidden && !smenu.contains(e.target) && !arr.contains(e.target)) closeSecMenu(); };
    const escSec = (e) => { if (e.key === 'Escape' && !smenu.hidden) closeSecMenu(); };
    document.addEventListener('pointerdown', offSec, true); document.addEventListener('keydown', escSec);
    M.cleanups.push(() => { document.removeEventListener('pointerdown', offSec, true); document.removeEventListener('keydown', escSec); });
    let secDrag = null;
    function renderArr() {
      const S = M.song, E = M.engine, items = md.arrangement(S), it = E.playing && M.playMode === 'song' ? items[E.pass] : null;
      modeBtns.forEach((b) => { const on = b.dataset.v === M.playMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      blocks.innerHTML = '';
      S.sections.forEach((x, k) => {
        const b = ui.h('button', 'mel-arr-b' + (k === S.cur ? ' cur' : '') + (it && it.k === k ? ' play' : ''));
        b.type = 'button'; b.dataset.k = k; b.style.setProperty('--c', x.color);
        const bars = k === S.cur ? S.bars : x.data.bars, ts = k === S.cur ? S.ts || '4/4' : x.data.ts;
        b.innerHTML = '<span class="nm">' + ui.esc(x.name) + '</span>' + (x.rep > 1 ? '<i>×' + (it && it.k === k ? (it.r + 1) + '/' : '') + x.rep + '</i>' : '');
        b.title = x.name + ' · ' + bars + ' bar' + (bars > 1 ? 's' : '') + ' · ' + ts + (x.rep > 1 ? ' · ×' + x.rep : '') + (k === S.cur ? ' (shown; click for its menu, drag to reorder)' : ' (click to edit, drag to reorder)');
        b.setAttribute('aria-pressed', String(k === S.cur));
        blocks.append(b);
      });
      addBtn.disabled = S.sections.length >= md.MAX_SECTIONS;
    }
    U.renderArr = renderArr;
    blocks.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.mel-arr-b');
      if (!b || e.button > 0) return;
      secDrag = { k: +b.dataset.k, x0: e.clientX, moved: false, id: e.pointerId, to: +b.dataset.k };
      try { blocks.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    blocks.addEventListener('pointermove', (e) => {
      if (!secDrag || e.pointerId !== secDrag.id) return;
      if (!secDrag.moved && Math.abs(e.clientX - secDrag.x0) > 6) secDrag.moved = true;
      if (!secDrag.moved) return;
      const bs = [...blocks.children];
      let to = bs.length - 1;
      for (let i = 0; i < bs.length; i++) { const r = bs[i].getBoundingClientRect(); if (e.clientX < r.left + r.width / 2) { to = i > secDrag.k ? i - 1 : i; break; } }
      secDrag.to = to;
      bs.forEach((x, i) => { x.classList.toggle('drag', i === secDrag.k); x.classList.toggle('drop', i === to && i !== secDrag.k); });
    });
    const endSecDrag = (e) => {
      if (!secDrag || e.pointerId !== secDrag.id) return;
      const d = secDrag; secDrag = null;
      if (e.type === 'pointercancel') { renderArr(); return; }
      if (d.moved) { if (!M.moveSection(d.k, d.to)) renderArr(); return; }
      const b = blocks.children[d.k];
      if (d.k === M.song.cur) { if (!smenu.hidden && smenu.dataset.k === String(d.k)) closeSecMenu(); else openSecMenu(d.k, b); }
      else { closeSecMenu(); M.selectSection(d.k); }
    };
    blocks.addEventListener('pointerup', endSecDrag);
    blocks.addEventListener('pointercancel', endSecDrag);
    blocks.addEventListener('keydown', (e) => {   // Enter / Space on the shown block opens its menu (click handles others)
      const b = e.target.closest('.mel-arr-b');
      if (!b || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      const k = +b.dataset.k;
      if (k === M.song.cur) openSecMenu(k, b); else M.selectSection(k);
    });
    M.on('section', () => { renderArr(); const cb = blocks.querySelector('.cur'); if (cb && cb.scrollIntoView) cb.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    M.on('pass', renderArr);
    M.on('play', renderArr); M.on('stop', renderArr);
    renderArr();
    U.refreshSounds = () => { instSel.refresh(); backSel.refresh(); };
    M.cleanups.push(() => { instSel.destroy(); backSel.destroy(); });
    syncTools();
    return U;
  };
})();
