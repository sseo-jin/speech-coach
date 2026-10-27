import { parseScript, analyzeTake, rankSentences, pickWeak, norm } from './align.js';
import { trackPitch, speakerMedian, sentenceContour, compareIntonation } from './pitch.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SAMPLE = `Hello everyone, my name is Jin Seo.
Many people think that sunlight only gives us warmth and light. But it does much more.
Today, I'm going to tell you 3 health benefits of sunlight.
These days, we spend a lot of time away from the sun. So I want to tell you the reason why we really need sunlight.

First, sunlight makes our bones stronger.
When we are in the sun, our body makes vitamin D.
Vitamin D helps our body use calcium, and calcium makes our bones strong.
So even a short walk in the sun is good for our bones.

Second, sunlight can help us sleep well.
Morning sunlight sets our body clock.
Then at night, our body makes melatonin, and melatonin makes us feel more sleepy.
So if you go outside in the morning, you will sleep better at night.

Finally, sunlight can help us feel happy.
This is because it helps our brain make serotonin.
And that chemical makes us feel more relaxed and peaceful.
So when you feel down, a little sunlight can be the best medicine.

To sum up, sunlight is good for our bones, our sleep, and our mood.
Sunlight does much more than just keep us warm. It keeps our lives healthy.
How about going outside for just ten minutes tomorrow morning?
Thank you for listening.`;

const state = { takes: [] }; // {name, blob, url}

// ---------- step 1
const scriptEl = $('#script');
function updateScriptInfo() {
  const sc = parseScript(scriptEl.value);
  $('#scriptInfo').textContent = sc.words.length ? `${sc.parts.length} parts · ${sc.sentences.length} sentences · ${sc.words.length} words (~${Math.round(sc.words.length / 125 * 60)} s at 125 wpm)` : '';
  refreshAnalyze();
}
scriptEl.addEventListener('input', updateScriptInfo);
$('#loadSample').onclick = () => { scriptEl.value = SAMPLE; updateScriptInfo(); };

// ---------- step 2
function renderTakes() {
  const ul = $('#takes'); ul.innerHTML = '';
  state.takes.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>Take ${i + 1}</b><span class="muted">${esc(t.name)}</span><audio controls src="${t.url}"></audio><button class="x" title="remove">✕</button>`;
    li.querySelector('.x').onclick = () => { URL.revokeObjectURL(t.url); state.takes.splice(i, 1); renderTakes(); };
    ul.appendChild(li);
  });
  refreshAnalyze();
}
function addTake(blob, name) { state.takes.push({ blob, name, url: URL.createObjectURL(blob) }); renderTakes(); }
$('#files').onchange = (e) => { [...e.target.files].forEach(f => addTake(f, f.name)); e.target.value = ''; };

let rec = null, recStart = 0, recTimer = null;
$('#recBtn').onclick = async () => {
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recTimer); $('#recTime').textContent = '';
      $('#recBtn').textContent = '● Record a take'; $('#recBtn').classList.remove('rec');
      addTake(new Blob(chunks, { type: rec.mimeType }), `recorded ${new Date().toLocaleTimeString()}`);
    };
    rec.start(); recStart = Date.now();
    $('#recBtn').textContent = '■ Stop'; $('#recBtn').classList.add('rec');
    recTimer = setInterval(() => { $('#recTime').textContent = `${((Date.now() - recStart) / 1000).toFixed(0)} s`; }, 250);
  } catch (err) { alert('Microphone not available: ' + err.message); }
};

function refreshAnalyze() { $('#analyze').disabled = !(state.takes.length && parseScript(scriptEl.value).words.length); }

// ---------- audio → 16 kHz mono Float32
async function toPCM(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

// silent stretches measured from the audio itself (seconds)
function findSilences(pcm, minDur = 0.5) {
  const hop = 320; // 20 ms at 16 kHz
  const n = Math.floor(pcm.length / hop), rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = i * hop; k < (i + 1) * hop; k++) a += pcm[k] * pcm[k]; rms[i] = Math.sqrt(a / hop); }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)] || 0, loud = sorted[Math.floor(n * 0.9)] || 0;
  const thr = floor + (loud - floor) * 0.12;
  const out = []; let st = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && rms[i] < thr;
    if (quiet && st < 0) st = i;
    if (!quiet && st >= 0) { const s = st * 0.02, e = i * 0.02; if (e - s >= minDur) out.push({ start: s, end: e }); st = -1; }
  }
  return out;
}

