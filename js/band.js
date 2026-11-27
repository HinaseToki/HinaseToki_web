// A live band's weight under the backing, from the song's MIDI (as ai/cover/band_mix.band_layers): two
// power-chord guitars panned apart (muted eighths where the song is quiet, held chords where it is loud), a soft
// string bed, a sub bass, kick and snare, a crash and a tom fill into each louder section, a hall. They follow
// the chords read from the MIDI (a triad whose third is unclear is played without it) and stay out of the
// voice's 2-4 kHz. Guitars, drums, crashes and fills play only in bars where the MIDI's own drums play; guitars
// and sub follow the bass where it walks off the root; a strings tone a semitone from a sung note is left out;
// every bar stays 3 dB under the backing. The reading of the MIDI and the backing (chords, segments, energy,
// sectionStarts, midiParts, followBass, clearOf, underBand) is the same as Python's (tests/test_web.py); the
// sound is made by the browser's own oscillators and filters.
import { beatsAt } from './midi.js';

export const SHAPES = { maj: [0, 4, 7], min: [0, 3, 7], pow: [0, 7] };
const clip = (x, a, b) => Math.min(b, Math.max(a, x));
const percentile = (xs, q) => {                        // numpy's linear percentile
  const s = Float64Array.from(xs).sort(), h = (s.length - 1) * q / 100, lo = Math.floor(h);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (h - lo);
};
const median = xs => percentile(xs, 50);

// [start beat, beats, note, velocity] of every track but the melody and the drums (name or channel 10)
export function bandNotes(mid, melodyTrack) {
  const out = [];
  mid.tracks.forEach((tr, i) => {
    if (i === melodyTrack || /drum/i.test(tr.name ?? '')) return;
    const on = new Map();
    for (const e of tr.events) {
      if (e.type === 'on' && e.ch !== 9) on.set(e.note, [e.time, e.vel ?? 100]);
      else if ((e.type === 'off' || e.type === 'on') && on.has(e.note)) {
        const [s, v] = on.get(e.note); on.delete(e.note);
        out.push([beatsAt(mid, s), beatsAt(mid, e.time) - beatsAt(mid, s), e.note, v]);
      }
    }
  });
  return out;
}

// per beat: [root pitch class, 'maj'|'min'|'pow'] of the triad that fits best (bass counts double), or null
export function chords(notes, nBeats) {
  const w = Array.from({ length: nBeats }, () => new Float64Array(12)), low = new Array(nBeats).fill(200);
  for (const [s, d, n, v] of notes)
    for (let b = Math.floor(s); b < Math.min(nBeats, Math.ceil(s + d)); b++) {
      const over = Math.min(b + 1, s + d) - Math.max(b, s);
      if (over > 0) { w[b][n % 12] += over * v; low[b] = Math.min(low[b], n); }
    }
  const out = [];
  for (let b = 0; b < nBeats; b++) {
    const total = w[b].reduce((x, y) => x + y, 0);
    if (total === 0) { out.push(null); continue; }
    const wb = Float64Array.from(w[b]);
    if (low[b] < 200) wb[low[b] % 12] *= 2;
    const fit = (r, shape) => {
      let a = 0, o = 0;
      for (const i of shape) a += wb[(r + i) % 12];
      for (let i = 0; i < 12; i++) if (!shape.includes(i)) o += wb[(r + i) % 12];
      return a - .5 * o;
    };
    let best = null;
    for (let r = 0; r < 12; r++) for (const q of ['maj', 'min']) {
      const f = fit(r, SHAPES[q]), c = [f, r, q];
      if (!best || f > best[0] || (f === best[0] && (r > best[1] || (r === best[1] && q > best[2])))) best = c;
    }
    const sum = wb.reduce((x, y) => x + y, 0), other = fit(best[1], SHAPES[best[2] === 'maj' ? 'min' : 'maj']);
    const third = wb[(best[1] + (best[2] === 'maj' ? 4 : 3)) % 12];
    const sure = best[0] - other > .25 * Math.max(1e-9, sum) && third > .1 * sum;
    out.push([best[1], sure ? best[2] : 'pow']);
  }
  for (let b = 1; b < nBeats; b++) if (out[b] == null && out[b - 1] != null && w[b].some(x => x > 0)) out[b] = out[b - 1];
  return out;
}

