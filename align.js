// Pure analysis: script ↔ transcript alignment and per-sentence scoring.
// No browser APIs here, so it can be tested with node.

const NUM = {0:'zero',1:'one',2:'two',3:'three',4:'four',5:'five',6:'six',7:'seven',8:'eight',9:'nine',10:'ten',11:'eleven',12:'twelve',15:'fifteen',20:'twenty',30:'thirty',100:'hundred'};
const FILLERS = new Set(['um','uh','umm','uhh','er','erm','ah','hmm','mm','like']);

export function norm(w) {
  let x = w.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, '');
  if (/^\d+$/.test(x) && NUM[+x]) x = NUM[+x];
  return x.replace(/'s$/, 's').replace(/'/g, '');
}

// Script → parts (blank-line separated) → sentences → words
export function parseScript(text) {
  const parts = text.replace(/\r/g, '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const sentences = [];
  const words = [];
  parts.forEach((p, pi) => {
    const sents = p.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]*["”’)]*/g) || [p];
    sents.map(s => s.trim()).filter(Boolean).forEach(s => {
      const raw = s.split(/\s+/).filter(Boolean);
      const si = sentences.length;
      const ws = [];
      raw.forEach(r => {
        const n = norm(r);
        if (!n) return;
        ws.push(words.length);
        const name = ws.length > 0 && /^[A-Z][a-z]/.test(r) && !/^(I|I'm|I've|I'll)$/.test(r);
        words.push({ raw: r, n, si, name });
      });
      if (ws.length) sentences.push({ text: s, part: pi, words: ws });
    });
  });
  return { parts, sentences, words };
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
export function similar(a, b) {
  if (a === b) return 1;
  const d = lev(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

// Global alignment (script words S vs heard words H). Returns ops list.
// op: {t:'ok'|'sub'|'del'|'ins', s?:idx, h?:idx, near?:bool}
export function align(S, H) {
  const m = S.length, n = H.length;
  const D = Array.from({ length: m + 1 }, () => new Float32Array(n + 1));
  const B = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  for (let i = 1; i <= m; i++) { D[i][0] = i; B[i][0] = 1; }
  for (let j = 1; j <= n; j++) { D[0][j] = j * 0.7; B[0][j] = 2; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sim = similar(S[i - 1], H[j - 1]);
      const subCost = sim === 1 ? 0 : sim >= 0.6 ? 0.6 : 1.2;
      const a = D[i - 1][j - 1] + subCost, b = D[i - 1][j] + 1, c = D[i][j - 1] + 0.7;
      if (a <= b && a <= c) { D[i][j] = a; B[i][j] = 0; }
      else if (b <= c) { D[i][j] = b; B[i][j] = 1; }
      else { D[i][j] = c; B[i][j] = 2; }
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    const k = B[i][j];
    if (i > 0 && j > 0 && k === 0) {
      const sim = similar(S[i - 1], H[j - 1]);
      ops.push(sim === 1 ? { t: 'ok', s: i - 1, h: j - 1 } : { t: 'sub', s: i - 1, h: j - 1, near: sim >= 0.6 });
      i--; j--;
    } else if (i > 0 && (j === 0 || k === 1)) { ops.push({ t: 'del', s: i - 1 }); i--; }
    else { ops.push({ t: 'ins', h: j - 1 }); j--; }
  }
  return ops.reverse();
}

// heard: [{text, start, end}] word-level (seconds)
export function analyzeTake(script, heard, opts = {}) {
  const pauseMin = opts.pauseMin ?? 0.8;
  const H = heard.map(w => norm(w.text)).filter(Boolean);
  const hw = heard.filter(w => norm(w.text));
  const ops = align(script.words.map(w => w.n), H);
  const per = script.sentences.map(() => ({ ok: 0, sub: 0, del: 0, ins: 0, fill: 0, pauses: 0, maxPause: 0, h: [], badWords: [], subs: [] }));
  // attach insertions to the sentence of the nearest previous script word
  let lastS = 0;
  const hToS = new Map();
  for (const o of ops) {
    if (o.s !== undefined) lastS = script.words[o.s].si;
    const st = per[lastS];
    if (o.t === 'ok') { st.ok++; st.h.push(o.h); hToS.set(o.h, lastS); }
    else if (o.t === 'sub') {
      st.h.push(o.h); hToS.set(o.h, lastS);
      if (script.words[o.s].name) { st.ok++; continue; } // names are often transcribed oddly — not your fault
      st.sub++; st.badWords.push(o.s); st.subs.push({ s: o.s, h: o.h, near: o.near });
    }
    else if (o.t === 'del') { st.del++; st.badWords.push(o.s); }
    else { const n = H[o.h]; if (FILLERS.has(n)) st.fill++; else st.ins++; st.h.push(o.h); }
  }
  // pauses: prefer real silences measured from the audio (Whisper word timestamps often swallow silence)
  const betweenMin = opts.betweenMin ?? Math.max(1.3, pauseMin * 1.5);
  const pauseMarks = [];
  const sentOf = (j, dir) => { for (let k = j; k >= 0 && k < hw.length; k += dir) if (hToS.has(k)) return hToS.get(k); return undefined; };
  if (opts.silences && opts.silences.length) {
    for (const sil of opts.silences) {
      const dur = sil.end - sil.start, mid = (sil.start + sil.end) / 2;
      let j = hw.findIndex(w => (w.start + w.end) / 2 > mid);
      if (j === -1) continue;                 // trailing silence
      if (j === 0) continue;                  // leading silence
      const sp = sentOf(j - 1, -1), sn = sentOf(j, 1);
      if (sn === undefined) continue;
      if (sp === sn) {
        if (dur >= pauseMin) { per[sn].pauses++; per[sn].maxPause = Math.max(per[sn].maxPause, dur); pauseMarks.push({ before: j, dur, kind: 'in' }); }
      } else if (dur >= betweenMin) {
        per[sn].startPauses = (per[sn].startPauses || 0) + 1; per[sn].maxPause = Math.max(per[sn].maxPause, dur);
        pauseMarks.push({ before: j, dur, kind: 'start' });
      }
    }
  }
  per.forEach((st, si) => {
    const hs = st.h.slice().sort((a, b) => a - b);
    if (hs.length) {
      const t0 = hw[hs[0]].start, t1 = hw[hs[hs.length - 1]].end;
      st.dur = Math.max(0.01, t1 - t0);
      if (!(opts.silences && opts.silences.length)) {
        for (let k = 1; k < hs.length; k++) {
          const gap = hw[hs[k]].start - hw[hs[k - 1]].end;
          if (gap >= pauseMin) { st.pauses++; st.maxPause = Math.max(st.maxPause, gap); pauseMarks.push({ before: hs[k], dur: gap, kind: 'in' }); }
        }
      }
      st.wpm = (st.ok + st.sub) / st.dur * 60;
    } else { st.dur = 0; st.wpm = 0; }
    st.startPauses = st.startPauses || 0;
    const N = script.sentences[si].words.length;
    st.attempted = (st.ok + st.sub) / N >= 0.25;
    st.err = (st.sub + st.del) / N;
    st.score = !st.attempted ? 0 : st.err * 4 + st.pauses * 0.8 + st.startPauses * 0.8 + st.fill * 0.6 + st.ins * 0.3 + (st.wpm && st.wpm < 80 ? 0.5 : 0);
  });
  const total = hw.length ? hw[hw.length - 1].end - hw[0].start : 0;
  const wpm = total ? hw.length / total * 60 : 0;
  return { ops, per, H, hw, total, wpm, pauseMarks };
}

// Combine takes → ranked sentences
export function rankSentences(script, takes) {
  return script.sentences.map((s, si) => {
    const all = takes.map(t => t.per[si]);
    const rows = all.filter(r => r.attempted);
    const nTakes = rows.length || 1;
    const skippedTakes = all.length - rows.length;
    const meanScore = rows.reduce((a, r) => a + r.score, 0) / nTakes;
    const troubled = rows.filter(r => r.score >= 0.8).length;
    const wordHits = {};
    rows.forEach(r => r.badWords.forEach(w => { wordHits[w] = (wordHits[w] || 0) + 1; }));
    const reasons = [];
    const miss = rows.reduce((a, r) => a + r.del, 0), sub = rows.reduce((a, r) => a + r.sub, 0);
    const pauses = rows.reduce((a, r) => a + r.pauses, 0), fill = rows.reduce((a, r) => a + r.fill, 0);
    const starts = rows.reduce((a, r) => a + (r.startPauses || 0), 0);
    if (miss) reasons.push(`skipped ${miss} word${miss > 1 ? 's' : ''}`);
    if (sub) reasons.push(`${sub} word${sub > 1 ? 's' : ''} heard differently`);
    if (starts) reasons.push(`stuck before starting ${starts}×`);
    if (pauses) reasons.push(`${pauses} long pause${pauses > 1 ? 's' : ''} inside`);
    if (fill) reasons.push(`${fill} "um/uh"`);
    return { si, text: s.text, part: s.part, meanScore: rows.length ? meanScore : 0, troubled, nTakes, wordHits, reasons, skippedTakes, attemptedTakes: rows.length };
  });
}

export function pickWeak(ranked) {
  return ranked.filter(r => {
    if (!r.attemptedTakes) return false;
    const need = r.attemptedTakes >= 3 ? 2 : 1; // must show up in ≥2 takes when we have 3+
    return r.troubled >= need && r.meanScore >= 0.6;
  }).sort((a, b) => b.meanScore - a.meanScore);
}