// ---------- step 3
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0; const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data; const p = pending.get(m.id); if (!p) return;
  if (m.type === 'status') p.onStatus(m.text);
  else if (m.type === 'load') p.onStatus(`Downloading model… ${Math.round(m.pct * 100)}%`);
  else if (m.type === 'done') { pending.delete(m.id); p.resolve(m); }
  else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.text)); }
};
function transcribe(audio, model, onStatus) {
  const id = ++jobId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onStatus }); worker.postMessage({ type: 'transcribe', id, audio, model }, [audio.buffer]); });
}

// ---------- native reference voice (Kokoro TTS, in a worker)
const ttsWorker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
let ttsId = 0; const ttsPending = new Map();
ttsWorker.onmessage = (e) => {
  const m = e.data; const p = ttsPending.get(m.id); if (!p) return;
  if (m.type === 'status') p.onStatus(m.text);
  else if (m.type === 'load') p.onStatus(`Downloading native voice… ${Math.round(m.pct * 100)}%`);
  else if (m.type === 'done') { ttsPending.delete(m.id); p.resolve(m); }
  else if (m.type === 'error') { ttsPending.delete(m.id); p.reject(new Error(m.text)); }
};
function synthesize(text, voice, onStatus) {
  const id = ++ttsId;
  return new Promise((resolve, reject) => { ttsPending.set(id, { resolve, reject, onStatus }); ttsWorker.postMessage({ id, text, voice }); });
}
function wavBlob(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}
const nativeCache = new Map(); // `${voice}|${text}` → {url, words, contour}
async function nativeFor(text, voice, model, onStatus) {
  const key = `${voice}|${text}`;
  if (nativeCache.has(key)) return nativeCache.get(key);
  const out = await synthesize(text, voice, onStatus);
  const blob = wavBlob(out.audio, out.sr);
  const pcm = await toPCM(blob);
  const track = trackPitch(pcm);
  const ref = speakerMedian(track);
  const tr = await transcribe(pcm, model, onStatus);
  const res = { url: URL.createObjectURL(blob), words: tr.words, contour: sentenceContour(track, tr.words, ref) };
  nativeCache.set(key, res);
  return res;
}

function setProgress(frac, text) { $('#progress').hidden = false; $('#bar').style.width = `${Math.round(frac * 100)}%`; $('#status').textContent = text; }

$('#analyze').onclick = async () => {
  const script = parseScript(scriptEl.value);
  const model = $('#model').value;
  $('#analyze').disabled = true;
  const results = [];
  try {
    for (let i = 0; i < state.takes.length; i++) {
      const base = i / state.takes.length, step = 1 / state.takes.length;
      setProgress(base, `Take ${i + 1}/${state.takes.length}: decoding audio…`);
      const pcm = await toPCM(state.takes[i].blob);
      const silences = findSilences(pcm);
      const track = trackPitch(pcm); // before transcribe: the buffer is handed to the worker
      const out = await transcribe(pcm, model, (t) => setProgress(base + step * 0.3, `Take ${i + 1}/${state.takes.length}: ${t}`));
      const r = analyzeTake(script, out.words, { silences, pauseMin: +$('#pauseMin').value });
      const ref = speakerMedian(track);
      r.contours = r.per.map(p => p.attempted ? sentenceContour(track, p.h.slice().sort((a, b) => a - b).map(k => r.hw[k]), ref) : null);
      r.sentWords = r.per.map(p => p.h.slice().sort((a, b) => a - b).map(k => r.hw[k]));
      results.push({ ...r, text: out.text });
      setProgress(base + step, `Take ${i + 1} done`);
    }
    let natives = null;
    if ($('#intonation').checked) {
      natives = [];
      const voice = $('#voice').value, n = script.sentences.length;
      for (let si = 0; si < n; si++) {
        setProgress(si / n, `Native voice: sentence ${si + 1}/${n}…`);
        natives.push(await nativeFor(script.sentences[si].text, voice, model, (t) => setProgress(si / n, `Native voice ${si + 1}/${n}: ${t}`)));
      }
    }
    setProgress(1, 'Done ✓');
    render(script, results);
    renderIntonation(script, results, natives);
  } catch (err) {
    setProgress(0, 'Something went wrong: ' + err.message);
  } finally { refreshAnalyze(); }
};

