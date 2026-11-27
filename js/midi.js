// MIDI melody + lyric lines -> score, entirely in the browser (the file is never uploaded or saved).
// Port of ai/tools/midi_cover.py (tracks / melody / align_lines / fit / web_score); same input gives
// the same score.

import { SMALL, kataToHira, vowelOf } from './kana.js';

export const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const pyRound = x => {                     // Python's round(): halves go to the even neighbour
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - .5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
};
const pyG = x => String(parseFloat(x.toPrecision(6)));

// ---------------------------------------------------------------- Standard MIDI File
export function parseMidi(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, n) => String.fromCharCode(...u8.slice(o, o + n));
  if (str(0, 4) !== 'MThd') throw new Error('MIDI 파일이 아닙니다');
  const hlen = v.getUint32(4), ntr = v.getUint16(10), tpb = v.getUint16(12);
  if (tpb & 0x8000) throw new Error('이 MIDI 파일의 시간 형식(SMPTE)은 지원하지 않습니다');
  let o = 8 + hlen;
  let tracks = []; const tempos = [];
  for (let t = 0; t < ntr && o + 8 <= u8.length; t++) {
    if (str(o, 4) !== 'MTrk') { o += 8 + v.getUint32(o + 4); t--; continue; }
    const end = o + 8 + v.getUint32(o + 4);
    let p = o + 8, time = 0, status = 0;
    const ev = [], vlq = () => { let n = 0, b; do { b = u8[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    let name = '';
    while (p < end) {
      time += vlq();
      let b = u8[p];
      if (b & 0x80) { status = b; p++; } else if (!status) break;     // running status
      const hi = status & 0xf0, ch = status & 0x0f;
      if (status === 0xff) {
        const type = u8[p++], len = vlq();
        if (type === 0x51 && len === 3) tempos.push([time, (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2]]);
        if (type === 0x51 && len === 3) ev.push({ time, type: 'tempo', tempo: (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2] });
        if (type === 0x03) name = new TextDecoder().decode(u8.slice(p, p + len));
        p += len; status = 0;
      } else if (status === 0xf0 || status === 0xf7) { p += vlq(); status = 0; }
      else if (hi === 0x90 || hi === 0x80) {
        const note = u8[p], vel = u8[p + 1]; p += 2;
        ev.push({ time, type: hi === 0x90 && vel > 0 ? 'on' : 'off', note, ch });
      } else if (hi === 0xc0 || hi === 0xd0) p += 1;
      else p += 2;
    }
    tracks.push({ name, events: ev });
    o = end;
  }
  tempos.sort((a, b) => a[0] - b[0]);
  if (!tempos.length || tempos[0][0] > 0) tempos.unshift([0, 500000]);
  // a file with every instrument on one track: one track per channel
  const sounding = tracks.filter(t => t.events.some(e => e.type === 'on')), chs = [...new Set(sounding.flatMap(t => t.events.filter(e => e.type === 'on').map(e => e.ch)))].sort((a, b) => a - b);
  if (sounding.length === 1 && chs.length > 1)
    tracks = chs.map(c => ({ name: `${sounding[0].name} ch${c + 1}`.trim(), events: sounding[0].events.filter(e => e.ch === c) }));
  return { tpb, tracks, tempos };
}

// Time of a tick in beats of the first tempo: after a tempo change the notes still fall at their real times.
export function beatsAt(mid, tick) {
  let us = 0, [last, tempo] = mid.tempos[0]; const first = tempo;
  for (const [t, next] of mid.tempos.slice(1)) { if (t >= tick) break; us += (t - last) * tempo; last = t; tempo = next; }
  return Math.round((us + (tick - last) * tempo) / first / mid.tpb * 1e9) / 1e9;
}

export function trackList(mid) {
  return mid.tracks.map((tr, i) => {
    const on = tr.events.filter(e => e.type === 'on');
    if (!on.length) return null;
    const ps = on.map(e => e.note);
    return { track: i, name: tr.name, notes: on.length, low: Math.min(...ps), high: Math.max(...ps), channel: on[0].ch };
  }).filter(Boolean);
}

// (bpm, [[midi, startBeats, durBeats]]) for one track, monophonic (highest note wins)
export function melody(mid, track) {
  const on = new Map(), notes = [];
  for (const e of mid.tracks[track].events) {
    if (e.type === 'on') on.set(e.note, e.time);
    else if (e.type === 'off' && on.has(e.note)) {
      const s = on.get(e.note); on.delete(e.note);
      if (e.time > s) notes.push([e.note, beatsAt(mid, s), Math.round((beatsAt(mid, e.time) - beatsAt(mid, s)) * 1e8) / 1e8]);
    }
  }
  notes.sort((a, b) => a[1] - b[1] || b[0] - a[0]);
  const mono = [];
  for (const n of notes) {
    const last = mono[mono.length - 1];
    if (last && Math.abs(last[1] - n[1]) < 1e-6) continue;
    if (last && last[1] + last[2] > n[1]) mono[mono.length - 1] = [last[0], last[1], n[1] - last[1]];
    mono.push(n);
  }
  return { bpm: 60000000 / mid.tempos[0][1], notes: mono, tempoChanges: mid.tempos.slice(1).filter((t, i) => t[1] !== mid.tempos[i][1]).length };
}

// ---------------------------------------------------------------- lyrics
export function heldVowel(syl) {
  const c = syl.replace(/っ+$/, '').slice(-1) || 'あ';
  return c === 'ん' ? 'ん' : vowelOf(c);
}
// one lyric line (kana, spaces allowed) -> units that each need a note (っ rides on the mora before)
export function lineUnits(kana) {
  const h = kataToHira(kana), syl = [];
  for (const c of h) {
    if (SMALL.includes(c) && syl.length) syl[syl.length - 1] += c;
    else if (c === 'ー' && syl.length) syl.push('-');
    else if (c >= 'ぁ' && c <= 'ゖ') syl.push(c);
  }
  const out = [];
  for (const s of syl) {
    if (s === 'っ' && out.length) out[out.length - 1] += 'っ';
    else if (s === '-' && out.length) out.push(heldVowel(out[out.length - 1]));
    else out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- alignment
export function phrases(notes, gap = .5) {
  const out = [[notes[0]]];
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1], b = notes[i];
    if (b[1] - (a[1] + a[2]) >= gap) out.push([]);
    out[out.length - 1].push(b);
  }
  return out;
}

export function fit(units, notes, unit = .25) {
  notes = notes.map(n => [...n]);
  while (notes.length < units.length) {
    let i = 0; for (let k = 1; k < notes.length; k++) if (notes[k][2] > notes[i][2]) i = k;
    const [p, s, d] = notes[i];
    if (d < 2 * unit - 1e-6) break;
    notes.splice(i, 1, [p, s, d / 2], [p, s + d / 2, d / 2]);
  }
  while (notes.length > units.length && units.length > 0) {
    const same = [];
    for (let k = 0; k < notes.length - 1; k++)
      if (notes[k][0] === notes[k + 1][0] && Math.abs(notes[k][1] + notes[k][2] - notes[k + 1][1]) < 1e-6) same.push(k);
    if (!same.length) break;
    let k = same[0]; for (const c of same) if (notes[c][2] + notes[c + 1][2] < notes[k][2] + notes[k + 1][2]) k = c;
    const [p, s, d] = notes[k];
    notes.splice(k, 2, [p, s, d + notes[k + 1][2]]);
  }
  units = [...units];
  while (units.length > notes.length) {
    let i = 0;
    for (let k = 1; k < units.length - 1; k++) if (units[k].length + units[k + 1].length < units[i].length + units[i + 1].length) i = k;
    units.splice(i, 2, units[i] + units[i + 1]);
  }
  const out = []; let k = 0;
  notes.forEach(([p, s, d], j) => {
    const target = units.length ? pyRound((j + 1) * units.length / notes.length) : 0;
    let lyric;
    if (k < target) lyric = units[k++];
    else lyric = out.length ? heldVowel(out[out.length - 1][0]) : 'あ';
    out.push([lyric, p, s, d]);
  });
  return out;
}

// A line that starts with "@<beat>" begins at the first note from that beat on; the rest is aligned freely between pins.
export function alignLines(notes, lines, gap = .5, unit = .25) {
  const parts = [];
  lines.forEach((l, i) => {
    const m = /^@([\d.]+)\s*(.*)$/.exec(l), at = m ? +m[1] : -Infinity;
    if (m && i && at <= parts[parts.length - 1].at) throw new Error(`${i + 1}번째 줄의 @${m[1]}은 앞의 고정 위치보다 뒤여야 합니다`);
    if (m || !i) parts.push({ at, lines: [m ? m[2] : l] }); else parts[parts.length - 1].lines.push(l);
  });
  const out = [], info = { phrases: 0, lines: lines.length, groups: 0, cost: 0, sung_notes: 0 };
  parts.forEach((p, k) => {
    const end = parts[k + 1]?.at ?? Infinity, mine = notes.filter(n => n[1] >= p.at - 1e-6 && n[1] < end - 1e-6);
    if (!mine.length) throw new Error(`@${p.at} 이후에는 멜로디가 없습니다`);
    const r = alignFree(mine, p.lines, gap, unit);
    out.push(...r.sung);
    for (const key of ['phrases', 'groups', 'cost', 'sung_notes']) info[key] += r.info[key];
  });
  return { sung: out, info };
}

function alignFree(notes, lines, gap = .5, unit = .25) {
  const ph = phrases(notes, gap), units = lines.map(lineUnits);
  const slots = ph.map(p => p.reduce((a, n) => a + Math.max(1, pyRound(n[2] / unit)), 0));
  const L = units.length, P = ph.length, INF = Infinity;
  const best = Array.from({ length: L + 1 }, () => Array(P + 1).fill(INF));
  const back = Array.from({ length: L + 1 }, () => Array(P + 1).fill(null));
  best[0][0] = 0;
  for (let i = 0; i <= L; i++) for (let j = 0; j <= P; j++) {
    const c0 = best[i][j];
    if (c0 === INF) continue;
    if (j < P) { const c = c0 + .6 * ph[j].length; if (c < best[i][j + 1]) { best[i][j + 1] = c; back[i][j + 1] = [i, j, 'skip']; } }
    for (let k = 1; k <= 12 && i + k <= L; k++) {
      let n = 0; for (let q = i; q < i + k; q++) n += units[q].length;
      for (let m = 1; m <= 4 && j + m <= P; m++) {
        let nn = 0, cap = 0; for (let q = j; q < j + m; q++) { nn += ph[q].length; cap += slots[q]; }
        const cost = 2 * Math.max(0, n - cap) + .5 * Math.max(0, nn - n) + .3 * (k + m - 2);
        if (c0 + cost < best[i + k][j + m]) { best[i + k][j + m] = c0 + cost; back[i + k][j + m] = [i, j, 'map']; }
      }
    }
  }
  let jEnd = 0, bestEnd = INF;
  for (let j = 0; j <= P; j++) {
    let rest = 0; for (let q = j; q < P; q++) rest += ph[q].length;
    const c = best[L][j] + .6 * rest; if (c < bestEnd) { bestEnd = c; jEnd = j; }
  }
  const groups = []; let i = L, j = jEnd;
  while (i !== 0 || j !== 0) {
    const [pi, pj, kind] = back[i][j];
    if (kind === 'map') groups.push([pi, i, pj, j]);
    i = pi; j = pj;
  }
  groups.reverse();
  const out = [];
  for (const [li, lj, pi, pj] of groups)
    out.push(...fit(units.slice(li, lj).flat(), ph.slice(pi, pj).flat(), unit));
  return { sung: out, info: { phrases: P, lines: L, groups: groups.length, cost: Math.round(best[L][jEnd] * 10) / 10, sung_notes: out.length } };
}

// score notes for the page, starting at the first sung note (start 0: the song's intro is kept, so the render lines
// up with the original); rests keep their length unless maxRest is given
export function toNotes(sung, maxRest = Infinity, start = null) {
  const out = []; let t = start ?? (sung.length ? sung[0][2] : 0);
  for (const [lyric, p, s, d] of sung) {
    if (s - t > .01) out.push({ lyric: '', midi: null, beats: Math.min(s - t, maxRest) });
    out.push({ lyric, midi: p, beats: Math.round(d * 1000) / 1000 });
    t = s + d;
  }
  return out;
}
export function scoreText(sung, maxRest = 2) {         // same text as midi_cover.web_score
  const lines = []; let t = sung.length ? sung[0][2] : 0;
  for (const [lyric, p, s, d] of sung) {
    if (s - t > .01) lines.push(`- 0 ${pyG(Math.min(s - t, maxRest))}`);
    lines.push(`${lyric} ${noteName(p)} ${pyG(Math.round(d * 1000) / 1000)}`);
    t = s + d;
  }
  return lines.join('\n') + '\n';
}
