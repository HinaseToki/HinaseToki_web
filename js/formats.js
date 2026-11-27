// Scores of other programs, read and written in the browser: OpenUtau (ustx), UTAU (ust), MusicXML, MIDI, and this
// page's own project file. Reading gives {tempo, notes}; only one melody line is taken (the first voice).
import { clean, tidy, toText } from './score.js';

const TPB = 480;
const rest = beats => ({ lyric: '', midi: null, beats });

// [tick, length, midi, lyric] -> notes; overlaps are cut, gaps become rests
function fromTicks(list, tpb = TPB) {
  const out = []; let t = 0;
  for (const [a, len, midi, lyric] of list.sort((x, y) => x[0] - y[0])) {
    if (a < t) { const last = out[out.length - 1]; const over = (t - a) / tpb; if (!last || last.midi == null || last.beats <= over + 1e-6) continue; last.beats -= over; t = a; }
    if (a > t) out.push(rest((a - t) / tpb));
    out.push({ lyric, midi, beats: len / tpb }); t = a + len;
  }
  return clean(tidy(out));
}
const ticks = (notes, tpb = TPB) => { let t = 0; return notes.flatMap(n => { const a = Math.round(t * tpb); t += n.beats; return n.midi == null ? [] : [[a, Math.round(t * tpb) - a, n]]; }); };

