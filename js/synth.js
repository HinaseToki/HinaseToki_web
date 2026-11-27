// Hinase Toki singing synthesis in the browser: DiffSinger ONNX graphs run with ONNX Runtime Web (globalThis.ort).
// Pipeline: kana -> phonemes -> linguistic -> duration -> pitch -> variance -> acoustic -> vocoder.
// How a score becomes phrases, durations and curves is phrase.js (the same rules as ai/render/engine.py).
import { toHiragana } from './kana.js';
import { FT, HOP, PAD, SR, VOWELS, addVibrato, centerNotes, clampDurations, dynamicsGain, fillRests, floorVowels, frameCounts, gate, liftAttacks, noteCurve, phrases, scaleDurations, shapePitch, singLong } from './phrase.js';

export const LEAD = 0.3;                       // silence before the first note of the song
const lastVowel = ph => { const v = ph.findLast(x => VOWELS.has(x) && !['N', 'cl', 'AP', 'SP'].includes(x)); return v?.slice(-1); };
const aborted = signal => { if (signal?.aborted) throw new DOMException('중지했습니다', 'AbortError'); };

// One cache per voice and model build (manifest.version): a new model never mixes with parts of the old one,
// and that voice's old build is dropped once the new one is in use. Other voices (voices/<name>/) keep theirs.
const voiceOf = base => /(?:^|\/)voices\/([^/]+)\/?$/.exec(base ?? '')?.[1];
export const modelCache = (manifest, base) => 'toki-models-' + (voiceOf(base) ? `@${voiceOf(base)}-` : '') + (manifest.version ?? 'v1');
const sameVoice = (key, keep) => key.startsWith('toki-models-') && (key.slice(12).startsWith('@') ? key.slice(12).split('-')[0] === keep.slice(12).split('-')[0] : !keep.slice(12).startsWith('@'));
export async function fetchManifest(base = 'models/') {
  return (await fetch(base + 'manifest.json', { cache: 'no-cache' })).json();
}

export class Synth {
  constructor(base = 'models/') { this.base = base; this.sessions = {}; this.rendered = new Map(); }

  cache() { return 'caches' in self ? caches.open(modelCache(this.manifest, this.base)).catch(() => null) : null; }

  async part(part, cache) {                    // a model part, from the cache or the network (then cached)
    const url = this.base + part.name;
    let res = await cache?.match(url).catch(() => null);
    if (res) return res;
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    if (cache) await cache.put(url, res.clone()).catch(() => {});
    return res;
  }

