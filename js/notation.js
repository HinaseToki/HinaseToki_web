// The score as sheet music: bars of a time signature, note values (dotted, triplets), ties over barlines,
// pitches spelt in a key with the accidentals a bar needs. Shared by the staff view and the MusicXML export.
export const SIGS = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [3, 8], [9, 8], [12, 8], [2, 2]];
export const barLength = ([n, d]) => n * 4 / d;                        // in quarter beats
const EPS = 1e-6;

// where a beat falls: bar 1.., beat 1.. (in the signature's own unit)
export function barBeat(beat, sig) {
  const len = barLength(sig), bar = Math.floor(beat / len + EPS);
  return { bar: bar + 1, beat: Math.max(0, beat - bar * len) / (4 / sig[1]) + 1 };
}
// what the metronome counts: dotted quarters in 6/8, 9/8, 12/8
export const pulse = ([n, d]) => d === 8 && n % 3 === 0 && n > 3 ? 1.5 : 4 / d;

// ---------------------------------------------------------------- note values
const PLAIN = [[4, 'whole', 0], [3, 'half', 1], [2, 'half', 0], [1.5, 'quarter', 1], [1, 'quarter', 0], [.75, 'eighth', 1], [.5, 'eighth', 0],
  [.375, '16th', 1], [.25, '16th', 0], [.1875, '32nd', 1], [.125, '32nd', 0]];
const TRIPLET = [[4 / 3, 'half'], [2 / 3, 'quarter'], [1 / 3, 'eighth'], [1 / 6, '16th'], [1 / 12, '32nd']];
const multiple = (x, u) => Math.abs(x / u - Math.round(x / u)) < 1e-4;
export const FLAGS = { whole: 0, half: 0, quarter: 0, eighth: 1, '16th': 2, '32nd': 3 };

// A length in note values: [{beats, type, dots, tuplet}]; lengths no value can write are rounded to 32nds.
export function values(beats) {
  const out = [];
  if (!multiple(beats, 1 / 8) && multiple(beats, 1 / 12)) {
    let left = beats;
    while (left > EPS) { const v = TRIPLET.find(([b]) => b <= left + EPS) ?? TRIPLET.at(-1); out.push({ beats: v[0], type: v[1], dots: 0, tuplet: 3 }); left -= v[0]; }
    return out;
  }
  let left = Math.max(1 / 8, Math.round(beats * 8) / 8);
  while (left > EPS) { const v = PLAIN.find(([b]) => b <= left + EPS) ?? PLAIN.at(-1); out.push({ beats: v[0], type: v[1], dots: v[2], tuplet: 0 }); left -= v[0]; }
  if (Math.abs(left) > EPS || out.length && Math.abs(out.reduce((a, p) => a + p.beats, 0) - beats) > 1e-4) out.at(-1).approx = true;
  return out;
}

// Bars of pieces: {index (-1: filler rest), beat, beats, rest, type, dots, tuplet, tieStart, tieStop, first}.
// A note crossing a barline is tied; the last bar is filled with rests; pieces keep the exact lengths of the notes.
export function measures(notes, sig) {
  const len = barLength(sig), bars = [], at = b => (bars[b] ??= { start: b * len, pieces: [] });
  let t = 0;
  const lay = (index, from, beats, rest) => {
    let o = from; const end = from + beats, parts = [];
    while (end - o > EPS) {
      const bar = Math.floor(o / len + EPS), stop = Math.min(end, (bar + 1) * len), segment = stop - o;
      const vs = values(segment), scale = segment / vs.reduce((a, v) => a + v.beats, 0);
      let p = o;
      for (const v of vs) { const piece = { index, beat: p, ...v, beats: v.beats * scale, rest }; parts.push([bar, piece]); p += piece.beats; }
      o = stop;
    }
    parts.forEach(([bar, piece], k) => {
      if (!rest) Object.assign(piece, { first: k === 0, tieStart: k < parts.length - 1, tieStop: k > 0 });
      at(bar).pieces.push(piece);
    });
  };
  notes.forEach((n, i) => { if (n.beats > EPS) lay(i, t, n.beats, n.midi == null); t += n.beats; });
  const end = Math.max(len, Math.ceil(t / len - EPS) * len);
  if (end - t > EPS) lay(-1, t, end - t, true);
  for (let b = 0; b * len < end - EPS; b++) at(b);
  return bars;
}

