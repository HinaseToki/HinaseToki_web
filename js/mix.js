// Voice and backing in one stereo song (levels in dB, offset in seconds: positive starts the backing later).
export function mixdown(voice, backing, { offset = 0, voice: vdb = 0, backing: bdb = -4, reverb = .18, sr = 44100, ceiling = .89 } = {}) {
  const shift = Math.round(offset * sr), bl = backing?.[0], br = backing?.[1] ?? bl;
  const n = Math.max(voice.length, bl ? bl.length + shift : 0), L = new Float32Array(n), R = new Float32Array(n);
  const gv = 10 ** (vdb / 20), gb = 10 ** (bdb / 20);
  for (let i = 0; i < voice.length; i++) { L[i] += gv * voice[i]; R[i] += gv * voice[i]; }
  if (reverb > 0 && bl) room(voice, L, R, gv * reverb, sr);
  if (bl) for (let i = Math.max(0, -shift); i < bl.length && i + shift < n; i++) { L[i + shift] += gb * bl[i]; R[i + shift] += gb * br[i]; }
  limit([L, R], ceiling, sr);
  return [L, R];
}

// a small room: four damped combs per side (different lengths left and right)
function room(x, L, R, gain, sr) {
  [[L, [1557, 1617, 1491, 1422]], [R, [1580, 1640, 1514, 1445]]].forEach(([out, lens]) => {
    for (const len of lens) {
      const d = new Float32Array(Math.round(len * sr / 44100)); let low = 0, k = 0;
      for (let i = 0; i < out.length; i++) {
        const y = d[k]; low = y * .6 + low * .4;
        d[k] = (x[i] ?? 0) + low * .78; k = k + 1 === d.length ? 0 : k + 1;
        out[i] += gain * .25 * y;
      }
    }
  });
}

// nothing passes the ceiling: the gain starts down 5 ms before a peak, comes back over 80 ms, both sides together
export function limit(ch, ceiling, sr) {
  const n = ch[0].length, look = Math.round(.005 * sr), rel = Math.exp(-1 / (.08 * sr)), g = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(...ch.map(c => Math.abs(c[i]))); g[i] = p > ceiling ? ceiling / p : 1; }
  let hold = 1;
  for (let i = n - 1, down = 1; i >= 0; i--) { down = Math.min(g[i], down + (1 - down) / look); g[i] = Math.min(g[i], down); }   // ahead of the peak
  for (let i = 0; i < n; i++) { hold = Math.min(g[i], 1 - (1 - hold) * rel); for (const c of ch) c[i] = Math.max(-ceiling, Math.min(ceiling, c[i] * hold)); }
}

// ---------------------------------------------------------------- the cover mix (as ai/cover/mix.py: v35's chain)
// The band shaped toward a produced mix (fixed tone bands and a 2 kHz dip where words are heard), 2 dB of
// ducking under her, a little width, one room for both, then the whole brought to a loudness with a ceiling.
export const COVER = { level: .9, reverb: .10, dip: 3, wide: 2.5, duck: 2, tone: true, loudness: -15, ceiling: -1 };
const BAND_TONE = [['lowshelf', 80, -1.2, .7], ['peak', 180, -2.6, .9], ['peak', 1300, 1.8, .7], ['highshelf', 6500, 1.5, .7]];

// RBJ cookbook section, normalised: {b0, b1, b2, a1, a2}
export function biquad(kind, f, gain, q, sr) {
  const a = 10 ** (gain / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  let b, d;
  if (kind === 'peak') { b = [1 + al * a, -2 * c, 1 - al * a]; d = [1 + al / a, -2 * c, 1 - al / a]; }
  else if (kind === 'lowshelf' || kind === 'highshelf') {
    const sq = 2 * Math.sqrt(a) * al, g = kind === 'lowshelf' ? 1 : -1;
    b = [a * ((a + 1) - g * (a - 1) * c + sq), g * 2 * a * ((a - 1) - g * (a + 1) * c), a * ((a + 1) - g * (a - 1) * c - sq)];
    d = [(a + 1) + g * (a - 1) * c + sq, -g * 2 * ((a - 1) + g * (a + 1) * c), (a + 1) + g * (a - 1) * c - sq];
  } else if (kind === 'highpass') { b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]; d = [1 + al, -2 * c, 1 - al]; }
  else throw new Error(`unknown filter ${kind}`);
  return { b0: b[0] / d[0], b1: b[1] / d[0], b2: b[2] / d[0], a1: d[1] / d[0], a2: d[2] / d[0] };
}

// the sections one after another (transposed direct form II), on a copy
export function filter(x, sections) {
  const y = Float32Array.from(x);
  for (const { b0, b1, b2, a1, a2 } of sections) {
    let z1 = 0, z2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i], o = b0 * v + z1; z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o; }
  }
  return y;
}

// BS.1770's two K-weighting filters (as ai/tools/master.py), for any sample rate
function kWeight(x, sr) {
  let f0 = 1681.974450955533, Q = .7071752369554196, k = Math.tan(Math.PI * f0 / sr), a0 = 1 + k / Q + k * k;
  const Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** .4996667741545416;
  const shelf = { b0: (Vh + Vb * k / Q + k * k) / a0, b1: 2 * (k * k - Vh) / a0, b2: (Vh - Vb * k / Q + k * k) / a0, a1: 2 * (k * k - 1) / a0, a2: (1 - k / Q + k * k) / a0 };
  f0 = 38.13547087602444; Q = .5003270373238773; k = Math.tan(Math.PI * f0 / sr); a0 = 1 + k / Q + k * k;
  return filter(x, [shelf, { b0: 1, b1: -2, b2: 1, a1: 2 * (k * k - 1) / a0, a2: (1 - k / Q + k * k) / a0 }]);
}