const same = (a, b) => a === b || (a && b && a.length === b.length && a.every((x, i) => x === b[i]));

// per beat: whether the MIDI's own drums play in that bar (4 beats); per beat the bass's lowest pitch class
// (null where it rests; a track named bass or on a bass program); the melody's [start beat, beats, note]
export function midiParts(mid, melodyTrack, nBeats) {
  const drums = new Array(nBeats).fill(false), bass = new Array(nBeats).fill(null), melody = [];
  mid.tracks.forEach((tr, i) => {
    const prog = tr.events.find(e => e.type === 'program')?.program ?? -1;
    const isDrum = /drum/i.test(tr.name ?? '') || tr.events.some(e => e.type === 'on' && e.ch === 9);
    const isBass = /bass/i.test(tr.name ?? '') || (prog >= 32 && prog <= 39);
    const on = new Map(), low = new Map();
    for (const e of tr.events) {
      if (e.type === 'on') {
        on.set(e.note, e.time);
        const b = Math.floor(beatsAt(mid, e.time));
        if (isDrum && b < nBeats) for (let k = Math.floor(b / 4) * 4; k < Math.min(nBeats, Math.floor(b / 4) * 4 + 4); k++) drums[k] = true;
      } else if (e.type === 'off' && on.has(e.note)) {
        const s = beatsAt(mid, on.get(e.note)), d = beatsAt(mid, e.time) - s; on.delete(e.note);
        if (i === melodyTrack) melody.push([s, d, e.note]);
        else if (isBass && !isDrum)
          for (let b = Math.floor(s); b < Math.min(nBeats, Math.ceil(s + d)); b++)
            if (Math.min(b + 1, s + d) - Math.max(b, s) >= .25) low.set(b, Math.min(low.get(b) ?? 200, e.note));
      }
    }
    for (const [b, n] of low) if (bass[b] == null) bass[b] = n % 12;
  });
  return { drums, bass, melody };
}

// per beat [root, quality, low]: the chord over the bass's own note where the bass is off the root
export const followBass = (ch, bass) => ch.map((c, b) => c == null ? null : [c[0], c[1], bass[b] ?? c[0]]);

// the chord tones no sung note (half a beat or longer, inside beats b0..b1) sits a semitone from
export function clearOf(tones, melody, b0, b1) {
  const sung = new Set(melody.filter(([s, d]) => d >= .5 && s < b1 && s + d > b0).map(m => m[2] % 12));
  const keep = tones.filter(m => ![...sung].some(x => [1, 11].includes((((m - x) % 12) + 12) % 12)));
  return keep.length ? keep : tones.slice(0, 1);
}

// a gain per sample that keeps the layers `under` dB below the backing in every bar (eased over 50 ms)
export function underBand(layers, L, R, bar, sr = 44100, under = 3) {
  const total = layers[0].length, n = Math.floor(bar * sr), g = new Float32Array(total).fill(1);
  const rms2 = (chs, a, b) => { let s = 0, c = 0; for (const x of chs) for (let i = a; i < b; i++) { s += (x[i] ?? 0) ** 2; c++; } return Math.sqrt(s / c) + 1e-9; };
  for (let a = 0; a < total; a += n) {
    const b = Math.min(total, a + n), v = Math.min(1, rms2([L, R], a, b) * 10 ** (-under / 20) / rms2(layers, a, b));
    g.fill(v, a, b);
  }
  const h = 1102, out = new Float32Array(total); let s = 0;
  const at = i => g[clip(i, 0, total - 1)];
  for (let i = -h; i <= h; i++) s += at(i);
  for (let i = 0; i < total; i++) { out[i] = s / (2 * h + 1); s += at(i + h + 1) - at(i - h); }
  return out;
}
// [first beat, beats, chord] of each run of beats on one chord
export function segments(ch) {
  const out = [];
  for (let b = 0; b < ch.length;) {
    if (ch[b] == null) { b++; continue; }
    let e = b;
    while (e + 1 < ch.length && same(ch[e + 1], ch[b])) e++;
    out.push([b, e - b + 1, ch[b]]); b = e + 1;
  }
  return out;
}