// ---------- step 4 + 5
function sentenceHTML(script, si, hits, nTakes) {
  const s = script.sentences[si];
  return s.words.map(wi => {
    const w = script.words[wi]; const h = hits[wi] || 0;
    return h && (h >= 2 || nTakes < 3) ? `<mark class="bad" title="missed or misheard in ${h} take(s)">${esc(w.raw)}</mark>` : esc(w.raw);
  }).join(' ');
}

function render(script, takes) {
  const ranked = rankSentences(script, takes);
  const weak = pickWeak(ranked);
  const weakSet = new Set(weak.map(w => w.si));
  // summary
  const avgDur = takes.reduce((a, t) => a + t.total, 0) / takes.length;
  const avgErr = takes.reduce((a, t) => a + t.per.reduce((x, p) => x + p.sub + p.del, 0), 0) / takes.length;
  $('#summary').innerHTML = `
    <div class="stat"><b>${takes.length}</b>takes</div>
    <div class="stat"><b>${Math.floor(avgDur / 60)}:${String(Math.round(avgDur % 60)).padStart(2, '0')}</b>avg length</div>
    <div class="stat"><b>${Math.round(takes.reduce((a, t) => a + t.wpm, 0) / takes.length)}</b>words / min</div>
    <div class="stat"><b>${avgErr.toFixed(1)}</b>missed/misheard words per take</div>
    <div class="stat"><b>${weak.length}</b>weak sentences</div>`;
  $('#weak').innerHTML = weak.length ? weak.map(w => `
    <div class="weak-item"><div class="sent">${sentenceHTML(script, w.si, w.wordHits, w.nTakes)}</div>
    <div class="why">trouble in ${w.troubled}/${w.nTakes} takes · ${w.reasons.join(' · ') || 'slow'}</div></div>`).join('')
    : '<p>No sentence keeps tripping you up. Nice! 🎉</p>';
  const unpracticed = ranked.filter(r => r.skippedTakes > 0);
  if (unpracticed.length) $('#weak').innerHTML += `<p class="muted" style="margin-top:12px">Not practiced in some takes (not counted as weak): ${unpracticed.map(r => `#${r.si + 1} (${r.skippedTakes}/${takes.length})`).join(', ')}</p>`;
  // heatmap
  const col = (v) => v < 0.4 ? '#d3f9d8' : v < 1 ? '#fff3bf' : '#ffd8c2';
  $('#heat').innerHTML = `<table class="heat"><tr><th>#</th><th>Sentence</th>${takes.map((_, i) => `<th>T${i + 1}</th>`).join('')}</tr>
    ${script.sentences.map((s, si) => `<tr><td>${si + 1}</td><td>${esc(s.text)}</td>${takes.map(t => t.per[si].attempted ? `<td class="c" style="background:${col(t.per[si].score)}" title="score ${t.per[si].score.toFixed(2)}">${t.per[si].score.toFixed(1)}</td>` : '<td class="c muted">—</td>').join('')}</tr>`).join('')}</table>`;
  // diffs
  $('#diffs').innerHTML = takes.map((t, ti) => {
    let html = '';
    const marks = new Map(t.pauseMarks.map(p => [p.before, p]));
    for (const o of t.ops) {
      const pm = o.h !== undefined && marks.get(o.h);
      if (pm) html += `<span class="pause" title="${pm.kind === 'start' ? 'stuck before this sentence' : 'pause inside the sentence'}">⏸${pm.dur.toFixed(1)}s</span> `;
      if (o.t === 'ok') html += `<span class="w-ok">${esc(t.hw[o.h].text)}</span> `;
      else if (o.t === 'sub') html += `<span class="w-sub" title="script: ${esc(script.words[o.s].raw)}">${esc(t.hw[o.h].text)}</span> `;
      else if (o.t === 'del') html += `<span class="w-del">${esc(script.words[o.s].raw)}</span> `;
      else html += `<span class="w-ins">${esc(t.hw[o.h].text)}</span> `;
    }
    return `<h4>Take ${ti + 1} · ${t.total.toFixed(0)} s</h4><div class="diff">${html}</div>`;
  }).join('') + '<p class="muted">orange = heard differently · <s>red</s> = skipped · <i>grey</i> = extra words · ⏸ = long pause</p>';
  $('#results').hidden = false;

  // cue cards: one per part
  const labels = ['Intro', 'Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Point 6'];
  const nParts = script.parts.length;
  $('#cards').innerHTML = script.parts.map((_, pi) => {
    const sents = script.sentences.map((s, si) => ({ s, si })).filter(x => x.s.part === pi);
    const title = pi === nParts - 1 && nParts > 1 ? 'Conclusion' : (labels[pi] || `Part ${pi + 1}`);
    return `<div class="card"><h3>${pi + 1}. ${title}</h3><ol>${sents.map(({ s, si }) => {
      if (weakSet.has(si)) return `<li class="full">${sentenceHTML(script, si, ranked[si].wordHits, ranked[si].nTakes)}</li>`;
      const first = s.text.split(/\s+/).slice(0, 3).join(' ');
      return `<li><span class="first">${esc(first)}</span> …</li>`;
    }).join('')}</ol></div>`;
  }).join('');
  $('#cardsSec').hidden = false;
  $('#results').scrollIntoView({ behavior: 'smooth' });
}

