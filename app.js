import { parseScript, analyzeTake, rankSentences, pickWeak } from './align.js';

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
      const out = await transcribe(pcm, model, (t) => setProgress(base + step * 0.3, `Take ${i + 1}/${state.takes.length}: ${t}`));
      results.push({ ...analyzeTake(script, out.words), text: out.text });
      setProgress(base + step, `Take ${i + 1} done`);
    }
    setProgress(1, 'Done ✓');
    render(script, results);
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
    let html = ''; let prevEnd = null;
    for (const o of t.ops) {
      if (o.h !== undefined && prevEnd !== null && t.hw[o.h] && t.hw[o.h].start - prevEnd >= 0.8) html += `<span class="pause">⏸${(t.hw[o.h].start - prevEnd).toFixed(1)}s</span> `;
      if (o.t === 'ok') html += `<span class="w-ok">${esc(t.hw[o.h].text)}</span> `;
      else if (o.t === 'sub') html += `<span class="w-sub" title="script: ${esc(script.words[o.s].raw)}">${esc(t.hw[o.h].text)}</span> `;
      else if (o.t === 'del') html += `<span class="w-del">${esc(script.words[o.s].raw)}</span> `;
      else html += `<span class="w-ins">${esc(t.hw[o.h].text)}</span> `;
      if (o.h !== undefined && t.hw[o.h]) prevEnd = t.hw[o.h].end;
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

$('#print').onclick = () => window.print();
updateScriptInfo();
