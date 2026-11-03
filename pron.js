// Pronunciation check with Microsoft Azure AI Speech "Pronunciation Assessment".
// Off by default: only when the user turns it on does the latest take leave the browser.
// Uses a short-lived token from the az-token edge function, or a local key (config.local.js) when testing.
import { align, norm } from './align.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@1.40.0/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js';

function loadSDK() {
  if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.onload = () => window.SpeechSDK ? resolve(window.SpeechSDK) : reject(new Error('Speech SDK did not load'));
    s.onerror = () => reject(new Error('Speech SDK could not be downloaded'));
    document.head.appendChild(s);
  });
}

// 16 kHz mono Float32 → WAV blob (used for Azure and for exact seeking when replaying a word)
export function toWav(pcm, rate = 16000) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

// Returns { pron, accuracy, fluency, completeness, prosody, words: {scriptIdx: {acc, start, end, err}} }
export async function assess(script, wavBlob, { key, region, token }, onStatus = () => {}) {
  const SDK = await loadSDK();
  onStatus('Checking pronunciation with Microsoft…');
  const cfg = token ? SDK.SpeechConfig.fromAuthorizationToken(token, region) : SDK.SpeechConfig.fromSubscription(key, region);
  cfg.speechRecognitionLanguage = 'en-US';
  const audio = SDK.AudioConfig.fromWavFileInput(new File([wavBlob], 'take.wav', { type: 'audio/wav' }));
  const reference = script.sentences.map(s => s.text).join(' ');
  const pa = new SDK.PronunciationAssessmentConfig(reference, SDK.PronunciationAssessmentGradingSystem.HundredMark, SDK.PronunciationAssessmentGranularity.Phoneme, true);
  pa.enableProsodyAssessment = true;
  const reco = new SDK.SpeechRecognizer(cfg, audio);
  pa.applyTo(reco);

  const segs = [];
  await new Promise((resolve, reject) => {
    reco.recognized = (_, e) => {
      if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
      const j = JSON.parse(e.result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult));
      if (j.NBest && j.NBest[0]) segs.push(j.NBest[0]);
      onStatus(`Checking pronunciation… ${segs.length} part${segs.length > 1 ? 's' : ''} done`);
    };
    reco.canceled = (_, e) => {
      if (e.reason === SDK.CancellationReason.Error) reject(new Error(e.errorDetails || 'Pronunciation check failed'));
      else resolve();
    };
    reco.sessionStopped = () => resolve();
    reco.startContinuousRecognitionAsync(() => {}, (err) => reject(new Error(err)));
  });
  await new Promise(r => reco.stopContinuousRecognitionAsync(r, r));
  reco.close();
  if (!segs.length) throw new Error('Microsoft heard no speech in the latest take');

  // Azure words → script words (our own alignment, so omissions are judged against the whole script)
  const heard = segs.flatMap(s => s.Words || []).filter(w => w.PronunciationAssessment?.ErrorType !== 'Omission' && w.Offset !== undefined);
  const H = heard.map(w => norm(w.Word));
  const words = {};
  let matched = 0;
  for (const o of align(script.words.map(w => w.n), H)) {
    if (o.t !== 'ok' && o.t !== 'sub') continue;
    const w = heard[o.h], pa = w.PronunciationAssessment || {};
    const acc = o.t === 'ok' ? (pa.AccuracyScore ?? 100) : Math.min(pa.AccuracyScore ?? 0, 40);
    words[o.s] = { acc, start: w.Offset / 1e7, end: (w.Offset + w.Duration) / 1e7, err: pa.ErrorType };
    matched++;
  }
  // segment scores weighted by length
  const avg = (k) => {
    let a = 0, n = 0;
    for (const s of segs) { const v = s.PronunciationAssessment?.[k]; if (v === undefined) continue; const len = (s.Words || []).length || 1; a += v * len; n += len; }
    return n ? a / n : undefined;
  };
  const accVals = Object.values(words).map(w => w.acc);
  const accuracy = accVals.length ? accVals.reduce((a, b) => a + b, 0) / accVals.length : 0;
  const completeness = matched / script.words.length * 100;
  const fluency = avg('FluencyScore') ?? 0, prosody = avg('ProsodyScore');
  const pron = prosody === undefined
    ? accuracy * 0.5 + fluency * 0.25 + completeness * 0.25
    : accuracy * 0.4 + fluency * 0.2 + completeness * 0.2 + prosody * 0.2;
  return { pron, accuracy, fluency, completeness, prosody, words };
}
