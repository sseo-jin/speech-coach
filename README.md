# Speech Coach

Paste a speech script, add several practice recordings, and it finds the sentences you keep stumbling on, then turns them into cue cards (strong sentences = first words only, weak sentences = full text with the tricky words marked).

- Runs entirely in the browser. Speech-to-text: Whisper (`onnx-community/whisper-base.en_timestamped`) via transformers.js 4.2.0 in a Web Worker. Recordings never leave the device.
- `align.js` — script ↔ transcript word alignment (weighted edit distance), per-sentence scoring: skipped / misheard words, long pauses (≥0.8 s), fillers, speed. A sentence is "weak" only if it is troubled in ≥2 of 3+ takes. Sentences not attempted in a take are ignored for that take. Names are not counted as errors.
- `app.js` — UI: script → takes (upload or record) → analyze → weak list, heatmap, per-take diff → printable cue cards.

Run locally:

```
python3 -m http.server 5178
```

then open http://localhost:5178

Built 2026-10-27 as a demonstrative-speech topic idea for 영어발표 (SKKU).
