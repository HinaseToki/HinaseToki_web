// Lyric video of the song just sung, made in the browser: Toki's lavender page, the line being sung
// on a highlight that fills note by note (karaoke wipe), its Korean reading and an optional
// translation underneath, a piano roll running past a playhead, and a short title card at both ends.
// Same look as ai/tools/lyric_video.py. Encoded to MP4 with WebCodecs (faster than real time);
// browsers without it record the canvas live with MediaRecorder instead.
import { library } from './cdn.js';
import { morae } from './kana.js';

const LEAD = 0.3;          // silence before the first note in synth.sing's output
const INTRO = 2.5, OUTRO = 2.0;
const WIPE_LEAD = 0.1;     // a mora is heard from its consonant, a little before the note
const C = {
  top: '#f6f5ff', bottom: '#e8e7fb', band: ['#5458d6', '#8b6adb', '#5458d6'], progress: '#d6d1ff',
  box: '#fdfdff', boxSung: '#6e68d8', text: '#2d2b55', textSung: '#ffffff',
  read: '#a6a3de', readSung: '#5d50c8', trans: '#7870be', title: '#8a88b8', sub: '#a9a7cf',
  bokeh: ['140,140,240', '166,139,232', '127,163,240'], note: '#c3bef5', noteSung: '#6e68d8',
};
const JA = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif';
const KO = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';

// ---------------------------------------------------------------- lines and timing
// The score -> lines of sung notes with their times in the audio (s). A rest of a beat or more ends
// a line (as in synth.sing); a line longer than maxUnits notes is cut where the notes leave the
// longest gap, so it fits on screen.
export function songLines(notes, tempo, maxUnits = 16) {
  const beat = 60 / (Math.min(400, Math.max(20, +tempo || 110)));
  const raw = []; let cur = null, t = LEAD;
  for (const n of notes) {
    const sec = Math.max(1 / 64, +n.beats || 1) * beat;
    if (n.midi == null) { if (sec >= beat - 1e-6 && cur) { raw.push(cur); cur = null; } }
    else (cur ??= []).push({ text: String(n.lyric ?? '').trim(), t0: t, t1: t + sec, midi: n.midi });
    t += sec;
  }
  if (cur) raw.push(cur);
  const cut = u => {
    if (u.length <= maxUnits) return [u];
    let at = u.length >> 1, best = -1;
    for (let i = Math.ceil(u.length * .3); i <= Math.floor(u.length * .7); i++) {
      const gap = u[i].t0 - u[i - 1].t0;
      if (gap > best + 1e-6) { best = gap; at = i; }
    }
    return [...cut(u.slice(0, at)), ...cut(u.slice(at))];
  };
  const lines = raw.flatMap(cut).map(units => ({ units, t0: units[0].t0, t1: units[units.length - 1].t1, read: readings(units) }));
  // on screen from a little before the first note until the next line comes (or a while after)
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    l.show = Math.min(l.t0, Math.max(l.t0 - .6, prev ? prev.t1 : -1e9));
  });
  lines.forEach((l, i) => { l.hide = lines[i + 1] ? Math.min(l.t1 + 1.2, lines[i + 1].show) : l.t1 + 1.6; });
  return lines;
}

