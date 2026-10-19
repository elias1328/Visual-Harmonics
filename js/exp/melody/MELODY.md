# Melody modules and the part context `M`

Melody is split into classic scripts. They share `window.VH.melody` (no ES modules, so it works from file://). Load order is set in `index.html`:

| file | role |
|---|---|
| `model.js` | constants, song model, `serialize`/`parse` (with v1 migration), chord helpers → `VH.melody.model` |
| `bands.js` | harmony map (mixed spectra) → `M.bands` |
| `view.js` | canvas geometry and drawing → `M.view` |
| `engine.js` | transport, buses, voices, backing → `M.engine` |
| `tools.js` | pointer tool registry and the built-in `draw` tool → `M.tools` |
| `ui.js` | dock, Settings sections, chord picker, layer menu, mixer, tone → `M.ui` |
| `tools-edit.js`, `sound.js`, `export.js`, `generate.js` | **Wave B parts** (B1, B2, B3, B3) |
| `onboard.js` | part: first-visit demo song, ghost path, 5-step tutorial, Settings > Song > "Start here" (see Onboarding) |
| `main.js` | builds `M`, history, autosave, share, keys, frame loop; starts the parts; registers the experiment |

Parts edit **only their own file(s)**. A2 owns the core API (`js/core`); the melody core files above are shared. If you need something that `M` does not offer, ask for a hook. Do not wrap `M.*` methods or `VH.audio.*` functions, and do not patch other parts' DOM. Everything a part needs is listed below: `M.addHook`, `M.on('layerRemoved')`, `M.view.addLane`, `M.ui.mixer.addRow`, `M.markBandsDirty`, `M.engine.layerBusFor`.

## Writing a part

```js
// js/exp/melody/sound.js
VH.melody.parts.push((M) => {
  const off = M.onPlayTick((t) => { /* ... */ });
  const sec = M.ui.addPanelSection('Effects', 35, { group: 'sound' });
  return { destroy() { off(); /* stop audio, disconnect nodes, remove listeners */ } };
});
```

- Each factory is called **once per mount**, after the dock, panel and tools exist and before the first frame. It runs again on every remount: a tab switch unmounts and remounts.
- The factory may return `{ destroy() }`. `destroy` runs on unmount and must stop audio, disconnect nodes and remove window/document listeners (PLAN §2).
  - DOM inside `M.el` is removed for you.
  - `M.on(...)` subscriptions, `M.later` timers and `M.cleanups` entries are released for you.
- A throwing factory is logged and skipped, so Melody keeps working.
- For window/document listeners, push the remover onto `M.cleanups`, e.g. `M.cleanups.push(() => document.removeEventListener('keydown', f))`.

## The song (`M.song`)

`M.song` is the **live object**. It is *replaced* on undo/redo/load, so always read `M.song` again; never keep a reference to it.

```
{ key: 0..11, mode: 'major'|'minor', bars: 4|8|16, bpm: 40..200 (4/4, bar = 4 beats),
  chords: [[root 0..11, 'maj'|'min'|'dim'|'aug'|'sus2'|'sus4'|'7'|'maj7'|'m7'] | null, ...]  (length = bars),
  layers: [{ id 'l1'|'l2'|..., name, color '#rrggbb', sound (VH.sounds id), mode 'line'|'notes', vol 0..1, mute, solo,
             line: Float32Array(bars*48) of midi or NaN   (48 samples per bar),
             notes: [{ s: start sixteenth, d: length in sixteenths, m: midi (float) }] }, ...]   (1..8 layers),
  backing: { sound, vol 0..1, on, style: 'drone'|'strum'|'arp'|'pulse'|'broken',
             styleOpts?: { arp: { rate, pattern, oct, gate }, strum: { speed, dir }, pulse: { rate, gate }, broken: { pattern } } },
  master: 0..1, bandsOthers: bool,
  fx: {}, drums: {}, ext: {},     // free-form JSON for parts: B2 owns fx + drums; others use ext.<partName>
  loopRegion?: [a, b] | null,     // loop only bars a..b-1 (whole bars). Serialized only when set; part of undo, autosave, share
  grid: 8|16, loop, snap }        // view prefs: autosaved and shared, but NOT part of undo
```

- **Layer ids** are stable. They are unique within the song and kept by undo/redo, autosave and share links. `M.addLayer` takes `max + 1`.
  - Songs saved before ids existed get `l1..lN` in layer order when parsed (`S.migratedIds` > 0 then). An old autosave is saved back in the new format.
  - Part data may be keyed by id, or by index and kept aligned with `'layerRemoved'`. B1's `ext.edit.vib` and B2's `fx.layers` are index-keyed and shift there.
- Pitch range: `model.LO` = 48 (C3) to `model.HI` = 84 (C6). Time unit: the **sixteenth** (`model.SPB` = 16 per bar). Line samples: `model.LPB` = 48 per bar.
- `fx`, `drums` and `ext` must stay plain JSON. They survive autosave, share links and undo.
- `backing.styleOpts` holds each backing style's own sub-settings (sound.js: `NS.sound.styleOptsOf(S, style)` validates and fills defaults; missing = the original fixed patterns). It is serialized only when set, so older songs serialize unchanged. Live playback, the WAV render (`NS.sound.offline`) and the MIDI export (`NS.sound.barEvents`) all read it.
- Notes may carry extra runtime fields such as `sel: true` (B1 selection; the view draws it with a white outline). Those fields are **not** serialized.
- Model helpers (`M.model`): `nextLayerId(layers)`, `assignIds(layers)`, `chordMidis(ch)`, `chordName(ch, names)`, `namesOf(S)`, `scaleOf(S)`, `diatonic(S)`, `secPerBar(S)`, `secPer16(S)`, `layerGain(S, i)` (0 when muted or not soloed), `serialize(S, full)`, `parse(obj)`, `newLayer(i, opts, bars)`, `COLORS`, `MAX_LAYERS` = 8, `QUALS`.

## Editing and undo

| call | does |
|---|---|
| `M.commit(label, opts?)` | Call **after** mutating `M.song`. It records one undo step (label shown on the Undo button) if the song changed since the last commit, then re-syncs the UI, refreshes bands, autosaves, and emits `'song'`. Returns `true` if a step was recorded. For drags, mutate on every move with `M.requestRender()` and commit once on pointer-up. `opts = { chords: [bars whose chord changed], source: 'chord' \| 'generate' \| ..., keepHash }` goes to the `beforeCommit` hooks (see Hooks). `M.lastCommit` is the final context `{ label, chords, source, info }`. |
| `M.undo()` / `M.redo()` | Undo or redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y). |
| `M.save()` | Debounced autosave without an undo step (for view prefs). |
| `M.requestRender()` | Redraw on the next frame. |
| `M.toast(msg)` | Short status message. |

