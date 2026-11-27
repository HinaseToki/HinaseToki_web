// How a score is sung, without the models: the same rules as ai/render/engine.py (tests/test_web.py runs both
// on the same inputs). Notes: {lyric ('' rest, 'AP' breath), midi|null, beats, expr?: {vib, cents, scoop, fall, dyn, br, gen, ten}}.

export const SR = 44100, HOP = 512, FT = HOP / SR;
export const PAD = 0.3;                       // silence around each phrase in its own pass
export const VOWELS = new Set(['a', 'i', 'u', 'e', 'o', 'N', 'cl', 'wa', 'ya', 'yo', 'yu', 'wi', 'we', 'wo', 'ye', 'AP', 'SP']);
const SUNG = new Set([...VOWELS].filter(v => !['cl', 'AP', 'SP'].includes(v)));
const MIN_DUR = { N: .07, cl: .05, n: .045, m: .045, k: .035, g: .035, t: .035, d: .035, p: .035, b: .035, ch: .04, ts: .04, s: .05, sh: .05 };
const MIN_CONS = .025, MAX_CONS = .16, MIN_VOWEL = .04;
export const EXPRESSION = ['vib', 'cents', 'scoop', 'fall', 'dyn', 'br', 'gen', 'ten'];

const rint = x => { const f = Math.floor(x), d = x - f; return d < .5 ? f : d > .5 ? f + 1 : f % 2 ? f + 1 : f; };   // halves to even
const median = a => { const s = Array.from(a).sort((x, y) => x - y), n = s.length; return n ? (s[(n - 1) >> 1] + s[n >> 1]) / 2 : NaN; };
const clip = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------------------------------------------------------- score
export const breathLen = s => s >= .25 ? Math.min(.35, .6 * s) : 0;

function trim(notes) {
  const out = notes.filter(n => n.beats > 1e-6);
  while (out.length && out[out.length - 1].midi == null) out.pop();
  return out;
}

function cut(start, notes, beat, maxSeconds) {
  const length = notes.reduce((a, n) => a + n.beats, 0) * beat, rests = [];
  let t = 0, sung = false;
  notes.forEach((n, i) => {
    if (n.midi == null && n.lyric === '' && i > 0 && i < notes.length - 1 && sung) rests.push([i, t]);
    if (n.midi != null) sung = true;
    t += n.beats;
  });
  if (length <= maxSeconds || !rests.length) return [{ start, notes: trim(notes) }];
  const [i, at] = rests.reduce((b, r) => Math.abs(r[1] * beat - length / 2) < Math.abs(b[1] * beat - length / 2) ? r : b);
  return [...cut(start, notes.slice(0, i), beat, maxSeconds), ...cut(start + at + notes[i].beats, notes.slice(i + 1), beat, maxSeconds)];
}

// {phrases: [{start (beats), notes}], beats}
export function phrases(notes, beat, split = 1, maxSeconds = 12) {
  const out = []; let t = 0, cur = [], start = 0, before = 10;
  for (const n of notes) {
    const last = cur[cur.length - 1];
    if (n.midi == null) {
      if (n.beats >= split) { if (cur.length) out.push([start, cur]); cur = []; before = n.beats * beat; }
      else if (cur.length) cur.push({ lyric: '', midi: null, beats: n.beats, expr: {} });
      else before += n.beats * beat;
    } else {
      if (!cur.length) {
        const ap = breathLen(before); start = t - ap / beat;
        if (ap) cur.push({ lyric: 'AP', midi: null, beats: ap / beat, expr: {} });
      } else if (last.midi == null && last.lyric === '') {
        const ap = breathLen(last.beats * beat);
        if (ap) { last.beats -= ap / beat; cur.push({ lyric: 'AP', midi: null, beats: ap / beat, expr: {} }); }
      }
      cur.push({ lyric: n.lyric, midi: n.midi, beats: n.beats, expr: { ...n.expr } });
    }
    t += n.beats;
  }
  if (cur.length) out.push([start, cur]);
  return { phrases: out.flatMap(([s, ns]) => cut(s, ns, beat, maxSeconds)).filter(p => p.notes.some(n => n.midi != null)), beats: t };
}

