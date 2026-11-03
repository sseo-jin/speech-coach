import { parseScript, analyzeTake, rankSentences, pickWeak } from './align.js';
import { readyScore, fmt, LONG_PAUSE } from './score.js';
import { assess, toWav } from './pron.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// localStorage can be missing (private window) — never let it break the page
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

// demo.json: a fixed sample result for live demos on someone else's computer.
// If an uploaded take matches a recording in it, its saved transcript and pronunciation are reused,
// so the demo needs no model download and no Azure key.
const demo = await fetch('demo.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);

async function sha(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

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

const state = { takes: [], wavs: [] }; // takes: {name, blob, url} · wavs: 16 kHz WAV urls for exact replay
// Target time: minutes ±1, seconds ±15 with the arrows only (no typing, so no odd values)
const MAX_SEC = 10 * 60;
const toSec = (v) => { const [m, sec] = String(v).trim().split(':'); return sec === undefined ? +m : +m * 60 + +sec; };
const getT = (id) => +$(`#${id} .tm`).value * 60 + +$(`#${id} .ts`).value;
function setT(id, sec) {
  sec = Math.max(0, Math.min(MAX_SEC, Math.round(sec / 15) * 15));
  $(`#${id} .tm`).value = Math.floor(sec / 60);
  $(`#${id} .ts`).value = String(sec % 60).padStart(2, '0');
  store.set('sc:' + id, `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
}
const target = () => [getT('tFrom'), getT('tTo')];
setT('tFrom', toSec(store.get('sc:tFrom', '1:30')) || 90);
setT('tTo', toSec(store.get('sc:tTo', '2:00')) || 120);
for (const id of ['tFrom', 'tTo']) {
  const box = $('#' + id);
  box.addEventListener('keydown', (e) => { if (!['ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) e.preventDefault(); });
  box.addEventListener('paste', (e) => e.preventDefault());
  box.addEventListener('input', () => {
    setT(id, getT(id)); // 0:45 +15 → 1:00, 1:00 −15 → 0:45
    const [lo, hi] = [getT('tFrom'), getT('tTo')];
    if (lo > hi) id === 'tFrom' ? setT('tTo', lo) : setT('tFrom', hi); // keep from ≤ to
    updateScriptInfo();
  });
}

// ---------- 1 PASTE
const scriptEl = $('#script');
scriptEl.value = store.get('sc:script', '');
function updateScriptInfo() {
  const sc = parseScript(scriptEl.value);
  store.set('sc:script', scriptEl.value);
  const ex = $('#expect');
  if (!sc.words.length) { ex.hidden = true; refreshAnalyze(); return; }
  const sec = sc.words.length / +$('#wpm').value * 60, [lo, hi] = target();
  const fit = sec < lo ? `<span class="warn">⚠ ${fmt(lo - sec)} short</span>` : sec > hi ? `<span class="bad">⚠ ${fmt(sec - hi)} too long</span>` : '<span class="good">✅ fits your target</span>';
  ex.innerHTML = `<div><b>${fmt(sec)}</b>expected time</div><div><b>${sc.words.length}</b>words</div><div><b>${sc.sentences.length}</b>sentences</div><div class="fit">${fit}<span class="muted">at ${$('#wpm').value} words / min · target ${fmt(lo)}–${fmt(hi)}</span></div>`;
  ex.hidden = false;
  refreshAnalyze();
}
scriptEl.addEventListener('input', updateScriptInfo);
$('#wpm').onchange = updateScriptInfo;
$('#loadSample').onclick = () => { scriptEl.value = SAMPLE; updateScriptInfo(); };

// ---------- 2 RECORD
function renderTakes() {
  const ul = $('#takes'); ul.innerHTML = '';
  state.takes.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>Take ${i + 1}</b><span class="muted">${esc(t.name)}</span><audio controls src="${t.url}"></audio><button class="x" title="remove">✕</button>`;
    li.querySelector('.x').onclick = () => { URL.revokeObjectURL(t.url); state.takes.splice(i, 1); renderTakes(); };
    ul.appendChild(li);
  });
  if (state.takes.length && state.takes.length < 3) ul.insertAdjacentHTML('beforeend', `<li class="muted tip">${3 - state.takes.length} more take${state.takes.length === 2 ? '' : 's'} for the best results</li>`);
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
      $('#recBtn').textContent = '● Record'; $('#recBtn').classList.remove('rec');
      addTake(new Blob(chunks, { type: rec.mimeType }), `recorded ${new Date().toLocaleTimeString()}`);
    };
    rec.start(); recStart = Date.now();
    $('#recBtn').textContent = '■ Stop'; $('#recBtn').classList.add('rec');
    recTimer = setInterval(() => { $('#recTime').textContent = fmt((Date.now() - recStart) / 1000); }, 250);
  } catch (err) { alert('Microphone not available: ' + err.message); }
};

