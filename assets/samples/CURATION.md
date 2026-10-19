# Sample curation: CC0 instrument pack (VSCO-2-CE)

## Source and provenance

- Source: `C:\Users\elias\Documents\Instrument Samples (CC0 Public Domain)` (14 folders, 167 WAVs, all stereo 16-bit 44.1 kHz PCM). Read only; nothing there was modified.
- The pack is derived from **VS Chamber Orchestra: Community Edition (VSCO-2-CE)**: see its `LICENSE` (CC0 1.0), `README.md` and `Readme.txt`.
- The folder names ("Felt Grand Piano", "Monastery Choir Ooh", ...) were assigned by a tool and are often wrong. Each folder was identified by ear-proxy analysis (spectrum, inharmonicity, envelope, vibrato/tremolo, duration) and by matching its note grid against the VSCO-2-CE folder tree (github.com/sgossner/VSCO-2-CE). Several folders mix two or more source instruments; those were split or trimmed to one coherent timbre.
- Output MP3s were written with metadata stripped (`-map_metadata -1`).

## Method

- Analysis per WAV: format, channels, duration, peak, RMS, clipped samples (|x| >= 0.999 on either channel), onset (first sample above -50 dB re peak), tail noise floor (last 50-200 ms RMS), L/R correlation.
- Pitch: harmonic-comb estimate (FFT peaks at k*f, k <= 4, amplitude-weighted) plus median multi-frame YIN. Both must be within 30 c of the zone's root. Octave and mislabel checks used a wide-range YIN pass, FFT partial inspection and partial levels at 0.25-4x the label.
- Downmix: (L+R)/2. Where L/R correlation was below -0.4 (a polarity-inverted channel; 8 files), R was inverted before summing so the channels do not cancel. All sources are already 44.1 kHz.
- Zone selection: up to 8 zones, evenly spread across the passing zones; a pick that is more than 20 c off is swapped for a better-tuned unselected neighbour. One zone per sounding pitch (filename-collision guard).
- Conversion: leading silence over 5 ms trimmed (cut 1 ms before onset, 1 ms fade-in); trailing silence trimmed at -60 dB. Capped at 4 s (5 s for sustained strings, brass, organ, woodwind) with a 0.3 s cos^2 fade-out; samples that end mid-sustain get a fade too.
- Gain: one gain per instrument (relative dynamics kept), iterated so the loudest **decoded** MP3 zone peaks at or just below -1 dBFS. Mono MP3, 44.1 kHz, 96 kbps CBR, LAME.
- Spectrum: middle zone, FFT of 0.3-1.0 s after onset, peaks >= -40 dB, ratios to the measured f0. Harmonic instruments get one peak per harmonic number; mallets get all peaks (6 % merge). At most 16 entries, max amp 1.
- Files are named by the *sounding* pitch (rootMidi, `s` = sharp), not the source label.

## Summary

167 WAVs analyzed; 111 zones kept in 16 instruments; 25 files rejected; 31 files passed but were not selected (8-zone cap). Total MP3 size 5.38 MB.

| Instrument | id | Source folder | Grade | Zones kept / files | Range | Max pitch err | Real identity |
|---|---|---|---|---|---|---|---|
| Upright Piano | `upright-piano` | `01_Felt_Grand_Piano` | **good** | 8 / 14 | G1-G6 | 15.9 c | Upright piano (VSCO-2-CE `Keys/Upright Nr1`), not a felt grand |
| Pizzicato Strings | `pizz-strings` | `02_Ancient_Acoustic_Lute` | **ok** | 8 / 16 | C2-G4 | 14.1 c | Pizzicato strings (cello/viola section plus solo violin), not a lute |
| Concert Harp | `harp` | `03_Classical_Nylon_Harp` | **good** | 8 / 20 | D2-A6 | 18.9 c | Concert (pedal) harp; 'nylon' in the label is a guess |
| Upright Piano B (soft) | `upright-b-soft` | `04_Vintage_Rhodes_Keys` | **good** | 7 / 8 | F1-F5 | 15.8 c | Upright piano (VSCO-2-CE `Keys/Upright Piano`), not a Rhodes |
| Upright Piano B (loud) | `upright-b-loud` | `05_Haunted_Wurlitzer_Keys` | **good** | 8 / 8 | A1-F6 | 15.7 c | Upright piano (VSCO-2-CE `Keys/Upright Piano`), not a Wurlitzer |
| Low Strings Sustain | `low-strings` | `06_Cathedral_Strings_Section` | **good** | 8 / 14 | F#1-G5 | 4.7 c | Low strings sustain (cello section + contrabass mix) |
| Solo Contrabass | `contrabass` | `07_Chamber_Vibrato_Strings` | **good** | 6 / 6 | E1-G#3 | 2.7 c | Solo contrabass (split out of 'Chamber Vibrato Strings') |
| Solo Violin | `solo-violin` | `07_Chamber_Vibrato_Strings` | **good** | 6 / 6 | G3-G6 | 17.4 c | Solo violin, arco vibrato (split out of 'Chamber Vibrato Strings') |
| Mixed Low Brass | `mixed-brass` | `08_Dungeon_Brass_Horns` | **ok** | 8 / 14 | A1-A5 | 5.9 c | Mixed brass (tuba / F horn / trombone / trumpet), not one horn section |
| Pipe Organ (quiet stop) | `organ-quiet` | `09_Monastery_Choir_Ooh` | **good** | 8 / 12 | C2-F#5 | 9.9 c | Pipe organ, quiet registration (VSCO-2-CE `Keys/Organ/Quiet`), not a choir |
| Pipe Organ (full) | `organ-loud` | `10_Cathedral_Choir_Ahh` | **ok** | 7 / 12 | C2-F#5 | 5.6 c | Pipe organ, loud/full registration (VSCO-2-CE `Keys/Organ/Loud`), not a choir |
| Concert Flute | `flute` | `11_Hollow_Woodwind_Flute` | **good** | 7 / 10 | A4-A6 | 2.9 c | Concert flute (files 05-11); files 01/03/04 are bassoon/oboe |
| Marimba | `marimba` | `12_Celesta_Kalimba_Bells` | **ok** | 3 / 3 | C3-C5 | 5.1 c | Marimba (split out of 'Celesta Kalimba Bells') |
| Xylophone | `xylophone` | `12_Celesta_Kalimba_Bells` | **ok** | 5 / 6 | G5-G7 | 19.7 c | Xylophone (split out of 'Celesta Kalimba Bells') |
| Glockenspiel | `glockenspiel` | `13_Harpsichord_Clavichord` | **ok** | 6 / 6 | G4-C7 | 17.6 c | Glockenspiel (VSCO-2-CE `Percussion/Glock`), not a harpsichord |
| Tremolo Strings | `tremolo-strings` | `14_Dark_Fantasy_Gloom_Pads` | **ok** | 8 / 12 | G#2-G5 | 19.8 c | Tremolo strings (mixed sections), not a synth pad |

