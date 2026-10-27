// Speech-to-text in a Web Worker so the page stays responsive.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

env.allowLocalModels = false;
let asr = null, loaded = '';

self.onmessage = async (e) => {
  const { type, id, audio, model } = e.data;
  try {
    if (!asr || loaded !== model) {
      self.postMessage({ type: 'status', id, text: 'Loading speech model (first time only)…' });
      asr = await pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        device: (self.navigator && self.navigator.gpu) ? 'webgpu' : 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) self.postMessage({ type: 'load', id, file: p.file, pct: p.loaded / p.total });
        },
      }).catch(async () => pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'wasm' }));
      loaded = model;
    }
    if (type === 'transcribe') {
      self.postMessage({ type: 'status', id, text: 'Listening…' });
      const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
      const words = (out.chunks || []).map(c => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] }))
        .filter(w => w.text);
      self.postMessage({ type: 'done', id, text: out.text, words });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, text: String(err && err.message || err) });
  }
};
