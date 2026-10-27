// Native reference voice: Kokoro TTS running in the browser.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';

let tts = null;

self.onmessage = async (e) => {
  const { id, text, voice } = e.data;
  try {
    if (!tts) {
      self.postMessage({ type: 'status', id, text: 'Loading native voice (first time only)…' });
      tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8', device: 'wasm',
        progress_callback: (p) => { if (p.status === 'progress' && p.total) self.postMessage({ type: 'load', id, pct: p.loaded / p.total }); },
      });
    }
    const out = await tts.generate(text, { voice: voice || 'af_heart' });
    const audio = out.audio;
    self.postMessage({ type: 'done', id, audio, sr: out.sampling_rate }, [audio.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, text: String(err && err.message || err) });
  }
};