// rests take the pitch of the next sung note (or the last one, at the end)
export function fillRests(mids) {
  const out = [...mids];
  for (let i = out.length - 2; i >= 0; i--) out[i] ??= out[i + 1];
  return out.map((m, i, a) => { if (m == null) a[i] = i ? a[i - 1] : 60; return a[i]; });
}

// ---------------------------------------------------------------- durations
export function frameCounts(seconds) {
  let t = 0, prev = 0;
  return seconds.map(s => { t += s; const e = rint(t / FT), n = Math.max(1, e - prev); prev = e; return n; });
}

export function scaleDurations(pred, frames) {
  const p = Array.from(pred, v => Math.max(v, 1e-3)), sum = p.reduce((a, b) => a + b, 0);
  let acc = 0, prev = 0;
  const d = p.map(v => { acc += v; const c = rint(acc / sum * frames), n = c - prev; prev = c; return n; });
  while (frames >= d.length && Math.min(...d) < 1) { d[d.indexOf(Math.min(...d))]++; d[d.indexOf(Math.max(...d))]--; }
  return d;
}

export function clampDurations(ph, durs, words) {
  const f = s => Math.max(1, rint(s / FT)), d = [...durs]; let i = 0;
  for (const w of words) {
    const head = VOWELS.has(ph[i]) ? i : null;
    for (let j = i; j < i + w.length; j++) {
      if (j === head || (VOWELS.has(ph[j]) && !(ph[j] in MIN_DUR))) continue;
      const lo = f(Math.max(MIN_CONS, MIN_DUR[ph[j]] ?? 0)), hi = VOWELS.has(ph[j]) ? Infinity : f(MAX_CONS);
      const want = Math.min(hi, Math.max(lo, d[j]));
      if (head == null) { d[j] = want; continue; }
      const delta = Math.min(want - d[j], Math.max(0, d[head] - f(MIN_VOWEL)));
      d[j] += delta; d[head] -= delta;
    }
    if (head != null && ph[head] === 'N') {
      let need = f(MIN_DUR.N) - d[head];
      for (let j = i + w.length - 1; need > 0 && j > head; j--) {
        const take = Math.min(need, Math.max(0, d[j] - 1));
        d[j] -= take; d[head] += take; need -= take;
      }
    }
    i += w.length;
  }
  return d;
}

// ---------------------------------------------------------------- pitch (MIDI units per frame)
export function centerNotes(curve, frames, mids, limit = .35, edge = 4) {
  const p = Float32Array.from(curve); let pos = 0;
  frames.forEach((n, i) => {
    const a = pos; pos += n;
    if (mids[i] == null || n < 6) return;
    const off = median(p.slice(a + Math.floor(n / 4), a + n - Math.floor(n / 6))) - mids[i];
    if (!(Math.abs(off) > limit)) return;
    const k = Math.min(edge, Math.floor(n / 3));
    const ramp = (j, up) => k > 1 ? (up ? .3 + .7 * j / (k - 1) : 1 - .7 * j / (k - 1)) : up ? .3 : 1;
    for (let j = 0; j < n; j++) p[a + j] -= off * (j < k ? ramp(j, true) : 1) * (j >= n - k ? ramp(j - (n - k), false) : 1);
  });
  return p;
}

export function addVibrato(curve, frames, notes, depth = .13, minLen = .62) {
  const p = Float32Array.from(curve); let pos = 0;
  frames.forEach((n, i) => {
    const a = pos; pos += n;
    const want = notes[i].expr?.vib;
    if (notes[i].midi == null || want === 0 || (want == null && n * FT < minLen)) return;
    if (want == null) {
      const core = Array.from(p.slice(a + Math.floor(.25 / FT), a + n - 6));
      if (core.length < 20) return;
      const k = Math.min(41, (core.length >> 1) * 2 - 1), h = k >> 1;
      const q = core.map((c, j) => { let s = 0; for (let m = -h; m <= h; m++) s += core[clip(j + m, 0, core.length - 1)]; return c - s / k; });
      const mean = q.reduce((x, y) => x + y, 0) / q.length;
      if (Math.sqrt(q.reduce((x, y) => x + (y - mean) ** 2, 0) / q.length) >= .09) return;
    }
    const late = Math.min(.28, n * FT * .3), rate = 5.3 + .25 * Math.sin(a), amt = want ?? depth;
    for (let j = 0; j < n; j++) {
      const t = j * FT;
      p[a + j] += amt * clip((t - late) / .35, 0, 1) * clip((n * FT - t) / .12, 0, 1) * Math.sin(2 * Math.PI * rate * (t - late));
    }
  });
  return p;
}

