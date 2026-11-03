// Ready score: one number for "how ready am I", plus the reasons it lost points.
// Pure functions, testable with node.

export const LONG_PAUSE = 2; // seconds — "stopped for more than two seconds"

export const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// takes: analyzeTake results · weak: pickWeak result · target: [lo, hi] seconds · pron: {pron} or null
export function readyScore(takes, weak, target, pron) {
  const avgDur = takes.reduce((a, t) => a + t.total, 0) / takes.length;
  const [lo, hi] = target;
  const off = avgDur < lo ? lo - avgDur : avgDur > hi ? avgDur - hi : 0;
  const stops = takes.reduce((a, t) => a + t.pauseMarks.filter(p => p.dur >= LONG_PAUSE).length, 0) / takes.length;

  const parts = [
    { key: 'time', max: 25, got: 25 * clamp01(1 - off / 45) },
    { key: 'pauses', max: 25, got: 25 * clamp01(1 - stops / 4) },
    { key: 'stuck', max: 30, got: 30 * clamp01(1 - weak.length / 5) },
  ];
  if (pron) parts.push({ key: 'pron', max: 20, got: 20 * clamp01((pron.pron - 50) / 45) });
  const max = parts.reduce((a, p) => a + p.max, 0);
  const score = Math.round(parts.reduce((a, p) => a + p.got, 0) / max * 100);

  const why = [];
  if (off > 0) why.push(`${fmt(off)} ${avgDur > hi ? 'over' : 'under'} time`);
  if (stops >= 0.5) why.push(`${+stops.toFixed(1)} stop${stops >= 1.5 ? 's' : ''} over ${LONG_PAUSE} s per take`);
  if (weak.length) why.push(`${weak.length} stuck sentence${weak.length > 1 ? 's' : ''}`);
  if (pron && pron.pron < 90) why.push(`pronunciation ${Math.round(pron.pron)}/100`);
  return { score, parts, why, avgDur, stops, off };
}