// ---------------------------------------------------------------- OpenUtau
// ustx is YAML; the few fields needed are read by their indentation (block or {flow} maps).
export function importUstx(text) {
  const scalar = v => { v = v.trim(); return /^".*"$/.test(v) ? JSON.parse(v) : /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v; };
  const tempo = +(/^bpm:\s*([\d.]+)/m.exec(text)?.[1] ?? /^tempos:\s*\n(?:\s*-\s*)\{?.*?bpm:\s*([\d.]+)/m.exec(text)?.[1] ?? 120), tpb = +(/^resolution:\s*(\d+)/m.exec(text)?.[1] ?? TPB);
  const parts = text.split(/^voice_parts:\s*$/m)[1]?.split(/^\S/m)[0] === undefined ? '' : text.split(/^voice_parts:\s*$/m)[1];
  const list = []; let part = -1, offset = 0, inNotes = false, cur = null, indent = -1;
  const done = () => { if (cur && cur.position != null && cur.tone != null) list.push([offset + +cur.position, +cur.duration, +cur.tone, /^\+/.test(cur.lyric) ? 'ー' : String(cur.lyric ?? 'ら')]); cur = null; };
  for (const line of (parts ?? '').split('\n')) {
    const m = /^(\s*)(-\s+)?([A-Za-z_]+):\s*(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m) { if (/^\S/.test(line) && !/^-/.test(line)) break; continue; }
    const depth = m[1].length + (m[2]?.length ?? 0), item = !!m[2], [, , , key, val] = m;
    if (item && m[1].length === 0) { done(); if (++part > 0) break; inNotes = false; offset = 0; }
    if (!item && m[1].length === 0) break;                                   // the next section (wave_parts ...)
    if (key === 'position' && !inNotes) offset = +val;
    else if (key === 'notes') { inNotes = true; indent = -1; }
    else if (inNotes && item && (indent < 0 || depth === indent) && key === 'position') { done(); indent = depth; cur = { position: val }; }
    else if (inNotes && cur && depth === indent && ['duration', 'tone', 'lyric'].includes(key)) cur[key] = scalar(val);
    else if (inNotes && m[1].length <= 2 && !item && depth < indent) inNotes = false;
  }
  done();
  if (!list.length) throw new Error('이 ustx 파일에는 음표가 없습니다');
  return { tempo, notes: fromTicks(list, tpb) };
}

export function exportUstx(notes, tempo) {
  const body = ticks(notes).map(([a, len, n]) => `  - position: ${a}
    duration: ${len}
    tone: ${n.midi}
    lyric: ${JSON.stringify(n.lyric === 'ー' ? '+~' : n.lyric)}
    pitch:
      data:
      - {x: -25, y: 0, shape: io}
      - {x: 25, y: 0, shape: io}
      snap_first: true
    vibrato: {length: ${n.expr?.vib ? 60 : 0}, period: 185, depth: ${Math.round((n.expr?.vib ?? 0) * 100) || 25}, in: 20, out: 15, shift: 0, drift: 0}`).join('\n');
  return `name: Hinase Toki
comment: ''
output_dir: Vocal
cache_dir: UCache
ustx_version: "0.6"
resolution: ${TPB}
bpm: ${tempo}
beat_per_bar: 4
beat_unit: 4
time_signatures:
- {bar_position: 0, beat_per_bar: 4, beat_unit: 4}
tempos:
- {position: 0, bpm: ${tempo}}
tracks:
- {singer: HinaseToki_AI, phonemizer: OpenUtau.Core.DiffSinger.DiffSingerJapanesePhonemizer, renderer_settings: {renderer: DIFFSINGER}, mute: false, solo: false, volume: 0}
voice_parts:
- duration: ${Math.ceil(notes.reduce((a, n) => a + n.beats, 0) * TPB)}
  name: Toki
  comment: ''
  track_no: 0
  position: 0
  notes:
${body}
wave_parts: []
`;
}

// ---------------------------------------------------------------- UTAU
export function importUst(text) {
  const tempo = +(/^Tempo=([\d.]+)/m.exec(text)?.[1] ?? 120), out = [];
  for (const block of text.split(/^\[#/m).slice(1)) {
    if (!/^\d+\]/.test(block)) continue;
    const f = Object.fromEntries(block.split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    const beats = +f.Length / TPB, lyric = (f.Lyric ?? '').trim();
    if (!(beats > 0)) continue;
    out.push(/^(R|r|)$/.test(lyric) ? rest(beats) : { lyric: lyric.split(' ').pop(), midi: +f.NoteNum, beats });       // "a か" (VCV) -> か
  }
  if (!out.some(n => n.midi != null)) throw new Error('이 ust 파일에는 음표가 없습니다');
  return { tempo, notes: clean(tidy(out)) };
}

// ---------------------------------------------------------------- MusicXML
export function importMusicXml(text) {
  const part = /<part\b[^>]*>([\s\S]*?)<\/part>/.exec(text)?.[1];
  if (!part) throw new Error('MusicXML 파일이 아닙니다');
  const tag = (s, t) => new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`).exec(s)?.[1]?.trim();
  const tempo = +(/<sound\b[^>]*\btempo="([\d.]+)"/.exec(text)?.[1] ?? tag(text, 'per-minute') ?? 120);
  const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const unescape = s => s.replace(/&(lt|gt|amp|quot|apos);/g, (_, k) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[k]);
  let div = 1, voice = null; const out = [];
  for (const m of part.matchAll(/<divisions>(\d+)<\/divisions>|<note\b[^>]*>([\s\S]*?)<\/note>/g)) {
    if (m[1]) { div = +m[1]; continue; }
    const n = m[2];
    if (/<chord\s*\/?>/.test(n) || /<grace\b/.test(n)) continue;
    const v = tag(n, 'voice') ?? '1'; voice ??= v; if (v !== voice) continue;
    const beats = +(tag(n, 'duration') ?? 0) / div;
    if (!(beats > 0)) continue;
    if (/<rest\b/.test(n)) { out.push(rest(beats)); continue; }
    const p = tag(n, 'pitch') ?? '', midi = STEP[tag(p, 'step')] + +(tag(p, 'alter') ?? 0) + (+tag(p, 'octave') + 1) * 12;
    const last = out[out.length - 1];
    if (/<tie\b[^>]*type="stop"/.test(n) && last?.midi === midi) { last.beats += beats; continue; }
    const lyric = tag(tag(n, 'lyric') ?? '', 'text');
    out.push({ lyric: lyric ? unescape(lyric) : 'ー', midi, beats });
  }
  if (!out.some(n => n.midi != null)) throw new Error('이 MusicXML 파일에는 음표가 없습니다');
  return { tempo, notes: clean(tidy(out)) };
}

// ---------------------------------------------------------------- MIDI
export function exportMidi(notes, tempo) {
  const vlq = n => { const b = [n & 127]; while (n >>= 7) b.unshift(n & 127 | 128); return b; }, be = (n, k) => Array.from({ length: k }, (_, i) => Math.floor(n / 256 ** (k - 1 - i)) & 255);
  const us = Math.round(6e7 / tempo), ev = [[0, [255, 0x51, 3, ...be(us, 3)]], [0, [255, 3, 4, 84, 111, 107, 105]]], enc = new TextEncoder();
  for (const [a, len, n] of ticks(notes)) {
    const ly = [...enc.encode(n.lyric)];
    ev.push([a, [255, 5, ...vlq(ly.length), ...ly]], [a, [0x90, n.midi, 96]], [a + len, [0x80, n.midi, 0]]);
  }
  ev.sort((x, y) => x[0] - y[0] || (x[1][0] === 0x80 ? -1 : 0) - (y[1][0] === 0x80 ? -1 : 0));
  let t = 0; const body = ev.flatMap(([a, b]) => { const d = vlq(a - t); t = a; return [...d, ...b]; }).concat([0, 255, 47, 0]);
  return Uint8Array.from([77, 84, 104, 100, ...be(6, 4), ...be(0, 2), ...be(1, 2), ...be(TPB, 2), 77, 84, 114, 107, ...be(body.length, 4), ...body]);
}

// ---------------------------------------------------------------- this page's project
export const writeProject = ({ tempo, notes, ...rest }) => JSON.stringify({ app: 'hinase-toki', version: 1, tempo, notes, ...rest }, null, 1);
export function readProject(text) {
  let d; try { d = JSON.parse(text); } catch { d = null; }
  if (d?.app !== 'hinase-toki') throw new Error('토키 프로젝트 파일이 아닙니다');
  return { ...d, tempo: +d.tempo || 110, notes: clean(d.notes) };
}

export async function readScoreFile(file) {
  const name = file.name.toLowerCase(), text = async enc => new TextDecoder(enc).decode(await file.arrayBuffer());
  if (name.endsWith('.ustx')) return importUstx(await text());
  if (name.endsWith('.ust')) { const t = await text(); return importUst(t.includes('�') ? await text('shift_jis') : t); }
  if (/\.(musicxml|xml)$/.test(name)) return importMusicXml(await text());
  if (name.endsWith('.json') || name.endsWith('.toki')) return readProject(await text());
  throw new Error('지원 형식은 ustx, ust, musicxml, toki(json)입니다');
}
export { toText };
