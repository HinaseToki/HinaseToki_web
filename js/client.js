// The page's side of service.js.
export class SynthClient {
  constructor(port) {
    this.port = port; this.waiting = new Map(); this.next = 1;
    port.onmessage = ({ data: m }) => {
      const w = this.waiting.get(m.id); if (!w) return;
      if ('progress' in m) w.onProgress?.(m.progress, m.key);
      else if ('stage' in m) w.onStage?.(m.stage, m.at);
      else {
        this.waiting.delete(m.id);
        if (m.error) w.no(m.error.name === 'AbortError' ? new DOMException(m.error.message, 'AbortError') : new Error(m.error.message)); else w.yes(m.result);
      }
    };
    port.onerror = e => { for (const w of this.waiting.values()) w.no(new Error(e.message || '작업자를 시작하지 못했어요')); this.waiting.clear(); };
  }
  call(message, on = {}, signal) {
    const id = this.next++;
    return new Promise((yes, no) => {
      this.waiting.set(id, { yes, no, ...on });
      signal?.addEventListener('abort', () => this.port.postMessage({ id, type: 'abort' }), { once: true });
      this.port.postMessage({ id, ...message });
    });
  }
  load(onProgress, base) { return this.call({ type: 'load', base }, { onProgress }); }
  sing(notes, { onStage, signal, ...options } = {}) { return this.call({ type: 'sing', notes, options }, { onStage }, signal); }
}