function refreshAnalyze() { $('#analyze').disabled = !(state.takes.length && parseScript(scriptEl.value).words.length); }

// ---------- 3 CHECK — pronunciation key
// config.local.js (git-ignored) can hold the key so it survives a cleared browser
const local = window.SC_CONFIG || {};
$('#azKey').value = store.get('sc:azKey', '') || local.azureKey || '';
$('#azRegion').value = store.get('sc:azRegion', '') || local.azureRegion || '';
$('#pronOn').checked = store.get('sc:pronOn', false);
$('#pronNote').hidden = !$('#pronOn').checked;
$('#pronOn').onchange = () => {
  store.set('sc:pronOn', $('#pronOn').checked);
  $('#pronNote').hidden = !$('#pronOn').checked;
};

// ---------- audio → 16 kHz mono Float32
async function toPCM(buf) {
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
  const scriptKey = await sha(script.words.map(w => w.n).join(' '));
  $('#analyze').disabled = true;
  const results = [];
  state.wavs.forEach(u => URL.revokeObjectURL(u)); state.wavs = [];
  let lastWav = null, lastHash = '';
  state.last = { script: scriptEl.value, target: target(), scriptKey, tx: {}, pron: {} }; // for scExportDemo()
  const unheard = [];
  try {
    const n = state.takes.length;
    for (let i = 0; i < n; i++) {
      const base = i / n, step = 1 / n;
      setProgress(base, `Take ${i + 1}/${n}: decoding audio…`);
      const bytes = await state.takes[i].blob.arrayBuffer();
      const hash = await sha(bytes);
      const pcm = await toPCM(bytes).catch(() => { throw new Error(`Take ${i + 1} (${state.takes[i].name}) is not an audio file this browser can read. Try m4a, mp3 or wav.`); });
      const wav = toWav(pcm);
      const silences = findSilences(pcm);
      // same recording + same model → reuse the transcript (makes a re-run instant)
      const txKey = `sc:tx:${model}:${hash}`;
      let out = store.get(txKey, null) || demo?.tx?.[hash] || null;
      if (!out) {
        out = await transcribe(pcm, model, (t) => setProgress(base + step * 0.3, `Take ${i + 1}/${n}: ${t}`));
        // the model sometimes hallucinates on a take (e.g. a line of random characters) — never keep that
        const heard = out.words.filter(w => /[a-z0-9]/i.test(w.text));
        if (heard.length < Math.max(5, script.words.length * 0.2)) { unheard.push(i + 1); continue; }
        store.set(txKey, { text: out.text, words: out.words });
      }
      state.last.tx[hash] = { text: out.text, words: out.words };
      state.wavs.push(URL.createObjectURL(wav));
      lastWav = wav; lastHash = hash;
      results.push({ ...analyzeTake(script, out.words, { silences, pauseMin: +$('#pauseMin').value }), text: out.text, label: i + 1 });
      setProgress(base + step, `Take ${i + 1} done`);
    }

    if (!results.length) throw new Error('No speech could be heard in your takes. Try recording closer to the microphone.');
    let pron = null, pronErr = '';
    if ($('#pronOn').checked) {
      const key = $('#azKey').value.trim(), region = $('#azRegion').value.trim();
      const pKey = `sc:pron:${scriptKey}:${lastHash}`;
      pron = store.get(pKey, null) || demo?.pron?.[`${scriptKey}:${lastHash}`] || null;
      if (!pron && !(key && region)) pronErr = 'Pronunciation check is not set up yet (no Azure key in config.local.js).';
      else if (!pron) {
        try {
          pron = await assess(script, lastWav, { key, region }, (t) => setProgress(0.97, t));
          store.set(pKey, pron);
        } catch (err) { pronErr = 'Pronunciation check failed: ' + err.message; }
      }
    }
    setProgress(1, unheard.length ? `Done ✓ — couldn't hear take ${unheard.join(', ')}, so it was left out. Try analyzing it again or record it once more.` : 'Done ✓');
    if (pron) state.last.pron[`${scriptKey}:${lastHash}`] = pron;
    state.last.results = results; state.last.pronResult = pron;
    render(script, results, pron, pronErr, scriptKey);
    store.set('sc:lastResult', { script: scriptEl.value, results, pron, pronErr, scriptKey });
  } catch (err) {
    setProgress(0, 'Something went wrong: ' + err.message);
  } finally { refreshAnalyze(); }
};