Actions, each of which commits:
- `M.setActive(i)` (does not commit; it emits `'layer'`)
- `M.setLayerSound(i, id)`
- `M.setLayerMode(i)`
- `M.setBackingSound(id)`
- `M.setChord(bar, ch|null, { extra(song)? })` (also previews the chord)
  - `extra` may edit more of the song in the same undo step.
  - It commits with `{ chords: [bar], source: 'chord' }`, so auto-fit (B1) can turn it into 'Chord + fit'.
- `M.setBars(n)`
- `M.setLoopRegion([a, b] | null)`: one undo step ('Loop bars 2–3' / 'Clear loop region'); clears the cue; when playing outside the new region it seeks to its start.
- `M.replaceSong(obj, label?, prep?)`: replace the whole song (serialized form). With `label` it is one undo step; without, no step (first-visit demo). `prep(song)` may edit the new song before it is recorded (its sounds and bands are ready).
- `M.newSong()` ('New song' step), `M.loadDemo(label?)` (onboard.js).
- `M.addLayer(opts?)` (returns the new index, or -1 at 8 layers). The layer gets the next id; `'layerAdded'` fires before the commit.
- `M.removeLayer(i)`: `'layerRemoved'` fires after the splice, before the commit.

Sounds:
- `M.soundOf(i)` returns the resolved Sound of layer i; it falls back to String when the id is missing.
- `M.backingSound()`
- `M.usesSound(id, exceptLayer?)`
- `M.active` is the active layer index.
- `M.el` is the experiment's root element.

