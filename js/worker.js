import { loadOrt } from './cdn.js';
import { serve } from './service.js';
import { Synth } from './synth.js';

// base: the voice's models folder, relative to the page (models/ is the default voice)
serve(self, async base => { globalThis.ort = await loadOrt(); return new Synth(new URL(base ?? 'models/', new URL('../', import.meta.url)).href); });