// ---------- replay a moment of a take
let stopTimer = null;
async function playSeg(url, a, b) {
  const p = $('#player');
  if (p.dataset.src !== url) {
    p.src = url; p.dataset.src = url;
    await new Promise(r => p.readyState >= 1 ? r() : p.addEventListener('loadedmetadata', r, { once: true }));
  }
  clearTimeout(stopTimer);
  p.currentTime = Math.max(0, a);
  await p.play().catch(() => {});
  stopTimer = setTimeout(() => p.pause(), Math.max(0.4, b - a) * 1000);
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (el && state.wavs[+el.dataset.take]) playSeg(state.wavs[+el.dataset.take], +el.dataset.a, +el.dataset.b);
});
const playAttr = (take, a, b) => `data-take="${take}" data-a="${a.toFixed(2)}" data-b="${b.toFixed(2)}"`;

// ---------- render
function sentenceHTML(script, si, hits, nTakes) {
  const s = script.sentences[si];
  return s.words.map(wi => {
    const w = script.words[wi]; const h = hits[wi] || 0;
    return h && (h >= 2 || nTakes < 3) ? `<mark class="bad" title="missed or misheard in ${h} take(s)">${esc(w.raw)}</mark>` : esc(w.raw);
  }).join(' ');
}
const snippet = (text, n = 7) => { const w = text.split(/\s+/); return esc(w.slice(0, n).join(' ')) + (w.length > n ? ' …' : ''); };

function render(script, takes, pron, pronErr, scriptKey, { sample = false, scroll = true } = {}) {
  const ranked = rankSentences(script, takes);
  const weak = pickWeak(ranked);
  const weakSet = new Set(weak.map(w => w.si));
  const [lo, hi] = target();
  const r = readyScore(takes, weak, [lo, hi], pron);
  const last = takes.length - 1;

  // Ready score
  const label = { time: 'Time', pauses: 'Pauses', stuck: 'Stuck sentences', pron: 'Pronunciation' };
  const tone = r.score >= 85 ? 'good' : r.score >= 65 ? 'warn' : 'bad';
  $('#ready').innerHTML = `<div class="score ${tone}" style="--p:${r.score}"><b>${r.score}</b><span>Ready</span></div>
    <div class="why"><p class="lead">${r.score >= 85 ? 'You are almost ready.' : r.score >= 65 ? 'Getting there.' : 'Keep practicing.'}</p>
    <p>${r.why.length ? r.why.map(esc).join(' · ') : 'Nothing to fix. 🎉'}</p>
    <div class="parts">${r.parts.map(p => `<span>${label[p.key]} <b>${Math.round(p.got)}</b>/${p.max}</span>`).join('')}</div></div>`;

  // time and speed
  $('#timeSpeed').innerHTML = takes.map((t, i) => {
    const ok = t.total >= lo && t.total <= hi;
    const mark = ok ? '<span class="good">✅</span>' : t.total > hi ? '<span class="bad">⚠ long</span>' : '<span class="warn">⚠ short</span>';
    return `<div class="stat"><span class="muted">Take ${t.label}</span><b>${fmt(t.total)}</b>${mark} · ${Math.round(t.wpm)} wpm</div>`;
  }).join('') + `<div class="stat target"><span class="muted">Target</span><b>${fmt(lo)}–${fmt(hi)}</b>average ${fmt(r.avgDur)}</div>`;

  // stops over 2 s, grouped by sentence
  const stops = new Map();
  takes.forEach((t, ti) => t.pauseMarks.filter(p => p.dur >= LONG_PAUSE && p.si !== undefined).forEach(p => {
    const at = t.hw[p.before].start;
    if (!stops.has(p.si)) stops.set(p.si, []);
    stops.get(p.si).push({ ti, dur: p.dur, kind: p.kind, a: at - p.dur - 1.2, b: at + 1.5 });
  }));
  $('#stops').innerHTML = stops.size ? [...stops.entries()].sort((a, b) => a[0] - b[0]).map(([si, list]) => `
    <div class="stop"><span class="sent">${list[0].kind === 'start' ? 'before' : 'inside'} “${snippet(script.sentences[si].text)}”</span>
    ${list.map(s => `<button class="chip" ${playAttr(s.ti, s.a, s.b)} title="listen">▶ Take ${takes[s.ti].label} · ${s.dur.toFixed(1)} s</button>`).join('')}</div>`).join('')
    : '<p class="muted">No stops over 2 seconds. 👏</p>';

  // weak sentences
  $('#weak').innerHTML = weak.length ? weak.map(w => `
    <div class="weak-item"><div class="sent">${sentenceHTML(script, w.si, w.wordHits, w.nTakes)}</div>
    <div class="why">stuck in ${w.troubled}/${w.nTakes} takes · ${w.reasons.join(' · ') || 'slow'}</div></div>`).join('')
    : '<p class="muted">No sentence keeps tripping you up. Nice! 🎉</p>';
  const unpracticed = ranked.filter(x => x.skippedTakes > 0);
  if (unpracticed.length && unpracticed.length <= 6) $('#weak').innerHTML += `<p class="muted" style="margin-top:12px">Not practiced in some takes (not counted as weak): ${unpracticed.map(x => `#${x.si + 1} (${x.skippedTakes}/${takes.length})`).join(', ')}</p>`;

  // pronunciation on the latest take — click a word to hear it
  renderPron(script, takes[last], last, pron, pronErr, takes[last].label);

  $('#results').hidden = false;

  // cue cards (shown when "Make my cue card" is pressed)
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
  $('#cards').hidden = true; $('#print').hidden = true;
  $('#cardsSec').hidden = false;

  // repeat: save this run, draw the trend
  const hk = `sc:hist:${scriptKey}`;
  const hist = getHist(hk);
  if (!sample) hist.push({ t: Date.now(), score: r.score, takes: takes.length, stuck: weak.length });
  if (!sample) store.set(hk, hist.slice(-30));
  renderHistory(hk);

  if (scroll) $('#results').scrollIntoView({ behavior: 'smooth' });
}

