// The synthesiser behind a message port (a worker, so the page never freezes while she sings).
// in:  {id, type: 'load', base?} (base: the voice's models folder; another one replaces the voice) | {id, type: 'sing', notes, options} | {id, type: 'abort'}
// out: {id, progress} | {id, stage} | {id, result} | {id, error: {name, message}}
import { EXPRESSION } from './phrase.js';

const CONTROL = { gen: 'gender', ten: 'tension' };
const controls = s => EXPRESSION.filter(k => CONTROL[k] && s.sessions?.acoustic?.inputNames?.includes(CONTROL[k]));

export function serve(port, makeSynth) {
  let synth = null, voice; const jobs = new Map(), post = (m, t) => port.postMessage(m, t ?? []);
  port.onmessage = async ({ data: { id, type, ...d } }) => {
    if (type === 'abort') { jobs.get(id)?.abort(); return; }
    const job = new AbortController(); jobs.set(id, job);
    try {
      if (type === 'load' && synth && d.base !== voice) synth = null;     // another voice: only one in memory
      if (type === 'load') voice = d.base;
      synth ??= await makeSynth(voice);
      if (type === 'load') {
        await synth.load((p, key) => post({ id, progress: p, key }));
        post({ id, result: { controls: controls(synth) } });
      } else {
        const r = await synth.sing(d.notes, { ...d.options, signal: job.signal, onStage: (s, p) => post({ id, stage: s, at: p }) });
        post({ id, result: { ...r, phrases: r.phrases.map(({ pitch, ...p }) => p) } }, [r.audio.buffer]);
      }
    } catch (e) { post({ id, error: { name: e.name, message: e.message } }); }
    jobs.delete(id);
  };
}
