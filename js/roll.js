// The piano roll: scrolls and zooms, notes are added (double click), selected (click, shift, drag over empty space),
// moved, stretched; everything also works from the keyboard. It only asks for edits: the score belongs to the page.
import { barLength, pulse } from './notation.js';
import { HIGH, LOW, addNote, moveNotes, onsets, removeNotes, resizeNote, splitNote, joinNotes, totalBeats, transpose } from './score.js';

export const ROWS = HIGH - LOW + 1, EDGE = 7;
export const rowY = (midi, v) => (HIGH - midi) * v.row;
export const midiAt = (y, v) => Math.min(HIGH, Math.max(LOW, HIGH - Math.floor(y / v.row)));
export const snap = (x, grid) => grid ? Math.round(x / grid) * grid : x;
const box = (n, o, v) => ({ x0: o * v.px - v.scroll, x1: (o + n.beats) * v.px - v.scroll, y: rowY(n.midi, v) });

export function hit(notes, x, y, v) {
  const o = onsets(notes);
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i].midi == null) continue;
    const b = box(notes[i], o[i], v);
    if (x >= b.x0 && x <= b.x1 && y >= b.y && y < b.y + v.row) return { index: i, edge: x > b.x1 - Math.min(EDGE, (b.x1 - b.x0) / 3) };
  }
  return null;
}
export function inside(notes, [xa, ya, xb, yb], v) {
  const [x0, x1] = [Math.min(xa, xb), Math.max(xa, xb)], [y0, y1] = [Math.min(ya, yb), Math.max(ya, yb)], o = onsets(notes);
  return notes.flatMap((n, i) => { if (n.midi == null) return []; const b = box(n, o[i], v); return b.x1 >= x0 && b.x0 <= x1 && b.y + v.row >= y0 && b.y <= y1 ? [i] : []; });
}

