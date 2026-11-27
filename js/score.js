// The score as data: [{lyric ('' rest), midi|null, beats, expr?}] in order. Every edit returns a new score.
import { EXPRESSION } from './phrase.js';
import { NAMES, noteName } from './midi.js';

export const LOW = 48, HIGH = 84, MIN_BEATS = 1 / 32;
export const RANGE = { vib: [0, 2], cents: [-100, 100], scoop: [0, 5], fall: [0, 5], dyn: [-24, 12], br: [-20, 20], gen: [-1, 1], ten: [-10, 10] };
const clip = (x, a, b) => Math.min(b, Math.max(a, x));
const rest = beats => ({ lyric: '', midi: null, beats });
const copy = ns => ns.map(n => ({ ...n, ...(n.expr ? { expr: { ...n.expr } } : {}) }));

// rests joined, empty ones dropped, none at the end
export function tidy(notes) {
  const out = [];
  for (const n of notes) {
    if (n.midi == null) {
      if (n.beats < 1e-6) continue;
      const last = out[out.length - 1];
      if (last && last.midi == null) { out[out.length - 1] = rest(last.beats + n.beats); continue; }
    }
    out.push(n);
  }
  return out;
}

export function onsets(notes) { let t = 0; return notes.map(n => { const o = t; t += n.beats; return o; }); }
export const totalBeats = notes => notes.reduce((a, n) => a + n.beats, 0);

// Notes from a list of [onset, note]: rests fill the gaps, a note that would overlap starts after the one before.
function fromOnsets(list, end = 0) {
  const out = []; let t = 0;
  for (const [o, n] of list.sort((a, b) => a[0] - b[0])) {
    if (o - t > 1e-6) out.push(rest(o - t));
    out.push(n); t = Math.max(t, o) + n.beats;
  }
  if (end - t > 1e-6) out.push(rest(end - t));
  return tidy(out);
}
const placed = notes => { const o = onsets(notes); return notes.map((n, i) => [o[i], n, i]).filter(x => x[1].midi != null); };

// The given notes move together by `delta` beats, as far as the notes around them allow.
export function moveNotes(notes, indexes, delta) {
  const ns = copy(notes), all = placed(ns), on = new Set(indexes);
  let lo = -Infinity, hi = Infinity;
  all.forEach(([o, n, i], k) => {
    if (!on.has(i)) return;
    const before = all[k - 1], after = all[k + 1];
    if (!before) lo = Math.max(lo, -o); else if (!on.has(before[2])) lo = Math.max(lo, before[0] + before[1].beats - o);
    if (after && !on.has(after[2])) hi = Math.min(hi, after[0] - o - n.beats);
  });
  const d = clip(delta, lo, Math.max(lo, hi));
  return fromOnsets(all.map(([o, n, i]) => [on.has(i) ? o + d : o, n]));
}

export function removeNotes(notes, indexes, closeGap = false) {
  const on = new Set(indexes);
  return tidy(copy(notes).map((n, i) => !on.has(i) ? n : closeGap ? rest(0) : rest(n.beats)));
}

// A longer note takes the rest after it first and only then pushes the rest of the song; a shorter one leaves a rest.
export function resizeNote(notes, i, beats) {
  const ns = copy(notes), was = ns[i].beats;
  ns[i].beats = Math.max(MIN_BEATS, beats);
  const grow = ns[i].beats - was, next = ns[i + 1];
  if (grow < 0) ns.splice(i + 1, 0, rest(-grow));
  else if (next && next.midi == null) next.beats = Math.max(0, next.beats - grow);
  return tidy(ns);
}

// A new note at `beat`: {notes, index}, or null when something is already sung there.
export function addNote(notes, beat, midi, beats, lyric = 'ら') {
  const all = placed(copy(notes));
  if (all.some(([o, n]) => beat < o + n.beats - 1e-6 && beat >= o - 1e-6)) return null;
  const after = all.find(([o]) => o > beat);
  const n = { lyric, midi: clip(midi, LOW, HIGH), beats: Math.max(MIN_BEATS, after ? Math.min(beats, after[0] - beat) : beats) };
  const out = fromOnsets([...all.map(([o, x]) => [o, x]), [beat, n]]);
  return { notes: out, index: out.indexOf(n) };
}

export function splitNote(notes, i) {
  const ns = copy(notes), half = ns[i].beats / 2;
  if (half < MIN_BEATS) return ns;
  ns.splice(i, 1, { ...ns[i], beats: half }, { ...ns[i], lyric: 'ー', beats: half });
  return ns;
}