## Events: `M.on(evt, cb)` returns `off()`

| event | args | when |
|---|---|---|
| `'song'` | `(S)` | after every commit, undo/redo or load |
| `'layer'` | `(i)` | active layer changed or layers added/removed |
| `'layerAdded'` | `(id, index)` | a layer was pushed. Fires **before** its commit, so song edits here join that undo step |
| `'layerRemoved'` | `(id, index)` | a layer was spliced out. Fires **before** its commit: shift index-keyed part data here (same undo step) |
| `'play'` / `'stop'` | none | transport |
| `'tick'` | `(t)` | every frame while playing (also `M.onPlayTick(cb)`) |
| `'bar'` | `(b)` | playhead entered bar b (after the backing has been told) |
| `'draw'` | `(ctx, view)` | overlay drawing. The ctx is already scaled for dpr and translated by `-scrollX`, so draw in **content coords** with `view.xOf` / `view.yOf`. Runs after layers, before the playhead. |
| `'layout'` / `'scroll'` | `(view)` | canvas resized or scrolled |
| `'sounds'` | none | sound library changed (resolved sounds and bands refreshed) |
| `'tools'` / `'tool'` | none | tool list or current tool changed |
| `'seek'` | `(t16)` | `engine.seek`: playhead moved (playing) or the cue was set (stopped) |
| `'unmount'` | none | before parts' `destroy` |

Tick info `t`:

```
{ now (performance.now ms), pos16, prevPos16, wrapped (looped this frame), bar, lineIndex, phase 0..1,
  cont16 (continuous play time in sixteenths since Play: never jumps on loops or seeks), seekId (changes on Play / seek),
  seekCont16 (cont16 at that Play / seek), loopA16, loopB16 (the looped range: region or whole song),
  ctxTime, secPer16, timeOf(t16) -> AudioContext time of sixteenth t16 (for precise scheduling with opts.when) }
```

**Look-ahead scheduling with loops, regions and seeks.** Schedule in `cont16` coordinates and map them to song positions
with `engine.segments(c0, c1)` -> `[{ c, s, n }]` (continuous start, song start, length in sixteenths), which follows the
loop region / song loop from the current position. When `seekId` changes, drop what you queued and continue from
`seekCont16`. The engine's note scheduler and sound.js (drums, backing styles) both work this way.

Playback is frame-driven. To place a hit precisely, schedule it with `when: t.timeOf(step)` for steps where `prevPos16 < step <= pos16`. Mind `wrapped`.

The engine schedules layer **notes** `engine.LOOKAHEAD` = 80 ms ahead on the audio clock, so `voiceOpts` may move them earlier by up to that much. Line voices start in the frame they begin.

## Audio: `M.engine`

Signal path:

```
layer i voice ─► M.layerBus(i) ─┐
backing voice ─► backingBus() ──┼─► sumBus() ─► [insert chain] ─► masterBus() ─► VH.audio.out
```

- `M.layerBus(i)`, `engine.backingBus()`, `engine.sumBus()` and `engine.masterBus()` return GainNodes of the **live** AudioContext, or `null` before the first gesture created it. Create your nodes lazily, e.g. in `'play'`.
  - They are never built in another context. Inside `VH.audio.withContext(offline, ...)` they still return the live nodes, and `engine.ctx` stays the live context.
- `engine.layerBusFor(ctx, i)` and `engine.busesFor(ctx)` (`{ master, sum, backing, layers[] }`) are for offline rendering.
  - For the live context they return the live buses.
  - For any other context they return a separate bus set, built once per context, with gains from the song mix and `master` into that context's `VH.audio` output.
- The engine sets the bus gains from vol/mute/solo/backing/master. Call `engine.applyMix()` after changing those fields yourself.
- `engine.setInsert({ input, output } | null)`: put an FX chain (`VH.fx.chain(...)`) between sum and master. Pass `null` to remove it. Disconnect your nodes in `destroy`.
- `engine.setBacking(impl | null)` replaces the default drone. `impl = { onBar(bar, midis|null, info), stop(rel) }`, where `info = { now, ctxTime, secPerBar }`.
  - Play into `engine.backingBus()` and respect `M.song.backing.on`.
  - Use `M.backingSound()`.
  - `stop` must silence everything.
  - Pass `null` to restore the drone. `engine.restartBacking()` re-triggers the current bar.
