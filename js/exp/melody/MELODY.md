# Melody modules and the part context `M`

Melody is split into classic scripts. They share `window.VH.melody` (no ES modules, so it works from file://). Load order is set in `index.html`:

| file | role |
|---|---|
| `model.js` | constants, song model, time signatures, chord regions, sections + arrangement, `serialize`/`parse` (with migrations) → `VH.melody.model` |
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
{ key: 0..11, mode: scale id (VH.harmony.SCALES: 'major'|'minor'|'dorian'|...; key + mode are PER SECTION), tuning: '12tet'|'ji'|'pyth'|'19tet'|'24tet'|'31tet'|'slendro'|'pelog' (song-wide),
  bpm: 40..200 (quarter notes per minute, song-wide),
  // the CURRENT SECTION's content (see Sections):
  bars: 1..16, ts: '2/4'|'3/4'|'4/4'|'5/4'|'6/8'|'7/8'|'12/8',
  chords: [{ at: t16 within the section, chord: [root 0..11, 'maj'|'min'|'dim'|'aug'|'sus2'|'sus4'|'7'|'maj7'|'m7'] | null }, ...],
  sections: [{ id, name, color '#rrggbb', rep 1..8, data }], cur: index of the section shown,
  layers: [{ id 'l1'|'l2'|..., name, color '#rrggbb', sound (VH.sounds id), mode 'line'|'notes', vol 0..1, mute, solo,
             lines: [{ id 's1'|'s2'|.., v: Float32Array(tot16*3) of midi or NaN }]   (line strokes, 3 samples per sixteenth; see below),
             notes: [{ s: start sixteenth, d: length in sixteenths, m: midi (float) }] }, ...]   (1..8 layers),
  backing: { sound, vol 0..1, on, style: 'drone'|'strum'|'arp'|'pulse'|'broken',
             styleOpts?: { arp: { rate, pattern, oct, gate }, strum: { speed, dir }, pulse: { rate, gate }, broken: { pattern } } },
  master: 0..1, bandsOthers: bool,
  fx: {}, drums: {}, ext: {},     // free-form JSON for parts: B2 owns fx + drums; others use ext.<partName>
  loopRegion?: [a, b] | null,     // loop only bars a..b-1 (whole bars). Serialized only when set; part of undo, autosave, share
  auto: [{ id, target, points: [[t16, v 0..1, smooth?]] }],   // automation lanes of the shown SECTION (see Automation lanes)
  grid: 8|16, loop, snap }        // view prefs: autosaved and shared, but NOT part of undo
```

- **Line strokes.** A layer's line is a list of strokes that may overlap in time (polyphonic within the layer); a stroke
  may hold several runs. Stroke ids are stable (vibrato is keyed by them) and empty strokes are dropped on every commit.
  Serialized (since schema `v: 3`) as `lines: [{ id, segs }]`. Songs saved before strokes (v1 / v2, one `line` of segments) parse
  into stroke `s1` (`S.migratedLines` > 0; the autosave is written back as v3), their vibrato `{ l }` into `{ s: { s1 } }`.
  Helpers on `M.model`: `strokes(l)`, `addStroke(l, len)`, `nextStrokeId(l)`, `pruneStrokes(l)`, `lineAt(l, i)` -> `[{ id, m }]`,
  `hasLine(l)`, `lineRuns(l)`, `MAX_STROKES` = 8. `layer.line` is a legacy accessor (not serialized): stroke #1's samples;
  assigning an array replaces all strokes with one. New code reads `lines`.
- **Layer ids** are stable. They are unique within the song and kept by undo/redo, autosave and share links. `M.addLayer` takes `max + 1`.
  - Songs saved before ids existed get `l1..lN` in layer order when parsed (`S.migratedIds` > 0 then). An old autosave is saved back in the new format.
  - Part data may be keyed by id, or by index and kept aligned with `'layerRemoved'`. B1's `ext.edit.vib` and B2's `fx.layers` are index-keyed and shift there.
- Pitch range: `model.LO` = 48 (C3) to `model.HI` = 84 (C6). Time unit: the **sixteenth**; line samples: 3 per sixteenth.
  The bar length follows the section's time signature: use `md.spb(S)` (sixteenths per bar), `md.lpb(S)` (line samples
  per bar), `md.tot16(S)` (section length), `md.barAt(S, t16)`, `md.barsOf(S)`, `md.beatGrid(S, half)`, `md.tsOf(S)`
  (`{ n, d, spb, beats, half, compound }`; 6/8 + 12/8 beat in dotted quarters, 7/8 is 2+2+3). `model.SPB` = 16 /
  `model.LPB` = 48 remain as the 4/4 values for old callers only. `secPerBar(S)` follows the meter.
- **Chord regions.** `S.chords` holds chord *events*, sorted, with one at every bar start; more events split a bar, so a
  bar can hold several chords and a region never crosses a bar line. Region i = `[chords[i].at, md.regionEnd(S, i))`.
  Helpers: `regionAt(S, t16)`, `regionChord(S, i)`, `chordAt(S, t16)`, `regions(S)` -> `[{ i, a, z, chord, bar }]`,
  `barChords(S)` (one per bar, the older view), `splitAt(S, t16)`, `mergeAt(S, i)`, `normChords(S)`. **Every API that
  took a bar for chords / bands now takes a region index** (`M.setChord(r, ch)`, `engine.previewChord(r)`,
  `M.bands.column / consonance / snap / snapPure / fitCtx / cross(.., r, L)`, `bandExtras(r, L)`, beforeCommit
  `cx.chords`); while no bar is split, region index == bar index. `M.splitChord(t16)` / `M.mergeChord(r)` (one undo
  step each; a merge auto-fits the merged region).
- `fx`, `drums` and `ext` must stay plain JSON. They survive autosave, share links and undo.
- **Drum kit** (sound.js, song-wide): `ext.kit = { id, name, rows: [{ k, name, syn, sound, sname, vol }] }` (missing = built-in
  kick / snare / hat / perc). `k` is the pattern key (`kick|snare|hat|perc|r1..r9`, patterns stay per section), `syn` the
  built-in synth drum (`kick snare hat perc tom clap`), `sound` a VH.sounds id (imported one-shot, Babel find, CC0 sample;
  null = synth), `vol` 0..1.5. Up to 8 rows. Saved kits: VH.store `melody.kits` (song-independent); the song keeps a
  snapshot. `NS.sound.kitOf(S)`, `drumEvents` -> `{ drum (syn), row, ri, sound, gm }` (GM note by row: 36, 38, 42, 76, 39,
  45, 50, 49), `playHit`, `babelKit()`. `M.kit`: `get, open, close, use(kit), save(name), saved(), fromBabel(), addSounds(sounds)`.
- **Own sounds in links**: `M.ownSounds(S)` (imported / Babel / custom sounds the song uses). Share adds `ext.snd = { id: { name,
  play, spectrum } }` and shows `M.SHARE_NOTE`; on load a missing sound becomes `VH.sounds.closest(info)` (same play type,
  then spectral similarity), kit rows the synth drum, and a toast names each fallback (`M.missing`).
- `backing.styleOpts` holds each backing style's own sub-settings (sound.js: `NS.sound.styleOptsOf(S, style)` validates and fills defaults; missing = the original fixed patterns). It is serialized only when set, so older songs serialize unchanged. Live playback, the WAV render (`NS.sound.offline`) and the MIDI export (`NS.sound.barEvents`) all read it.
- Notes may carry extra runtime fields such as `sel: true` (B1 selection; the view draws it with a white outline). Those fields are **not** serialized.
- Model helpers (`M.model`): `nextLayerId(layers)`, `assignIds(layers)`, `chordMidis(ch)`, `chordName(ch, names)`, `namesOf(S)`, `scaleOf(S)`, `diatonic(S)`, `secPerBar(S)`, `secPer16(S)`, `layerGain(S, i)` (0 when muted or not soloed), `serialize(S, full)`, `parse(obj)`, `newLayer(i, opts, bars)`, `COLORS`, `MAX_LAYERS` = 8, `QUALS`.

## Scales, modes + tunings (M1)

- **Key = root + scale, per section** (live `S.key` / `S.mode` are the shown section's; `liveContent` / `sections[k].data`
  carry `key`, `mode`). 19 scales in `VH.harmony.SCALES` (`{ id, name, group: Common|Modes|Exotic, steps, hint }`);
  'major' / 'minor' keep their ids. `md.scaleOf(S)`, `md.scaleChords(S)` -> `[{ r, q, deg, k, rn }]` (7-note scales: the
  stacked triad per degree; others: every triad / 7th that fits), `md.diatonic(S)` (`[[r, q]]`, first = tonic), `md.scaleLabel(S)`.
- **Tuning** (song-wide `S.tuning`, `md.tuningOf(S)`): `md.gridOf(S)` -> `{ et12, N, pts (every tuning pitch in LO..HI,
  anchored at the section's key root), cls, scaleCls, idx(m), snap(m), inScale(m) }`; `md.gridSnap(S, m)`. 12-TET = the
  integer midis, so 12-TET behaviour is unchanged. `fitCtx`, snap, auto-fit, 🎲 Melody and select-move use grid pitches
  (`fitCtx().pts`, `.grid`). `md.chordMidis(ch, S)` = tuned chord tones (harmony.tunedChord: JI = just ratios from the
  chord root, others = nearest steps; `ch.kp` = the section key in flattened songs); without `S` the plain ET midis.
  Bands, backing, previews and the WAV render use the tuned tones; Pure intonation stays independent.
- View: faint scale tint on in-scale rows / piano keys (`view.showScale`, Settings > Edit > Harmony map "Show scale",
  VH.store `melody.showScale`, default on); in non-12 tunings a step strip (step numbers, cents, 12-TET ticks).
- Export: MIDI with `tuned: true` puts every simultaneous note (notes layers, backing) on its own channel with pitch
  bends (`exportLib.packVoices`); Settings > Song "⤓ .scl" downloads `VH.harmony.sclText(tuning)`.
- Schema `v: 5`: per-section `key` / `mode`, `tuning` (only when not 12-TET). Older songs load as their major / minor in 12-TET.

## Automation lanes (export.js, bottom part)

- Data per section: `S.auto` (live = the shown section; others in `sections[k].data.auto`; copied by duplicate, carried by
  `md.flatten` as `F.flatAuto = { target: [{ a, n, pts }] }`, sliced by `exportLib.sliceSong`). Serialized (top level and
  per section) only when non-empty, so songs without lanes serialize unchanged. `md.autoIn / autoOut / autoCopy`.
- Targets: `'<layer id>.vol|pan|cut|rev|dly'`, `'backing.vol'`, `'drums.vol'`, `'master.vol'`. Lane values 0..1: vol =
  gain multiplier on the fader (dB readout), pan -1..1, cut = lowpass 40 Hz..20 kHz (log), rev / dly = send level. A point's
  3rd value 1 = smooth (cosine) segment after it. A section without a lane for a target is neutral (vol 1, centre, open,
  sends at the mixer level). Pure helpers: `VH.melody.exportLib.auto` (`valueAt`, `ramp`, `pieces`, `targets`,
  `chanKinds`, `fmt`, `ccPoints`, `slice`; tested in `test/melody-auto.test.js`).
- Audio: sound.js `FxGraph` channels build `[gain][StereoPanner][lowpass]` before their insert chain and their own send
  gains only while a lane targets them (`ch.params()`, `ch.neutral(kind)`); no lanes = the plain graph (sample-identical).
  Master: `engine.autoMaster(on)` (a gain after the master bus). Live: a look-ahead scheduler (120 ms, `E.segments`, so
  loop regions / seeks / Song-mode passes follow) with `setValueAtTime` + `linearRampToValueAtTime` (smooth and cutoff
  segments in 1/4-sixteenth steps). Offline (WAV / MP3) schedules the same ramps up front; MIDI writes CC7 / 10 / 74 / 91 /
  93 per channel (every 1/32, changes only) and master volume as a Universal SysEx.
- UI: an `addLane` strip under the drum lane ("Automation (n)" toggle, "+ Lane", 36 px rows aligned to the canvas grid;
  collapsed by default at <= 600 px), Settings > Mix > Automation "Show automation" (`melody.showAuto`). Gestures: click =
  add (1/16 snap, Shift free), drag = move, double-click / right-click = delete, Alt+click or ∿ = smooth. One undo step
  per gesture. Debug handle: `VH.melody.autoPart`.

## Sections + arrangement

- A song is a list of **sections** in play order (`S.sections`), each with its own bars, time signature, chords, loop
  region, layer content (strokes + notes, by layer id), drum pattern (`S.drums` minus `vol`) and vibrato (`ext.edit.vib`).
  Tempo, tuning, instruments, mixer and fx are song-wide (key + scale are per section). The live fields above are the shown section (`S.cur`); the
  others' content lives in `sections[k].data` (`md.selectSection` swaps; `md.sectionSong(S, k)` gives any section as a
  standalone song; `md.arrangement(S)` -> passes `[{ k, r, a, n }]`; `md.songTot(S)`; `md.flatten(S, { only? })` lays the
  arrangement end to end for export, with `S.flat = { tot, bars: [{ a, n, b, ts, drums }], ts: [{ at, ts }] }`).
- Actions (each one undo step): `M.addSection(dup)` (after the shown one; a new one gets tonic chords, no notes, the same
  meter, bars and groove), `M.deleteSection(k)`, `M.moveSection(from, to)`, `M.renameSection(k, name)`,
  `M.recolorSection(k, color)`, `M.setRepeat(k, 1..8)`, `M.setTimeSig(ts)` (content keeps its place in each bar; emits
  `'timeSig'` before its commit so parts adapt, e.g. the drum steps), `M.setBars(1..16)`. `M.selectSection(k)` shows a
  section (no undo step). Undo / redo restore the section shown with the snapshot.
- Playback: `M.playMode` 'section' (loop the shown section / its loop region) | 'song' (`M.setPlayMode`, VH.store
  `melody.playMode`): Play runs the arrangement from the shown section; at a section end `M.nextPass()` switches the
  section shown and the engine restarts its schedulers at the new downbeat (`engine.pass` = the arrangement item).
- Count-in (Settings > Song > Count-in, VH.store `melody.countIn`): Play first clicks one bar (x/4 quarters, x/8 eighths,
  accent on 1); `engine.counting`, `engine.countLog` = `[[audio time, level 2|1|0]]`.
- UI (ui.js): the **arrangement strip** is a top lane above the chord header (`view.addLane(el, { top: true })`): Section /
  Song, one block per section (click = show; click the shown one = menu: name, color, repeat, duplicate, delete; drag =
  reorder), "+" (new / duplicate). One 28 px row that scrolls sideways.
- Serialized (schema `v: 4`): top-level content = the shown section; `sections: [{ id, name, color, rep, ...content of
  the others }]`, `cur`; chords `[[at, root, q] | [at]]`. Older songs and share links migrate to one section "A"
  (`S.migratedSections`; the autosave is written back as v4).

## Editing and undo

| call | does |
|---|---|
| `M.commit(label, opts?)` | Call **after** mutating `M.song`. It records one undo step (label shown on the Undo button) if the song changed since the last commit, then re-syncs the UI, refreshes bands, autosaves, and emits `'song'`. Returns `true` if a step was recorded. For drags, mutate on every move with `M.requestRender()` and commit once on pointer-up. `opts = { chords: [bars whose chord changed], source: 'chord' \| 'generate' \| ..., keepHash }` goes to the `beforeCommit` hooks (see Hooks). `M.lastCommit` is the final context `{ label, chords, source, info }`. |
| `M.undo()` / `M.redo()` | Undo or redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y). |
| `M.revert()` | Drop uncommitted live edits (back to the last committed song, no step). Used when a pinch cancels a drag. |
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
- `M.setBars(n)` (1..16, current section; new bars repeat the chords and splits of the bars before them)
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

- **Sharing + loading** (main.js): `M.shareCode()` returns a Promise of the share-link code (`VH.store.encodeShare(serialize(S, true))`; own sounds
  add `ext.snd`). View preferences (Map look, scale tint) are never part of it. `M.share()` copies `<url>#melody/s=<code>` (local hosts use the public URL).
  `M.loadSong(code, { undoable = true, label, toast, failToast, keepHash })` returns Promise<boolean>: it decodes + parses a code, replaces the song (one undo
  step unless `undoable: false`), resolves missing sounds as links do, and toasts; false (with `failToast`) when unreadable.
  `M.publish()` opens the Gallery's publish dialog for this song (`VH.gallery.openPublish(M)`), or returns null when the gallery is not loaded.

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
| `'draw'` | `(ctx, view)` | overlay drawing. The ctx is already scaled for dpr, translated by `X0 - scrollX` and clipped to the visible map, so draw in **content coords** with `view.xOf` / `view.yOf`. Runs after layers, before the playhead. |
| `'layout'` / `'scroll'` | `(view)` | canvas resized or scrolled (time scroll or pitch zoom / scroll) |
| `'sounds'` | none | sound library changed (resolved sounds and bands refreshed) |
| `'tools'` / `'tool'` | none | tool list or current tool changed |
| `'seek'` | `(t16)` | `engine.seek`: playhead moved (playing) or the cue was set (stopped) |
| `'section'` | `(k)` | the section shown changed, or sections were added / removed / reordered / renamed |
| `'pass'` | `(p)` | Song playback moved to arrangement item p |
| `'timeSig'` | `(ts)` | `M.setTimeSig`, before its commit (adapt part data in the same undo step) |
| `'unmount'` | none | before parts' `destroy` |

Tick info `t`:

```
{ now (performance.now ms), pos16, prevPos16, wrapped (looped this frame), bar, region (chord region), pass, lineIndex, phase 0..1,
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
- `engine.setBacking(impl | null)` replaces the default drone. `impl = { onBar(bar, midis|null, info), stop(rel) }`, called per
  **chord region**, where `info = { now, ctxTime, secPerBar, region, a16, z16, secs }`.
- Backing styles (sound.js `backingEvents(style, midis, sec16, opts, bar, { ts, a, len })`) follow the meter: pulse on the
  beats (6/8 in dotted quarters), broken bass / chord on the beats, arpeggios on the bar grid; a region starting between
  onsets re-strikes the pattern there. `regionEvents(S, r)` (MIDI). Drum steps = sixteenths per bar (`presetPat(id, ts)`:
  3/4 waltz, 6/8 + 12/8 compound, others a generic groove; `drums.ts` = the meter a pattern was made for).
  - Play into `engine.backingBus()` and respect `M.song.backing.on`.
  - Use `M.backingSound()`.
  - `stop` must silence everything.
  - Pass `null` to restore the drone. `engine.restartBacking()` re-triggers the current bar.
- Transport: `play()` starts at `engine.cue` (set by a seek while stopped), else the loop region's start, else 0. `seek(t16)` while playing jumps there and playback continues (notes queued for the old position are cut); while stopped it sets the cue (drawn as a dashed line). `loopRange()` -> `{ a16, b16, on }`. With a loop region, playback loops only those bars (regardless of `song.loop`); a seek outside it plays on to the region end (or the song end) and then returns to the region start.
- `engine.playing`, `phase`, `pos16`, `bar`, `ctx`, `play()`, `stop()`, `toggle()`, `seek(t16)`, `secPer16()`, `secPerBar()`, `playOf(sound)` ('glide' | 'hit'), `gainOf(i)`, `backingGain()`.
- `engine.previewChord(bar)` and `engine.previewNote(i, midi, dur)` are for gesture handlers only. `engine.stopAll()`, `engine.stopLayer(i)`.
- Line playback: one voice per **stroke** (overlapping strokes sound together; `engine.lineVoices()` counts the live ones). 'glide' sounds play legato within a stroke's run (`setFreq`). 'hit' sounds re-trigger only when a stroke crosses a semitone, at least `engine.MIN_GAP` = 70 ms apart on the audio clock (per stroke).
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
into the new pitch over a sixteenth. Each line stroke is fitted on its own. Line vibrato is keyed by stroke id + sample
index (unchanged); note vibrato is re-keyed. Tests can set `VH.melody.fitStats = { items: [] }` to collect
`{ L, kind: 'note'|'plateau', stroke?, from, to, micro, kept }`.

Vibrato store (B1): `S.ext.edit.vib[L] = { s: { <stroke id>: [[from, to, cents, hz]] }, n: [[s, m, cents, hz]] }`.
`VH.melody.vibrato.lineAt(S, L, i, strokeId)`, `lineArray(S, L, strokeId)`; the export's `vibReader(song, L).line(i, strokeId)`.

`voiceOpts`:
- `kind` is `'note'`, `'line'` or `'backing'` (layer = -1 for the backing).
- `opts = { midi, gain, when }`. `when` is an audio time, or `undefined` for now. Notes come with their scheduled time, up to `LOOKAHEAD` ahead.
- Mutate `opts` or return a replacement. `when`, `gain` and `midi` are honoured. All registered fns run in order.

`pitchMod`:
- `ref` depends on `kind`:
  - `'line'`: `{ i, m, k }` (line sample, midi and stroke id).
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
- `M.bands.fitCtx(r, L)` (r = chord region) -> `{ cons (per semitone LO..HI), thr (the bar's 60th percentile), c(m), isChord(m), isKey(m),
  fits(m), score(n, from, dir, prev), best(p, dir, prev) }` or null without a chord: the shared rules of the ET snaps,
  auto-fit and the generator. `fits` = chord tone, or key tone with consonance >= thr. `best` keeps p's semitone when it
  fits, else picks a fitting semitone within ±2 that keeps the melodic direction (dir, relative to the fitted previous
  pitch prev), smallest move, ties to chord tones.

- **Tension dial** (`S.tension` 0..1, per section, serialized only when > 0; `M.setTension(v, final)`; Settings > Song slider + the chip left of the zoom buttons): the map highlights `h = md.tensionH(c, T)` instead of the consonance c (T = 0: h = c, pixel-identical to before; else a Gaussian around c = 1 - T blended in; warmer palette via `md.tensionTint`). Applied at draw / fit time to the cached columns (`bands.pixels`, `at.H`, `at.match(m)`, `at.matchPeaks()`). With T > 0 `fitCtx().fits` = h + faded chord / key bonuses + a chord-extension bonus (peaks at Color) >= the bar's 70th percentile, and `best` looks within 3 semitones. The hover readout shows "% match"; snap, select-move, auto-fit and the generator follow. Export and playback are unchanged.

## Map look (view preference)

- `M.bands.look()` -> `{ clarity 0..100, theme, thick, glow, dark, grid 0..100, regions, piano, labels }` (`md.LOOK_DEFAULTS`, validated by `md.lookIn`), stored in
  VH.store `melody.look`; **not in the song, not shared, not an undo step**. `M.bands.setLook(patch)` (saves, marks the bands dirty, emits `'look'`) and
  `M.bands.resetLook()`. The scale tint stays `view.showScale` / `melody.showScale` (`M.view.setShowScale(v)`).
- Draw-time only: band columns keep their `t` curve; `md.lookCurve(t, look)` (pure: thickness power, clarity floor + contrast, local maxima only from 60%,
  identity at 0) runs after the Tension mapping, then `md.lookStops(theme, tint, dark)` gives the palette (7 themes in `md.LOOK_THEMES`; the Tension tint is added
  to a theme's stops, Ember / Mono blend toward their own `hot` stops). At the defaults the old pixel path runs unchanged.
- UI: `M.view.buildLook(host)` builds the controls, used by Settings > Edit > "Map look" and the 🎨 chip pop-over left of the ◐ chip.
- Grid visibility scales the bar / beat / semitone lines; `regions` off flattens the chord-header tints; `piano` off makes `X0` 0; `labels` hides C / note names.

## View: `M.view`

- `cv`, `ctx`, `HDR` (chord header height, 40), `VW`, `TH`, `MH` (map height), `BW` (bar width), `CW` (content width), `scrollX`.
- **Piano strip:** `X0` (= `KW()`, 22 px; 14 px at <= 600 px) is the strip's width. The time axis starts right of it: content
  x 0 (bar 1) is canvas x `X0`, and `GW` = `VW - X0` is the visible graph width (bar widths and time scroll use it).
  `sx(x)` turns a content x into a canvas x (`x - scrollX + X0`); DOM placed over the canvas (pickers, coach marks, the
  drum lane's `translateX(X0 - scrollX)`) uses it.
- **Pitch zoom:** `span` visible semitones (36 .. `Z_MIN` 12) with `pTop` the top pitch. `yOf` / `midiOf` / `keyOf` follow
  it, as do `PPS()` (px per semitone) and `noteH()` (note bar height). `setPitchView(span, top)`, `zoomAt(f, canvasY)`,
  `scrollPitch(dm)`, `zoomed()`. Ctrl/Cmd + wheel zooms around the cursor, a plain wheel scrolls pitch while zoomed
  (Shift / horizontal wheel = time), + / − keys and buttons (top-right), a two-finger pinch, a one-finger drag on the piano
  strip, and a slim scroll bar at the right edge while zoomed. The band image is cropped at draw time (no recompute).
  Saved in `VH.store` `melody.view` (`{ span, top }`), not in the song. Emits `'scroll'`.
- Conversions: `U()` (px per sixteenth), `xOf(t16)`, `t16Of(x)`, `yOf(midi)`, `midiOf(y)`.
- `xy(pointerEvent)` returns `[x, y]` in content coords (scroll and strip offset applied).
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
  | Song | Song: key, bars + time signature (shown section), tempo, loop, count-in (10) · Generate (45) · How to read it (90, collapsed) |
  | Sound | Instrument tone (22) · Backing (25) · Backing style + its sub-settings (26) · Effects (35) · Play feel (45, collapsed) · samples note (85) |
  | Mix | Mixer (10): layer rows, backing, part rows (`mixer.addRow`), master · Automation (40) |
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

  `p = { e, x, y, t16, midi, bar, region, layer, inHeader }`. Clicks on the chord header never reach tools: there a click on
  the chord name opens the picker for that region, a click on empty strip space seeks (`view.hdrAt(x, y)` -> `{ kind:
  'name' | 'empty' | 'x' | 'edge' | 'plus', region, at }`), a "+" at a beat boundary (hover near the strip's bottom)
  splits the chord, the grip between two chords drags the boundary (snaps to beats, Shift half-beats; dropped on the
  next / previous boundary = merge; `M.tools.edgeSnap / edgeTo / edgeDone`), right-click = Split here / Merge / Change chord,
  a drag across the strip sets a whole-bar loop region (drawn as a band; its ✕ clears it), and while an inbox chord is
  waiting (`M.placing`) any header click places it.
- Hover readout (tools.js): while the pointer is over the map (and while drawing; on touch only while pressed) a label
  near it shows "E4 · 92% fit" / "F#4 +18¢ · 31%": `M.bandsAt(t16).consonance(midi)` of the active layer, the same
  column data the map is painted from (other layers included when `bandsOthers` is on). `M.tools.readoutText(t16, m)`.
- Drum lane (sound.js): below 600 px stage width it shows one bar at a time with ‹ › paging (follows the playhead while
  playing; steps >= 18 px); wider, every bar sits under its canvas bar, aligned to the pixel.
- Export renders the whole arrangement (`md.flatten`; MIDI writes a time-signature meta at every meter change); the
  dialog offers "Current section only" (with 2+ sections) and, with a loop region, "Export loop region only"
  (`exportLib.sliceSong(S, a, b)`).
- `toast(msg, { sticky, action: { label, run } })` (sticky stays until replaced or `toast(null)`; an action adds a button, e.g. Undo), `mixer.open() / close() / refresh()` (the mixer is the panel's Mix tab; the dock's Mixer button opens it there), `layerMenu.open(i)`, `drawer` (the Settings panel API), `openPanel(group)`, `closeFloats()`.
- `mixer.addRow({ id, label, color?, get() -> 0..1, set(v), commit?, mute?: { get() -> bool, set(bool) }, muteTitle?, quiet?() })` adds a row between the backing and the master, with class `mel-mix-<id>`. It returns `remove()`. B2's Drums row is one.
  - `set` runs while dragging.
  - On release, the row commits `commit`: a label or a function. The default label is '<label> volume'.
  - `mute.set` should commit itself.
- For Melody, the experiment's load hint sits under the chord header (melody.css), clear of lanes and the dock.
- The built-in tool is `M.tools.list[0]` with id `'draw'`. `M.tools.noteAt(x, y)` returns the active layer's note index under a point, or -1.
- Line strokes (Pen and Line tool): a stroke starting within ~1 semitone of an existing stroke (± a sixteenth) edits that
  stroke over the drawn span ("fix"); farther away it adds a new overlapping stroke ("+ new"); Alt always adds one. A
  badge by the cursor shows which. `M.tools.strokeTarget(x, y, alt)` -> `{ st | null, i, m }`, `beginStroke(p)` (creates
  the new stroke), `drawBadge(ctx, x, y, fix)`, `badgeState()` ('fix' | 'new' | null), `cancel()` (abort the current drag
  with `M.revert()`). One undo step per stroke. The eraser splits a stroke it cuts: later pieces become new strokes.
- MIDI export: a layer's line runs are packed into voices that never overlap; each voice gets its own channel (channel 10
  skipped) with its own pitch bends. Separate mode writes one track per layer holding all of its channels.

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
| `{ type: 'song', code, title?, author? }` | the Gallery's "Open in Melody": `M.loadSong(code, ...)` as one undo step labelled "Open <title>"; toast "Opened <title> by <author> (Ctrl+Z to go back)"; an unreadable code toasts "That song couldn't be read". `title` is cut at 60 chars, `author` at 30 (default "Anonymous"). |

- `chord` uses exactly the `song.chords` entry format: `[root, quality]`, root 0..11 (C = 0), quality one of
  `'maj' 'min' 'dim' 'aug' 'sus2' 'sus4' '7' 'maj7' 'm7'` (`model.QUALS`). Example: `[9, 'min']` = A minor.
- `from` (optional) is the sender's experiment id ('spiral', 'babel'); the toast shows its title. Missing = the
  experiment the user came from (`VH.app.prev`).
- Unknown items are ignored. With several chord items the last one waits to be placed.

## Onboarding (onboard.js)

- **First visit** (main.js `M.firstVisit`): no autosave, no share link in the URL, an empty inbox, `melody.tutorial` not
  'done', and the first Melody mount of the page. Only then the demo song loads (without an undo step) and the tutorial
  starts. An autosave or a share link is never replaced.
- **Demo** (`VH.melody.demoSong()`, a one-section song): 4 bars, 90 BPM, C Am F G, Arpeggio backing (Pluck), soft brush drums; layer 1 is
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
