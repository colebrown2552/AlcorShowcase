# AlcorMusic

A piano roll with live score preview, multi-part playback and export to MIDI, MusicXML and WAV.
Everything, including sound synthesis, happens in the browser.

![AlcorMusic](../../screenshots/AlcorMusic.png)

## Highlights

- **Synthesis from first principles.** Instruments are generated, not sampled: a plucked-string
  model (`vPluck`), PolyBLEP band-limited oscillators (`blep`) that avoid aliasing (harsh false
  tones from digital waveforms), and a noise generator (`noiseGen`) for drums.
- **File formats written by hand.** `parseMidi` and `midiBytes` read and write Standard MIDI
  Files, `wavBytes` renders audio to WAV, and MusicXML export produces notation that other programs
  open.
- **Two views of one project.** The piano roll and the sheet preview edit the same notes, at 480
  ticks per quarter note, with hard limits on project length and render time.

## How it works

[`alcor-music.js`](../assets/js/alcor-music.js) has two halves. The **engine** section is pure
logic (synthesis, file formats, patterns) with no DOM, storage or network, so it can be loaded
alone. The **UI** section draws the piano roll and score and drives playback through the Web Audio
API.

## Run it

Serve `AlcorApps/web` with any static server (see the [AlcorApps README](../../README.md)) and
open `AlcorMusic/`. The theme sketch loads with notes already in it; press **Play**.
