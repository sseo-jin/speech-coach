# Speech Coach

Paste a speech script, add several practice recordings, and it finds the sentences you keep stumbling on, then turns them into cue cards (strong sentences = first words only, weak sentences = full text with the tricky words marked).

- Runs entirely in the browser. Speech-to-text: Whisper (`onnx-community/whisper-base.en_timestamped`) via transformers.js 4.2.0 in a Web Worker. Recordings never leave the device.
- `align.js` — script ↔ transcript word alignment (weighted edit distance), per-sentence scoring: skipped / misheard words, long pauses (≥0.8 s), fillers, speed. A sentence is "weak" only if it is troubled in ≥2 of 3+ takes. Sentences not attempted in a take are ignored for that take. Names are not counted as errors.
- `app.js` — UI in four steps (matches the demonstrative speech): paste → record → check → repeat.
  - Paste: expected time and word count against a target time.
  - Check: Ready score (time 25 + pauses 25 + stuck sentences 30 [+ pronunciation 20]) with the reasons, time/speed per take, stops over 2 s (click to listen), stuck sentences, pronunciation on the latest take (click a word to hear it).
  - Repeat: Ready score history per script (account, or localStorage when logged out) as a line chart, the sentences missed in 2+ runs, and a cue card built from this take plus those sentences.
  - Transcripts and pronunciation results are cached by audio hash, so re-analyzing the same files is instant (handy for a live demo).
- `score.js` — Ready score. `pron.js` — Microsoft Azure AI Speech Pronunciation Assessment (off by default; the latest take is sent to Azure only when turned on; the key stays in Supabase secrets; the browser gets a 10-minute token from the `az-token` edge function in `supabase/functions/`, or uses `config.local.js` when testing locally).

Run locally:

```
python3 -m http.server 5178
```

then open http://localhost:5178

Built 2026-10-27 as a demonstrative-speech topic idea for 영어발표 (SKKU).

Cue cards print at 148×98 mm — the course rule is "no larger than 10 × 15 cm".

Live demo on another computer: `demo.json` holds a fixed sample result (script, target, transcripts and pronunciation by audio hash). "See a sample result" shows it with no recording, and uploading the same takes reuses it, so no model download or Azure key is needed. To remake it: analyze the demo takes locally (pronunciation on), run `copy(scExportDemo())` in the console and save the text as `demo.json`.
