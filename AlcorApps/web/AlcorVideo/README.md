# AlcorVideo

A multi-track video editor in the browser: up to 12 video and 12 audio tracks, trimming and
splitting, keyframes, effects and transitions, color grading, titles and captions, and export to
MP4 or WebM. Media never leaves the device.

![AlcorVideo](../../screenshots/AlcorVideo.png)

## Highlights

- **Rendering uses the browser's own pipeline.** Each frame of the timeline is composited onto a
  canvas (layers, transforms, effects, grade, titles) and the canvas stream is recorded with
  `MediaRecorder`. Export needs no server and no native encoder.
- **A responsive 24-track timeline** while audio, video and canvas all share one page.

## How it works

The editor loads as separate bundles, one per feature group:

| Bundle | Contents |
|---|---|
| `editor-core.js` | Timeline model, editing operations, playback and the editor UI. |
| `editor-effects.js` | Effects and transitions, rendered per frame on a canvas. |
| `editor-grade.js` | Color grading. |
| `editor-waveform.js` | Audio waveforms for the timeline. |
| `editor-export.js` | Export: frames drawn to a canvas, captured with `MediaRecorder`. |
| `editor-sample.js`, `editor-sample-webm.js` | The built-in sample project's media. |

## Run it

Serve `AlcorApps/web` with any static server (see the [AlcorApps README](../../README.md)), open
`AlcorVideo/` and choose **Try a sample project**.

## Limitations

Export codecs depend on the browser, because encoding goes through `MediaRecorder`.