- Transport: `play()` starts at `engine.cue` (set by a seek while stopped), else the loop region's start, else 0. `seek(t16)` while playing jumps there and playback continues (notes queued for the old position are cut); while stopped it sets the cue (drawn as a dashed line). `loopRange()` -> `{ a16, b16, on }`. With a loop region, playback loops only those bars (regardless of `song.loop`); a seek outside it plays on to the region end (or the song end) and then returns to the region start.
- `engine.playing`, `phase`, `pos16`, `bar`, `ctx`, `play()`, `stop()`, `toggle()`, `seek(t16)`, `secPer16()`, `secPerBar()`, `playOf(sound)` ('glide' | 'hit'), `gainOf(i)`, `backingGain()`.
- `engine.previewChord(bar)` and `engine.previewNote(i, midi, dur)` are for gesture handlers only. `engine.stopAll()`, `engine.stopLayer(i)`.
- Line playback: 'glide' sounds play one legato voice per line run (`setFreq`). 'hit' sounds re-trigger only when the line crosses a semitone, at least `engine.MIN_GAP` = 70 ms apart on the audio clock.
- Voices are started with `{ gain, dest: bus, when }`. The core applies `sound.tone` itself, so do **not** also pass `opts.tone` for the same sound. For offline export (B3), rebuild the graph in an OfflineAudioContext with `VH.audio.withContext` and the song data (or `layerBusFor`); the live buses belong to the live context.

## Hooks: `M.addHook(name, fn)` returns `off()`

Registered functions live as long as the mount and are released with `M`. Never wrap `VH.audio.voice`, `M.setChord`, `M.removeLayer` and so on.

| hook | signature | called |
|---|---|---|
| `'voiceOpts'` | `fn(layer, kind, midi, opts) -> opts?` | when the engine starts one of its voices. See below. B2: humanize (±15 ms, ±10 % on notes). |
| `'pitchMod'` | `fn(layer, kind, t, ref) -> cents` | every play tick, for each engine voice. See below. B1: vibrato; B2: harmony magnet. |
| `'beforeCommit'` | `fn(cx)` | inside `M.commit`, before the snapshot. See below. B1: auto-fit for `source` `'chord'` / `'generate'` ('Chord + fit' / 'Generate + fit'). |

Auto-fit (tools-edit.js, Settings > Edit > "Auto-fit notes to a new chord", `melody.autofit`): only what clashes with
the new chord moves (`fitCtx.fits`), onto equal-tempered semitones within ±2. Notes keep a deliberate microtonal offset
(|offset| > 30¢ while Snap is off); everything else ends exactly on a semitone. Lines are split into plateaus (runs within
±0.35 semitone for >= a sixteenth, not a slow slide) that move as one unit (median onto the semitone, wobble kept) and
glides that are re-drawn between the new plateau ends (rescaled, or eased when the span collapses or flips). A held note
coming in over the bar line keeps its pitch when it still fits (common tone), else steps the way the line goes and eases
into the new pitch over a sixteenth. Line vibrato is index-keyed (unchanged); note vibrato is re-keyed. Tests can set
`VH.melody.fitStats = { items: [] }` to collect `{ L, kind: 'note'|'plateau', from, to, micro, kept }`.

`voiceOpts`:
- `kind` is `'note'`, `'line'` or `'backing'` (layer = -1 for the backing).
- `opts = { midi, gain, when }`. `when` is an audio time, or `undefined` for now. Notes come with their scheduled time, up to `LOOKAHEAD` ahead.
- Mutate `opts` or return a replacement. `when`, `gain` and `midi` are honoured. All registered fns run in order.

`pitchMod`:
- `ref` depends on `kind`:
  - `'line'`: `{ i, m }` (line sample and midi).
  - `'note'`: the note `{ s, d, m }`, asked only once the note has started.
  - `'backing'`: `{ m }`.
- `t` is the tick info.
- The engine sums all fns and sets the voice to `midi + cents / 100`, with a 20 ms glide while modulated. Line voices also start at the modulated pitch.