Label fixes (rootMidi vs. file label): +12 for every file of folders 06, 08, 11 (flute), 12, 13 and 14, files 01-08 of folder 02 and 01-06 of folder 07; **-2** for files 05-12 of folder 09 (labeled D/G#, sound C/F#). All other kept zones sound at their label.

## Per-instrument detail

### Upright Piano (`upright-piano`, keys): good

**Real identity:** Upright piano (VSCO-2-CE `Keys/Upright Nr1`), not a felt grand. Same C/G sampling grid as Upright Nr1 (C1-G7, 14 notes). Stretched partials (8th at 8.05x), 7-13 s free decay, peak level at about -30 dBFS (soft hammer). C7 (+33 c YIN) and G7 (no stable pitch) rejected.

Spectrum from G3 (f0 195.58 Hz); gain +30.00 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Felt Grand Piano - C1 (MIDI 24).wav | C1 (24) | C1 (24) | -22.3 / -12.3 c | 7.51 s | -32.3 dB | - | - | passed; not selected |
| 02 - Felt Grand Piano - G1 (MIDI 31).wav | G1 (31) | G1 (31) | -15.9 / -9.4 c | 7.70 s | -30.6 dB | 4.00 s | -1.03 dB | kept: `G1.mp3` |
| 03 - Felt Grand Piano - C2 (MIDI 36).wav | C2 (36) | C2 (36) | -9.0 / -6.5 c | 10.55 s | -30.7 dB | 4.00 s | -1.15 dB | kept: `C2.mp3` |
| 04 - Felt Grand Piano - G2 (MIDI 43).wav | G2 (43) | G2 (43) | -6.3 / +0.3 c | 13.02 s | -31.4 dB | 4.00 s | -1.91 dB | kept: `G2.mp3` |
| 05 - Felt Grand Piano - C3 (MIDI 48).wav | C3 (48) | C3 (48) | -3.0 / -0.2 c | 7.07 s | -31.5 dB | - | - | passed; not selected |
| 06 - Felt Grand Piano - G3 (MIDI 55).wav | G3 (55) | G3 (55) | -3.7 / +0.5 c | 10.21 s | -31.2 dB | 4.00 s | -1.66 dB | kept: `G3.mp3` |
| 07 - Felt Grand Piano - C4 (MIDI 60).wav | C4 (60) | C4 (60) | -3.3 / -3.2 c | 11.02 s | -32.4 dB | 4.00 s | -2.86 dB | kept: `C4.mp3` |
| 08 - Felt Grand Piano - G4 (MIDI 67).wav | G4 (67) | G4 (67) | +1.1 / +0.4 c | 10.41 s | -33.7 dB | - | - | passed; not selected (R polarity flipped in downmix) |
| 09 - Felt Grand Piano - C5 (MIDI 72).wav | C5 (72) | C5 (72) | -1.4 / +0.3 c | 8.89 s | -33.1 dB | 4.00 s | -3.54 dB | kept: `C5.mp3` (R polarity flipped in downmix) |
| 10 - Felt Grand Piano - G5 (MIDI 79).wav | G5 (79) | G5 (79) | +4.0 / +2.5 c | 8.66 s | -33.0 dB | 4.00 s | -3.44 dB | kept: `G5.mp3` (R polarity flipped in downmix) |
| 11 - Felt Grand Piano - C6 (MIDI 84).wav | C6 (84) | C6 (84) | +4.6 / +8.0 c | 5.78 s | -31.2 dB | - | - | passed; not selected |
| 12 - Felt Grand Piano - G6 (MIDI 91).wav | G6 (91) | G6 (91) | +2.3 / +9.8 c | 3.53 s | -34.1 dB | 3.53 s | -4.53 dB | kept: `G6.mp3` |
| 13 - Felt Grand Piano - C7 (MIDI 96).wav | C7 (96) | C7 (96) | +12.0 / +33.1 c | 2.85 s | -30.9 dB | - | - | rejected: pitch error +33.1 c (YIN), +12.0 c (comb) |
| 14 - Felt Grand Piano - G7 (MIDI 103).wav | G7 (103) | G7 (103) | +4.8 / n/a | 1.69 s | -33.5 dB | - | - | rejected: YIN found no stable pitch (comb +4.8 c) |

### Pizzicato Strings (`pizz-strings`, plucked): ok

**Real identity:** Pizzicato strings (cello/viola section plus solo violin), not a lute. Files 01-08 sound one octave above their labels (cello/viola pizz grid); files 09-12 sound at the label (solo-violin pizz grid). Fast pluck, 1-3 s decay, few harmonics. Files 13-16 are fragments or unpitched and are rejected.

Spectrum from A3 (f0 219.55 Hz); gain +13.13 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Ancient Acoustic Lute - C1 (MIDI 24).wav | C1 (24) | C2 (36) | +0.8 / -0.6 c | 3.13 s | -24.0 dB | 2.57 s | -11.30 dB | kept: `C2.mp3` |
| 02 - Ancient Acoustic Lute - G1 (MIDI 31).wav | G1 (31) | G2 (43) | -2.6 / +1.9 c | 3.22 s | -22.5 dB | - | - | passed; not selected |
| 03 - Ancient Acoustic Lute - C2 (MIDI 36).wav | C2 (36) | C3 (48) | +0.1 / -0.2 c | 2.27 s | -31.2 dB | 2.27 s | -18.52 dB | kept: `C3.mp3` |
| 04 - Ancient Acoustic Lute - E2 (MIDI 40).wav | E2 (40) | E3 (52) | +0.7 / -4.1 c | 0.46 s | -33.2 dB | 0.46 s | -20.56 dB | kept: `E3.mp3` |
| 05 - Ancient Acoustic Lute - G2 (MIDI 43).wav | G2 (43) | G3 (55) | -9.0 / -8.2 c | 0.91 s | -27.9 dB | - | - | passed; not selected |
| 09 - Ancient Acoustic Lute - A3 (MIDI 57).wav | A3 (57) | A3 (57) | -3.5 / -2.1 c | 2.58 s | -20.8 dB | 2.48 s | -8.15 dB | kept: `A3.mp3` |
| 06 - Ancient Acoustic Lute - B2 (MIDI 47).wav | B2 (47) | B3 (59) | -5.6 / +9.8 c | 1.84 s | -25.3 dB | 1.84 s | -12.62 dB | kept: `B3.mp3` |
| 10 - Ancient Acoustic Lute - C4 (MIDI 60).wav | C4 (60) | C4 (60) | -12.7 / -8.3 c | 1.51 s | -12.8 dB | - | - | passed; not selected |
| 07 - Ancient Acoustic Lute - D3 (MIDI 50).wav | D3 (50) | D4 (62) | +12.1 / -7.5 c | 1.76 s | -25.3 dB | 1.76 s | -12.56 dB | kept: `D4.mp3` |
| 11 - Ancient Acoustic Lute - E4 (MIDI 64).wav | E4 (64) | E4 (64) | -14.1 / -12.7 c | 1.95 s | -22.1 dB | 1.95 s | -9.41 dB | kept: `E4.mp3` |
| 08 - Ancient Acoustic Lute - F3 (MIDI 53).wav | F3 (53) | F4 (65) | +2.2 / +3.8 c | 1.13 s | -24.0 dB | - | - | passed; not selected |
| 12 - Ancient Acoustic Lute - G4 (MIDI 67).wav | G4 (67) | G4 (67) | -13.3 / -11.2 c | 1.30 s | -13.8 dB | 0.99 s | -1.15 dB | kept: `G4.mp3` |
| 13 - Ancient Acoustic Lute - B4 (MIDI 71).wav | B4 (71) | - | - | 0.28 s | -21.7 dB | - | - | rejected: 0.28 s fragment; no clean harmonic series (peaks at 0.81, 1.19, 1.98 x label within 3 dB) |
| 14 - Ancient Acoustic Lute - D5 (MIDI 74).wav | D5 (74) | - | - | 0.40 s | -15.0 dB | - | - | rejected: 0.40 s fragment; inharmonic cluster around 1150 Hz, no stable pitch |
| 15 - Ancient Acoustic Lute - G5 (MIDI 79).wav | G5 (79) | - | - | 1.19 s | -12.1 dB | - | - | rejected: different source: energy at G4/G5 plus a 291 Hz component at -4 dB; YIN unstable |
| 16 - Ancient Acoustic Lute - E6 (MIDI 88).wav | E6 (88) | - | - | 1.26 s | -24.9 dB | - | - | rejected: no stable pitch (YIN aperiodicity 0.93); cluster around 1300-1400 Hz |

### Concert Harp (`harp`, plucked): good

**Real identity:** Concert (pedal) harp; 'nylon' in the label is a guess. Grid E1-A6 in thirds matches VSCO-2-CE `Strings/Harp` exactly. Pitches at the label. E1 (-31 c YIN) rejected; G1 and B1 peak below -40 dBFS and were rejected as near silent.

Spectrum from D4 (f0 291.49 Hz); gain +17.53 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Classical Nylon Harp - E1 (MIDI 28).wav | E1 (28) | E1 (28) | -22.4 / -31.1 c | 22.68 s | -33.3 dB | - | - | rejected: pitch error -31.1 c (YIN), -22.4 c (comb) |
| 02 - Classical Nylon Harp - G1 (MIDI 31).wav | G1 (31) | G1 (31) | -28.7 / -24.0 c | 6.75 s | -50.1 dB | - | - | rejected: near silent |
| 03 - Classical Nylon Harp - B1 (MIDI 35).wav | B1 (35) | B1 (35) | -16.7 / +677.3 c | 12.95 s | -42.0 dB | - | - | rejected: pitch error +677.3 c (YIN), -16.7 c (comb); near silent |
| 04 - Classical Nylon Harp - D2 (MIDI 38).wav | D2 (38) | D2 (38) | -6.8 / -6.0 c | 9.87 s | -34.7 dB | 4.00 s | -17.61 dB | kept: `D2.mp3` |
| 05 - Classical Nylon Harp - F2 (MIDI 41).wav | F2 (41) | F2 (41) | -8.2 / -7.7 c | 17.50 s | -38.2 dB | - | - | passed; not selected |
| 06 - Classical Nylon Harp - A2 (MIDI 45).wav | A2 (45) | A2 (45) | -6.1 / -5.0 c | 11.38 s | -30.4 dB | 4.00 s | -13.35 dB | kept: `A2.mp3` |
| 07 - Classical Nylon Harp - C3 (MIDI 48).wav | C3 (48) | C3 (48) | -2.8 / -2.7 c | 8.96 s | -37.3 dB | - | - | passed; not selected |
| 08 - Classical Nylon Harp - E3 (MIDI 52).wav | E3 (52) | E3 (52) | -5.1 / -7.6 c | 13.95 s | -30.0 dB | - | - | passed; not selected |
| 09 - Classical Nylon Harp - G3 (MIDI 55).wav | G3 (55) | G3 (55) | -9.1 / -7.2 c | 10.24 s | -24.8 dB | 4.00 s | -7.66 dB | kept: `G3.mp3` |
| 10 - Classical Nylon Harp - B3 (MIDI 59).wav | B3 (59) | B3 (59) | -13.2 / -12.7 c | 11.23 s | -25.4 dB | - | - | passed; not selected |
| 11 - Classical Nylon Harp - D4 (MIDI 62).wav | D4 (62) | D4 (62) | -12.9 / -7.0 c | 10.89 s | -22.9 dB | 4.00 s | -5.85 dB | kept: `D4.mp3` |
| 12 - Classical Nylon Harp - F4 (MIDI 65).wav | F4 (65) | F4 (65) | -1.1 / -0.4 c | 10.85 s | -22.8 dB | - | - | passed; not selected |
| 13 - Classical Nylon Harp - A4 (MIDI 69).wav | A4 (69) | A4 (69) | -10.9 / -12.9 c | 12.15 s | -18.2 dB | 4.00 s | -1.13 dB | kept: `A4.mp3` |
| 14 - Classical Nylon Harp - C5 (MIDI 72).wav | C5 (72) | C5 (72) | -11.2 / -7.9 c | 7.01 s | -20.3 dB | - | - | passed; not selected |
| 15 - Classical Nylon Harp - E5 (MIDI 76).wav | E5 (76) | E5 (76) | -12.8 / -8.0 c | 6.64 s | -22.3 dB | 4.00 s | -5.17 dB | kept: `E5.mp3` |
| 16 - Classical Nylon Harp - G5 (MIDI 79).wav | G5 (79) | G5 (79) | -5.6 / -6.0 c | 5.95 s | -25.8 dB | - | - | passed; not selected (R polarity flipped in downmix) |
| 17 - Classical Nylon Harp - B5 (MIDI 83).wav | B5 (83) | B5 (83) | -8.4 / -7.8 c | 4.42 s | -27.1 dB | - | - | passed; not selected |
| 18 - Classical Nylon Harp - D6 (MIDI 86).wav | D6 (86) | D6 (86) | -7.2 / -6.7 c | 3.90 s | -23.1 dB | 2.40 s | -6.04 dB | kept: `D6.mp3` |
| 19 - Classical Nylon Harp - F6 (MIDI 89).wav | F6 (89) | F6 (89) | -6.3 / -5.1 c | 2.34 s | -28.8 dB | - | - | passed; not selected |
| 20 - Classical Nylon Harp - A6 (MIDI 93).wav | A6 (93) | A6 (93) | -18.9 / -15.6 c | 3.61 s | -26.8 dB | 3.55 s | -9.72 dB | kept: `A6.mp3` |

### Upright Piano B (soft) (`upright-b-soft`, keys): good

**Real identity:** Upright piano (VSCO-2-CE `Keys/Upright Piano`), not a Rhodes. Integer-plus-stretch partials (5.02, 6.03, 7.05x) of struck strings, no tine/bell partial or tremolo. Its F-C#-A grid interleaves with folder 05 into one major-third grid, as in the 23-step Upright Piano set. About 12 dB quieter than folder 05. C#6 rejected (+30 c YIN, near silent).

Spectrum from F3 (f0 174.47 Hz); gain +24.24 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Vintage Rhodes Keys - F1 (MIDI 29).wav | F1 (29) | F1 (29) | -1.8 / +9.0 c | 15.60 s | -29.5 dB | 4.00 s | -5.70 dB | kept: `F1.mp3` |
| 02 - Vintage Rhodes Keys - C#2 (MIDI 37).wav | C#2 (37) | C#2 (37) | -15.8 / -5.8 c | 20.67 s | -24.8 dB | 4.00 s | -1.03 dB | kept: `Cs2.mp3` |
| 03 - Vintage Rhodes Keys - A2 (MIDI 45).wav | A2 (45) | A2 (45) | -11.2 / -5.8 c | 14.62 s | -31.3 dB | 4.00 s | -7.52 dB | kept: `A2.mp3` |
| 04 - Vintage Rhodes Keys - F3 (MIDI 53).wav | F3 (53) | F3 (53) | -1.4 / -1.4 c | 13.40 s | -33.4 dB | 4.00 s | -9.63 dB | kept: `F3.mp3` |
| 05 - Vintage Rhodes Keys - C#4 (MIDI 61).wav | C#4 (61) | C#4 (61) | +1.8 / +2.6 c | 11.84 s | -37.6 dB | 4.00 s | -13.83 dB | kept: `Cs4.mp3` |
| 06 - Vintage Rhodes Keys - A4 (MIDI 69).wav | A4 (69) | A4 (69) | +2.7 / +3.5 c | 8.40 s | -36.1 dB | 4.00 s | -12.36 dB | kept: `A4.mp3` |
| 07 - Vintage Rhodes Keys - F5 (MIDI 77).wav | F5 (77) | F5 (77) | +5.2 / +12.3 c | 7.31 s | -39.2 dB | 4.00 s | -15.39 dB | kept: `F5.mp3` |
| 08 - Vintage Rhodes Keys - C#6 (MIDI 85).wav | C#6 (85) | C#6 (85) | +13.5 / +30.3 c | 6.60 s | -46.1 dB | - | - | rejected: pitch error +30.3 c (YIN), +13.5 c (comb); near silent |

### Upright Piano B (loud) (`upright-b-loud`, keys): good

**Real identity:** Upright piano (VSCO-2-CE `Keys/Upright Piano`), not a Wurlitzer. Struck-string spectrum with stretched partials (6.03, 7.04, 8.07x); 10-28 s decays (a Wurlitzer reed decays much faster). Complements folder 04 on the same major-third grid.

Spectrum from A3 (f0 219.97 Hz); gain +15.50 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Haunted Wurlitzer Keys - A1 (MIDI 33).wav | A1 (33) | A1 (33) | -9.6 / +6.7 c | 18.66 s | -19.1 dB | 4.00 s | -4.09 dB | kept: `A1.mp3` |
| 02 - Haunted Wurlitzer Keys - F2 (MIDI 41).wav | F2 (41) | F2 (41) | -3.3 / +1.7 c | 28.62 s | -16.1 dB | 4.00 s | -1.03 dB | kept: `F2.mp3` |
| 03 - Haunted Wurlitzer Keys - C#3 (MIDI 49).wav | C#3 (49) | C#3 (49) | -0.2 / -0.2 c | 23.36 s | -18.1 dB | 4.00 s | -3.05 dB | kept: `Cs3.mp3` |
| 04 - Haunted Wurlitzer Keys - A3 (MIDI 57).wav | A3 (57) | A3 (57) | -0.2 / +1.6 c | 21.72 s | -20.3 dB | 4.00 s | -5.25 dB | kept: `A3.mp3` |
| 05 - Haunted Wurlitzer Keys - F4 (MIDI 65).wav | F4 (65) | F4 (65) | +0.9 / +1.5 c | 16.91 s | -21.8 dB | 4.00 s | -6.79 dB | kept: `F4.mp3` |
| 06 - Haunted Wurlitzer Keys - C#5 (MIDI 73).wav | C#5 (73) | C#5 (73) | +4.3 / +6.2 c | 10.04 s | -22.1 dB | 4.00 s | -7.05 dB | kept: `Cs5.mp3` |
| 07 - Haunted Wurlitzer Keys - A5 (MIDI 81).wav | A5 (81) | A5 (81) | +4.3 / +6.9 c | 11.88 s | -34.0 dB | 4.00 s | -18.93 dB | kept: `A5.mp3` (R polarity flipped in downmix) |
| 08 - Haunted Wurlitzer Keys - F6 (MIDI 89).wav | F6 (89) | F6 (89) | +14.1 / +15.7 c | 9.84 s | -33.5 dB | 4.00 s | -18.29 dB | kept: `F6.mp3` |

### Low Strings Sustain (`low-strings`, strings): good

**Real identity:** Low strings sustain (cello section + contrabass mix). All 14 files sound one octave above their labels (fixed: rootMidi = label + 12). The notes mix the contrabass grid (F#0, A#0, C#2, G#2) and the cello grid (E1, G1, B1, F2, C3...). Bowed, harmonic, slow 1-5 s swell, light vibrato (3-5 c).

Spectrum from F3 (f0 174.92 Hz); gain +19.27 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Cathedral Strings Section - F#0 (MIDI 18).wav | F#0 (18) | F#1 (30) | -0.3 / +0.1 c | 9.05 s | -35.6 dB | 5.00 s | -16.82 dB | kept: `Fs1.mp3` |
| 02 - Cathedral Strings Section - A#0 (MIDI 22).wav | A#0 (22) | A#1 (34) | +0.4 / +0.1 c | 7.58 s | -29.2 dB | - | - | passed; not selected |
| 03 - Cathedral Strings Section - E1 (MIDI 28).wav | E1 (28) | E2 (40) | -4.0 / -3.6 c | 9.33 s | -27.5 dB | 5.00 s | -9.10 dB | kept: `E2.mp3` |
| 04 - Cathedral Strings Section - G1 (MIDI 31).wav | G1 (31) | G2 (43) | -2.5 / -1.3 c | 8.17 s | -19.6 dB | - | - | passed; not selected |
| 05 - Cathedral Strings Section - B1 (MIDI 35).wav | B1 (35) | B2 (47) | -0.0 / +0.6 c | 8.97 s | -20.6 dB | 5.00 s | -1.82 dB | kept: `B2.mp3` |
| 06 - Cathedral Strings Section - C#2 (MIDI 37).wav | C#2 (37) | C#3 (49) | +2.2 / -0.1 c | 7.65 s | -32.2 dB | - | - | passed; not selected |
| 07 - Cathedral Strings Section - F2 (MIDI 41).wav | F2 (41) | F3 (53) | +3.0 / +0.9 c | 8.26 s | -23.6 dB | 5.00 s | -4.77 dB | kept: `F3.mp3` |
| 08 - Cathedral Strings Section - G#2 (MIDI 44).wav | G#2 (44) | G#3 (56) | +2.9 / +0.9 c | 7.67 s | -27.7 dB | 5.00 s | -8.89 dB | kept: `Gs3.mp3` |
| 09 - Cathedral Strings Section - C3 (MIDI 48).wav | C3 (48) | C4 (60) | +0.1 / -0.2 c | 9.24 s | -23.4 dB | - | - | passed; not selected |
| 10 - Cathedral Strings Section - E3 (MIDI 52).wav | E3 (52) | E4 (64) | -1.0 / -1.1 c | 9.28 s | -23.1 dB | 5.00 s | -5.11 dB | kept: `E4.mp3` |
| 11 - Cathedral Strings Section - G3 (MIDI 55).wav | G3 (55) | G4 (67) | +1.3 / +1.4 c | 9.19 s | -23.2 dB | - | - | passed; not selected |
| 12 - Cathedral Strings Section - B3 (MIDI 59).wav | B3 (59) | B4 (71) | -4.4 / -0.1 c | 6.39 s | -27.9 dB | 5.00 s | -9.07 dB | kept: `B4.mp3` |
| 13 - Cathedral Strings Section - E4 (MIDI 64).wav | E4 (64) | E5 (76) | +3.1 / +0.3 c | 7.73 s | -26.6 dB | - | - | passed; not selected |
| 14 - Cathedral Strings Section - G4 (MIDI 67).wav | G4 (67) | G5 (79) | +4.7 / -0.0 c | 9.61 s | -19.9 dB | 5.00 s | -1.03 dB | kept: `G5.mp3` |

### Solo Contrabass (`contrabass`, strings): good

**Real identity:** Solo contrabass (split out of 'Chamber Vibrato Strings'). Files 01-06 (E0-G#2) sit on the VSCO-2-CE Solo Contrabass grid and sound one octave above the label (fixed +12). They are timbrally unrelated to files 07-12, so they form their own instrument.

Spectrum from C2 (f0 65.41 Hz); gain +19.62 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Chamber Vibrato Strings - E0 (MIDI 16).wav | E0 (16) | E1 (28) | +0.0 / +0.1 c | 16.17 s | -39.7 dB | 5.00 s | -21.12 dB | kept: `E1.mp3` |
| 02 - Chamber Vibrato Strings - G0 (MIDI 19).wav | G0 (19) | G1 (31) | -1.4 / -0.2 c | 10.67 s | -37.6 dB | 5.00 s | -18.45 dB | kept: `G1.mp3` |
| 03 - Chamber Vibrato Strings - C1 (MIDI 24).wav | C1 (24) | C2 (36) | +0.0 / -0.3 c | 8.27 s | -33.4 dB | 5.00 s | -14.20 dB | kept: `C2.mp3` |
| 04 - Chamber Vibrato Strings - F#1 (MIDI 30).wav | F#1 (30) | F#2 (42) | +0.1 / +0.0 c | 7.49 s | -33.8 dB | 5.00 s | -14.62 dB | kept: `Fs2.mp3` |
| 05 - Chamber Vibrato Strings - A1 (MIDI 33).wav | A1 (33) | A2 (45) | +2.7 / -0.0 c | 7.08 s | -20.2 dB | 5.00 s | -1.04 dB | kept: `A2.mp3` |
| 06 - Chamber Vibrato Strings - G#2 (MIDI 44).wav | G#2 (44) | G#3 (56) | -0.4 / -0.5 c | 9.24 s | -29.4 dB | 5.00 s | -10.73 dB | kept: `Gs3.mp3` |

### Solo Violin (`solo-violin`, strings): good

**Real identity:** Solo violin, arco vibrato (split out of 'Chamber Vibrato Strings'). Files 07-12 (G3-G6) match the Solo Violin Arco Vib grid and sound at the label. Vibrato 10-15 c.

Spectrum from A4 (f0 444.44 Hz); gain +9.58 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 07 - Chamber Vibrato Strings - G3 (MIDI 55).wav | G3 (55) | G3 (55) | -2.5 / -1.4 c | 16.65 s | -16.0 dB | 5.00 s | -9.64 dB | kept: `G3.mp3` |
| 08 - Chamber Vibrato Strings - C4 (MIDI 60).wav | C4 (60) | C4 (60) | -14.0 / +3.0 c | 13.23 s | -10.2 dB | 5.00 s | -1.03 dB | kept: `C4.mp3` |
| 09 - Chamber Vibrato Strings - A4 (MIDI 69).wav | A4 (69) | A4 (69) | +17.4 / +8.3 c | 14.11 s | -14.6 dB | 5.00 s | -5.36 dB | kept: `A4.mp3` |
| 10 - Chamber Vibrato Strings - E5 (MIDI 76).wav | E5 (76) | E5 (76) | +5.4 / +12.3 c | 13.41 s | -16.2 dB | 5.00 s | -7.67 dB | kept: `E5.mp3` |
| 11 - Chamber Vibrato Strings - C6 (MIDI 84).wav | C6 (84) | C6 (84) | -9.4 / -10.0 c | 12.26 s | -13.9 dB | 5.00 s | -5.19 dB | kept: `C6.mp3` |
| 12 - Chamber Vibrato Strings - G6 (MIDI 91).wav | G6 (91) | G6 (91) | -9.3 / +10.8 c | 12.27 s | -15.4 dB | 5.00 s | -7.33 dB | kept: `G6.mp3` |

### Mixed Low Brass (`mixed-brass`, brass): ok

**Real identity:** Mixed brass (tuba / F horn / trombone / trumpet), not one horn section. All files sound one octave above their labels (fixed +12). The note grid pulls from Tuba (F0, A#2, D3), F Horn (A0, C1, D4), trombone (F3, G3) and trumpet (A4). Low zones are buzzy with strong 3rd-7th harmonics; upper zones are rounder.

Spectrum from F3 (f0 174.26 Hz); gain +22.09 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Dungeon Brass Horns - F0 (MIDI 17).wav | F0 (17) | F1 (29) | -21.8 / -5.4 c | 3.98 s | -30.3 dB | - | - | passed; not selected |
| 02 - Dungeon Brass Horns - A0 (MIDI 21).wav | A0 (21) | A1 (33) | -5.9 / -0.8 c | 5.37 s | -22.7 dB | 5.00 s | -1.02 dB | kept: `A1.mp3` |
| 03 - Dungeon Brass Horns - C1 (MIDI 24).wav | C1 (24) | C2 (36) | -1.5 / -0.0 c | 6.20 s | -25.8 dB | 5.00 s | -4.11 dB | kept: `C2.mp3` |
| 04 - Dungeon Brass Horns - D#1 (MIDI 27).wav | D#1 (27) | D#2 (39) | -2.5 / +1.1 c | 8.08 s | -23.8 dB | - | - | passed; not selected |
| 05 - Dungeon Brass Horns - F1 (MIDI 29).wav | F1 (29) | F2 (41) | +0.4 / -0.0 c | 12.93 s | -38.9 dB | 5.00 s | -17.22 dB | kept: `F2.mp3` |
| 06 - Dungeon Brass Horns - A#1 (MIDI 34).wav | A#1 (34) | A#2 (46) | +5.2 / +0.1 c | 13.71 s | -32.6 dB | - | - | passed; not selected |
| 07 - Dungeon Brass Horns - F2 (MIDI 41).wav | F2 (41) | F3 (53) | -3.6 / +0.3 c | 12.26 s | -29.6 dB | 5.00 s | -8.01 dB | kept: `F3.mp3` |
| 08 - Dungeon Brass Horns - A#2 (MIDI 46).wav | A#2 (46) | A#3 (58) | -0.1 / -0.1 c | 7.17 s | -27.9 dB | 5.00 s | -6.28 dB | kept: `As3.mp3` (R polarity flipped in downmix) |
| 09 - Dungeon Brass Horns - C3 (MIDI 48).wav | C3 (48) | C4 (60) | +1.4 / +0.3 c | 14.28 s | -24.6 dB | - | - | passed; not selected |
| 10 - Dungeon Brass Horns - D3 (MIDI 50).wav | D3 (50) | D4 (62) | -2.3 / -1.0 c | 9.60 s | -31.9 dB | 5.00 s | -10.26 dB | kept: `D4.mp3` (R polarity flipped in downmix) |
| 11 - Dungeon Brass Horns - F3 (MIDI 53).wav | F3 (53) | F4 (65) | +0.2 / +0.1 c | 25.83 s | -35.1 dB | - | - | passed; not selected |
| 12 - Dungeon Brass Horns - G3 (MIDI 55).wav | G3 (55) | G4 (67) | -0.7 / -0.0 c | 7.20 s | -33.4 dB | 5.00 s | -11.74 dB | kept: `G4.mp3` |
| 13 - Dungeon Brass Horns - D4 (MIDI 62).wav | D4 (62) | D5 (74) | +5.5 / -0.0 c | 8.19 s | -11.9 dB | - | - | passed; not selected |
| 14 - Dungeon Brass Horns - A4 (MIDI 69).wav | A4 (69) | A5 (81) | +1.0 / +1.6 c | 7.08 s | -25.8 dB | 5.00 s | -4.14 dB | kept: `A5.mp3` |

### Pipe Organ (quiet stop) (`organ-quiet`, organ): good

**Real identity:** Pipe organ, quiet registration (VSCO-2-CE `Keys/Organ/Quiet`), not a choir. No vibrato (pitch std about 2 c), dead-steady 12 s sustain, odd-harmonic spectrum of a stopped pipe: an organ, not voices. Files 05-12 are labeled D/G# but sound C/F#: **label fix -2 semitones**. Files 01-04 are a different stop whose sounding pitches collide with files 05-08; not used.

Spectrum from F#3 (f0 185.47 Hz); gain +22.11 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Monastery Choir Ooh - C2 (MIDI 36).wav | C2 (36) | - | - | 12.26 s | -20.7 dB | - | - | rejected: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08 |
| 05 - Monastery Choir Ooh - D2 (MIDI 38).wav | D2 (38) | C2 (36) | -8.8 / -6.1 c | 11.55 s | -38.3 dB | 5.00 s | -22.36 dB | kept: `C2.mp3` |
| 02 - Monastery Choir Ooh - F#2 (MIDI 42).wav | F#2 (42) | - | - | 11.84 s | -17.7 dB | - | - | rejected: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08 |
| 06 - Monastery Choir Ooh - G#2 (MIDI 44).wav | G#2 (44) | F#2 (42) | -4.4 / +9.9 c | 12.16 s | -38.0 dB | 5.00 s | -16.36 dB | kept: `Fs2.mp3` |
| 03 - Monastery Choir Ooh - C3 (MIDI 48).wav | C3 (48) | - | - | 12.13 s | -22.4 dB | - | - | rejected: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08 |
| 07 - Monastery Choir Ooh - D3 (MIDI 50).wav | D3 (50) | C3 (48) | -0.5 / -0.7 c | 12.49 s | -25.8 dB | 5.00 s | -4.10 dB | kept: `C3.mp3` |
| 04 - Monastery Choir Ooh - F#3 (MIDI 54).wav | F#3 (54) | - | - | 11.89 s | -23.4 dB | - | - | rejected: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08 |
| 08 - Monastery Choir Ooh - G#3 (MIDI 56).wav | G#3 (56) | F#3 (54) | +4.4 / +5.2 c | 12.13 s | -22.7 dB | 5.00 s | -1.03 dB | kept: `Fs3.mp3` |
| 09 - Monastery Choir Ooh - D4 (MIDI 62).wav | D4 (62) | C4 (60) | +1.3 / +2.5 c | 12.14 s | -33.3 dB | 5.00 s | -11.68 dB | kept: `C4.mp3` |
| 10 - Monastery Choir Ooh - G#4 (MIDI 68).wav | G#4 (68) | F#4 (66) | +0.2 / +0.8 c | 12.26 s | -26.8 dB | 5.00 s | -6.14 dB | kept: `Fs4.mp3` |
| 11 - Monastery Choir Ooh - D5 (MIDI 74).wav | D5 (74) | C5 (72) | -3.6 / -3.7 c | 12.15 s | -28.6 dB | 5.00 s | -7.44 dB | kept: `C5.mp3` |
| 12 - Monastery Choir Ooh - G#5 (MIDI 80).wav | G#5 (80) | F#5 (78) | -0.6 / -0.2 c | 12.06 s | -27.6 dB | 5.00 s | -5.94 dB | kept: `Fs5.mp3` |

### Pipe Organ (full) (`organ-loud`, organ): ok

**Real identity:** Pipe organ, loud/full registration (VSCO-2-CE `Keys/Organ/Loud`), not a choir. Steady, no vibrato, rich harmonic series up to the 24th partial: an organ plenum. Notes repeat (C2-F#3 twice: loud files 01-04 and quieter 05-08); the quieter takes plus 09-12 are used for a consistent level. The 0.5x partial (16' rank) sits 6-23 dB below the strongest partial, so the octave can sound ambiguous; rootMidi follows the 8' (label) pitch, confirmed by the harmonic comb. File 07 (C3) rejected: YIN locks to the sub-octave/quint.

Spectrum from C4 (f0 261.22 Hz); gain +17.89 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Cathedral Choir Ahh - C2 (MIDI 36).wav | C2 (36) | - | - | 13.77 s | -7.4 dB | - | - | rejected: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB) |
| 05 - Cathedral Choir Ahh - C2 (MIDI 36).wav | C2 (36) | C2 (36) | +5.6 / +3.1 c | 12.64 s | -18.5 dB | 5.00 s | -1.03 dB | kept: `C2.mp3` |
| 02 - Cathedral Choir Ahh - F#2 (MIDI 42).wav | F#2 (42) | - | - | 12.77 s | -7.0 dB | - | - | rejected: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB) |
| 06 - Cathedral Choir Ahh - F#2 (MIDI 42).wav | F#2 (42) | F#2 (42) | +4.9 / +0.9 c | 12.66 s | -18.8 dB | 5.00 s | -1.32 dB | kept: `Fs2.mp3` |
| 03 - Cathedral Choir Ahh - C3 (MIDI 48).wav | C3 (48) | - | - | 12.70 s | -10.8 dB | - | - | rejected: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB) |
| 07 - Cathedral Choir Ahh - C3 (MIDI 48).wav | C3 (48) | C3 (48) | +1.2 / -710.6 c | 12.30 s | -19.6 dB | - | - | rejected: pitch error -710.6 c (YIN), +1.2 c (comb) |
| 04 - Cathedral Choir Ahh - F#3 (MIDI 54).wav | F#3 (54) | - | - | 12.83 s | -11.2 dB | - | - | rejected: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB) |
| 08 - Cathedral Choir Ahh - F#3 (MIDI 54).wav | F#3 (54) | F#3 (54) | +2.5 / +1.9 c | 12.46 s | -21.7 dB | 5.00 s | -4.45 dB | kept: `Fs3.mp3` |
| 09 - Cathedral Choir Ahh - C4 (MIDI 60).wav | C4 (60) | C4 (60) | -2.7 / -0.8 c | 12.36 s | -21.0 dB | 5.00 s | -3.71 dB | kept: `C4.mp3` |
| 10 - Cathedral Choir Ahh - F#4 (MIDI 66).wav | F#4 (66) | F#4 (66) | -0.2 / -0.0 c | 12.29 s | -25.0 dB | 5.00 s | -7.58 dB | kept: `Fs4.mp3` |
| 11 - Cathedral Choir Ahh - C5 (MIDI 72).wav | C5 (72) | C5 (72) | -2.1 / -1.8 c | 12.40 s | -22.4 dB | 5.00 s | -6.18 dB | kept: `C5.mp3` |
| 12 - Cathedral Choir Ahh - F#5 (MIDI 78).wav | F#5 (78) | F#5 (78) | -0.7 / +1.5 c | 12.02 s | -28.5 dB | 5.00 s | -11.07 dB | kept: `Fs5.mp3` |

### Concert Flute (`flute`, woodwind): good

**Real identity:** Concert flute (files 05-11); files 01/03/04 are bassoon/oboe. Files 05-11 match the VSCO-2-CE Flute grid (A, C, E) and sound one octave above the label (fixed +12), A4-A6. File 01 (sounds A2) has a bassoon-like formant and files 03/04 (A#3, F4) are oboe-like and below the flute range, so they are excluded.

Spectrum from A5 (f0 880.28 Hz); gain +6.31 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Hollow Woodwind Flute - A1 (MIDI 33).wav | A1 (33) | - | - | 7.29 s | -14.2 dB | - | - | rejected: different instrument: bassoon-like (sounds A2, harmonics 4-6 dominate), below the flute range |
| 03 - Hollow Woodwind Flute - A#2 (MIDI 46).wav | A#2 (46) | - | - | 10.35 s | -30.2 dB | - | - | rejected: different instrument: oboe-like (sounds A#3), below the flute range |
| 04 - Hollow Woodwind Flute - F3 (MIDI 53).wav | F3 (53) | - | - | 9.99 s | -24.7 dB | - | - | rejected: different instrument: oboe-like (sounds F4), timbre does not match the flute zones |
| 05 - Hollow Woodwind Flute - A3 (MIDI 57).wav | A3 (57) | A4 (69) | +1.4 / -0.7 c | 8.00 s | -21.7 dB | 5.00 s | -15.84 dB | kept: `A4.mp3` |
| 06 - Hollow Woodwind Flute - C4 (MIDI 60).wav | C4 (60) | C5 (72) | +0.1 / +1.8 c | 7.59 s | -21.3 dB | 5.00 s | -15.43 dB | kept: `C5.mp3` |
| 07 - Hollow Woodwind Flute - E4 (MIDI 64).wav | E4 (64) | E5 (76) | +0.4 / +0.0 c | 8.10 s | -19.6 dB | 5.00 s | -13.70 dB | kept: `E5.mp3` |
| 08 - Hollow Woodwind Flute - A4 (MIDI 69).wav | A4 (69) | A5 (81) | +0.6 / -0.8 c | 7.34 s | -18.5 dB | 5.00 s | -12.63 dB | kept: `A5.mp3` |
| 09 - Hollow Woodwind Flute - C5 (MIDI 72).wav | C5 (72) | C6 (84) | +2.9 / -2.1 c | 7.29 s | -13.5 dB | 5.00 s | -7.55 dB | kept: `C6.mp3` |
| 10 - Hollow Woodwind Flute - E5 (MIDI 76).wav | E5 (76) | E6 (88) | -1.7 / +0.9 c | 5.99 s | -11.6 dB | 5.00 s | -5.67 dB | kept: `E6.mp3` |
| 11 - Hollow Woodwind Flute - A5 (MIDI 81).wav | A5 (81) | A6 (93) | +2.4 / +0.6 c | 5.51 s | -6.9 dB | 5.00 s | -1.05 dB | kept: `A6.mp3` |

### Marimba (`marimba`, mallets): ok

**Real identity:** Marimba (split out of 'Celesta Kalimba Bells'). Files 01-03 (C2, F3, C4 labels) match the VSCO-2-CE Marimba grid and sound one octave higher (fixed +12). Near-pure fundamental with the marimba's tuned 4th partial (4.0x) on the low bar; 2-8 s decay.

Spectrum from F4 (f0 349.17 Hz); gain +20.40 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Celesta Kalimba Bells - C2 (MIDI 36).wav | C2 (36) | C3 (48) | +1.7 / +1.9 c | 8.45 s | -20.9 dB | 4.00 s | -1.06 dB | kept: `C3.mp3` |
| 02 - Celesta Kalimba Bells - F3 (MIDI 53).wav | F3 (53) | F4 (65) | -0.3 / +0.8 c | 6.01 s | -23.0 dB | 3.38 s | -3.03 dB | kept: `F4.mp3` |
| 03 - Celesta Kalimba Bells - C4 (MIDI 60).wav | C4 (60) | C5 (72) | +4.5 / +5.1 c | 3.84 s | -23.6 dB | 2.10 s | -3.66 dB | kept: `C5.mp3` (R polarity flipped in downmix) |

### Xylophone (`xylophone`, mallets): ok

**Real identity:** Xylophone (split out of 'Celesta Kalimba Bells'). Files 04-09 match the VSCO-2-CE Xylo grid (G/C) and sound one octave above the label (fixed +12). Strong fundamental with the xylophone's tuned 3rd partial (2.9-3.1x). C8 (+30 c YIN, +24 c comb) rejected. The tuning drifts sharp with height (+9 to +20 c).

Spectrum from G6 (f0 1578.77 Hz); gain +26.21 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 04 - Celesta Kalimba Bells - G4 (MIDI 67).wav | G4 (67) | G5 (79) | +9.3 / +9.5 c | 7.21 s | -28.4 dB | 4.00 s | -2.72 dB | kept: `G5.mp3` |
| 05 - Celesta Kalimba Bells - C5 (MIDI 72).wav | C5 (72) | C6 (84) | +9.5 / +12.4 c | 7.21 s | -28.3 dB | 4.00 s | -2.74 dB | kept: `C6.mp3` |
| 06 - Celesta Kalimba Bells - G5 (MIDI 79).wav | G5 (79) | G6 (91) | +11.9 / +13.0 c | 6.95 s | -26.8 dB | 3.81 s | -1.60 dB | kept: `G6.mp3` |
| 07 - Celesta Kalimba Bells - C6 (MIDI 84).wav | C6 (84) | C7 (96) | +15.4 / +17.1 c | 7.21 s | -27.0 dB | 3.94 s | -1.20 dB | kept: `C7.mp3` |
| 08 - Celesta Kalimba Bells - G6 (MIDI 91).wav | G6 (91) | G7 (103) | +15.7 / +19.7 c | 4.78 s | -28.1 dB | 3.43 s | -2.44 dB | kept: `G7.mp3` |
| 09 - Celesta Kalimba Bells - C7 (MIDI 96).wav | C7 (96) | C8 (108) | +24.4 / +30.0 c | 2.79 s | -27.6 dB | - | - | rejected: pitch error +30.0 c (YIN), +24.4 c (comb) |

### Glockenspiel (`glockenspiel`, mallets): ok

**Real identity:** Glockenspiel (VSCO-2-CE `Percussion/Glock`), not a harpsichord. A harpsichord would have a dense harmonic spectrum; these files are almost pure sine tones with a weak bar partial at 2.8x and a 0.5-1.8 s metallic ring. The 6-note G/C grid matches VSCO-2-CE Glock exactly. Files sound one octave above the label (fixed +12).

Spectrum from G5 (f0 790.23 Hz); gain +4.81 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Harpsichord Clavichord - G3 (MIDI 55).wav | G3 (55) | G4 (67) | +12.8 / +12.9 c | 3.62 s | -5.4 dB | 1.77 s | -1.25 dB | kept: `G4.mp3` |
| 02 - Harpsichord Clavichord - C4 (MIDI 60).wav | C4 (60) | C5 (72) | +12.3 / +12.3 c | 3.37 s | -5.7 dB | 1.85 s | -1.23 dB | kept: `C5.mp3` |
| 03 - Harpsichord Clavichord - G4 (MIDI 67).wav | G4 (67) | G5 (79) | +13.7 / +14.0 c | 2.51 s | -7.5 dB | 1.48 s | -2.93 dB | kept: `G5.mp3` |
| 04 - Harpsichord Clavichord - C5 (MIDI 72).wav | C5 (72) | C6 (84) | +15.4 / +15.8 c | 1.89 s | -8.1 dB | 1.08 s | -3.80 dB | kept: `C6.mp3` |
| 05 - Harpsichord Clavichord - G5 (MIDI 79).wav | G5 (79) | G6 (91) | +16.0 / +16.3 c | 1.62 s | -7.1 dB | 0.67 s | -2.74 dB | kept: `G6.mp3` |
| 06 - Harpsichord Clavichord - C6 (MIDI 84).wav | C6 (84) | C7 (96) | +16.8 / +17.6 c | 1.47 s | -11.6 dB | 0.55 s | -6.91 dB | kept: `C7.mp3` |

### Tremolo Strings (`tremolo-strings`, strings): ok

**Real identity:** Tremolo strings (mixed sections), not a synth pad. The envelope has 9-11 Hz amplitude modulation (bowed tremolo) and doubled partials (ensemble). The note grid mixes the contrabass, cello and violin tremolo grids. Files sound one octave above the label (fixed +12). E0 (unstable YIN) and C1 (clipped source sample) rejected.

Spectrum from C4 (f0 260.91 Hz); gain +19.22 dB.

| Source file | Label | Sounds as (rootMidi) | Pitch err comb / YIN | Src dur | Src peak | Out dur | MP3 peak | Status |
|---|---|---|---|---|---|---|---|---|
| 01 - Dark Fantasy Gloom Pads - E0 (MIDI 16).wav | E0 (16) | E1 (28) | -9.0 / +589.2 c | 10.64 s | -25.3 dB | - | - | rejected: pitch error +589.2 c (YIN), -9.0 c (comb) |
| 02 - Dark Fantasy Gloom Pads - C1 (MIDI 24).wav | C1 (24) | C2 (36) | -9.9 / +1.0 c | 10.47 s | -1.2 dB | - | - | rejected: 1 clipped samples in source |
| 03 - Dark Fantasy Gloom Pads - G#1 (MIDI 32).wav | G#1 (32) | G#2 (44) | -8.8 / -19.8 c | 6.39 s | -19.8 dB | 5.00 s | -1.06 dB | kept: `Gs2.mp3` |
| 04 - Dark Fantasy Gloom Pads - C2 (MIDI 36).wav | C2 (36) | C3 (48) | -8.8 / -4.3 c | 10.52 s | -33.5 dB | 5.00 s | -16.64 dB | kept: `C3.mp3` |
| 05 - Dark Fantasy Gloom Pads - F2 (MIDI 41).wav | F2 (41) | F3 (53) | +4.1 / +1.0 c | 7.02 s | -32.6 dB | 5.00 s | -13.85 dB | kept: `F3.mp3` |
| 06 - Dark Fantasy Gloom Pads - G#2 (MIDI 44).wav | G#2 (44) | G#3 (56) | -10.8 / -29.0 c | 6.12 s | -25.9 dB | - | - | passed; not selected |
| 07 - Dark Fantasy Gloom Pads - C3 (MIDI 48).wav | C3 (48) | C4 (60) | -4.7 / +0.3 c | 8.19 s | -36.0 dB | 5.00 s | -17.22 dB | kept: `C4.mp3` |
| 08 - Dark Fantasy Gloom Pads - E3 (MIDI 52).wav | E3 (52) | E4 (64) | -1.3 / +1.2 c | 6.76 s | -33.5 dB | 5.00 s | -14.68 dB | kept: `E4.mp3` |
| 09 - Dark Fantasy Gloom Pads - G3 (MIDI 55).wav | G3 (55) | G4 (67) | -5.0 / -1.1 c | 7.28 s | -37.8 dB | 5.00 s | -18.96 dB | kept: `G4.mp3` |
| 10 - Dark Fantasy Gloom Pads - B3 (MIDI 59).wav | B3 (59) | B4 (71) | -4.7 / +0.1 c | 7.88 s | -37.8 dB | - | - | passed; not selected |
| 11 - Dark Fantasy Gloom Pads - E4 (MIDI 64).wav | E4 (64) | E5 (76) | +7.2 / -0.2 c | 12.40 s | -30.9 dB | 5.00 s | -12.13 dB | kept: `E5.mp3` |
| 12 - Dark Fantasy Gloom Pads - G4 (MIDI 67).wav | G4 (67) | G5 (79) | +5.5 / +0.5 c | 10.88 s | -27.6 dB | 5.00 s | -11.82 dB | kept: `G5.mp3` |

## Rejected files

No whole instrument was rejected. These individual files were not used:

- `01_Felt_Grand_Piano/13 - Felt Grand Piano - C7 (MIDI 96).wav`: pitch error +33.1 c (YIN), +12.0 c (comb)
- `01_Felt_Grand_Piano/14 - Felt Grand Piano - G7 (MIDI 103).wav`: YIN found no stable pitch (comb +4.8 c)
- `02_Ancient_Acoustic_Lute/13 - Ancient Acoustic Lute - B4 (MIDI 71).wav`: 0.28 s fragment; no clean harmonic series (peaks at 0.81, 1.19, 1.98 x label within 3 dB)
- `02_Ancient_Acoustic_Lute/14 - Ancient Acoustic Lute - D5 (MIDI 74).wav`: 0.40 s fragment; inharmonic cluster around 1150 Hz, no stable pitch
- `02_Ancient_Acoustic_Lute/15 - Ancient Acoustic Lute - G5 (MIDI 79).wav`: different source: energy at G4/G5 plus a 291 Hz component at -4 dB; YIN unstable
- `02_Ancient_Acoustic_Lute/16 - Ancient Acoustic Lute - E6 (MIDI 88).wav`: no stable pitch (YIN aperiodicity 0.93); cluster around 1300-1400 Hz
- `03_Classical_Nylon_Harp/01 - Classical Nylon Harp - E1 (MIDI 28).wav`: pitch error -31.1 c (YIN), -22.4 c (comb)
- `03_Classical_Nylon_Harp/02 - Classical Nylon Harp - G1 (MIDI 31).wav`: near silent
- `03_Classical_Nylon_Harp/03 - Classical Nylon Harp - B1 (MIDI 35).wav`: pitch error +677.3 c (YIN), -16.7 c (comb); near silent
- `04_Vintage_Rhodes_Keys/08 - Vintage Rhodes Keys - C#6 (MIDI 85).wav`: pitch error +30.3 c (YIN), +13.5 c (comb); near silent
- `09_Monastery_Choir_Ooh/01 - Monastery Choir Ooh - C2 (MIDI 36).wav`: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08
- `09_Monastery_Choir_Ooh/02 - Monastery Choir Ooh - F#2 (MIDI 42).wav`: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08
- `09_Monastery_Choir_Ooh/03 - Monastery Choir Ooh - C3 (MIDI 48).wav`: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08
- `09_Monastery_Choir_Ooh/04 - Monastery Choir Ooh - F#3 (MIDI 54).wav`: different stop (open flue, strong 2nd harmonic) from files 05-12 (stopped pipe, odd harmonics); its sounding pitch duplicates one of files 05-08
- `10_Cathedral_Choir_Ahh/01 - Cathedral Choir Ahh - C2 (MIDI 36).wav`: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB)
- `10_Cathedral_Choir_Ahh/02 - Cathedral Choir Ahh - F#2 (MIDI 42).wav`: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB)
- `10_Cathedral_Choir_Ahh/03 - Cathedral Choir Ahh - C3 (MIDI 48).wav`: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB)
- `10_Cathedral_Choir_Ahh/07 - Cathedral Choir Ahh - C3 (MIDI 48).wav`: pitch error -710.6 c (YIN), +1.2 c (comb)
- `10_Cathedral_Choir_Ahh/04 - Cathedral Choir Ahh - F#3 (MIDI 54).wav`: louder duplicate take of a file 05-08 note (same sounding pitch, filename collision); strong 16' sub-octave (0.5x partial at -8 to -21 dB)
- `11_Hollow_Woodwind_Flute/01 - Hollow Woodwind Flute - A1 (MIDI 33).wav`: different instrument: bassoon-like (sounds A2, harmonics 4-6 dominate), below the flute range
- `11_Hollow_Woodwind_Flute/03 - Hollow Woodwind Flute - A#2 (MIDI 46).wav`: different instrument: oboe-like (sounds A#3), below the flute range
- `11_Hollow_Woodwind_Flute/04 - Hollow Woodwind Flute - F3 (MIDI 53).wav`: different instrument: oboe-like (sounds F4), timbre does not match the flute zones
- `12_Celesta_Kalimba_Bells/09 - Celesta Kalimba Bells - C7 (MIDI 96).wav`: pitch error +30.0 c (YIN), +24.4 c (comb)
- `14_Dark_Fantasy_Gloom_Pads/01 - Dark Fantasy Gloom Pads - E0 (MIDI 16).wav`: pitch error +589.2 c (YIN), -9.0 c (comb)
- `14_Dark_Fantasy_Gloom_Pads/02 - Dark Fantasy Gloom Pads - C1 (MIDI 24).wav`: 1 clipped samples in source

Files that passed every check but were left out only because of the 8-zone cap are marked "passed; not selected" in the tables above.

## Credits & license

VS Chamber Orchestra: Community Edition by Versilian Studios / Sam Gossner and Ivy Audio / Simon Dalzell. CC0 1.0. Homepage: vis.versilstudios.net/vsco-community.html. Requested: credit the authors; do not sell the samples directly.

The full CC0 1.0 legal text is in [`LICENSE`](LICENSE), copied unchanged from the source pack. The MP3 conversions, trims and level changes in this folder add no new rights restrictions.