// ---------- intonation vs native
function curvePath(curve, w, h, lo, hi) {
  let d = '', pen = false;
  curve.forEach((v, k) => {
    if (v === null) { pen = false; return; }
    const x = (k + 0.5) / curve.length * w, y = h - (v - lo) / (hi - lo) * h;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `; pen = true;
  });
  return d;
}
function renderIntonation(script, takes, natives) {
  const sec = $('#intoSec');
  if (!natives) { sec.hidden = true; return; }
  const rows = script.sentences.map((s, si) => {
    const nat = natives[si];
    const mine = takes.map(t => t.contours[si]);
    const cmp = compareIntonation(nat.contour, mine) || { issues: [], score: 0 };
    // stress: which word sits highest
    if (nat.contour && nat.contour.peak >= 0) {
      const natWord = norm(nat.words[nat.contour.peak].text);
      const mineWords = takes.map((t, ti) => mine[ti] && mine[ti].peak >= 0 ? norm(t.sentWords[si][mine[ti].peak].text) : null).filter(Boolean);
      const differ = mineWords.filter(w => w !== natWord);
      if (mineWords.length && differ.length >= Math.ceil(mineWords.length / 2)) {
        const top = differ.sort((a, b) => differ.filter(x => x === b).length - differ.filter(x => x === a).length)[0];
        cmp.issues.push({ kind: 'stress', text: `native voice stresses “${natWord}”, you stress “${top}”` });
        cmp.score++;
      }
    }
    return { si, s, nat, mine, cmp };
  });
  const W = 300, H = 70;
  const box = (r) => {
    const all = [r.nat.contour, ...r.mine].filter(Boolean).flatMap(c => c.curve).filter(v => v !== null);
    const lo = Math.min(-6, ...all), hi = Math.max(6, ...all);
    const paths = r.mine.filter(Boolean).map(c => `<path d="${curvePath(c.curve, W, H, lo, hi)}" class="me"/>`).join('');
    const nat = r.nat.contour ? `<path d="${curvePath(r.nat.contour.curve, W, H, lo, hi)}" class="nat"/>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" class="contour" preserveAspectRatio="none">${paths}${nat}</svg>`;
  };
  const item = (r) => `<div class="into-item ${r.cmp.issues.length ? 'has' : ''}">
      <div class="sent">${r.si + 1}. ${esc(r.s.text)}</div>
      <div class="into-row">${box(r)}<audio controls preload="none" src="${r.nat.url}"></audio></div>
      ${r.cmp.issues.length ? `<ul class="issues">${r.cmp.issues.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>` : '<div class="why">close to the native shape ✓</div>'}
    </div>`;
  const bad = rows.filter(r => r.cmp.issues.length).sort((a, b) => b.cmp.score - a.cmp.score);
  const good = rows.filter(r => !r.cmp.issues.length);
  $('#intoList').innerHTML = (bad.length ? bad.map(item).join('') : '<p>Your intonation follows the native shape everywhere. 🎉</p>')
    + (good.length ? `<details class="detail"><summary>Sentences that already sound natural (${good.length})</summary>${good.map(item).join('')}</details>` : '');
  sec.hidden = false;
}

$('#print').onclick = () => window.print();
updateScriptInfo();