// integrated loudness (LUFS) of the channels, gated as BS.1770: silence does not count
export function loudness(ch, sr = 44100) {
  const y = ch.map(c => kWeight(c, sr).map(v => v * v)), n = Math.round(.4 * sr), hop = Math.round(.1 * sr);
  const len = Math.max(n, ch[0].length), sums = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) sums[i + 1] = sums[i] + y.reduce((s, c) => s + (c[i] ?? 0), 0);
  const blocks = [];
  for (let s = 0; s + n <= len; s += hop) blocks.push((sums[s + n] - sums[s]) / n);
  const db = p => -.691 + 10 * Math.log10(Math.max(p, 1e-20)), mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  let z = blocks.filter(p => db(p) > -70);
  if (!z.length) return -Infinity;
  const rel = db(mean(z)) - 10; z = z.filter(p => db(p) > rel);
  return db(mean(z));
}

// the band's gain: down by up to `depth` dB while she is loud (20 ms down, 250 ms back), as backing_mix.ducking
function ducking(v, depth, sr) {
  const B = 256, m = Math.floor(v.length / B), e = new Float32Array(m);
  for (let j = 0; j < m; j++) { let s = 0; for (let i = j * B; i < (j + 1) * B; i++) s += v[i] * v[i]; e[j] = Math.sqrt(s / B); }
  const live = [...e].filter(x => x > 0).sort((a, b) => a - b), top = live.length ? live[Math.floor(.95 * (live.length - 1))] : 1;
  const att = Math.exp(-B / (.02 * sr)), rel = Math.exp(-B / (.25 * sr)), floor = 1 - 10 ** (-depth / 20), out = new Float32Array(v.length).fill(1);
  let g = 1;
  for (let j = 0; j < m; j++) {
    const t = 1 - floor * Math.min(1, e[j] / (top + 1e-9));
    g = t < g ? att * g + (1 - att) * t : rel * g + (1 - rel) * t;
    out.fill(g, j * B, (j + 1) * B);
  }
  return out;
}

const peakOf = (...ch) => { let p = 0; for (const c of ch) for (const x of c) if (Math.abs(x) > p) p = Math.abs(x); return p; };
const rmsOf = x => { let s = 0, n = 0; for (const v of x) if (Math.abs(v) > 1e-3) { s += v * v; n++; } return n ? Math.sqrt(s / n) : 1; };

// voice + band (2 channels, or null) as a cover; offset in seconds (positive: the band starts later)
export function coverMix(voice, backing, opts = {}) {
  const o = { ...COVER, offset: 0, sr: 44100, ...opts }, sr = o.sr, shift = Math.round(o.offset * sr);
  const bl0 = backing?.[0], br0 = backing?.[1] ?? bl0;
  const T = Math.max(voice.length, bl0 ? bl0.length + shift : 0);
  let v = new Float32Array(T); v.set(voice.subarray(0, T));
  v = filter(v, [biquad('highpass', 90, 0, Math.SQRT1_2, sr)]);
  const vp = Math.max(1e-9, peakOf(v)); for (let i = 0; i < T; i++) v[i] /= vp;
  const L = new Float32Array(T), R = new Float32Array(T);
  for (let i = 0; i < T; i++) { L[i] = v[i]; R[i] = v[i]; }
  if (o.reverb > 0) room(v, L, R, o.reverb, sr);
  if (bl0) {
    const place = x => { const y = new Float32Array(T); for (let i = Math.max(0, -shift); i < x.length && i + shift < T; i++) y[i + shift] = x[i]; return y; };
    const shape = [...(o.tone ? BAND_TONE : []), ...(o.dip ? [['peak', 2000, -o.dip, .6]] : [])].map(([k, f, g, q]) => biquad(k, f, g, q, sr));
    let bl = filter(place(bl0), shape), br = br0 === bl0 ? bl : filter(place(br0), shape);
    if (br === bl) br = Float32Array.from(bl);
    if (o.reverb > 0) { const wl = new Float32Array(T), wr = new Float32Array(T); room(bl.map((x, i) => (x + br[i]) / 2), wl, wr, .18, sr); for (let i = 0; i < T; i++) { bl[i] += wl[i]; br[i] += wr[i]; } }
    const mid = bl.map((x, i) => (x + br[i]) / 2), k = rmsOf(v) / rmsOf(mid) * o.level, d = o.duck ? ducking(v, o.duck, sr) : null;
    const w = 10 ** (o.wide / 20);
    for (let i = 0; i < T; i++) {
      const m = (bl[i] + br[i]) / 2, s = (bl[i] - br[i]) / 2 * w, g = k * (d ? d[i] : 1);
      L[i] += g * (m + s); R[i] += g * (m - s);
    }
  }
  const top = 10 ** (o.ceiling / 20), peak = Math.max(1e-9, peakOf(L, R));
  for (let i = 0; i < T; i++) { L[i] *= .89 / peak; R[i] *= .89 / peak; }
  let out = [L, R];
  for (let round = 0; round < 3; round++) {                   // limiting lowers the loudness a little
    const now = loudness(out, sr);
    if (!isFinite(now) || Math.abs(o.loudness - now) < .1) break;
    const g = 10 ** ((o.loudness - now) / 20);
    out = [L.map(x => x * g), R.map(x => x * g)];
    limit(out, top, sr);
  }
  return out;
}