function renderPron(script, take, ti, pron, pronErr, label) {
  const words = script.words;
  let html = '';
  if (pron) {
    $('#pronScores').textContent = `· ${Math.round(pron.pron)}/100 — accuracy ${Math.round(pron.accuracy)} · fluency ${Math.round(pron.fluency)} · completeness ${Math.round(pron.completeness)}${pron.prosody !== undefined ? ` · intonation ${Math.round(pron.prosody)}` : ''}`;
    $('#pronHint').textContent = `Take ${label}. Red words were not clear. Click a word to hear your voice again.`;
    const map = pron.words;
    html = words.map((w, wi) => {
      const p = map[wi];
      if (!p) return `<span class="w skip" title="skipped">${esc(w.raw)}</span>`;
      const cls = p.acc >= 80 ? 'good' : p.acc >= 60 ? 'meh' : 'bad';
      return `<span class="w ${cls}" ${playAttr(ti, p.start - 0.15, p.end + 0.15)} title="${Math.round(p.acc)}/100${p.err && p.err !== 'None' ? ' · ' + p.err : ''}">${esc(w.raw)}</span>`;
    });
  } else {
    // without Microsoft: words the speech model heard differently are the unclear ones
    $('#pronScores').textContent = '';
    $('#pronHint').innerHTML = (pronErr ? `<span class="bad">${esc(pronErr)}</span> ` : '') +
      `Take ${label}. Red words are the ones the AI heard differently. Click one to hear your voice again.${pronErr ? '' : ' Turn on “Check pronunciation” for word-by-word scores.'}`;
    const bySrc = {};
    for (const o of take.ops) if (o.s !== undefined) bySrc[o.s] = o;
    html = words.map((w, wi) => {
      const o = bySrc[wi];
      if (!o || o.t === 'del') return `<span class="w skip" title="skipped">${esc(w.raw)}</span>`;
      const h = take.hw[o.h];
      const cls = o.t === 'sub' && !w.name ? 'bad' : '';
      return `<span class="w ${cls}" ${playAttr(ti, h.start - 0.15, h.end + 0.15)}${cls ? ` title="heard: ${esc(h.text)}"` : ''}>${esc(w.raw)}</span>`;
    });
  }
  // keep the script's sentence breaks readable
  const out = []; let prev = -1;
  words.forEach((w, wi) => { if (w.si !== prev && prev !== -1 && script.sentences[w.si].part !== script.sentences[prev].part) out.push('<br><br>'); out.push(html[wi]); prev = w.si; });
  $('#pron').innerHTML = out.join(' ');
}