export function shapePitch(curve, frames, notes) {
  const p = Float32Array.from(curve), ease = x => (1 - clip(x, 0, 1)) ** 2; let pos = 0;
  frames.forEach((n, i) => {
    const a = pos, e = notes[i].expr ?? {}; pos += n;
    if (notes[i].midi == null || !('cents' in e || 'scoop' in e || 'fall' in e)) return;
    for (let j = 0; j < n; j++) {
      const t = j * FT;
      p[a + j] += (e.cents ?? 0) / 100 - (e.scoop ?? 0) * ease(t / Math.min(.16, n * FT / 2)) - (e.fall ?? 0) * ease((n * FT - FT - t) / Math.min(.2, n * FT / 2));
    }
  });
  return p;
}

// ---------------------------------------------------------------- voice curves
export function floorVowels(ph, durs, voicing, below = 4) {
  const v = Float32Array.from(voicing), spans = []; let pos = 0;
  ph.forEach((p, i) => { if (SUNG.has(p)) spans.push([pos, pos + durs[i]]); pos += durs[i]; });
  if (!spans.length) return v;
  const low = median(spans.flatMap(([a, b]) => Array.from(v.slice(a, b)))) - below;
  for (const [a, b] of spans) for (let j = a; j < b; j++) v[j] = Math.max(v[j], low);
  return v;
}

export function noteCurve(frames, notes, key, ramp = 4) {
  const v = frames.flatMap((n, i) => Array(n).fill(+(notes[i].expr?.[key] ?? 0)));
  if (!v.some(x => x)) return Float32Array.from(v);
  return Float32Array.from(v, (_, j) => { let s = 0; for (let m = -ramp; m <= ramp; m++) s += v[clip(j + m, 0, v.length - 1)]; return s / (2 * ramp + 1); });
}

export function dynamicsGain(frames, notes) {
  const db = noteCurve(frames, notes, 'dyn'), n = db.length, out = new Float32Array(n * HOP);
  for (let i = 0; i < out.length; i++) {
    const x = clip(i / HOP - .5, 0, n - 1), k = Math.min(n - 1, Math.floor(x)), w = x - k;
    out[i] = 10 ** ((db[k] * (1 - w) + db[Math.min(n - 1, k + 1)] * w) / 20);
  }
  return out;
}

export function gate(wave, ph, durs) {
  const wav = Float32Array.from(wave), at = f => f * HOP, lin = (x, a, b, n) => n > 1 ? a + (b - a) * x / (n - 1) : a;
  let pos = 0;
  ph.forEach((p, i) => {
    const a = at(pos), b = Math.min(wav.length, at(pos + durs[i])); pos += durs[i];
    if (p === 'SP' && i === 0) {
      const f = Math.min(Math.floor(.03 * SR), b);
      for (let j = 0; j < b; j++) wav[j] *= j < b - f ? 0 : lin(j - (b - f), 0, 1, f);
    } else if (p === 'SP' && i === ph.length - 1) {
      const s = a + Math.floor(.18 * SR), f = Math.min(Math.floor(.08 * SR), Math.max(0, wav.length - s));
      for (let j = s; j < wav.length; j++) wav[j] *= j < s + f ? lin(j - s, 1, 0, f) : 0;
    } else if (p === 'SP') {
      const s = a + Math.floor(.15 * SR), e = b - Math.floor(.06 * SR), f = Math.floor(.04 * SR);
      if (e - s > Math.floor(.1 * SR)) for (let j = s; j < e; j++) wav[j] *= j < s + f ? lin(j - s, 1, .08, f) : j >= e - f ? lin(j - (e - f), .08, 1, f) : .08;
    } else if (p === 'AP') {
      const f = Math.min(Math.floor(.03 * SR), Math.floor((b - a) / 3));
      for (let j = a; j < b; j++) wav[j] *= j >= b - f ? lin(j - (b - f), .45, 1, f) : .45;
    }
  });
  return wav;
}
