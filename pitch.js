// Pitch (intonation) tools. Pure functions, testable with node.

// YIN pitch tracker → f0 per 10 ms frame (0 = unvoiced). pcm: 16 kHz mono Float32Array.
export function trackPitch(pcm, sr = 16000, fmin = 70, fmax = 400) {
  const hop = Math.round(sr * 0.01), win = Math.round(sr * 0.04);
  const tMin = Math.floor(sr / fmax), tMax = Math.ceil(sr / fmin);
  const n = Math.max(0, Math.floor((pcm.length - win - tMax) / hop));
  const f0 = new Float32Array(n), rms = new Float32Array(n);
  const d = new Float32Array(tMax + 1);
  for (let i = 0; i < n; i++) {
    const o = i * hop;
    let e = 0; for (let k = 0; k < win; k++) e += pcm[o + k] * pcm[o + k];
    rms[i] = Math.sqrt(e / win);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)] || 0, loud = sorted[Math.floor(n * 0.9)] || 0;
  const thr = floor + (loud - floor) * 0.15;
  for (let i = 0; i < n; i++) {
    if (rms[i] < thr) continue;
    const o = i * hop;
    let run = 0, best = -1;
    d[0] = 1;
    for (let t = 1; t <= tMax; t++) {
      let s = 0; for (let k = 0; k < win; k++) { const x = pcm[o + k] - pcm[o + k + t]; s += x * x; }
      run += s; d[t] = run ? s * t / run : 1;
    }
    for (let t = tMin; t <= tMax; t++) {
      if (d[t] < 0.15) { while (t + 1 <= tMax && d[t + 1] < d[t]) t++; best = t; break; }
    }
    if (best > 0) {
      // parabolic interpolation
      const a = d[best - 1], b = d[best], c = best + 1 <= tMax ? d[best + 1] : b;
      const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
      f0[i] = sr / (best + (Math.abs(shift) < 1 ? shift : 0));
    }
  }
  return { f0, hop: 0.01 };
}

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// semitones relative to the speaker's median pitch (so men/women/TTS are comparable)
export function speakerMedian(track) { return median(Array.from(track.f0).filter(Boolean)); }

function frames(track, t0, t1, ref) {
  const out = [];
  const a = Math.max(0, Math.floor(t0 / track.hop)), b = Math.min(track.f0.length - 1, Math.ceil(t1 / track.hop));
  for (let i = a; i <= b; i++) if (track.f0[i]) out.push({ t: i * track.hop, st: 12 * Math.log2(track.f0[i] / ref) });
  // drop octave jumps (tracker errors): anything > 9 st from local median
  const m = median(out.map(x => x.st));
  return out.filter(x => Math.abs(x.st - m) < 9);
}

// words: [{text,start,end}] belonging to one sentence, in order
export function sentenceContour(track, words, ref) {
  if (!words.length || !ref) return null;
  const t0 = words[0].start, t1 = words[words.length - 1].end;
  const fr = frames(track, t0, t1, ref);
  if (fr.length < 8) return null;
  const sts = fr.map(x => x.st);
  const range = pct(sts, 0.9) - pct(sts, 0.1);
  // ending: last 0.25 s of voicing vs the 0.5 s before it
  const lastT = fr[fr.length - 1].t;
  const tail = fr.filter(x => x.t >= lastT - 0.25).map(x => x.st);
  const before = fr.filter(x => x.t < lastT - 0.25 && x.t >= lastT - 0.75).map(x => x.st);
  const endDelta = before.length && tail.length ? mean(tail) - mean(before) : 0;
  const ending = endDelta <= -1.2 ? 'fall' : endDelta >= 1.2 ? 'rise' : 'flat';
  // the word that sits highest = where the stress lands
  let peak = -1, peakSt = -Infinity;
  words.forEach((w, k) => {
    const ws = frames(track, w.start, w.end, ref).map(x => x.st);
    if (ws.length >= 3) { const v = pct(ws, 0.8); if (v > peakSt) { peakSt = v; peak = k; } }
  });
  // 40-point curve over normalized time for drawing
  const curve = [];
  for (let k = 0; k < 40; k++) {
    const ta = t0 + (t1 - t0) * k / 40, tb = t0 + (t1 - t0) * (k + 1) / 40;
    const v = fr.filter(x => x.t >= ta && x.t < tb).map(x => x.st);
    curve.push(v.length ? mean(v) : null);
  }
  return { range, ending, endDelta, peak, curve };
}

// Compare a learner's sentence contours (one per take) against the native one.
export function compareIntonation(native, mine, scriptWordsOfSentence) {
  const rows = mine.filter(Boolean);
  if (!native || !rows.length) return null;
  const issues = [];
  const myRange = mean(rows.map(r => r.range));
  if (myRange < Math.max(3, native.range * 0.55)) issues.push({ kind: 'flat', text: `flat — your pitch moves ${myRange.toFixed(1)} semitones, the native voice ${native.range.toFixed(1)}` });
  const ends = rows.map(r => r.ending);
  const majority = (v) => ends.filter(e => e === v).length >= Math.ceil(rows.length / 2);
  if (native.ending === 'fall' && majority('rise')) issues.push({ kind: 'end', text: 'ending goes up (sounds like a question) — native voice drops' });
  else if (native.ending === 'fall' && majority('flat')) issues.push({ kind: 'end', text: "ending stays level — native voice drops at the end" });
  return { myRange, issues, score: issues.length };
}