// ---------------------------------------------------------------- pitch spelling
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6], FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
const BY_SHARP = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
const BY_FLAT = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
export const KEYS = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
export const KEY_NAMES = { '-6': 'G♭', '-5': 'D♭', '-4': 'A♭', '-3': 'E♭', '-2': 'B♭', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F♯' };
// the key signature's alteration of a letter (0 C .. 6 B)
export const keyAlter = (letter, key) => key > 0 ? (SHARP_ORDER.indexOf(letter) < key ? 1 : 0) : key < 0 ? (FLAT_ORDER.indexOf(letter) < -key ? -1 : 0) : 0;
export const keyLetters = key => key > 0 ? SHARP_ORDER.slice(0, key) : FLAT_ORDER.slice(0, -key);

// {step (7 per octave, C-1 = 0), letter, octave, alter}; the key's own notes as it writes them, the rest by its side
export function spell(midi, key = 0) {
  const pc = ((midi % 12) + 12) % 12, oct = Math.floor(midi / 12) - 1;
  let [letter, alter] = (key < 0 ? BY_FLAT : BY_SHARP)[pc];
  for (let l = 0; l < 7; l++) {                                         // B♯/E♯/C♭/F♭ only when the key says so
    const a = keyAlter(l, key); if (a && (LETTER_PC[l] + a + 12) % 12 === pc) { letter = l; alter = a; }
  }
  const octave = oct + (LETTER_PC[letter] + alter > 11 ? -1 : LETTER_PC[letter] + alter < 0 ? 1 : 0);
  return { step: octave * 7 + letter, letter, octave, alter };
}
export const stepMidi = (step, key = 0) => { const letter = ((step % 7) + 7) % 7, octave = Math.floor(step / 7); return (octave + 1) * 12 + LETTER_PC[letter] + keyAlter(letter, key); };

// the accidental each piece shows (null: none; 0 natural): the key, then what the bar has said so far, per staff step
export function accidentals(bar, notes, key) {
  const said = new Map();
  return bar.pieces.map(p => {
    if (p.rest) return null;
    const s = spell(notes[p.index].midi, key), now = said.has(s.step) ? said.get(s.step) : keyAlter(s.letter, key);
    if (p.tieStop) { said.set(s.step, s.alter); return null; }
    said.set(s.step, s.alter);
    return s.alter === now ? null : s.alter;
  });
}

// the letter of a key press (A-G) nearest to the pitch before it, in the key
export function nearestPitch(letter, ref, key = 0, low = 0, high = 127) {
  const pc = LETTER_PC[letter] + keyAlter(letter, key);
  let best = null;
  for (let m = pc - 12; m <= 140; m += 12) if (m >= low && m <= high && (best == null || Math.abs(m - ref) < Math.abs(best - ref))) best = m;
  return best;
}
export const LETTERS = 'cdefgab';

// ---------------------------------------------------------------- clefs
// bottom: the staff step of the lowest line (E4 for treble, G2 for bass)
export const CLEFS = { treble: { bottom: 30, sign: 'G', line: 2 }, bass: { bottom: 18, sign: 'F', line: 4 } };
const ledgers = (step, bottom) => step < bottom - 1 ? Math.floor((bottom - step) / 2) : step > bottom + 9 ? Math.floor((step - bottom - 8) / 2) : 0;
// 'treble' | 'bass' as chosen; 'auto': the clef that needs fewer ledger lines for these notes (treble when even)
export function clefOf(notes, choice = 'auto', key = 0) {
  if (CLEFS[choice]) return choice;
  const steps = notes.filter(n => n.midi != null).map(n => spell(n.midi, key).step);
  const cost = c => steps.reduce((a, s) => a + ledgers(s, CLEFS[c].bottom), 0);
  return cost('bass') < cost('treble') ? 'bass' : 'treble';
}