// ---------------------------------------------------------------- kana -> hangul reading
// Same rules as hangul_reading in ai/tools/lyric_video.py; one piece per note, ん/っ close the
// syllable before them (ㄴ / ㅅ).
const CHO = { '': 11, k: 15, g: 0, s: 9, z: 12, t: 16, d: 3, n: 2, h: 18, b: 7, p: 17, m: 6, r: 5, ch: 14, j: 12, ts: 14, f: 18 };
const JUNG = { a: 0, i: 20, u: 13, e: 5, o: 8, ya: 2, yu: 17, yo: 12, wa: 9, eu: 18, we: 15, wi: 16, wo: 14 };
const ROWS = { '': 'あいうえお', k: 'かきくけこ', g: 'がぎぐげご', s: 'さしすせそ', z: 'ざじずぜぞ', t: 'たちつてと', d: 'だぢづでど',
  n: 'なにぬねの', h: 'はひふへほ', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ', m: 'まみむめも', r: 'らりるれろ' };
const KANA = {};
for (const [c, row] of Object.entries(ROWS)) [...row].forEach((k, i) => { KANA[k] = [c, 'aiueo'[i]]; });
Object.assign(KANA, { し: ['s', 'i'], じ: ['j', 'i'], ぢ: ['j', 'i'], ち: ['ch', 'i'], す: ['s', 'eu'], ず: ['z', 'eu'], づ: ['z', 'eu'],
  つ: ['ts', 'eu'], ふ: ['f', 'u'], や: ['', 'ya'], ゆ: ['', 'yu'], よ: ['', 'yo'], わ: ['', 'wa'], を: ['', 'o'] });
const SMALL = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' }, SMALL_V = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
const syl = (c, v) => String.fromCharCode(0xAC00 + (CHO[c] * 21 + JUNG[v]) * 28);

function mora(m) {
  const head = m[0], tail = m.slice(1);
  if (!KANA[head]) return m;
  let [c, v] = KANA[head];
  if (SMALL[tail]) {                                   // きゃ しゃ ちゃ じゃ
    v = SMALL[tail];
    if (['ch', 'j', 'ts'].includes(c)) v = { ya: 'a', yu: 'u', yo: 'o' }[v];
  } else if (SMALL_V[tail]) {                          // ふぁ てぃ でぃ
    v = SMALL_V[tail];
    if (c === 'f') { c = 'h'; v = { a: 'wa', i: 'wi', e: 'we', o: 'wo', u: 'u' }[v]; }
  }
  return syl(c, v);
}
function readings(units) {
  const out = units.map(() => '');
  const close = (i, m) => {                            // add ㄴ / ㅅ to the last open syllable
    const s = out[i], ch = s.charCodeAt(s.length - 1);
    if (!(ch >= 0xAC00 && ch <= 0xD7A3) || (ch - 0xAC00) % 28) return false;
    out[i] = s.slice(0, -1) + String.fromCharCode(ch + (m === 'ん' ? 4 : 19));
    return true;
  };
  units.forEach((u, i) => {
    for (const m of morae(u.text)) {
      if (m === 'ん' || m === 'っ') {
        if (!(out[i] && close(i, m)) && !(!out[i] && i > 0 && close(i - 1, m))) out[i] += m === 'ん' ? '응' : '';
      } else out[i] += mora(m);
    }
  });
  return out;
}

// ---------------------------------------------------------------- drawing
const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

class Scene {
  constructor(canvas, { lines, duration, title, subtitle, shown, translation }) {
    Object.assign(this, { canvas, lines, duration, title, subtitle, shown, translation });
    this.x = canvas.getContext('2d', { alpha: false });
    this.W = canvas.width; this.H = canvas.height; this.S = this.H / 1080;
    this.total = INTRO + duration + OUTRO;
    const all = lines.flatMap(l => l.units);
    this.notes = all;
    this.lo = Math.min(...all.map(u => u.midi)) - 2; this.hi = Math.max(...all.map(u => u.midi)) + 2;
    // background and soft lights: drawn once, the lights only move
    const bg = document.createElement('canvas'); bg.width = this.W; bg.height = this.H;
    const b = bg.getContext('2d'), g = b.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, C.top); g.addColorStop(1, C.bottom); b.fillStyle = g; b.fillRect(0, 0, this.W, this.H);
    this.bg = bg;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.lights = Array.from({ length: 9 }, (_, i) => ({ x: rnd(), y: rnd(), r: .12 + rnd() * .18, sp: .03 + rnd() * .05,
      ph: rnd() * 6.28, col: C.bokeh[i % 3], a: .10 + rnd() * .10 }));
    this.roll = document.createElement('canvas'); this.roll.width = this.W; this.roll.height = Math.round(150 * this.S);
    this.fit = new Map();
  }

  draw(t) {
    const { x, W, H, S } = this, a = t - INTRO;
    x.globalAlpha = 1; x.drawImage(this.bg, 0, 0);
    for (const l of this.lights) {                     // slowly drifting soft lights
      const cx = (l.x + .06 * Math.sin(t * l.sp * 6 + l.ph)) * W, cy = (l.y + .05 * Math.cos(t * l.sp * 5 + l.ph)) * H, r = l.r * H * 1.6;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${l.col},${l.a})`); g.addColorStop(1, `rgba(${l.col},0)`);
      x.fillStyle = g; x.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    }
    const ui = ease((t - INTRO + .5) / .7) * (1 - ease((t - (this.total - OUTRO) - .2) / .7));
    const card = 1 - ease((t - INTRO + .9) / .8) + ease((t - (this.total - OUTRO) + .1) / .8);
    if (card > .001) this.titleCard(Math.min(1, card), t);
    if (ui > .001) { x.globalAlpha = ui; this.main(a); }
    x.globalAlpha = 1;
  }

  logo(cx, cy, r) {
    const { x } = this, k = r / 50;
    const g = x.createLinearGradient(cx - r, cy - r, cx + r, cy + .2 * r);
    g.addColorStop(0, '#4e54de'); g.addColorStop(1, '#9e64e8');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
    x.strokeStyle = '#fff'; x.lineWidth = 5.8 * k; x.beginPath(); x.arc(cx, cy, 33 * k, 0, 7); x.stroke();
    x.fillStyle = '#fff'; x.beginPath(); x.arc(cx, cy - 24 * k, 2.6 * k, 0, 7); x.fill();
    for (const [bx, h] of [[34.5, 12], [43, 23], [51.5, 36], [60, 26], [68.5, 15]]) {
      x.beginPath(); x.roundRect(cx + (bx - 50) * k, cy - h / 2 * k, 5.6 * k, h * k, 2.8 * k); x.fill();
    }
  }

  titleCard(alpha, t) {
    const { x, W, H, S } = this, rise = (1 - alpha) * 18 * S;
    x.globalAlpha = alpha;
    this.logo(W / 2, H * .40 + rise, 70 * S);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const title = this.title || '히나세 토키';
    x.fillStyle = C.text; x.font = `600 ${this.fitSize(title, 64, `${JA}`, W * .8, '600')}px ${JA}`;
    x.fillText(title, W / 2, H * .40 + 130 * S + rise);
    if (this.subtitle) { x.fillStyle = C.title; x.font = `${30 * S}px ${KO}`; x.fillText(this.subtitle, W / 2, H * .40 + 195 * S + rise); }
    x.textAlign = 'left'; x.globalAlpha = 1;
  }

  fitSize(text, size, family, width, weight = '') {       // font size (px) so the text fits the width
    const key = text + '|' + size + '|' + width;
    if (this.fit.has(key)) return this.fit.get(key);
    let s = size * this.S;
    this.x.font = `${weight} ${s}px ${family}`;
    const w = this.x.measureText(text).width;
    if (w > width) s *= width / w;
    this.fit.set(key, s);
    return s;
  }

  main(a) {
    const { x, W, H, S } = this, base = x.globalAlpha;
    // title in the corner
    x.textBaseline = 'alphabetic';
    if (this.title) { x.fillStyle = C.title; x.font = `600 ${30 * S}px ${JA}`; x.fillText(this.title, 72 * S, 92 * S); }
    if (this.subtitle) { x.fillStyle = C.sub; x.font = `${24 * S}px ${KO}`; x.fillText(this.subtitle, 72 * S, (this.title ? 130 : 92) * S); }
    // the blue-violet band; its lower edge is the song's progress
    const cy = H * .43, bh = 190 * S;
    const g = x.createLinearGradient(0, 0, W, 0);
    C.band.forEach((c, i) => g.addColorStop(i / (C.band.length - 1), c));
    x.fillStyle = g; x.globalAlpha = base * .92; x.fillRect(0, cy - bh / 2, W, bh);
    x.globalAlpha = base; x.fillStyle = C.progress;
    x.fillRect(0, cy + bh / 2 - 6 * S, W * Math.min(1, Math.max(0, a / this.duration)), 6 * S);
    // the line being sung
    const i = this.lines.findIndex(l => a >= l.show && a < l.hide);
    if (i >= 0) {
      const l = this.lines[i];
      const fin = Math.min(.2, l.t0 - l.show), fade = (fin > .01 ? ease((a - l.show) / fin) : 1) * (1 - ease((a - (l.hide - .25)) / .25));
      x.globalAlpha = base * fade;
      this.line(l, i, a, cy - 4 * S + (1 - fade) * 10 * S);
    }
    x.globalAlpha = base;
    this.pianoRoll(a);
  }

  line(l, i, a, cy) {
    const { x, W, S } = this;
    const own = this.shown?.[i];                        // the user's own text for this line, if given
    const pieces = own ? [own] : l.units.map(u => u.text);
    const text = pieces.join('');
    const size = this.fitSize(text, 70, JA, W - 300 * S, '600');
    x.font = `600 ${size}px ${JA}`;
    const widths = pieces.map(p => x.measureText(p).width), tw = widths.reduce((s, w) => s + w, 0);
    // how far the fill has come: whole notes sung, plus the part of the one being sung
    const prog = l.units.map(u => Math.min(1, Math.max(0, (a + WIPE_LEAD - u.t0) / Math.max(.05, u.t1 - u.t0))));
    let fill;
    if (own) fill = prog.reduce((s, p) => s + p, 0) / prog.length * tw;
    else fill = widths.reduce((s, w, k) => s + w * prog[k], 0);
    const padX = 40 * S, boxH = size + 50 * S, bw = tw + 2 * padX, bx = (W - bw) / 2, by = cy - boxH / 2;
    const tx = bx + padX, ty = cy + size * .36;
    x.fillStyle = C.box; x.beginPath(); x.roundRect(bx, by, bw, boxH, 14 * S); x.fill();
    x.fillStyle = C.text; x.fillText(text, tx, ty);
    if (fill > 0) {
      x.save(); x.beginPath(); x.rect(bx, by - 2, padX + fill + (fill >= tw - .5 ? padX : 0), boxH + 4); x.clip();
      x.fillStyle = C.boxSung; x.beginPath(); x.roundRect(bx, by, bw, boxH, 14 * S); x.fill();
      x.fillStyle = C.textSung; x.fillText(text, tx, ty); x.restore();
    }
    // Korean reading below the band, filling with the same notes
    const rsize = this.fitSize(l.read.join(''), 36, KO, W - 300 * S);
    x.font = `${rsize}px ${KO}`;
    const rw = l.read.map(r => x.measureText(r).width), rt = rw.reduce((s, w) => s + w, 0);
    let rx = (W - rt) / 2; const ry = cy + 95 * S + 58 * S;
    l.read.forEach((r, k) => {
      if (!r) return;
      x.fillStyle = C.read; x.fillText(r, rx, ry);
      if (prog[k] > 0) {
        x.save(); x.beginPath(); x.rect(rx, ry - rsize, rw[k] * prog[k], rsize * 1.4); x.clip();
        x.fillStyle = C.readSung; x.fillText(r, rx, ry); x.restore();
      }
      rx += rw[k];
    });
    const tr = this.translation?.[i];
    if (tr) {
      x.fillStyle = C.trans; x.font = `${this.fitSize(tr, 32, KO, W - 300 * S)}px ${KO}`;
      x.textAlign = 'center'; x.fillText(tr, W / 2, ry + 56 * S); x.textAlign = 'left';
    }
  }

  pianoRoll(a) {
    const { x, W, H, S } = this, r = this.roll, rx = r.getContext('2d'), rh = r.height;
    const pps = 230 * S, head = W * .3, row = (rh - 20 * S) / (this.hi - this.lo + 1);
    rx.globalCompositeOperation = 'source-over'; rx.clearRect(0, 0, W, rh);
    for (const n of this.notes) {
      const x0 = head + (n.t0 - a) * pps, w = Math.max(4 * S, (n.t1 - n.t0) * pps - 3 * S);
      if (x0 > W || x0 + w < 0) continue;
      rx.fillStyle = a + WIPE_LEAD >= n.t0 ? C.noteSung : C.note;
      const th = Math.min(16 * S, Math.max(9 * S, row * .8));
      rx.beginPath(); rx.roundRect(x0, 10 * S + (this.hi - n.midi + .5) * row - th / 2, w, th, th / 2); rx.fill();
    }
    rx.fillStyle = C.boxSung; rx.fillRect(head - 1.5 * S, 0, 3 * S, rh);
    rx.globalCompositeOperation = 'destination-in';  // fade out at both sides
    const g = rx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.12, '#000'); g.addColorStop(.85, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
    rx.fillStyle = g; rx.fillRect(0, 0, W, rh);
    x.drawImage(r, 0, H - rh - 60 * S);
  }
}

// ---------------------------------------------------------------- encoding
const abortError = () => new DOMException('멈췄어요', 'AbortError');
const tick = () => new Promise(r => setTimeout(r));

// The song's channels (the mix with the backing when there is one) with the title cards' silence around them.
export const soundOf = song => song.mix ?? [song.audio];
export const padded = (channels, sr) => channels.map(audio => {
  const pcm = new Float32Array(Math.round((INTRO + OUTRO) * sr) + audio.length);
  pcm.set(audio, Math.round(INTRO * sr));
  return pcm;
});
function resample(pcm, from, to) {
  if (from === to) return pcm;
  const out = new Float32Array(Math.floor(pcm.length * to / from)), k = from / to;
  for (let i = 0; i < out.length; i++) {
    const p = i * k, j = Math.floor(p), f = p - j;
    out[i] = pcm[j] * (1 - f) + (pcm[j + 1] ?? 0) * f;
  }
  return out;
}

async function withWebCodecs(scene, pcm, sr, fps, { onProgress, signal }) {
  const { W, H } = scene;
  const video = { codec: H > 720 ? 'avc1.640028' : 'avc1.64001f', width: W, height: H, bitrate: H > 720 ? 10e6 : 6e6, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(video)).supported) return null;
  let audio = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: pcm.length, bitrate: 192000 }, kind = 'aac';
  if (!(await AudioEncoder.isConfigSupported(audio)).supported) {
    audio = { codec: 'opus', sampleRate: 48000, numberOfChannels: pcm.length, bitrate: 160000 }; kind = 'opus';
    if (!(await AudioEncoder.isConfigSupported(audio)).supported) return null;
    pcm = pcm.map(c => resample(c, sr, 48000)); sr = 48000;
  }
  const { Muxer, ArrayBufferTarget } = await library('muxer');
  const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width: W, height: H, frameRate: fps }, audio: { codec: kind, numberOfChannels: pcm.length, sampleRate: sr } });
  let failed = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { failed = e; } });
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { failed = e; } });
  try {
    venc.configure(video); aenc.configure(audio);
    for (let i = 0; i < pcm[0].length; i += 4096) {
      const n = Math.min(4096, pcm[0].length - i), d = new Float32Array(n * pcm.length);
      pcm.forEach((c, k) => d.set(c.subarray(i, i + n), k * n));
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfChannels: pcm.length, numberOfFrames: n,
        timestamp: Math.round(i / sr * 1e6), data: d });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush();
    const frames = Math.ceil(scene.total * fps);
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw abortError();
      if (failed) throw failed;
      scene.draw(i / fps);
      const f = new VideoFrame(scene.canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(f, { keyFrame: i % (fps * 2) === 0 }); f.close();
      while (venc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 2));
      if (i % 10 === 0) { onProgress?.(i / frames); await tick(); }
    }
    await venc.flush();
    if (failed) throw failed;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
  } finally {
    for (const e of [venc, aenc]) if (e.state !== 'closed') e.close();
  }
}

// Fallback: play the song and record the canvas as it is drawn (takes as long as the video).
async function withRecorder(scene, pcm, sr, fps, { onProgress, signal }) {
  const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    .find(t => window.MediaRecorder?.isTypeSupported(t));
  if (!type) throw new Error('이 브라우저는 영상을 만들 수 없어요. 최신 Chrome이나 Safari에서 열어 주세요');
  const ctx = new AudioContext({ sampleRate: sr });
  const buf = ctx.createBuffer(pcm.length, pcm[0].length, sr); pcm.forEach((c, k) => buf.copyToChannel(c, k));
  const src = ctx.createBufferSource(), dest = ctx.createMediaStreamDestination();
  src.buffer = buf; src.connect(dest);
  const stream = new MediaStream([...scene.canvas.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: scene.H > 720 ? 10e6 : 6e6 });
  const parts = []; rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  scene.draw(0); rec.start(1000);
  const t0 = ctx.currentTime + .15; src.start(t0);
  try {
    await new Promise((resolve, reject) => {
      const step = () => {
        if (signal?.aborted) return reject(abortError());
        const t = Math.max(0, ctx.currentTime - t0);
        scene.draw(t); onProgress?.(t / scene.total);
        if (t >= scene.total) resolve(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  } finally { rec.stop(); src.stop(); await done; ctx.close(); }
  return { blob: new Blob(parts, { type }), ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

// song: {audio, sampleRate, notes, tempo} from the last synth.sing; shown / translation: one entry
// per line (or empty); height 720 or 1080.
export async function makeVideo(canvas, song, { title = '', subtitle = '', shown = null, translation = null,
  height = 1080, fps = 30, onProgress, signal } = {}) {
  const lines = songLines(song.notes, song.tempo);
  if (!lines.length) throw new Error('부른 음표가 없어요');
  canvas.height = height; canvas.width = Math.round(height * 16 / 9 / 2) * 2;
  const scene = new Scene(canvas, { lines, duration: soundOf(song)[0].length / song.sampleRate, title, subtitle, shown, translation });
  const pcm = padded(soundOf(song), song.sampleRate);
  if (window.VideoEncoder && window.AudioEncoder) {
    const r = await withWebCodecs(scene, pcm, song.sampleRate, fps, { onProgress, signal });
    if (r) return r;
  }
  return withRecorder(scene, pcm, song.sampleRate, fps, { onProgress, signal });
}

// One still frame (for the preview before making the video).
export function previewFrame(canvas, song, opts = {}, at = null) {
  const lines = songLines(song.notes, song.tempo);
  if (!lines.length) return;
  canvas.height = 540; canvas.width = 960;
  const scene = new Scene(canvas, { lines, duration: soundOf(song)[0].length / song.sampleRate, ...opts });
  scene.draw(INTRO + (at ?? (lines[0].t0 + Math.min(1, (lines[0].t1 - lines[0].t0) / 2))));
}