  // Large models are split into <95 MB parts (GitHub's file limit). Only this model is held in memory.
  async fetchModel(file, onProgress) {
    const cache = await this.cache(), parts = this.manifest.files[file];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.size, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(new Uint8Array(await (await this.part(p, cache)).arrayBuffer()), o);
      o += p.size; onProgress?.(p.size);
    }
    return buf;
  }

  async createSession(bytes, providers) {
    const make = list => ort.InferenceSession.create(bytes, { executionProviders: list, logSeverityLevel: 3 });
    try { return await make(providers); } catch (e) { if (providers.length < 2) throw e; return make(['wasm']); }   // some graphs fail on WebGPU
  }

  async load(onProgress) {
    this.manifest = await fetchManifest(this.base);
    if ('caches' in self) {
      const keep = modelCache(this.manifest, this.base);
      for (const k of await caches.keys().catch(() => [])) if (k !== keep && sameVoice(k, keep)) caches.delete(k).catch?.(() => {});
    }
    this.phonemes = await (await fetch(this.base + this.manifest.phonemes)).json();
    const dict = await (await fetch(this.base + this.manifest.dictionary)).text();
    this.dict = new Map(dict.split('\n').filter(Boolean).map(l => { const [k, v] = l.split('\t'); return [k, v.trim().split(/\s+/)]; }));
    const total = Object.values(this.manifest.files).flat().reduce((n, p) => n + p.size, 0);
    let done = 0;
    ort.env.logLevel = 'error';                // ORT's placement notices are not errors
    const providers = globalThis.navigator && 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    for (const [key, file] of Object.entries(this.manifest.graphs))   // one at a time: never two models in memory twice
      this.sessions[key] = await this.createSession(await this.fetchModel(file, n => { done += n; onProgress?.(done / total, key); }), providers);
  }

  kanaToPhonemes(text, prevVowel = 'a') {
    const out = [];
    text = toHiragana(text.replace(/\s+/g, ''));
    for (let i = 0; i < text.length;) {
      const two = text.slice(i, i + 2), one = text[i];
      if (two.length === 2 && this.dict.has(two)) { out.push(...this.dict.get(two)); i += 2; continue; }
      if (this.dict.has(one)) out.push(...this.dict.get(one));
      else if (one === 'っ' || one === 'ッ') out.push('cl');
      else if (one === 'ー') out.push(lastVowel(out) ?? prevVowel);      // long vowel: repeat the last vowel
      else throw new Error(`"${one}"은(는) 읽을 수 없습니다. 가사는 히라가나, 가타카나 또는 한글 발음으로 입력해 주십시오`);
      i++;
    }
    return out;
  }

  // One phrase through the six graphs. Returns the raw (unnormalised) wave with its own margins silenced.
  async singPhrase(notes, beat, { steps, varSteps, clamp, center = .35, vibrato = true, floor = 4, signal }) {
    const T = (type, data, dims) => new ort.Tensor(type, data, dims);
    const I = a => T('int64', BigInt64Array.from(a, BigInt), [1, a.length]), N = v => T('int64', BigInt64Array.from([BigInt(v)]), []);
    const rest = { lyric: '', midi: null, beats: PAD / beat };
    const all = [rest, ...notes, rest], nf = frameCounts(all.map(n => n.beats * beat)), mids = fillRests(all.map(n => n.midi));
    // phonemes; a note's leading consonants belong to the previous word (sung before the beat)
    const words = [[]], ph = [], phNote = [];
    let prev = 'a';
    all.forEach((n, i) => {
      const p = n.lyric === 'AP' ? ['AP'] : n.lyric ? this.kanaToPhonemes(n.lyric, prev) : ['SP'];
      prev = lastVowel(p) ?? prev;
      const k = p.findIndex(x => VOWELS.has(x));
      if (k < 0) throw new Error(`"${n.lyric}"에는 모음이 없습니다`);
      if (i) { words[words.length - 1].push(...p.slice(0, k)); words.push(p.slice(k)); } else words[0].push(...p.slice(k));
      const seq = i ? p : p.slice(k);
      ph.push(...seq); phNote.push(...seq.map(() => i));
    });
    const tokens = I(ph.map(x => this.phonemes[x])), wordDiv = I(words.map(w => w.length)), wordDur = I(nf);
    const go = async (kind, feeds) => { aborted(signal); const r = await this.sessions[kind].run(feeds); aborted(signal); return r; };

    const { encoder_out: enc, x_masks: mask } = await go('linguistic', { tokens, word_div: wordDiv, word_dur: wordDur });
    const pred = (await go('dur', { encoder_out: enc, x_masks: mask, ph_midi: I(phNote.map(i => Math.round(mids[i]))), word_div: wordDiv, word_dur: wordDur })).ph_dur_pred.data;
    let durs = [], k = 0;
    words.forEach((w, j) => { durs.push(...scaleDurations(pred.slice(k, k + w.length), nf[j])); k += w.length; });
    if (clamp) durs = clampDurations(ph, durs, words);   // keep short consonants and ん audible (clearer lyrics)
    const nFr = durs.reduce((a, b) => a + b, 0), phDur = I(durs), F = a => T('float32', a, [1, nFr]);
    const base = Float32Array.from(nf.flatMap((f, i) => Array(f).fill(mids[i])));

    const pitchOut = (await go('pitch', {
      encoder_out: enc, ph_dur: phDur, note_midi: T('float32', Float32Array.from(mids), [1, mids.length]),
      note_rest: T('bool', Uint8Array.from(all, n => n.midi == null ? 1 : 0), [1, all.length]), note_dur: wordDur,
      pitch: F(base), expr: F(new Float32Array(nFr).fill(1)), retake: T('bool', new Uint8Array(nFr).fill(1), [1, nFr]), steps: N(varSteps),
    })).pitch_pred.data;
    // vibrato: 'natural' (flat starts lifted, long notes held like a singer), true (a light late vibrato), false
    const natural = vibrato === 'natural';
    let curve = centerNotes(pitchOut, nf, all.map(n => n.midi), center ?? Infinity);
    if (natural) curve = liftAttacks(curve, nf, all.map(n => n.midi));
    curve = addVibrato(curve, nf, all, undefined, vibrato && !natural ? .62 : Infinity);
    if (natural) curve = singLong(curve, nf, all);
    curve = shapePitch(curve, nf, all);

    const z = () => F(new Float32Array(nFr)), takesTension = this.sessions.variance.inputNames?.includes('tension');
    const kinds = ['energy', 'breathiness', 'voicing', ...(takesTension ? ['tension'] : [])];
    const v = await go('variance', {
      encoder_out: enc, ph_dur: phDur, pitch: F(curve), ...Object.fromEntries(kinds.map(x => [x, z()])),
      retake: T('bool', new Uint8Array(nFr * kinds.length).fill(1), [1, nFr, kinds.length]), steps: N(varSteps),
    });
    const add = (a, key) => { const c = noteCurve(nf, all, key); return Float32Array.from(a, (x, j) => x + c[j]); };
    const voicing = floor == null ? v.voicing_pred.data : floorVowels(ph, durs, v.voicing_pred.data, floor);
    const f0 = F(Float32Array.from(curve, m => 440 * 2 ** ((m - 69) / 12)));
    const has = name => this.sessions.acoustic.inputNames?.includes(name), extra = {};
    if (has('gender')) extra.gender = F(noteCurve(nf, all, 'gen'));
    if (has('velocity')) extra.velocity = F(new Float32Array(nFr).fill(1));
    if (has('energy')) extra.energy = v.energy_pred;
    if (has('tension') && v.tension_pred) extra.tension = F(add(v.tension_pred.data, 'ten'));
    const { mel } = await go('acoustic', {
      ...extra, tokens, durations: phDur, f0, breathiness: F(add(v.breathiness_pred.data, 'br')), voicing: F(voicing),
      depth: T('float32', Float32Array.from([this.manifest.depth ?? 0.6]), []), steps: N(steps),
    });
    let wav = Float32Array.from((await go('vocoder', { mel, f0 })).waveform.data);
    if (wav.some(Number.isNaN)) {              // a GPU driver gave NaN (seen with older ORT): redo on the CPU
      this.cpuVocoder ??= await this.createSession(await this.fetchModel(this.manifest.graphs.vocoder), ['wasm']);
      wav = Float32Array.from((await this.cpuVocoder.run({ mel, f0 })).waveform.data);
    }
    const g = dynamicsGain(nf, all);
    for (let j = 0; j < wav.length && j < g.length; j++) wav[j] *= g[j];
    return { wav: gate(wav, ph, durs), pitch: curve };
  }

  // The whole song, phrase by phrase, each placed at its own time. notes: [{lyric, midi, beats, expr}].
  // A phrase that did not change since the last time is not sung again; takes {phrase: n} asks for another take.
  async sing(notes, { tempo = 110, steps = 20, varSteps = 10, clamp = true, vibrato = 'natural', takes = {}, onStage, signal } = {}) {
    notes = notes.map(n => ({ lyric: String(n.lyric ?? '').trim(), midi: n.midi ?? null, beats: Math.max(1 / 64, +n.beats || 1), expr: n.expr ?? {} }));
    if (!notes.some(n => n.midi != null)) throw new Error('부를 음표가 없습니다. 음표를 하나 이상 입력해 주십시오');
    const empty = notes.findIndex(n => n.midi != null && !n.lyric);
    if (empty >= 0) throw new Error(`${empty + 1}번째 음표에 가사가 없습니다`);
    tempo = Math.min(400, Math.max(20, +tempo || 110));
    const beat = 60 / tempo, { phrases: list, beats } = phrases(notes, beat);
    const out = new Float32Array(Math.ceil((LEAD + beats * beat + 0.6) * SR)), info = [], used = new Map();
    for (let i = 0; i < list.length; i++) {
      aborted(signal);
      onStage?.(`노래 생성 중… (${i + 1}/${list.length})`, i / list.length);
      const { start, notes: ns } = list[i];
      const key = JSON.stringify([ns, beat, steps, varSteps, clamp, vibrato, takes[i] ?? 0]);
      const r = this.rendered.get(key) ?? used.get(key) ?? await this.singPhrase(ns, beat, { steps, varSteps, clamp, vibrato, signal });
      used.set(key, r); this.rendered.set(key, r);
      const at = Math.round((LEAD + start * beat - PAD) * SR);
      for (let j = Math.max(0, -at); j < r.wav.length && at + j < out.length; j++) out[at + j] += r.wav[j];
      const len = ns.reduce((a, n) => a + n.beats, 0);
      info.push({ start: start * beat, beats: [start, start + len], text: ns.map(n => n.midi == null ? '' : n.lyric).join(''), pitch: r.pitch });
    }
    this.rendered = used;                      // keep only what this song uses
    let peak = 1e-6; for (const s of out) peak = Math.max(peak, Math.abs(s));
    for (let j = 0; j < out.length; j++) out[j] = out[j] / peak * 0.9;
    onStage?.('', 1);
    return { audio: out, sampleRate: SR, phrases: info };
  }
}

export function toWav(channels, sr) {
  const ch = channels instanceof Float32Array ? [channels] : channels, n = ch[0].length, c = ch.length;
  const buf = new ArrayBuffer(44 + n * c * 2), d = new DataView(buf);
  const w = (o, s) => [...s].forEach((x, i) => d.setUint8(o + i, x.charCodeAt(0)));
  w(0, 'RIFF'); d.setUint32(4, 36 + n * c * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, c, true); d.setUint32(24, sr, true);
  d.setUint32(28, sr * c * 2, true); d.setUint16(32, c * 2, true); d.setUint16(34, 16, true); w(36, 'data');
  d.setUint32(40, n * c * 2, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) d.setInt16(44 + (i * c + k) * 2, Math.max(-1, Math.min(1, ch[k][i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}
export { FT, HOP, SR };