`beforeCommit`:
- `cx = { label, chords, source, song, info }`.
- Edit the song here (same undo step), change `cx.label`, and put results in `cx.info`.

`M.hooks.voiceOpts(...)` and `M.hooks.pitchMod(...)` are the dispatchers the engine calls. `M.hooks.bandExtras` is a single slot (below).

## Harmony bands

`M.bandsAt(t16, layerIdx?)` returns the map for the bar at t16, scored for that layer (default: the active layer):

```
{ bar, chord, layer, rows (301), D: Float32Array raw dissonance per row, V: 0..1 (0 = most consonant),
  midiOfRow(r), rowOfMidi(m), consonance(m) -> 0..1 (NaN without chord), snap(m) -> nearest bright semitone (ET; exact band with Pure intonation),
  peaks() -> consonant midis, brightest first }
```

- Rows run from LO to HI.
- Bands = the layer's spectrum (candidate partials) against the chord voiced with the **backing instrument's** spectrum (chord partials). Spectra come from `VH.sounds.spectrumOf`, which includes the tone.
- **"Bands include other layers"** is the `M.song.bandsOthers` setting, with a panel toggle in Harmony. B3 implements the hook:
  - `M.hooks.bandExtras = (bar, layerIdx) => [{ hz, spectrum? }, ...]`: extra voices that count like chord tones for that bar and layer. Omit `spectrum` to use the backing spectrum.
  - The hook is only consulted while `bandsOthers` is on, and results are cached by value.
  - Call `M.markBandsDirty(bars?)` when the hook's results changed, and the map is redrawn on the next frame. Columns are cached by value (chord + spectra + extras), so unchanged bars cost nothing. `M.invalidateBands()` also drops that cache.
- Lower level: `M.bands.consonance(m, bar, L)`, `M.bands.snap(m, bar, L)`, `M.bands.cross(hz, bar, L)`.
- **Equal temperament by default.** The backing plays equal-tempered chords, so `snap` (and `bandsAt().snap`) returns a
  whole semitone (integer midi): within ±1.5 of m, scored by band consonance + chord / key membership - distance. Band
  maxima themselves are often a few cents off (a just third -14¢, a 7/4 -31¢). `M.bands.pure` (Settings > Edit >
  Intonation [Advanced] "Pure intonation", `VH.store` `melody.pureIntonation`, off by default) restores the exact band
  maxima (`M.bands.snapPure`) for Snap, Line ends, Select-move, auto-fit and 🎲 Melody. `peaks()` and the ghost path stay
  exact band maxima (a visual guide).
- `M.bands.fitCtx(bar, L)` -> `{ cons (per semitone LO..HI), thr (the bar's 60th percentile), c(m), isChord(m), isKey(m),
  fits(m), score(n, from, dir, prev), best(p, dir, prev) }` or null without a chord: the shared rules of the ET snaps,
  auto-fit and the generator. `fits` = chord tone, or key tone with consonance >= thr. `best` keeps p's semitone when it
  fits, else picks a fitting semitone within ±2 that keeps the melodic direction (dir, relative to the fitted previous
  pitch prev), smallest move, ties to chord tones.

## View: `M.view`

- `cv`, `ctx`, `HDR` (chord header height, 40), `VW`, `TH`, `MH` (map height), `BW` (bar width), `CW` (content width), `scrollX`.
- Conversions: `U()` (px per sixteenth), `xOf(t16)`, `t16Of(x)`, `yOf(midi)`, `midiOf(y)`.
- `xy(pointerEvent)` returns `[x, y]` in content coords.
- `rrect(x, y, w, h, r)`, `setScroll(x)`, `relayout()`.
- `addLane(el, { height? })` puts a DOM strip under the canvas and makes room for it. B2's drum lane is one.
  - The lane goes below the canvas's scroll bar and is as wide as the canvas. Content that should line up with the song uses `view.xOf` / `BW` / `scrollX` and listens to `'layout'` / `'scroll'` (the drum lane's step columns sit exactly under the canvas's bar and beat lines and scroll with it).
  - The canvas gets shorter by the lane's height + 6 px.
  - Without `height`, the lane is measured with a ResizeObserver, so content changes re-layout.
  - It returns `{ el, setHeight(px), remove() }`. `lanes()` lists `{ el, height }`.