const dbOf = (L, R, a, n) => { let s = 0; for (let i = a; i < a + n; i++) { const m = (L[i] ?? 0) + (R[i] ?? 0); s += m * m; } return 20 * Math.log10(Math.sqrt(s / n) + 1e-6); };

// 0..1 per beat: how loud the band is over the surrounding bar
export function energy(L, R, beat, nBeats, sr = 44100) {
  const n = Math.floor(beat * sr), db = Array.from({ length: nBeats }, (_, b) => dbOf(L, R, b * n, n));
  const sm = db.map((_, i) => [i + 1, i, i - 1, i - 2].reduce((s, j) => s + (j >= 0 && j < nBeats ? db[j] : 0), 0) / 4);
  const loud = sm.filter(x => x > -60), [lo, hi] = loud.length ? [percentile(loud, 20), percentile(loud, 85)] : [-60, 0];
  return sm.map(x => clip((x - lo) / Math.max(1e-6, hi - lo), 0, 1));
}

// bar starts (seconds) where the band gets louder by riseDb than over the bars before (a new section)
export function sectionStarts(L, R, bar, sr = 44100, riseDb = 3, gapBars = 8) {
  const n = Math.floor(bar * sr), bars = Math.floor(Math.min(L.length, R.length) / n);
  const db = Array.from({ length: bars }, (_, i) => dbOf(L, R, i * n, n)), p40 = bars ? percentile(db, 40) : 0, out = [];
  let last = -gapBars;
  for (let i = 4; i < bars; i++)
    if (db[i] > median(db.slice(i - 4, i)) + riseDb && db[i] > p40 && i - last >= gapBars) { out.push(i * bar); last = i; }
  return out;
}

const hz = m => 440 * 2 ** ((m - 69) / 12);
function noise(ctx, sec, seed = 1) {
  const b = ctx.createBuffer(1, Math.ceil(sec * ctx.sampleRate), ctx.sampleRate), d = b.getChannelData(0);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < d.length; i++) { x = (x * 1664525 + 1013904223) >>> 0; d[i] = x / 2147483648 - 1; }
  return b;
}
function hall(ctx, sec = 2.8, decay = 2.2) {
  const n = Math.ceil(sec * ctx.sampleRate), pre = Math.floor(.025 * ctx.sampleRate), b = ctx.createBuffer(2, n + pre, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c), src = noise(ctx, sec, 5 + c).getChannelData(0); let e = 0, lp = 0;
    for (let i = 0; i < n; i++) { lp += .55 * (src[i] * Math.exp(-i / ctx.sampleRate * decay) - lp); d[pre + i] = lp; e += lp * lp; }
    for (let i = 0; i < d.length; i++) d[i] /= Math.sqrt(e);
  }
  return b;
}
const chain = (_ctx, ...nodes) => { nodes.reduce((a, b) => (a.connect(b), b)); return nodes[nodes.length - 1]; };
function bq(ctx, type, f, gain = 0, Q = Math.SQRT1_2) {
  const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.gain.value = gain; x.Q.value = Q; return x;
}