export class Roll {
  // page: {notes(), edit(notes, selection), select(set), preview(midi), lyric(index)}
  constructor(scroller, canvas, spacer, page) {
    Object.assign(this, { scroller, canvas, spacer, page, v: { px: 46, scroll: 0, row: 11 }, grid: .25, selected: new Set(), playhead: null, caret: null, inputMode: false, drag: null });
    scroller.addEventListener('scroll', () => { this.v.scroll = scroller.scrollLeft; this.draw(); });
    scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(Math.exp(-e.deltaY / 300), e.clientX - canvas.getBoundingClientRect().left); } }, { passive: false });
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; this.draw(); });
    canvas.addEventListener('dblclick', e => this.double(e));
    canvas.addEventListener('keydown', e => this.key(e));
    for (const t of ['focus', 'blur']) canvas.addEventListener(t, () => this.draw());
  }
  at(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  zoom(k, x = this.canvas.clientWidth / 2) {
    const beat = (x + this.v.scroll) / this.v.px;
    this.v.px = Math.min(240, Math.max(6, this.v.px * k)); this.layout();
    this.scroller.scrollLeft = beat * this.v.px - x; this.v.scroll = this.scroller.scrollLeft; this.draw();
  }
  fit() { this.v.px = Math.max(6, this.scroller.clientWidth / Math.max(4, totalBeats(this.page.notes()) + 1)); this.layout(); this.draw(); }
  noteBox(i) { const n = this.page.notes()[i], o = onsets(this.page.notes())[i]; this.show(o); return { x: o * this.v.px - this.v.scroll, y: rowY(n.midi, this.v) }; }
  layout() { this.spacer.style.width = Math.ceil((totalBeats(this.page.notes()) + 8) * this.v.px) + 'px'; this.v.scroll = this.scroller.scrollLeft; }
  setSelected(list) { this.selected = new Set(list); this.page.select(this.selected); this.draw(); }
  show(beat) {
    const x = beat * this.v.px - this.v.scroll, w = this.canvas.clientWidth;
    if (x < 30 || x > w - 60) { this.scroller.scrollLeft = beat * this.v.px - w * .2; this.v.scroll = this.scroller.scrollLeft; }
  }

  down(e) {
    const [x, y] = this.at(e), notes = this.page.notes(), h = hit(notes, x, y, this.v);
    this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(e.pointerId);
    if (!h && e.pointerType === 'touch') { this.drag = { kind: 'pan', cx: e.clientX, cy: e.clientY }; return; }       // a finger on empty space scrolls
    if (!h) { this.drag = { kind: 'box', x, y, to: [x, y], keep: e.shiftKey ? [...this.selected] : [] }; if (!e.shiftKey) this.setSelected([]); return; }
    if (e.shiftKey) { const s = new Set(this.selected); s.has(h.index) ? s.delete(h.index) : s.add(h.index); this.setSelected(s); return; }
    if (!this.selected.has(h.index)) this.setSelected([h.index]);
    this.drag = { kind: h.edge ? 'edge' : 'move', x, y, index: h.index, from: notes, moved: false };
    this.page.preview(notes[h.index].midi);
  }
  move(e) {
    const [x, y] = this.at(e), d = this.drag;
    if (!d) { const h = hit(this.page.notes(), x, y, this.v); this.canvas.style.cursor = h ? h.edge ? 'ew-resize' : 'grab' : 'crosshair'; return; }
    if (d.kind === 'pan') { this.scroller.scrollLeft += d.cx - e.clientX; scrollBy(0, d.cy - e.clientY); d.cx = e.clientX; d.cy = e.clientY; return; }
    if (d.kind === 'box') { d.to = [x, y]; this.selected = new Set([...d.keep, ...inside(this.page.notes(), [d.x, d.y, x, y], this.v)]); this.draw(); return; }
    if (Math.abs(x - d.x) + Math.abs(y - d.y) < 4 && !d.moved) return;
    d.moved = true;
    const beats = (x - d.x) / this.v.px;
    if (d.kind === 'edge') d.now = resizeNote(d.from, d.index, Math.max(this.grid || 1 / 32, snap(d.from[d.index].beats + beats, this.grid)));
    else {
      const k = Math.round((d.y - y) / this.v.row), picked = [...this.selected];
      if (k !== d.k) { d.k = k; this.page.preview(d.from[d.index].midi + k); }
      d.now = moveNotes(transpose(d.from, picked, k), picked, snap(beats, this.grid));
    }
    this.draw();
  }
  up() {
    const d = this.drag; this.drag = null;
    if (!d || d.kind === 'pan') return;
    if (d.kind === 'box') { if (Math.abs(d.to[0] - d.x) + Math.abs(d.to[1] - d.y) < 4) this.page.caret?.(Math.max(0, snap((d.x + this.v.scroll) / this.v.px, this.grid || .25))); this.page.select(this.selected); this.draw(); return; }
    if (d.now) this.commit(d.from, d.now);
  }
  // the selection follows its notes through an edit (counted among the sung ones)
  commit(from, now) {
    const sung = ns => ns.flatMap((n, i) => n.midi == null ? [] : [i]), a = sung(from), b = sung(now);
    this.selected = new Set(a.length === b.length ? [...this.selected].map(i => b[a.indexOf(i)]) : []);
    this.page.edit(now, this.selected);
  }
  double(e) {
    const [x, y] = this.at(e), notes = this.page.notes(), h = hit(notes, x, y, this.v);
    if (h) { this.page.lyric(h.index); return; }
    const g = this.grid || .25, beat = Math.max(0, Math.floor((x + this.v.scroll) / this.v.px / g + 1e-6) * g);
    const r = addNote(notes, beat, midiAt(y, this.v), Math.max(g, .5));
    if (r) { this.selected = new Set([r.index]); this.page.preview(midiAt(y, this.v)); this.page.edit(r.notes, this.selected); }
  }
  key(e) { editKey(this, e); }

  draw() {
    const c = this.canvas, x = c.getContext('2d'), v = this.v, W = this.scroller.clientWidth, H = ROWS * v.row, dpr = globalThis.devicePixelRatio || 1;
    if (!W) return;
    c.style.width = W + 'px'; c.style.height = H + 'px';
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.body), col = k => css.getPropertyValue(k).trim(), notes = this.drag?.now ?? this.page.notes(), o = onsets(notes);
    x.clearRect(0, 0, W, H);
    x.fillStyle = col('--line');
    for (let m = LOW; m <= HIGH; m++) if ([1, 3, 6, 8, 10].includes(m % 12)) { x.globalAlpha = .45; x.fillRect(0, rowY(m, v), W, v.row); }
    const sig = this.page.meta?.().sig ?? [4, 4], bar = barLength(sig), step = pulse(sig);
    for (let k = Math.floor(v.scroll / v.px / step); k * step * v.px - v.scroll < W; k++) {
      const b = k * step, onBar = Math.abs(b / bar - Math.round(b / bar)) < 1e-6;
      if (!onBar && step * v.px < 10) continue;
      x.globalAlpha = onBar ? 1 : .5; x.fillRect(Math.round(b * v.px - v.scroll), 0, onBar ? 1.5 : 1, H);
      if (onBar && b > 0 && bar * v.px > 26) { x.globalAlpha = 1; x.fillStyle = col('--muted'); x.font = '10px system-ui, sans-serif'; x.fillText(String(Math.round(b / bar) + 1), b * v.px - v.scroll + 3, 10); x.fillStyle = col('--line'); }
    }
    x.globalAlpha = 1; x.fillStyle = col('--muted'); x.font = '10px system-ui, sans-serif';
    for (let m = LOW; m <= HIGH; m += 12) x.fillText('C' + (m / 12 - 1), 2, rowY(m, v) + v.row - 2);
    notes.forEach((n, i) => {
      if (n.midi == null) return;
      const b = box(n, o[i], v); if (b.x1 < 0 || b.x0 > W) return;
      const w = Math.max(3, b.x1 - b.x0 - 1), picked = this.selected.has(this.drag?.now ? -1 : i) || (this.drag?.now && this.pickedInDrag(notes, i));
      x.fillStyle = col(picked ? '--accent2' : '--accent'); x.fillRect(b.x0, b.y, w, v.row);
      if (n.expr) { x.fillStyle = '#fff'; x.globalAlpha = .8; x.fillRect(b.x0 + 1, b.y + v.row - 2, Math.min(w - 2, 8), 1.5); x.globalAlpha = 1; }
      if (picked) { x.strokeStyle = col('--text'); x.lineWidth = 1.5; x.strokeRect(b.x0 + .5, b.y + .5, w - 1, v.row - 1); }
      if (w > 9) { x.fillStyle = col('--text'); x.font = '11px system-ui, sans-serif'; x.fillText(n.lyric, b.x0 + 1, b.y > 14 ? b.y - 2 : b.y + v.row + 10); }
    });
    if (this.drag?.kind === 'box') { const [a, b] = this.drag.to; x.strokeStyle = col('--accent'); x.lineWidth = 1; x.strokeRect(Math.min(a, this.drag.x), Math.min(b, this.drag.y), Math.abs(a - this.drag.x), Math.abs(b - this.drag.y)); }
    if (this.caret != null) { x.fillStyle = col('--accent'); x.globalAlpha = this.inputMode ? .9 : .5; for (let y = 0; y < H; y += 6) x.fillRect(Math.round(this.caret * v.px - v.scroll), y, this.inputMode ? 2 : 1, 3); x.globalAlpha = 1; }
    if (this.playhead != null) { x.fillStyle = col('--text'); x.fillRect(this.playhead * v.px - v.scroll, 0, 2, H); }
  }
  pickedInDrag(notes, i) {
    const sung = ns => ns.flatMap((n, k) => n.midi == null ? [] : [k]), a = sung(this.drag.from), b = sung(notes);
    return this.selected.has(a[b.indexOf(i)]);
  }
}