## UI: `M.ui`

- The dock is: Play, Instrument, Layers, **Tool** (one button showing the current tool; it opens a pop-over with every tool and its key), Mixer, Share, Settings. Snap lives in Settings > Edit (key **S**).
- `addDockButton({ icon, label, title, pressed, onClick })` returns the button (`btn.set({ icon, label, pressed })`). It is inserted before Settings.
  - Keep the dock calm: prefer Settings sections for secondary controls.
- `configureTools({ items: [[id, icon, label, key, title], ...], pick(id) })`: the Tool pop-over's list (B1 supplies its palette; without it every registered tool is listed). `pickTool(id)`, `syncTools()`, `toolPop.open() / close()`.
- `toggleSnap()`.
- `addPanelSection(title, order = 60, { group, collapsed, advanced })` (or one object `{ title, order, group, ... }`) returns a `.vh-section`: the body of a collapsible accordion on one of the Settings panel's category tabs, sorted by order within its tab.
  - `group`: `'song'` | `'sound'` | `'mix'` | `'edit'` | `'export'`. Without a group the section goes to a "General" tab, which is hidden while empty. The tab strip and the "Find a setting" filter appear once two or more groups have sections.
  - `collapsed` / `advanced` start the section closed (`advanced` also shows a small tag). The user's open/closed choice and the last tab are remembered (`VH.store` `ui.panel.melody.*`).
  - Current layout:

  | tab | sections (order) |
  |---|---|
  | Song | Song: key, bars, tempo, loop (10) · Generate (45) · How to read it (90, collapsed) |
  | Sound | Instrument tone (22) · Backing (25) · Backing style + its sub-settings (26) · Effects (35) · Play feel (45, collapsed) · samples note (85) |
  | Mix | Mixer (10): layer rows, backing, part rows (`mixer.addRow`), master |
  | Edit | Grid & snap (10) · Editing (30) · Undo & clear (50) · Harmony map (60) |
  | Export | Share (10) · Export (70) |

  Use `VH.ui.slider / button / select / soundPicker` inside. `M.ui.openPanel(group?)` opens the panel (on that tab); `M.ui.drawer.reveal(el)` shows a control (its tab and accordion).
- `addTool(tool)` / `setTool(id)`: tools appear in the dock's Tool pop-over. Tool shape:

  ```
  { id, label, icon, title,
    cursor: 'css' | (p) => 'css',
    down(p, M) -> true to capture the drag (false = click handled, no drag),
    move(p, M), up(p, M), hover(p, M),
    draw(ctx, view)   // content coords, current tool only
    activate(), deactivate() }
  ```

  `p = { e, x, y, t16, midi, bar, layer, inHeader }`. Clicks on the chord header never reach tools: there a click on the
  chord name opens the picker, a click on empty strip space seeks (`view.headerHit(x, y)` -> 'name' | 'empty' | 'x'),
  a drag across the strip sets a whole-bar loop region (drawn as a band; its ✕ clears it), and while an inbox chord is
  waiting (`M.placing`) any header click places it.
- Hover readout (tools.js): while the pointer is over the map (and while drawing; on touch only while pressed) a label
  near it shows "E4 · 92% fit" / "F#4 +18¢ · 31%": `M.bandsAt(t16).consonance(midi)` of the active layer, the same
  column data the map is painted from (other layers included when `bandsOthers` is on). `M.tools.readoutText(t16, m)`.
- Drum lane (sound.js): below 600 px stage width it shows one bar at a time with ‹ › paging (follows the playhead while
  playing; steps >= 18 px); wider, every bar sits under its canvas bar, aligned to the pixel.
- Export: with a loop region, the dialog offers "Export loop region only" (off by default); `exportLib.sliceSong(S, a, b)`.
- `toast(msg, { sticky, action: { label, run } })` (sticky stays until replaced or `toast(null)`; an action adds a button, e.g. Undo), `mixer.open() / close() / refresh()` (the mixer is the panel's Mix tab; the dock's Mixer button opens it there), `layerMenu.open(i)`, `drawer` (the Settings panel API), `openPanel(group)`, `closeFloats()`.
- `mixer.addRow({ id, label, color?, get() -> 0..1, set(v), commit?, mute?: { get() -> bool, set(bool) }, muteTitle?, quiet?() })` adds a row between the backing and the master, with class `mel-mix-<id>`. It returns `remove()`. B2's Drums row is one.
  - `set` runs while dragging.
  - On release, the row commits `commit`: a label or a function. The default label is '<label> volume'.
  - `mute.set` should commit itself.