// The layers (two Float32Arrays, `total` samples) for a backing [L, R] whose time 0 is the MIDI's beat 0.
export async function bandLayers(mid, melodyTrack, backing, { amount = 2.5, sr = 44100, under = 3 } = {}) {
  const [L, R = L] = backing, total = L.length, beat = mid.tempos[0][1] / 1e6, nBeats = Math.floor(total / sr / beat) + 1;
  const { drums, bass, melody } = midiParts(mid, melodyTrack, nBeats);
  const ch = followBass(chords(bandNotes(mid, melodyTrack), nBeats), bass), en = energy(L, R, beat, nBeats, sr);
  const ctx = new OfflineAudioContext(2, total, sr), out = ctx.createGain(); out.gain.value = amount; out.connect(ctx.destination);
  const bus = (gain, ...filters) => { const g = ctx.createGain(); g.gain.value = gain; chain(ctx, ...filters, g, out); return filters[0]; };
  const notch = () => bq(ctx, 'peaking', 2800, -5, .7);
  const verb = ctx.createConvolver(); verb.normalize = false; verb.buffer = hall(ctx); bus(.06 * .35, verb);
  const gtr = bus(.05, bq(ctx, 'highpass', 100), bq(ctx, 'lowpass', 5000), notch()), pad = bus(.012, bq(ctx, 'highpass', 200), notch());
  const sub = bus(.05, bq(ctx, 'lowpass', 110)), drm = bus(.07, ctx.createGain());
  const toVerb = ctx.createGain(); toVerb.connect(verb);
  const drive = Float32Array.from({ length: 2049 }, (_, i) => Math.tanh(3.5 * (i / 1024 - 1)));   // tanh(3.5 y / 3) of three saws
  const S = 1.6;                                    // a band-limited saw of sin(kx)/k peaks near 1.6
  const voice = (f, det, t0, dur, dest, gain, pan = 0, attack = .01, release = .05) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = 'sawtooth'; o.frequency.value = f * (1 + det); p.pan.value = pan;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + Math.min(attack, dur / 2));
    g.gain.setValueAtTime(gain, Math.max(t0 + Math.min(attack, dur / 2), t0 + dur - release)); g.gain.linearRampToValueAtTime(0, t0 + dur);
    chain(ctx, o, g, p, dest); o.start(t0); o.stop(t0 + dur + .01);
    return g;
  };
  for (const [b0, nb, [r, q, low]] of segments(ch)) {
    const root = 40 + (((low - 4) % 12) + 12) % 12, t0 = b0 * beat, dur = Math.min(nb * beat, total / sr - t0);
    if (dur <= 0) continue;
    const e = en.slice(b0, b0 + nb).reduce((a, x) => a + x, 0) / Math.min(nb, en.length - b0), g = .35 + .65 * e;
    const drumsIn = drums.slice(b0, b0 + nb).some(Boolean);
    if (drumsIn) for (const [det, pan] of [[0, .75], [.004, -.75]]) {      // two guitar players, panned apart, only with the drums
      const amp = ctx.createGain(), dist = ctx.createWaveShaper(), p = ctx.createStereoPanner();
      dist.curve = drive; p.pan.value = pan; amp.gain.value = 1;
      const pre = ctx.createGain(); pre.gain.value = S / 3;
      for (const m of [root, root + 7, root + 12]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m) * (1 + det);
        o.connect(pre); o.start(t0); o.stop(t0 + dur + .01);
      }
      chain(ctx, pre, dist, amp, p); p.connect(gtr); p.connect(toVerb);
      const a = amp.gain; a.setValueAtTime(0, t0);
      if (e > .55) for (let k = 0; k < nb && k * beat < dur; k++) a.setTargetAtTime(drums[b0 + k] ? g : 0, t0 + k * beat, .005);
      else for (let t = t0; t < t0 + dur - 1e-6; t += beat / 2) {   // muted eighths
        if (!drums[b0 + Math.floor((t - t0) / beat + 1e-6)]) continue;
        a.setValueAtTime(g, t); a.setTargetAtTime(0, t, beat / 2 / 9);
      }
      a.setValueAtTime(0, t0 + dur - .05);
      a.linearRampToValueAtTime(0, t0 + dur);
    }
    const tones = clearOf([...SHAPES[q].map(i => 60 + (r + i) % 12), 72 + r % 12], melody, b0, b0 + nb);   // none a semitone from the melody
    for (const m of tones) for (const [det, pan] of [[-.003, -1], [.003, 1]]) {    // strings, slow bow, wide
      const gnode = voice(hz(m), det, t0, dur, pad, .25 * (.3 + .7 * e) * S, pan, .35, .4);
      gnode.connect(toVerb);
    }
    const o = ctx.createOscillator(), g2 = ctx.createGain();                       // sub: the bass's note an octave down
    o.frequency.value = hz(root - 12); g2.gain.setValueAtTime(0, t0); g2.gain.linearRampToValueAtTime(.6 * e, t0 + .02);
    g2.gain.setValueAtTime(.6 * e, t0 + Math.max(.02, dur - .05)); g2.gain.linearRampToValueAtTime(0, t0 + dur);
    chain(ctx, o, g2, sub); o.start(t0); o.stop(t0 + dur + .01);
  }
  const hit = (t, gain, make, panL = 1, panR = 1) => {
    if (t < 0 || t >= total / sr) return;
    const g = ctx.createGain(), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2), gl = ctx.createGain(), gr = ctx.createGain();
    g.gain.value = gain; gl.gain.value = panL; gr.gain.value = panR; g.channelCount = 2; g.channelCountMode = 'explicit';
    make(g, t); chain(ctx, g, sp); sp.connect(gl, 0); sp.connect(gr, 1); gl.connect(mg, 0, 0); gr.connect(mg, 0, 1); mg.connect(drm);
  };
  const kick = (dest, t) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + .15);
    g.gain.setValueAtTime(1, t); g.gain.setTargetAtTime(0, t, 1 / 9);
    chain(ctx, o, g, dest); o.start(t); o.stop(t + .3);
  };
  const snareBuf = noise(ctx, .22, 3);
  const snare = (dest, t) => {
    const s = ctx.createBufferSource(), f = bq(ctx, 'bandpass', 3240, 0, .7), g = ctx.createGain(), o = ctx.createOscillator(), go = ctx.createGain();
    s.buffer = snareBuf; g.gain.setValueAtTime(.6, t); g.gain.setTargetAtTime(0, t, 1 / 20);
    o.frequency.value = 190; go.gain.setValueAtTime(.5, t); go.gain.setTargetAtTime(0, t, 1 / 30);
    chain(ctx, s, f, g, dest); chain(ctx, o, go, dest); s.start(t); o.start(t); o.stop(t + .22);
  };
  for (let b = 0; b < nBeats; b++) {
    if (ch[b] == null || !drums[b]) continue;
    if (en[b] > .55 || b % 2 === 0) hit(b * beat, b % 4 === 0 ? .8 : .6, kick);
    if (b % 2 === 1) hit(b * beat, .45 + .4 * en[b], snare);
  }
  const crashBuf = noise(ctx, 2.4, 7);
  for (const s of sectionStarts(L, R, 4 * beat, sr)) {                            // a crash and a tom fill before it
    const b = Math.round(s / beat);
    if (b >= nBeats || !drums[b] || (b >= 4 && !drums[b - 1])) continue;          // only where the MIDI's drums go on
    hit(s, .7, (dest, t) => {
      const n = ctx.createBufferSource(), f = bq(ctx, 'highpass', 4500), g = ctx.createGain();
      n.buffer = crashBuf; g.gain.setValueAtTime(1, t); g.gain.setTargetAtTime(0, t, 1 / 1.6); chain(ctx, n, f, g, dest); n.start(t);
    }, 1.1, .9);
    [[180, 1], [140, .75], [110, .5], [85, .25]].forEach(([f, off], k) => hit(s - off * beat, .5, (dest, t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * .96, t + .25);
      g.gain.setValueAtTime(1, t); g.gain.setTargetAtTime(0, t, 1 / 14); chain(ctx, o, g, dest); o.start(t); o.stop(t + .25);
    }, 1 - .3 * (k - 1.5) / 1.5, 1 + .3 * (k - 1.5) / 1.5));
  }
  const buf = await ctx.startRendering(), layers = [buf.getChannelData(0), buf.getChannelData(1)];
  const g = underBand(layers, L, R, 4 * beat, sr, under);                          // every bar under the backing
  for (const c of layers) for (let i = 0; i < c.length; i++) c[i] *= g[i];
  return layers;
}