// The keys both views share (the piano roll and the staff): selection, pitch, length, position, lyric, split/join.
export function editKey(view, e) {
  const notes = view.page.notes(), sel = [...view.selected].sort((a, b) => a - b), sung = notes.flatMap((n, i) => n.midi == null ? [] : [i]);
  const cmd = e.ctrlKey || e.metaKey, g = view.grid || .25; let now = null;
  const step = dir => { const k = sel.length ? sung.indexOf(dir > 0 ? sel[sel.length - 1] : sel[0]) + dir : dir > 0 ? 0 : sung.length - 1; const i = sung[Math.min(sung.length - 1, Math.max(0, k))]; if (i != null) { view.setSelected(e.shiftKey ? [...sel, i] : [i]); view.show(onsets(notes)[i]); view.page.preview(notes[i].midi); } };
  if (cmd && e.key === 'a') view.setSelected(sung);
  else if (e.key === 'Escape') view.setSelected([]);
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel.length) { now = transpose(notes, sel, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey || cmd ? 12 : 1)); view.page.preview(now[sel[0]].midi); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    if (cmd && sel.length) now = moveNotes(notes, sel, dir * g);
    else if (e.altKey && sel.length === 1) now = resizeNote(notes, sel[0], Math.max(g, notes[sel[0]].beats + dir * g));
    else step(dir);
  }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { now = removeNotes(notes, sel, e.shiftKey); view.selected = new Set(); view.page.edit(now, view.selected); now = null; }
  else if (e.key === 'Enter' && sel.length) view.page.lyric(sel[0]);
  else if (e.key === 's' && sel.length === 1) now = splitNote(notes, sel[0]);
  else if (e.key === 'j' && sel.length > 1) now = joinNotes(notes, sel);
  else if (e.key === '+' || e.key === '=') view.zoom(1.25); else if (e.key === '-') view.zoom(.8);
  else return;
  e.preventDefault();
  if (now) view.commit(notes, now);
}
