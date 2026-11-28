// The score as sheet music on one treble staff: systems that wrap like a page, bars of the time signature, the key,
// note values with dots, beams, ties and triplets, lyrics under the notes. Notes are picked, dragged up and down
// (along the staff), and a click elsewhere puts the input cursor there. Like the roll it only asks for edits.
import { FLAGS, accidentals, barLength, keyLetters, measures, pulse, spell, stepMidi } from './notation.js';
import { HIGH, LOW, onsets, transpose } from './score.js';
import { editKey } from './roll.js';

const BOTTOM = 30;                                                        // E4, the staff's lowest line
const SHARP_STEPS = [38, 35, 39, 36, 33, 37, 34], FLAT_STEPS = [34, 37, 33, 36, 32, 35, 31];
const GLYPH = { 1: '♯', '-1': '♭', 0: '♮' };
const MUSIC_FONT = '"Bravura Text", "Noto Music", "Apple Symbols", "Segoe UI Symbol", serif';

export class Staff {
  // page: {notes(), meta() -> {sig, key}, edit(notes, selection), select(set), preview(midi), lyric(index), caret(beat)}
  constructor(scroller, canvas, page) {
    Object.assign(this, { scroller, canvas, page, scale: 1, grid: .25, selected: new Set(), playhead: null, caret: null, inputMode: false, drag: null, L: null });
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => { this.drag = null; this.draw(); });
    canvas.addEventListener('dblclick', e => { const h = this.hit(...this.at(e)); if (h != null) this.page.lyric(h); });
    canvas.addEventListener('keydown', e => editKey(this, e));
    scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(Math.exp(-e.deltaY / 300)); } }, { passive: false });
    for (const t of ['focus', 'blur']) canvas.addEventListener(t, () => this.draw());
  }
  get sp() { return 8.5 * this.scale; }                                  // one staff space, px
  at(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  zoom(k) { this.scale = Math.min(2.2, Math.max(.6, this.scale * k)); this.layout(); this.draw(); }
  fit() { this.scale = 1; this.layout(); this.draw(); }
  setSelected(list) { this.selected = new Set(list); this.page.select(this.selected); this.draw(); }
  commit(from, now) {
    const sung = ns => ns.flatMap((n, i) => n.midi == null ? [] : [i]), a = sung(from), b = sung(now);
    this.selected = new Set(a.length === b.length ? [...this.selected].map(i => b[a.indexOf(i)]) : []);
    this.page.edit(now, this.selected);
  }

  // ---------------------------------------------------------------- layout
  layout(notes = this.page.notes()) {
    const { sig, key } = this.page.meta(), sp = this.sp, W = this.scroller.clientWidth;
    if (!W) return;
    const c = this.canvas.getContext('2d'); c.font = this.lyricFont();
    const bars = measures(notes, sig), margin = sp * 1.5, avail = W - margin * 2;
    const header = first => sp * 4.2 + Math.abs(key) * sp * 1.05 + (first ? sp * 3 : 0);
    // each piece: its natural width (the head, a longer note more, its lyric, an accidental)
    const sized = bars.map(bar => {
      const acc = accidentals(bar, notes, key);
      const items = bar.pieces.map((p, k) => {
        const ly = !p.rest && p.first ? notes[p.index].lyric : '';
        const lead = acc[k] != null ? sp * 1.3 : 0;
        const w = Math.max(sp * (2.2 + 3 * Math.sqrt(p.beats)) + lead + p.dots * sp * .6, ly && ly !== 'ー' ? c.measureText(ly).width + sp * 1.2 : 0);
        return { p, acc: acc[k], lead, w };
      });
      return { bar, items, w: sp * 1.4 + items.reduce((a, it) => a + it.w, 0) };
    });
    // bars into systems, each system stretched to the width (the last only if it is nearly full)
    const systems = []; let cur = null;
    sized.forEach((b, i) => {
      if (!cur || (cur.bars.length && cur.used + b.w > avail - header(false))) { cur = { bars: [], used: 0, first: !systems.length }; systems.push(cur); }
      cur.bars.push({ ...b, number: i + 1 }); cur.used += b.w;
    });
    // each system as high as its notes reach (stems and ledger lines), the lyrics just under its lowest note
    const pieces = [], byIndex = new Map(), rel = step => sp * 4 - (step - BOTTOM) * sp / 2;
    let y = 0;
    systems.forEach((s, k) => {
      const h = header(s.first), room = avail - h, stretch = k < systems.length - 1 || s.used > room * .7 ? room / s.used : 1;
      const steps = s.bars.flatMap(b => b.items.filter(it => !it.p.rest).map(it => spell(notes[it.p.index].midi, key).step));
      const above = Math.max(sp * 3.5, ...steps.map(st => -rel(st) + (st < 34 ? sp * 3.6 : sp) + sp * 1.2));
      const below = Math.max(sp * 4.5, ...steps.map(st => rel(st) + (st < 34 ? sp : sp * 3.6)));
      s.top = y; s.y = y + above; s.lyricY = s.y + below + sp * 2.3; s.bottom = s.lyricY + sp * 1.6; y = s.bottom;
      s.header = h; let x = margin + h;
      for (const b of s.bars) {
        b.x0 = x; x += sp * 1.4 * stretch;
        for (const it of b.items) {
          const piece = { ...it, sys: k, xs: x, xe: x + it.w * stretch };
          piece.hx = x + it.lead + sp * .9;                                // the head's centre
          if (!it.p.rest) { piece.s = spell(notes[it.p.index].midi, key); piece.hy = this.yOf(piece.s.step, s.y); if (!byIndex.has(it.p.index)) byIndex.set(it.p.index, piece); }
          pieces.push(piece); x = piece.xe;
        }
        b.x1 = x;
      }
      s.x1 = x;
    });
    this.L = { systems, pieces, byIndex, W, H: y + sp, sig, key };
    this.canvas.style.height = this.L.H + 'px';
  }
  lyricFont() { return `${Math.round(13 * Math.sqrt(this.scale))}px system-ui, -apple-system, "Hiragino Sans", sans-serif`; }
  yOf(step, sysY) { return sysY + this.sp * 4 - (step - BOTTOM) * this.sp / 2; }       // sysY: the staff's top line
  // the x of a beat (and its system), between the pieces around it
  beatX(beat) {
    const ps = this.L?.pieces; if (!ps?.length) return null;
    let p = ps.findLast(q => q.p.beat <= beat + 1e-6) ?? ps[0];
    const f = Math.min(1, Math.max(0, (beat - p.p.beat) / p.p.beats));
    return { x: p.xs + (p.xe - p.xs) * f, sys: p.sys };
  }
  noteBox(i) {
    const p = this.L?.byIndex.get(i); if (!p) return { x: 0, y: 0 };
    this.show(p.p.beat);
    return { x: p.hx - this.sp, y: this.L.systems[p.sys].lyricY - this.sp * .6 - this.scroller.scrollTop };
  }
  show(beat) {
    const at = this.beatX(beat); if (!at) return;
    const s = this.L.systems[at.sys], box = this.scroller;
    if (s.top < box.scrollTop || s.bottom > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, s.top - this.sp);
  }

  // ---------------------------------------------------------------- picking and dragging
  hit(x, y) {
    const sp = this.sp;
    for (const p of this.L?.pieces ?? []) {
      if (p.p.rest) continue;
      const ly = this.L.systems[p.sys].lyricY;
      if (Math.abs(x - p.hx) < sp * 1.1 && Math.abs(y - p.hy) < sp * .9) return p.p.index;
      if (p.p.first && x >= p.xs && x < p.xe && y > ly - sp * 2 && y < ly + sp) return p.p.index;  // its lyric
    }
    return null;
  }
  slotAt(x, y) {
    const L = this.L; if (!L) return null;
    const k = Math.max(0, L.systems.findIndex(s => y < s.bottom)) || (y >= L.systems.at(-1).bottom ? L.systems.length - 1 : 0);
    const ps = L.pieces.filter(p => p.sys === k);
    return ps.find(p => x < p.xe) ?? ps.at(-1);
  }
  down(e) {
    const [x, y] = this.at(e), notes = this.page.notes(), h = this.hit(x, y);
    this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(e.pointerId);
    if (h == null) {
      const slot = this.slotAt(x, y);
      if (slot) this.page.caret(slot.p.beat);
      if (!e.shiftKey) this.setSelected([]);
      return;
    }
    const sel = [...this.selected];
    if (e.shiftKey && sel.length) {                                       // a range, as MuseScore
      const sung = notes.flatMap((n, i) => n.midi == null ? [] : [i]), a = Math.min(...sel, h), b = Math.max(...sel, h);
      this.setSelected(sung.filter(i => i >= a && i <= b)); return;
    }
    if (e.ctrlKey || e.metaKey) { const s = new Set(sel); s.has(h) ? s.delete(h) : s.add(h); this.setSelected(s); return; }
    if (!this.selected.has(h)) this.setSelected([h]);
    this.page.caret(onsets(notes)[h]);
    this.drag = { index: h, y, from: notes, step: spell(notes[h].midi, this.L.key).step, k: 0 };
    this.page.preview(notes[h].midi);
  }
  move(e) {
    const [x, y] = this.at(e), d = this.drag;
    if (!d) { this.canvas.style.cursor = this.hit(x, y) != null ? 'ns-resize' : 'text'; return; }
    const steps = Math.round((d.y - y) / (this.sp / 2)), want = Math.min(HIGH, Math.max(LOW, stepMidi(d.step + steps, this.L.key)));
    const k = want - d.from[d.index].midi;
    if (k === d.k) return;
    d.k = k; d.now = transpose(d.from, [...this.selected], k); this.page.preview(want);
    this.draw(d.now);
  }
  up() { const d = this.drag; this.drag = null; if (d?.now) this.commit(d.from, d.now); }

  // ---------------------------------------------------------------- drawing
  draw(preview = null) {
    const c = this.canvas, W = this.scroller.clientWidth, dpr = globalThis.devicePixelRatio || 1;
    if (!W) return;
    if (preview || !this.L || this.L.W !== W) this.layout(preview ?? undefined);
    const L = this.L, H = L.H, sp = this.sp, x = c.getContext('2d'), notes = preview ?? this.page.notes();
    c.style.width = W + 'px';
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const css = getComputedStyle(this.canvas), col = k => css.getPropertyValue(k).trim(), ink = col('--text'), pick = col('--accent');
    x.strokeStyle = x.fillStyle = ink;
    const line = (x0, y0, x1, y1, w = 1) => { x.lineWidth = w; x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke(); };
    const text = (s, px, py, font, align = 'center') => { x.font = font; x.textAlign = align; x.fillText(s, px, py); };

    for (const [k, s] of L.systems.entries()) {
      const y0 = s.y, margin = sp * 1.5;
      for (let i = 0; i < 5; i++) line(margin, y0 + i * sp, s.x1, y0 + i * sp, Math.max(1, sp / 9));
      line(margin, y0, margin, y0 + 4 * sp, 1.2);
      // clef, key, time
      text('\u{1D11E}', margin + sp * 1.9, y0 + sp * 4.15, `${sp * 6.6}px ${MUSIC_FONT}`);
      let kx = margin + sp * 4.2;
      for (const [j, letter] of keyLetters(L.key).entries()) {
        const step = (L.key > 0 ? SHARP_STEPS : FLAT_STEPS)[j]; void letter;
        text(L.key > 0 ? '♯' : '♭', kx + j * sp * 1.05, this.yOf(step, y0) + sp * (L.key > 0 ? .55 : .35), `${sp * 2.3}px ${MUSIC_FONT}`);
      }
      if (s.first) {
        const tx = margin + s.header - sp * 1.7, f = `bold ${sp * 2.5}px Georgia, "Times New Roman", serif`;
        text(String(L.sig[0]), tx, y0 + sp * 1.85, f); text(String(L.sig[1]), tx, y0 + sp * 3.85, f);
      }
      for (const [j, b] of s.bars.entries()) {
        const last = k === L.systems.length - 1 && j === s.bars.length - 1;
        if (last) { line(b.x1 - sp * .55, y0, b.x1 - sp * .55, y0 + 4 * sp, 1); x.fillRect(b.x1 - sp * .3, y0, sp * .3, 4 * sp); }
        else line(b.x1, y0, b.x1, y0 + 4 * sp, 1.2);
        if (j === 0 && k > 0 || b.number > 1 && j === 0) { x.fillStyle = col('--muted'); text(String(b.number), b.x0 - sp * .2, y0 - sp * 1.6, `italic ${sp * 1.3}px Georgia, serif`, 'left'); x.fillStyle = ink; }
      }
    }
    // pieces, beams and ties
    const groups = this.beamGroups(L.pieces, L.sig, notes), sel = this.selected;
    const colour = p => p.p.index >= 0 && (sel.has(p.p.index) && !this.drag || this.drag && sel.has(p.p.index)) ? pick : ink;
    for (const p of L.pieces) {
      const sy = L.systems[p.sys].y;
      x.fillStyle = x.strokeStyle = colour(p);
      if (p.p.rest) { this.rest(x, p, sy); continue; }
      const step = p.s.step, hw = sp * .66;
      for (let s = 28; s >= step; s -= 2) line(p.hx - hw - sp * .45, this.yOf(s, sy), p.hx + hw + sp * .45, this.yOf(s, sy), 1.2);
      for (let s = 40; s <= step; s += 2) line(p.hx - hw - sp * .45, this.yOf(s, sy), p.hx + hw + sp * .45, this.yOf(s, sy), 1.2);
      x.beginPath(); x.ellipse(p.hx, p.hy, hw, sp * .45, -.35, 0, Math.PI * 2);
      if (p.p.type === 'half' || p.p.type === 'whole') { x.lineWidth = sp * .18; x.stroke(); } else x.fill();
      if (p.acc != null) text(GLYPH[p.acc], p.hx - hw - sp * .75, p.hy + sp * .5, `${sp * 2.2}px ${MUSIC_FONT}`);
      for (let d = 0; d < p.p.dots; d++) { x.beginPath(); x.arc(p.hx + hw + sp * (.5 + d * .5), p.hy - ((step - BOTTOM) % 2 === 0 ? sp / 2 : 0), sp * .17, 0, Math.PI * 2); x.fill(); }
      if (p.p.type !== 'whole' && !groups.member.has(p)) {
        const up = step < 34, sx = up ? p.hx + hw - .6 : p.hx - hw + .6, tip = up ? p.hy - sp * 3.4 : p.hy + sp * 3.4;
        line(sx, p.hy, sx, tip, sp * .12);
        for (let f = 0; f < FLAGS[p.p.type]; f++) {
          const fy = tip + (up ? 1 : -1) * f * sp * .85;
          x.lineWidth = sp * .22; x.beginPath(); x.moveTo(sx, fy);
          x.bezierCurveTo(sx + sp * .2, fy + (up ? 1 : -1) * sp * 1.1, sx + sp * 1.4, fy + (up ? 1 : -1) * sp * 1.3, sx + sp * .9, fy + (up ? 1 : -1) * sp * 2.6); x.stroke();
        }
      }
      const n = notes[p.p.index];
      if (p.p.first) {
        x.fillStyle = colour(p);
        if (n.lyric === 'ー') line(p.hx - sp * 1.6, L.systems[p.sys].lyricY - sp * .2, p.hx + sp * .9, L.systems[p.sys].lyricY - sp * .2, 1);
        else text(n.lyric, p.hx, L.systems[p.sys].lyricY, this.lyricFont());
      }
    }
    x.fillStyle = x.strokeStyle = ink;
    for (const g of groups.list) {
      x.fillStyle = x.strokeStyle = g.some(p => sel.has(p.p.index)) ? pick : ink;
      const up = g.reduce((a, p) => a + p.s.step, 0) / g.length < 34, hw = sp * .66, sy = L.systems[g[0].sys].y;
      const ys = g.map(p => p.hy), beamY = up ? Math.min(...ys) - sp * 3.2 : Math.max(...ys) + sp * 3.2, sxOf = p => up ? p.hx + hw - .6 : p.hx - hw + .6;
      for (const p of g) line(sxOf(p), p.hy, sxOf(p), beamY, sp * .12);
      const level = (lv, a, b) => x.fillRect(a, beamY + (up ? 1 : -1) * lv * sp * .8 - (up ? 0 : sp * .5), b - a, sp * .5);
      level(0, sxOf(g[0]), sxOf(g.at(-1)) + .5);
      for (let lv = 1; lv < 3; lv++) g.forEach((p, i) => {
        if (FLAGS[p.p.type] <= lv) return;
        const next = g[i + 1], prev = g[i - 1];
        if (next && FLAGS[next.p.type] > lv) level(lv, sxOf(p), sxOf(next) + .5);
        else if (!(prev && FLAGS[prev.p.type] > lv)) level(lv, next ? sxOf(p) : sxOf(p) - sp, next ? sxOf(p) + sp : sxOf(p));
      });
      if (g[0].p.tuplet) text('3', (g[0].hx + g.at(-1).hx) / 2, up ? beamY - sp * .7 : Math.min(...ys) - sp * 1.2, `italic bold ${sp * 1.4}px Georgia, serif`);
      void sy;
    }
    // triplets that are not beamed: the 3 over them
    for (const run of this.tripletRuns(L.pieces).filter(r => !r.every(p => groups.member.has(p)))) {
      const sy = L.systems[run[0].sys].y; x.fillStyle = ink;
      text('3', (run[0].hx + run.at(-1).hx) / 2, Math.min(sy - sp * .8, ...run.filter(p => p.hy).map(p => p.hy - sp * 4)), `italic bold ${sp * 1.4}px Georgia, serif`);
    }
    // ties
    x.strokeStyle = ink;
    L.pieces.forEach((p, i) => {
      if (p.p.rest || !p.p.tieStart) return;
      const q = L.pieces.slice(i + 1).find(o => o.p.index === p.p.index); if (!q) return;
      const below = p.s.step >= 34 ? -1 : 1, off = below * sp * .7;
      const arc = (a, b, y) => { x.lineWidth = sp * .16; x.beginPath(); x.moveTo(a, y + off); x.quadraticCurveTo((a + b) / 2, y + off + below * sp * 1.1, b, y + off); x.stroke(); };
      x.strokeStyle = colour(p);
      if (q.sys === p.sys) arc(p.hx + sp * .5, q.hx - sp * .5, p.hy);
      else { arc(p.hx + sp * .5, L.systems[p.sys].x1, p.hy); arc(L.systems[q.sys].bars[0].x0, q.hx - sp * .5, q.hy); }
    });
    // input cursor and play position
    if (this.caret != null) {
      const at = this.beatX(this.caret);
      if (at) {
        const sy = L.systems[at.sys].y; x.fillStyle = pick;
        if (this.inputMode) { x.globalAlpha = .28; x.fillRect(at.x, sy - sp * 1.5, sp * 1.8, sp * 7); x.globalAlpha = 1; x.fillRect(at.x, sy - sp * 1.5, 2, sp * 7); }
        else { x.globalAlpha = .5; x.fillRect(at.x, sy - sp, 1.5, sp * 6); x.globalAlpha = 1; }
      }
    }
    if (this.playhead != null) {
      const at = this.beatX(this.playhead);
      if (at) { const sy = L.systems[at.sys].y; x.fillStyle = pick; x.fillRect(at.x, sy - sp * 2, 2.5, sp * 8); }
    }
    x.textAlign = 'start';
  }
  rest(x, p, sy) {
    const sp = this.sp, cx = p.hx, mid = sy + sp * 2, t = p.p.type;
    if (t === 'whole') x.fillRect(cx - sp * .6, sy + sp, sp * 1.2, sp * .5);
    else if (t === 'half') x.fillRect(cx - sp * .6, mid - sp * .5, sp * 1.2, sp * .5);
    else if (t === 'quarter') {
      x.lineWidth = sp * .3; x.beginPath();
      x.moveTo(cx - sp * .3, mid - sp * 1.5); x.lineTo(cx + sp * .35, mid - sp * .6); x.lineTo(cx - sp * .3, mid + sp * .2);
      x.lineTo(cx + sp * .35, mid + sp * .9); x.quadraticCurveTo(cx - sp * .6, mid + sp * .6, cx - sp * .05, mid + sp * 1.6); x.stroke();
    } else {
      const n = FLAGS[t];
      x.lineWidth = sp * .16; x.beginPath(); x.moveTo(cx + sp * .5, mid - sp * .9); x.lineTo(cx - sp * .1 - (n - 1) * sp * .2, mid + sp * (1 + (n - 1) * .8)); x.stroke();
      for (let i = 0; i < n; i++) {
        const y = mid - sp * .6 + i * sp * .8, x0 = cx - sp * .2 - i * sp * .2;
        x.beginPath(); x.arc(x0, y, sp * .25, 0, Math.PI * 2); x.fill();
        x.beginPath(); x.moveTo(x0, y + sp * .1); x.quadraticCurveTo(x0 + sp * .4, y + sp * .3, cx + sp * .5 - i * sp * .2, y - sp * .3); x.stroke();
      }
    }
    for (let d = 0; d < p.p.dots; d++) { x.beginPath(); x.arc(cx + sp * (1 + d * .5), mid - sp / 2, sp * .17, 0, Math.PI * 2); x.fill(); }
  }
  // eighths and shorter, beamed within one beat (one dotted quarter in compound time); rests and barlines break them
  beamGroups(pieces, sig, notes) {
    const list = [], member = new Set(), unit = pulse(sig), bar = barLength(sig); let cur = [], key = null;
    const close = () => { if (cur.length > 1) { list.push(cur); for (const p of cur) member.add(p); } cur = []; key = null; };
    for (const p of pieces) {
      if (p.p.rest || FLAGS[p.p.type] < 1 || p.p.index < 0 || notes[p.p.index]?.midi == null) { close(); continue; }
      const inBar = Math.floor(p.p.beat / bar + 1e-6), k = `${p.sys}:${inBar}:${Math.floor((p.p.beat - inBar * bar) / unit + 1e-6)}:${p.p.tuplet}`;
      if (k !== key) close();
      cur.push(p); key = k;
    }
    close();
    return { list, member };
  }
  tripletRuns(pieces) {
    const runs = []; let cur = [], sum = 0;
    for (const p of pieces) {
      if (!p.p.tuplet) { if (cur.length) runs.push(cur); cur = []; sum = 0; continue; }
      cur.push(p); sum += p.p.beats;
      if ([.5, 1, 2].some(v => Math.abs(sum - v) < 1e-4)) { runs.push(cur); cur = []; sum = 0; }
    }
    if (cur.length) runs.push(cur);
    return runs;
  }
}