// Neighbouring notes in one: the first one's lyric and pitch.
export function joinNotes(notes, indexes) {
  const ns = copy(notes), sorted = [...indexes].sort((a, b) => a - b), first = sorted[0];
  for (const i of sorted.slice(1).reverse()) if (ns.slice(first, i).every(n => n.midi != null)) { ns[first].beats += ns[i].beats; ns.splice(i, 1); }
  return tidy(ns);
}

export function transpose(notes, indexes, k) {
  const on = indexes ? new Set(indexes) : null;
  return copy(notes).map((n, i) => n.midi != null && (!on || on.has(i)) ? { ...n, midi: clip(n.midi + k, LOW, HIGH) } : n);
}

export function setExpr(notes, indexes, key, value) {
  const on = new Set(indexes);
  return copy(notes).map((n, i) => {
    if (!on.has(i) || n.midi == null) return n;
    const e = { ...n.expr };
    if (value == null || !Number.isFinite(+value)) delete e[key]; else e[key] = clip(+value, ...RANGE[key]);
    const { expr, ...plain } = n;
    return Object.keys(e).length ? { ...plain, expr: e } : plain;
  });
}

// Syllables onto the sung notes from note `from` on; syllables left over get new notes at the end.
export function setLyrics(notes, from, syllables) {
  const ns = copy(notes); let k = 0;
  for (let i = from; i < ns.length && k < syllables.length; i++) if (ns[i].midi != null) ns[i].lyric = syllables[k++];
  const last = ns.findLast(n => n.midi != null)?.midi ?? 67;
  while (k < syllables.length) ns.push({ lyric: syllables[k++], midi: last, beats: .5 });
  return ns;
}

// Scores from links, files or storage are untrusted: keep only well-formed notes.
export function clean(list) {
  if (!Array.isArray(list)) throw new Error('악보 형식이 아닙니다');
  return list.slice(0, 5000).filter(n => n && typeof n === 'object').map(n => {
    const e = {};
    for (const k of EXPRESSION) if (n.expr && Number.isFinite(+n.expr[k]) && n.expr[k] !== null && k in n.expr) e[k] = clip(+n.expr[k], ...RANGE[k]);
    const b = +n.beats;
    return {
      lyric: n.midi == null ? '' : String(n.lyric ?? '').slice(0, 8), midi: n.midi == null ? null : clip(Math.round(+n.midi) || 60, LOW, HIGH),
      beats: clip(b > 0 ? b : 1, MIN_BEATS, 400), ...(Object.keys(e).length ? { expr: e } : {}),
    };
  });
}

// ---------------------------------------------------------------- text: "lyric NOTE beats [key=value ...]", rests "- 0 beats"
const num = x => String(Math.round(x * 1e4) / 1e4);
export const toText = notes => notes.map(n => n.midi == null ? `- 0 ${num(n.beats)}`
  : [n.lyric || 'ら', noteName(n.midi), num(n.beats), ...Object.entries(n.expr ?? {}).map(([k, v]) => `${k}=${num(v)}`)].join(' ')).join('\n');

export function parseNote(s) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec((s ?? '').trim());
  if (!m) return null;
  return NAMES.indexOf(m[1].toUpperCase()) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (+m[3] + 1) * 12;
}

export function fromText(text, reading = x => x) {
  return clean(text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !/^(tempo|mode):/i.test(l)).map(l => {
    const [ly, nt, b, ...kv] = l.split(/\s+/);
    if (ly === '-' || ly === 'R') return rest(+b || 1);
    const midi = parseNote(nt);
    if (midi == null) throw new Error(`"${nt ?? ''}"은(는) 음 이름이 아닙니다. C4, G#4 형식으로 입력해 주십시오`);
    const expr = Object.fromEntries(kv.map(x => x.split('=')).filter(([k]) => EXPRESSION.includes(k)).map(([k, v]) => [k, +v]));
    return { lyric: reading(ly), midi, beats: +b || 1, ...(Object.keys(expr).length ? { expr } : {}) };
  }));
}

// ---------------------------------------------------------------- undo
export class History {
  constructor(state) { this.past = []; this.now = structuredClone(state); this.future = []; }
  push(state) {
    if (JSON.stringify(state) === JSON.stringify(this.now)) return;
    this.past.push(this.now); if (this.past.length > 200) this.past.shift();
    this.now = structuredClone(state); this.future = [];
  }
  undo() { if (!this.past.length) return null; this.future.push(this.now); this.now = this.past.pop(); return structuredClone(this.now); }
  redo() { if (!this.future.length) return null; this.past.push(this.now); this.now = this.future.pop(); return structuredClone(this.now); }
}
