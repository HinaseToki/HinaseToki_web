// Playback of the score as it is edited: the melody as plain tones (or the sung take, while it still matches the
// score), a metronome, a loop, from any beat. Events are scheduled a little ahead on the audio clock.
import { barLength, pulse } from './notation.js';
import { onsets, totalBeats } from './score.js';

// the notes starting in [from, to) beats: {beat, beats, midi}
export function toneEvents(notes, from, to) {
  const o = onsets(notes);
  return notes.flatMap((n, i) => n.midi != null && o[i] >= from - 1e-9 && o[i] < to - 1e-9 ? [{ beat: o[i], beats: n.beats, midi: n.midi }] : []);
}
// metronome clicks in [from, to): {beat, accent (the first of a bar)}
export function clickEvents(sig, from, to) {
  const step = pulse(sig), bar = barLength(sig), out = [];
  for (let k = Math.ceil(from / step - 1e-9); k * step < to - 1e-9; k++) {
    const b = k * step + 0, inBar = b - Math.floor(b / bar + 1e-9) * bar;
    out.push({ beat: b, accent: inBar < 1e-6 });
  }
  return out;
}
// where playback goes after `beat`: back to the loop's start past its end, nowhere (null) past the song
export function nextBeat(beat, loop, end) {
  if (loop && beat >= loop[1] - 1e-9) return loop[0];
  return beat > end ? null : beat;
}

const AHEAD = .2;
export class Transport {
  // get(): {notes, tempo, sig, metronome, loop: [a, b] | null, song: AudioBuffer | null (with .lead seconds) }
  constructor(get, onStop = () => {}) { Object.assign(this, { get, onStop, ctx: null, timer: null, nodes: [] }); }
  get playing() { return !!this.timer; }
  // the beat being heard now
  get beat() {
    if (!this.timer) return null;
    return this.from + (this.ctx.currentTime - this.t0) * this.tempo / 60;
  }
  play(from = 0) {
    this.stop(true);
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const s = this.get();
    Object.assign(this, { from, tempo: s.tempo, t0: this.ctx.currentTime + .06, done: from, opts: s, end: totalBeats(s.notes) });
    if (s.song) {
      const src = this.ctx.createBufferSource(); src.buffer = s.song; src.connect(this.ctx.destination);
      src.start(this.t0, Math.max(0, s.song.lead + from * 60 / s.tempo)); this.nodes.push(src);
    }
    this.timer = setInterval(() => this.tick(), 25); this.tick();
  }
  stop(quiet = false) {
    clearInterval(this.timer); this.timer = null;
    for (const n of this.nodes) try { n.stop(); } catch {}
    this.nodes = [];
    if (!quiet) this.onStop();
  }
  at(beat) { return this.t0 + (beat - this.from) * 60 / this.tempo; }
  tick() {
    const s = this.opts, now = this.beat, next = nextBeat(now, s.loop, this.end + .25);
    if (next == null) { this.stop(); return; }
    if (next !== now) { this.play(next); return; }
    const until = Math.min(s.loop ? s.loop[1] : Infinity, now + AHEAD * this.tempo / 60);
    if (until <= this.done) return;
    if (!s.song) for (const e of toneEvents(s.notes, this.done, until)) this.tone(e.midi, this.at(e.beat), e.beats * 60 / this.tempo);
    if (s.metronome) for (const c of clickEvents(s.sig, this.done, until)) this.click(this.at(c.beat), c.accent);
    this.done = until;
    this.nodes = this.nodes.filter(n => !n.ended);
  }
  tone(midi, start, dur) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    start = Math.max(start, c.currentTime);
    g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(.18, start + .015);
    g.gain.setValueAtTime(.18, start + Math.max(.02, dur * .88)); g.gain.linearRampToValueAtTime(0, start + Math.max(.03, dur * .98));
    o.connect(g).connect(c.destination); o.start(start); o.stop(start + dur);
    o.onended = () => { o.ended = true; }; this.nodes.push(o);
  }
  click(start, accent) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    start = Math.max(start, c.currentTime);
    g.gain.setValueAtTime(accent ? .35 : .22, start); g.gain.exponentialRampToValueAtTime(.001, start + .05);
    o.connect(g).connect(c.destination); o.start(start); o.stop(start + .06);
    o.onended = () => { o.ended = true; }; this.nodes.push(o);
  }
}