- For Melody, the experiment's load hint sits under the chord header (melody.css), clear of lanes and the dock.
- The built-in tool is `M.tools.list[0]` with id `'draw'`. `M.tools.noteAt(x, y)` returns the active layer's note index under a point, or -1.

## Tone (derived instruments)

The Tone section edits a derived copy of the selected instrument through `VH.sounds.derive`:
- Synths: Overtones, Stretch and Brightness. Samplers: Brightness only (`tone.bright`).
- Slider params are stored in `VH.store` under `melody.tones[<derivedId>] = { base, n, stretch, bright }`.
- Reset returns the layer to the base instrument.

## Inbox (from other experiments)

Spiral and Babel send things to Melody through `VH.store` key **`melody.inbox`**: an array of items. Push your item(s),
then set `location.hash = '#melody'`. Melody consumes **and clears** the inbox when it mounts, and when it is already
mounted and the hash changes (`onRoute`).

| item | effect |
|---|---|
| `{ type: 'chord', chord: [root 0..11, quality], from? }` | "place chord" mode: a toast "C maj from Spiral: click a bar to place it (Esc cancels)"; the next bar-header click sets that bar's chord through `M.setChord` (preview + auto-fit, one undo step). Esc or the toast's Cancel aborts. |
| `{ type: 'sound', soundId, from? }` | the sound goes on the active layer as one undo step ('Instrument from Babel'); toast "Now playing <sound> on <layer name>" with an Undo button. Applied once `VH.sounds.ready` resolved (so saved / sampled sounds are found). |

- `chord` uses exactly the `song.chords` entry format: `[root, quality]`, root 0..11 (C = 0), quality one of
  `'maj' 'min' 'dim' 'aug' 'sus2' 'sus4' '7' 'maj7' 'm7'` (`model.QUALS`). Example: `[9, 'min']` = A minor.
- `from` (optional) is the sender's experiment id ('spiral', 'babel'); the toast shows its title. Missing = the
  experiment the user came from (`VH.app.prev`).
- Unknown items are ignored. With several chord items the last one waits to be placed.

## Onboarding (onboard.js)

- **First visit** (main.js `M.firstVisit`): no autosave, no share link in the URL, an empty inbox, `melody.tutorial` not
  'done', and the first Melody mount of the page. Only then the demo song loads (without an undo step) and the tutorial
  starts. An autosave or a share link is never replaced.
- **Demo** (`VH.melody.demoSong()`): 4 bars, 90 BPM, C Am F G, Arpeggio backing (Pluck), soft brush drums; layer 1 is
  Clarinet (glide) with a melody in bars 1-2 held on band maxima (`M.bands.snap`); bars 3-4 are empty. `song.ext.demo.ghost`
  draws a faint dashed **ghost path** through consonance peaks (`bandsAt().peaks()`) in bars 3-4 (`M.ghost()`); it is
  not playable and disappears once anything is drawn there.
- **Tutorial** (`M.tutorial`: `step`, `start()`, `next()`, `skip()`): coach marks (card + arrow + highlight ring,
  repositioned on resize / layout / scroll / panel changes): 1 Play (advances when the song reaches bar 3 or stops),
  2 draw in bars 3-4 (advances on a drawing there), 3 change a chord (advances on any chord change; mentions Auto-fit),
  4 try another instrument (ring on the dock's Instrument picker; advances when any layer's instrument changes),
  5 Settings tour (ring on Settings; opening the panel puts the card above it and rings its tab strip for 2.6 s;
  advances on Next), then "You made music! 🎉". "x / 5" counter; Next / Skip on every card. Done or skipped -> `melody.tutorial = 'done'`.
- Settings > Song > **Start here**: Replay tutorial (loads the demo as an undo step, restarts the tutorial), Load demo
  song, New song (asks for confirmation inside the panel; one undo step).