// history from this browser; on a fresh browser the demo script starts from the history saved in demo.json
const getHist = (hk) => store.get(hk, null) ?? (demo && hk === `sc:hist:${demo.scriptKey}` ? [...(demo.history || [])] : []);
function renderHistory(hk) {
  const hist = getHist(hk);
  $('#repeatSec').hidden = !hist.length;
  if (!hist.length) return;
  const recent = hist.slice(-6).map(h => h.score);
  $('#trend').innerHTML = `Your Ready score: <b>${recent.join(' → ')}</b>` +
    (hist.length > 1 ? ` <span class="muted">(${hist[hist.length - 1].score - hist[0].score >= 0 ? '+' : ''}${hist[hist.length - 1].score - hist[0].score} since your first try)</span>` : '');
  const W = 640, H = 200, P = 34;
  const x = (i) => hist.length === 1 ? W / 2 : P + i * (W - 2 * P) / (hist.length - 1);
  const y = (v) => H - P + 10 - v / 100 * (H - 2 * P);
  const pts = hist.map((h, i) => `${x(i).toFixed(1)},${y(h.score).toFixed(1)}`).join(' ');
  $('#graph').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Ready score over practice runs">
    ${[0, 50, 100].map(v => `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`).join('')}
    <defs><linearGradient id="stroke" x1="0" x2="1"><stop offset="0" stop-color="#3b5bfd"/><stop offset="1" stop-color="#7c4dff"/></linearGradient>
      <linearGradient id="fade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7c4dff" stop-opacity=".22"/><stop offset="1" stop-color="#7c4dff" stop-opacity="0"/></linearGradient></defs>
    ${hist.length > 1 ? `<polygon points="${x(0)},${y(0)} ${pts} ${x(hist.length - 1)},${y(0)}" class="area"/>` : ''}
    <polyline points="${pts}" class="line"/>
    ${hist.map((h, i) => `<circle cx="${x(i)}" cy="${y(h.score)}" r="5" class="dot"><title>Run ${i + 1}: ${h.score} · ${h.stuck} stuck · ${new Date(h.t).toLocaleString()}</title></circle>
      <text x="${x(i)}" y="${y(h.score) - 11}" text-anchor="middle" class="val">${h.score}</text>
      <text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="axis">#${i + 1}</text>`).join('')}
  </svg>`;
  $('#clearHist').onclick = () => { if (confirm('Clear the score history for this script?')) { store.set(hk, []); renderHistory(hk); } };
}

$('#makeCards').onclick = () => { $('#cards').hidden = false; $('#print').hidden = false; $('#cards').scrollIntoView({ behavior: 'smooth' }); };
$('#print').onclick = () => window.print();
updateScriptInfo();

// ---------- sample result (demo.json)
if (demo?.sample) {
  $('#sampleResult').hidden = false;
  $('#sampleResult').onclick = () => {
    scriptEl.value = demo.script; store.set('sc:script', demo.script);
    setT('tFrom', demo.target[0]); setT('tTo', demo.target[1]);
    updateScriptInfo(); refreshAnalyze();
    state.wavs = [];
    setProgress(1, 'This is a sample result. Upload your own takes and press Analyze to see yours.');
    render(parseScript(demo.script), demo.sample.results, demo.sample.pron, '', demo.scriptKey, { sample: true });
  };
}

// Run in the console after analyzing the demo takes, then save the text as demo.json
window.scExportDemo = () => {
  const l = state.last; if (!l?.results) return 'Analyze first.';
  return JSON.stringify({ script: l.script, target: l.target, scriptKey: l.scriptKey, tx: l.tx, pron: l.pron, sample: { results: l.results, pron: l.pronResult }, history: getHist(`sc:hist:${l.scriptKey}`) });
};
// on localhost only: save the latest analysis + this script's score history as demo.json
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  $('#saveDemo').hidden = false;
  $('#saveDemo').onclick = () => {
    const json = window.scExportDemo();
    if (!json.startsWith('{')) return alert('Analyze your demo takes first.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'demo.json'; a.click();
  };
}

// ---------- after a reload: show the last result again (scores are already kept in this browser)
{
  const l = store.get('sc:lastResult', null);
  if (l && l.script === scriptEl.value) {
    setProgress(1, 'Your last result. Add your takes again to replay your voice.');
    render(parseScript(l.script), l.results, l.pron, l.pronErr, l.scriptKey, { sample: true, scroll: false });
  }
}
