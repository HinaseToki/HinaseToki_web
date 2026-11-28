import { toWav, modelCache, fetchManifest, LEAD } from './synth.js';
import { SynthClient } from './client.js';
import { toHiragana, morae, particles } from './kana.js';
import { parseMidi, trackList, melody, alignLines, toNotes, noteName } from './midi.js';
import { exportMidi, exportMusicXml, exportUstx, readScoreFile, writeProject } from './formats.js';
import { HIGH, LOW, History, RANGE, addNote, clean, copyNotes, fromText, onsets, removeNotes, setExpr, setLyrics, toText, totalBeats, transpose, writeNotes } from './score.js';
import { Roll } from './roll.js';
import { Staff } from './staff.js';
import { CLEFS, KEYS, KEY_NAMES, LETTERS, SIGS, barBeat, clefOf, nearestPitch } from './notation.js';
import { Transport } from './transport.js';
import { mixdown, coverMix, COVER } from './mix.js';
import { hasKanji, kanaOf } from './kanji.js';
import { makeVideo, previewFrame, songLines } from './video.js';
import { retime } from './retime.js';
import { bandLayers } from './band.js';

const PRESETS = {
  'こんにちは': [['こ', 67, .5], ['ん', 67, .5], ['に', 69, .5], ['ち', 67, .5], ['わ', 67, 1.5]],
  'ドレミ': [['ど', 60, 1], ['れ', 62, 1], ['み', 64, 1], ['ふぁ', 65, 1], ['そ', 67, 1], ['ら', 69, 1], ['し', 71, 1], ['ど', 72, 2]],
  'ありがとう': [['あ', 64, .5], ['り', 67, .5], ['が', 69, .5], ['と', 67, .5], ['う', 64, 2]],
};
const $ = id => document.getElementById(id);
const say = text => { $('status').textContent = text; };
const tempoOf = () => Math.min(400, Math.max(20, +$('tempo').value || 110));
const fromPreset = k => PRESETS[k].map(([lyric, midi, beats]) => ({ lyric, midi, beats }));

// ---------------------------------------------------------------- the score
// the score's time signature, key and clef: how it is written, not what is sung
let meta = { sig: [4, 4], key: 0, clef: 'auto' };
function setMeta(d) {
  const sig = SIGS.find(s => s[0] === d?.sig?.[0] && s[1] === d?.sig?.[1]), key = KEYS.includes(d?.key) ? d.key : 0;
  meta = { sig: sig ?? [4, 4], key, clef: d?.clef in CLEFS ? d.clef : 'auto' };
}
// from the share link, else the last one used, else the first example
function loadScore() {
  try {
    if (location.hash.length > 1) {
      const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(location.hash.slice(1)), c => c.charCodeAt(0))));
      if (d.tempo) $('tempo').value = Math.min(400, Math.max(20, +d.tempo || 110));
      setMeta(d);
      return clean(d.notes);
    }
    const saved = JSON.parse(localStorage.getItem('toki-score') || 'null');
    if (saved?.notes?.length) { $('tempo').value = Math.min(400, Math.max(20, +saved.tempo || 110)); setMeta(saved); return clean(saved.notes); }
  } catch {}
  return fromPreset('こんにちは');
}
let notes = loadScore();
const history = new History({ notes, meta });          // the time signature, key and clef go back with the notes
const doc = () => ({ tempo: tempoOf(), sig: meta.sig, key: meta.key, clef: meta.clef, notes });
const save = () => { try { localStorage.setItem('toki-score', JSON.stringify(doc())); } catch {} };

// two views of one score: the staff (as a score editor shows it) and the piano roll; the selection is shared
const page = {
  notes: () => notes, meta: () => meta,
  edit: (now, selection) => edit(now, selection),
  select: s => { ed.selected = s; showSelection(); },
  preview: midi => { if (!tp.playing) beep(midi, (ctx ??= new AudioContext()).currentTime, .2); },
  lyric: i => askLyric(i),
  caret: beat => setCaret(beat),
};
const roll = new Roll($('rollBox'), $('roll'), $('rollSpacer'), page), staff = new Staff($('staffBox'), $('staff'), page), views = [staff, roll];
let current = staff;
const ed = {
  get selected() { return current.selected; },
  set selected(s) { for (const v of views) v.selected = s; },
  set playhead(b) { for (const v of views) v.playhead = b; },
  get playhead() { return current.playhead; },
  set grid(g) { for (const v of views) v.grid = g; },
  layout() { current.layout(); }, draw() { current.draw(); }, fit() { current.fit(); },
  show: b => current.show(b), noteBox: i => current.noteBox(i), zoom: k => current.zoom(k),
  setSelected: list => current.setSelected(list),
};
function showView(which, focus = false) {
  current = which === 'roll' ? roll : staff;
  $('rollBox').hidden = current !== roll; $('staffBox').hidden = current !== staff;
  $('viewStaff').setAttribute('aria-pressed', current === staff); $('viewRoll').setAttribute('aria-pressed', current === roll);
  try { localStorage.setItem('toki-view', current === roll ? 'roll' : 'staff'); } catch {}
  current.layout(); current.fit(); if (focus) current.canvas.focus({ preventScroll: true });
}
$('viewStaff').onclick = () => showView('staff', true);
$('viewRoll').onclick = () => showView('roll', true);

// the side panel: one tab at a time
const tabs = [...document.querySelectorAll('[role=tab]')];
function showTab(name) {
  for (const t of tabs) {
    const on = t.id === 'tab-' + name;
    t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; $(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (name === 'text' && $('tableBox').open) table();
}
for (const t of tabs) {
  t.onclick = () => showTab(t.id.slice(4));
  t.onkeydown = e => {
    const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!k) return;
    const next = tabs[(tabs.indexOf(t) + k + tabs.length) % tabs.length]; showTab(next.id.slice(4)); next.focus(); e.preventDefault();
  };
}

function edit(now, selection = null) {
  notes = now; history.push({ notes, meta });
  if (selection) ed.selected = new Set(selection); else ed.selected = new Set([...ed.selected].filter(i => notes[i] && notes[i].midi != null));
  refresh();
}
function refresh() {
  save(); for (const v of views) v.layout(); current.draw(); showSelection(); songSource(); showMeta();
  if ($('tableBox').open) table();
  if (document.activeElement !== $('text')) $('text').value = toText(notes);
  $('undoBtn').disabled = !history.past.length; $('redoBtn').disabled = !history.future.length;
}
const replace = now => { ed.selected = new Set(); caret = 0; edit(now); ed.fit(); };
const travel = state => { if (!state) return; ({ notes, meta } = state); showMeta(); ed.selected = new Set(); refresh(); };
$('undoBtn').onclick = () => travel(history.undo());
$('redoBtn').onclick = () => travel(history.redo());
addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  e.preventDefault(); travel(e.shiftKey ? history.redo() : history.undo());
});

// the lyric of a note, typed right on the roll; several syllables go on into the next notes
let editing = null;
function askLyric(i) {
  const box = ed.noteBox(i), f = $('lyricEdit');
  editing = i; ed.setSelected([i]); f.hidden = false; f.value = notes[i].lyric;
  f.style.left = Math.max(0, box.x) + 'px'; f.style.top = Math.max(0, box.y - 6) + 'px';
  f.focus(); f.select();
}
function endLyric(keep, next = false) {
  const i = editing, v = $('lyricEdit').value.trim(); editing = null; $('lyricEdit').hidden = true;
  if (i == null) return;
  if (keep && v && v !== notes[i].lyric) {
    const ms = morae(v);
    edit(ms.length > 1 ? setLyrics(notes, i, ms) : notes.map((n, k) => k === i ? { ...n, lyric: toHiragana(v).slice(0, 8) } : n), [i]);
  }
  const after = notes.findIndex((n, k) => k > i && n.midi != null);
  if (next && after > 0) askLyric(after); else $('roll').focus({ preventScroll: true });
}
$('lyricEdit').addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); endLyric(true, e.key === 'Tab' && !e.shiftKey); }
  if (e.key === 'Escape') endLyric(false);
});
$('lyricEdit').addEventListener('blur', () => { if (editing != null) endLyric(true); });

// ---------------------------------------------------------------- expression of the selected notes
const EXPR = { vib: ['비브라토', .05, '반음'], cents: ['미세 음정', 1, '센트'], scoop: ['밀어 올림', .1, '반음'], fall: ['떨어뜨림', .1, '반음'],
  dyn: ['세기', .5, 'dB'], br: ['숨소리', .5, 'dB'], gen: ['음색 굵기', .05, ''], ten: ['긴장도', .5, 'dB'] };
let controls = [];
function buildExpr() {
  $('exprRows').innerHTML = '';
  for (const [k, [label, step, unit]] of Object.entries(EXPR)) {
    if ((k === 'gen' || k === 'ten') && !controls.includes(k)) continue;         // only when this model can do it
    const l = document.createElement('label'), s = document.createElement('input'), o = document.createElement('output');
    Object.assign(s, { type: 'range', min: RANGE[k][0], max: RANGE[k][1], step, value: 0 });
    s.dataset.k = k; s.dataset.unit = unit;
    s.oninput = () => { o.textContent = s.value; };
    s.onchange = () => edit(setExpr(notes, ed.selected, k, +s.value), ed.selected);
    l.append(label, s, o); $('exprRows').append(l);
  }
  const b = document.createElement('button');
  b.className = 'ghost'; b.textContent = '표현 초기화'; b.type = 'button';
  b.onclick = () => edit(Object.keys(EXPR).reduce((ns, k) => setExpr(ns, ed.selected, k, null), notes), ed.selected);
  $('exprRows').append(b);
}
function showSelection() {
  const sel = [...ed.selected].filter(i => notes[i]?.midi != null).sort((a, b) => a - b), first = notes[sel[0]];
  $('expr').disabled = !sel.length; $('exprEmpty').hidden = !!sel.length; $('delBtn').disabled = !sel.length;
  for (const s of $('exprRows').querySelectorAll('input')) {
    const v = first?.expr?.[s.dataset.k]; s.value = v ?? 0; s.nextElementSibling.textContent = v ?? '기본';
  }
  $('rollStatus').textContent = !sel.length ? `음표 ${notes.filter(n => n.midi != null).length}개 · ${Math.round(totalBeats(notes) * 60 / tempoOf())}초`
    : sel.length > 1 ? `음표 ${sel.length}개 선택됨` : `${first.lyric} · ${noteName(first.midi)} · ${Math.round(first.beats * 1000) / 1000}박 · ${Math.round(onsets(notes)[sel[0]] * 100) / 100}박째`;
}

// ---------------------------------------------------------------- table, text, tools
function table() {
  const tbody = document.querySelector('#notes tbody'); tbody.innerHTML = '';
  const names = Array.from({ length: HIGH - LOW + 1 }, (_, i) => LOW + i);
  notes.forEach((n, i) => {
    const tr = document.createElement('tr'), rest = n.midi == null;
    tr.innerHTML = `<td>${rest ? '<i>쉼표</i>' : `<input class="lyric" aria-label="${i + 1}번째 가사">`}</td>
      <td>${rest ? '-' : `<select aria-label="${i + 1}번째 음">${names.map(m => `<option value="${m}" ${m === n.midi ? 'selected' : ''}>${noteName(m)}</option>`).join('')}</select>`}</td>
      <td><input type="number" step="any" min="0.03125" aria-label="${i + 1}번째 박자"></td><td><button aria-label="${i + 1}번째 삭제">✕</button></td>`;
    const set = change => edit(notes.map((x, k) => k === i ? { ...x, ...change } : x));
    const ly = tr.querySelector('.lyric'), num = tr.querySelector('input[type=number]');
    if (ly) { ly.value = n.lyric; ly.addEventListener('change', () => set({ lyric: toHiragana(ly.value.trim()).slice(0, 8) })); }   // a value, never HTML
    num.value = Math.round(n.beats * 1e4) / 1e4;
    num.addEventListener('change', () => set({ beats: Math.max(1 / 32, +num.value || 1) }));
    tr.querySelector('select')?.addEventListener('change', e => set({ midi: +e.target.value }));
    tr.querySelector('button').addEventListener('click', () => edit(notes.filter((_, k) => k !== i)));
    tbody.appendChild(tr);
  });
}
$('tableBox').addEventListener('toggle', () => { if ($('tableBox').open) table(); });
$('applyText').onclick = () => { try { replace(fromText($('text').value, toHiragana)); say(''); } catch (e) { say(e.message); } };
$('addBtn').onclick = () => { const r = addNote(notes, totalBeats(notes), notes.findLast(n => n.midi != null)?.midi ?? 67, 1); edit(r.notes, [r.index]); ed.show(totalBeats(notes)); };
$('restBtn').onclick = () => edit([...notes, { lyric: '', midi: null, beats: 1 }]);
$('delBtn').onclick = () => edit(removeNotes(notes, ed.selected), []);
$('grid').onchange = e => { ed.grid = +e.target.value; };

// ---------------------------------------------------------------- the score editor: cursor, signature, input, playback
let caret = 0;                                     // where input and playback start (beats)
const clock = sec => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
function showPos(beat) {
  const { bar, beat: b } = barBeat(beat, meta.sig);
  $('posStatus').textContent = `${bar}마디 ${Math.round(b * 100) / 100}박 · ${clock(beat * 60 / tempoOf())}`;
}
function setCaret(beat) {
  caret = Math.max(0, beat); for (const v of views) v.caret = caret;
  if (!tp.playing) showPos(caret);
  current.draw();
}
const CLEF_NAMES = { treble: '높은음자리표', bass: '낮은음자리표' };
function showMeta() {
  $('sig').value = meta.sig.join('/'); $('keySig').value = meta.key; $('clef').value = meta.clef;
  $('clef').options[0].textContent = `자동 (${CLEF_NAMES[clefOf(notes, 'auto', meta.key)]})`;   // which one auto picks now
}
$('clef').onchange = e => { meta = { ...meta, clef: e.target.value }; edit(notes, ed.selected); };
for (const [n, d] of SIGS) $('sig').add(new Option(`${n}/${d}`, `${n}/${d}`));
for (const k of KEYS) $('keySig').add(new Option(`${KEY_NAMES[k]}장조 (${k > 0 ? '♯' + k : k < 0 ? '♭' + -k : '없음'})`, k));
$('sig').onchange = e => { const [n, d] = e.target.value.split('/').map(Number); meta = { ...meta, sig: [n, d] }; edit(notes, ed.selected); };
$('keySig').onchange = e => { meta = { ...meta, key: +e.target.value }; edit(notes, ed.selected); };

// note input, as MuseScore: N, then a length (2-7, . dotted, Alt+3 triplet) and the letters A-G at the cursor
const DURS = [[2, '32분음표', 1 / 8, '32nd'], [3, '16분음표', .25, '16th'], [4, '8분음표', .5, 'eighth'], [5, '4분음표', 1, 'quarter'], [6, '2분음표', 2, 'half'], [7, '온음표', 4, 'whole']];
let inputMode = false, dur = 5, dotted = false, triplet = false;
const noteIcon = type => {
  const open = type === 'half' || type === 'whole', flags = { eighth: 1, '16th': 2, '32nd': 3 }[type] ?? 0;
  return `<svg viewBox="0 0 16 24" width="14" height="21" aria-hidden="true"><ellipse cx="6" cy="19" rx="4.2" ry="3" transform="rotate(-20 6 19)" fill="${open ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="1.6"/>`
    + (type === 'whole' ? '' : '<path d="M9.6 18V3" stroke="currentColor" stroke-width="1.4"/>')
    + Array.from({ length: flags }, (_, i) => `<path d="M9.6 ${3 + i * 4}q1 4 5 6" fill="none" stroke="currentColor" stroke-width="1.6"/>`).join('') + '</svg>';
};
for (const [key, name, , type] of DURS) {
  const b = document.createElement('button');
  Object.assign(b, { className: 'ghost icon', title: `${name} (${key})`, type: 'button', innerHTML: noteIcon(type) });
  b.setAttribute('role', 'radio'); b.setAttribute('aria-label', name); b.dataset.key = key;
  b.onclick = () => { dur = key; showInput(); };
  $('durations').append(b);
}
const length = () => DURS.find(d => d[0] === dur)[2] * (dotted ? 1.5 : 1) * (triplet ? 2 / 3 : 1);
function showInput() {
  for (const b of $('durations').children) b.setAttribute('aria-checked', +b.dataset.key === dur);
  $('dotBtn').setAttribute('aria-pressed', dotted); $('tripBtn').setAttribute('aria-pressed', triplet); $('inputBtn').setAttribute('aria-pressed', inputMode);
  for (const v of views) v.inputMode = inputMode;
  const name = (dotted ? '점' : '') + DURS.find(d => d[0] === dur)[1] + (triplet ? ' 셋잇단' : '');
  $('modeStatus').textContent = inputMode ? `입력 모드 · ${name}` : `일반 모드 · ${name}`;
  $('editor').classList.toggle('inputting', inputMode);
  current.draw();
}
function setInput(on) {
  inputMode = on;
  if (on) { const sel = [...ed.selected].sort((a, b) => a - b); if (sel.length) setCaret(onsets(notes)[sel[0]]); }
  showInput(); current.canvas.focus({ preventScroll: true });
}
$('inputBtn').onclick = () => setInput(!inputMode);
$('dotBtn').onclick = () => { dotted = !dotted; showInput(); };
$('tripBtn').onclick = () => { triplet = !triplet; showInput(); };
// the pitch a letter means here: nearest to the selected note, else to the last one before the cursor
function refPitch() {
  const sel = [...ed.selected].filter(i => notes[i]?.midi != null);
  if (sel.length) return notes[Math.max(...sel)].midi;
  const o = onsets(notes);
  return notes.findLast((n, i) => n.midi != null && o[i] < caret + 1e-6)?.midi ?? 67;
}
function enter(midi) {
  const len = length(), r = writeNotes(notes, caret, [midi == null ? { lyric: '', midi: null, beats: len } : { lyric: 'ら', midi, beats: len }]);
  edit(r.notes, r.indexes); setCaret(caret + len); current.show(caret);
  if (midi != null) page.preview(midi);
}
function moveCaret(dir) {
  const o = onsets(notes), marks = [...o, totalBeats(notes)];
  const to = dir > 0 ? marks.find(b => b > caret + 1e-6) : marks.findLast(b => b < caret - 1e-6);
  if (to == null) return;
  setCaret(to); current.show(to);
  const i = o.findIndex((b, k) => Math.abs(b - to) < 1e-6 && notes[k].midi != null);
  ed.setSelected(i >= 0 ? [i] : []);
  if (i >= 0) page.preview(notes[i].midi);
}
function inputKey(e) {
  const k = e.key.toLowerCase(), cmd = e.ctrlKey || e.metaKey;
  if (cmd) return false;
  if (e.altKey && e.code === 'Digit3') { triplet = !triplet; showInput(); return true; }
  if (e.altKey) return false;
  if (k.length === 1 && LETTERS.includes(k)) { enter(nearestPitch(LETTERS.indexOf(k), refPitch(), meta.key, LOW, HIGH)); return true; }
  if (k === '0') { enter(null); return true; }
  if (/^[2-7]$/.test(k)) { dur = +k; showInput(); return true; }
  if (k === '.') { dotted = !dotted; showInput(); return true; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { moveCaret(e.key === 'ArrowRight' ? 1 : -1); return true; }
  if (e.key === 'Backspace' && ed.selected.size) { const sel = [...ed.selected], at = Math.min(...sel.map(i => onsets(notes)[i])); edit(removeNotes(notes, sel), []); setCaret(at); return true; }
  if (e.key === 'Escape') { setInput(false); return true; }
  return false;
}

// copy, cut, paste (onto the selected note or the cursor, written over what is there)
let clip = null, flashTimer = 0;
function flash(text) { clearTimeout(flashTimer); $('modeStatus').textContent = text; flashTimer = setTimeout(showInput, 2000); }
function copySel(cut) {
  const sel = [...ed.selected]; if (!sel.length) return;
  clip = copyNotes(notes, sel);
  navigator.clipboard?.writeText(toText(clip)).catch(() => {});
  if (cut) edit(removeNotes(notes, sel), []);
  flash(`음표 ${clip.filter(n => n.midi != null).length}개를 ${cut ? '잘라냈습니다' : '복사했습니다'}`);
}
function paste() {
  if (!clip?.length) return;
  const sel = [...ed.selected], at = sel.length ? Math.min(...sel.map(i => onsets(notes)[i])) : caret;
  const r = writeNotes(notes, at, clip);
  edit(r.notes, r.indexes); setCaret(at + totalBeats(clip)); current.show(at);
}

// playback: from the selected note or the cursor; the loop is the selection (or the whole song)
let songBuffer = null;
const songMatches = () => !!song && song.tempo === tempoOf() && JSON.stringify(song.notes) === JSON.stringify(notes);
function songSource() {
  const ok = !!songBuffer && songMatches(), o = $('tSource').options[1];
  o.disabled = !ok; o.textContent = ok || !songBuffer ? '생성한 노래' : '생성한 노래 (악보 변경됨)';
  if (!ok && $('tSource').value === 'song') $('tSource').value = 'tone';
}
const pressed = id => $(id).getAttribute('aria-pressed') === 'true';
const toggle = id => $(id).setAttribute('aria-pressed', !pressed(id));
function loopSpan() {
  if (!pressed('tLoop')) return null;
  const sel = [...ed.selected], o = onsets(notes);
  if (!sel.length) return [0, totalBeats(notes)];
  return [Math.min(...sel.map(i => o[i])), Math.max(...sel.map(i => o[i] + notes[i].beats))];
}
const tp = new Transport(() => ({
  notes, tempo: tempoOf(), sig: meta.sig, metronome: pressed('tClick'), loop: loopSpan(),
  song: $('tSource').value === 'song' && songMatches() ? songBuffer : null,
}), () => { ed.playhead = null; $('tPlay').textContent = '▶'; $('tPlay').setAttribute('aria-label', '재생'); showPos(caret); current.draw(); });
function play() {
  if (tp.playing) { tp.stop(); return; }
  $('player').pause();
  const sel = [...ed.selected], o = onsets(notes), loop = loopSpan();
  const from = sel.length ? Math.min(...sel.map(i => o[i])) : loop && (caret < loop[0] || caret >= loop[1]) ? loop[0] : caret >= totalBeats(notes) ? 0 : caret;
  tp.play(from); $('tPlay').textContent = '⏸'; $('tPlay').setAttribute('aria-label', '정지');
  const frame = () => {
    if (!tp.playing) return;
    const b = tp.beat; if (b >= 0) { ed.playhead = b; showPos(b); current.show(b); current.draw(); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
$('tPlay').onclick = play;
$('tRewind').onclick = () => { const was = tp.playing; tp.stop(); ed.setSelected([]); setCaret(0); current.show(0); if (was) play(); };
$('tLoop').onclick = () => toggle('tLoop');
$('tClick').onclick = () => toggle('tClick');
$('keysBtn').onclick = () => $('keysHelp').showModal();

// the editor's keys, before the views' own: input mode, playback, clipboard, help
addEventListener('keydown', e => {
  if (e.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.closest?.('dialog')) return;
  if (!(e.target === document.body || e.target.closest?.('#editor'))) return;
  const cmd = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), done = () => { e.preventDefault(); e.stopPropagation(); };
  if (inputMode && inputKey(e)) return done();
  if (e.target.tagName === 'BUTTON' && e.key === 'Enter') return;
  if (e.key === ' ' && !cmd) { play(); return done(); }
  if (e.key === 'Home') { $('tRewind').click(); return done(); }
  if (cmd && (k === 'c' || k === 'x') && !getSelection().toString()) { copySel(k === 'x'); return done(); }
  if (cmd && k === 'v') { paste(); return done(); }
  if (cmd || e.altKey) return;
  if (k === 'n') { setInput(!inputMode); return done(); }
  if (k === 'm') { toggle('tClick'); return done(); }
  if (k === 'l') { toggle('tLoop'); return done(); }
  if (e.key === '?') { $('keysHelp').showModal(); return done(); }
}, true);
addEventListener('keyup', e => { if (e.key === ' ' && e.target.tagName === 'BUTTON' && e.target.closest('#editor')) e.preventDefault(); }, true);
// a click on the toolbar leaves the keys with the score, as in a score editor
document.querySelector('#editor .toolbar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
showInput();
$('zoomIn').onclick = () => ed.zoom(1.4); $('zoomOut').onclick = () => ed.zoom(1 / 1.4); $('zoomFit').onclick = () => ed.fit();
$('transpose').onchange = e => { const k = +e.target.value; e.target.value = 0; edit(transpose(notes, ed.selected.size ? ed.selected : null, k), ed.selected); };
for (const k of Object.keys(PRESETS)) $('preset').add(new Option(k, k));
$('preset').add(new Option('—', ''), 0); $('preset').value = '';
$('preset').onchange = e => { if (e.target.value) replace(fromPreset(e.target.value)); };
$('tempo').oninput = () => { save(); showSelection(); };
$('tempo').onchange = () => { $('tempo').value = tempoOf(); save(); showSelection(); };   // 20-400, as sung
// a whole lyric line, spread over the notes from the selected one on (extra syllables get new notes)
// kanji in a lyric field: read first (the dictionary comes once), the reading shown so it can be corrected
async function readKanji(id) {
  const f = $(id); if (!hasKanji(f.value)) return;
  say('한자 읽기 변환 중… (최초 1회 사전 17MB 다운로드)');
  try { f.value = (await Promise.all(f.value.split('\n').map(kanaOf))).join('\n'); say('한자를 가나로 변환했습니다. 읽기가 맞는지 확인해 주십시오'); }
  catch (e) { say(e.message); throw e; }
}
$('splitBtn').onclick = async () => { try { await readKanji('lyricLine'); } catch { return; } const ms = morae($('lyricLine').value); if (ms.length) edit(setLyrics(notes, ed.selected.size ? Math.min(...ed.selected) : 0, ms)); };

// melody preview with a plain tone (no model needed)
var ctx;
function beep(midi, start, dur) {
  ctx ??= new AudioContext();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle'; o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
  g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(.2, start + .02);
  g.gain.setValueAtTime(.2, start + dur * .85); g.gain.linearRampToValueAtTime(0, start + dur);
  o.connect(g).connect(ctx.destination); o.start(start); o.stop(start + dur);
  return o;
}
$('shareBtn').onclick = async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(doc())); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  const url = location.href.split('#')[0] + '#' + btoa(bin);
  if (url.length > 30000) { say('악보가 길어 링크를 만들 수 없습니다. "프로젝트 저장"으로 저장한 파일을 공유해 주십시오'); return; }
  window.history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); say('공유 링크를 복사했습니다'); }
  catch { say('복사하지 못했습니다. 주소창의 링크를 직접 복사해 주십시오'); }
};
function saveFile(data, name, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
for (const b of document.querySelectorAll('[data-save]')) b.onclick = () => ({
  toki: () => saveFile(writeProject(doc()), 'toki_project.json', 'application/json'),
  musicxml: () => saveFile(exportMusicXml(notes, { tempo: tempoOf(), ...meta, clef: clefOf(notes, meta.clef, meta.key) }), 'toki.musicxml', 'application/vnd.recordare.musicxml+xml'),
  ustx: () => saveFile(exportUstx(notes, tempoOf(), meta.sig), 'toki.ustx', 'text/yaml'),
  mid: () => saveFile(exportMidi(notes, tempoOf()), 'toki.mid', 'audio/midi'),
  txt: () => saveFile(`tempo: ${tempoOf()}\n${toText(notes)}\n`, 'toki.txt', 'text/plain'),
})[b.dataset.save]();
$('scoreFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const r = await readScoreFile(f); $('tempo').value = r.tempo; if (r.sig || r.key != null) { setMeta(r); showMeta(); } replace(r.notes.map(n => n.midi == null ? n : { ...n, lyric: toHiragana(n.lyric) })); say(`${f.name}: 음표 ${notes.filter(n => n.midi != null).length}개를 불러왔습니다`); }
  catch (err) { say(err.message); }
  e.target.value = '';
};

$('refFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const ref = (await readScoreFile(f)).notes.map(n => n.midi == null ? n : { ...n, lyric: toHiragana(n.lyric) });
    const r = retime(ref, notes), sign = x => (x > 0 ? '+' : '') + x;
    replace(r.notes);
    say(`${f.name}의 박자에 맞추었습니다: 음표 ${r.notes.filter(n => n.midi != null).length}개, 박자 ${sign(r.offset)}, 키 ${sign(r.shift)}반음, 바뀐 곳 ${r.changes.length}곳 (실행 취소 가능)`);
  } catch (err) { say(err.message); }
  e.target.value = '';
};

// ---------------------------------------------------------------- the voice
// The worker sings; where module workers do not exist the page does it itself.
function makeClient() {
  try { return new SynthClient(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })); }
  catch {
    const { port1, port2 } = new MessageChannel();
    Promise.all([import('./cdn.js'), import('./service.js'), import('./synth.js')]).then(([c, s, y]) =>
      s.serve(port1, async base => { globalThis.ort = await c.loadOrt(); return new y.Synth(base ?? 'models/'); }));
    return new SynthClient(port2);
  }
}
const synth = makeClient();
// which voice: a choice only where the site holds several (voices.json, written by python -m ai web)
let voices = [], voiceBase = 'models/', loaded = false;
const voiceName = () => { const v = voices.find(v => v.base === voiceBase); return v?.label ?? v?.name; };
async function chooseVoices() {
  try { voices = await (await fetch('voices.json', { cache: 'no-cache' })).json(); } catch { voices = []; }
  if (!Array.isArray(voices)) voices = [];
  if (voices.length < 2) { voiceBase = voices[0]?.base ?? 'models/'; return; }          // one voice: named, no choice
  $('voice').innerHTML = voices.map(v => `<option value="${v.base}">${v.label ?? v.name}${v.default ? ' (기본)' : ''}</option>`).join('');
  let saved = null; try { saved = localStorage.getItem('toki-voice'); } catch {}
  voiceBase = voices.some(v => v.base === saved) ? saved : (voices.find(v => v.default) ?? voices[0]).base;
  $('voice').value = voiceBase; $('voicePick').hidden = false;
}
$('voice').onchange = () => {
  voiceBase = $('voice').value; takes = {};                 // takes of another voice are not this one's
  try { localStorage.setItem('toki-voice', voiceBase); } catch {}
  if (loaded) start(); else offer();
};
async function start() {
  $('loadBtn').disabled = true; $('loadBar').hidden = false; $('singBtn').disabled = true; $('voice').disabled = true;
  try {
    const info = await synth.load(p => { $('loadBar').value = p; $('loadInfo').textContent = `내려받는 중 ${Math.round(p * 100)}%`; },
                                  voiceBase === 'models/' ? undefined : voiceBase);
    controls = info.controls; buildExpr(); showSelection(); loaded = true; $('voice').disabled = false; $('loadBtn').hidden = true;
    $('loadInfo').textContent = voices.length ? `준비 완료 (${voiceName()})` : '준비 완료'; $('loadBar').hidden = true; $('singBtn').disabled = false;
  } catch (e) { $('loadInfo').textContent = '음성 모델을 내려받지 못했습니다. 새로고침 후 다시 시도해 주십시오. (' + e.message + ')'; $('loadBtn').disabled = false; $('voice').disabled = false; $('loadBar').hidden = true; }
}
$('loadBtn').onclick = start;
// already downloaded once: start right away
async function offer() {
  try {
    const m = await fetchManifest(voiceBase), all = Object.values(m.files).flat();
    const mb = Math.round(all.reduce((n, p) => n + p.size, 0) / 1e6);
    $('loadInfo').textContent = `${mb}MB`;
    const c = await caches.open(modelCache(m, voiceBase)), base = new URL(voiceBase, location.href).href;
    if ((await Promise.all(all.map(p => c.match(base + p.name)))).every(Boolean)) start();
  } catch {}
}
chooseVoices().then(offer);

// notes that are likely to come out swallowed
function warnings() {
  const beat = 60 / tempoOf(), out = [], clampOn = $('clamp').checked;
  notes.forEach((n, i) => {
    if (n.midi == null) return;
    const m = morae(n.lyric).filter(x => !'っッー'.includes(x)).length;   // じっ is one note: the mora and its closure
    if (m > 1) out.push(`${i + 1}번째 음표(${n.lyric})에 ${m}음절이 들어 있습니다. 음표 하나에 한 음절씩 넣으면 발음이 더 명확합니다`);
    else if (n.beats * beat < (clampOn ? .1 : .2))      // "또렷하게" keeps short morae audible down to ~0.1 s
      out.push(`${i + 1}번째 음표(${n.lyric})가 너무 짧습니다 (${(n.beats * beat).toFixed(2)}초)`);
  });
  return out;
}

let job = null, takes = {}, songUrl = null;
$('stopBtn').onclick = () => job?.abort();
$('singBtn').onclick = () => { takes = {}; sing(); };
async function sing() {
  $('singBtn').disabled = true; $('singBtn').classList.add('singing'); $('stopBtn').hidden = false; $('singBar').hidden = false; $('singBar').value = 0;
  job = new AbortController();
  const steps = +$('steps').value, mine = structuredClone(notes), tempo = tempoOf();
  try {
    const r = await synth.sing(mine, { tempo, steps, varSteps: steps >= 40 ? 20 : 10, clamp: $('clamp').checked, vibrato: { natural: 'natural', light: true }[$('vibrato').value] ?? false, takes,
      signal: job.signal, onStage: (s, p) => { say(s); $('singBar').value = p; } });
    if (songUrl) URL.revokeObjectURL(songUrl);
    songUrl = URL.createObjectURL(toWav(r.audio, r.sampleRate));
    $('player').src = songUrl; $('player').hidden = false; $('player').play().catch(() => {});
    $('download').href = songUrl; $('download').hidden = false;
    song = { audio: r.audio, sampleRate: r.sampleRate, notes: mine, tempo, phrases: r.phrases };
    songBuffer = new AudioBuffer({ length: r.audio.length, sampleRate: r.sampleRate, numberOfChannels: 1 });
    songBuffer.copyToChannel(r.audio, 0); songBuffer.lead = LEAD; songSource();
    if (songMatches()) $('tSource').value = 'song';
    showPhrases(); showVideoCard(); $('mixBox').hidden = false; showTab('song');
    const w = warnings();
    say(w.length ? w.slice(0, 3).join(' / ') + (w.length > 3 ? ` 외 ${w.length - 3}개` : '') : '');
  } catch (e) { say(e.name === 'AbortError' ? '중지했습니다' : e.message); if (e.name !== 'AbortError') console.error(e); }
  $('singBtn').disabled = false; $('singBtn').classList.remove('singing'); $('stopBtn').hidden = true; $('singBar').hidden = true; job = null;
}
function showPhrases() {
  $('phraseBox').hidden = false; $('phraseList').innerHTML = '';
  song.phrases.forEach((p, i) => {
    const li = document.createElement('li'), b = document.createElement('button'), t = document.createElement('button');
    t.className = b.className = 'ghost'; t.textContent = '재생'; b.textContent = '재생성';
    li.append(`${p.text.slice(0, 24)}${p.text.length > 24 ? '…' : ''} `, t, b);
    t.onclick = () => { $('player').currentTime = Math.max(0, LEAD + p.start - .1); $('player').play(); };
    b.onclick = () => { if (job) return; takes = { ...takes, [i]: (takes[i] ?? 0) + 1 }; sing(); };
    $('phraseList').append(li);
  });
}
// moving line over the roll while the song plays
function follow() {
  const p = $('player');
  if (p.paused || p.ended) { ed.playhead = p.ended ? null : ed.playhead; ed.draw(); return; }
  ed.playhead = Math.max(0, (p.currentTime - LEAD) * (song?.tempo ?? tempoOf()) / 60);
  ed.show(ed.playhead); ed.draw(); requestAnimationFrame(follow);
}
$('player').addEventListener('play', () => requestAnimationFrame(follow));
$('player').addEventListener('ended', () => { ed.playhead = null; ed.draw(); });

// ---------------------------------------------------------------- backing track
let back = null, mixUrl = null;
$('backFile').onchange = async e => {
  const f = e.target.files[0]; back = null; $('mixBtn').disabled = true;
  if (!f) return;
  try {
    const b = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(await f.arrayBuffer());
    back = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
    $('mixBtn').disabled = false; $('mixInfo').textContent = `${f.name} (${Math.round(b.duration)}초)`;
  } catch { $('mixInfo').textContent = '오디오 파일로 열 수 없습니다'; }
};
let layered = null;                                // [backing, MIDI, track, the backing with the band layers]
async function withBand() {
  if (!$('bandLayers').checked || !midi) return back;
  const track = +$('midiTrack').value;
  if (layered?.[0] === back && layered[1] === midi && layered[2] === track) return layered[3];
  $('mixInfo').textContent = '밴드 보강을 만드는 중…';
  const [l, r] = await bandLayers(midi, track, back), bl = back[0], br = back[1] ?? back[0];
  const out = [Float32Array.from(bl, (x, i) => x + l[i]), Float32Array.from(br, (x, i) => x + r[i])];
  layered = [back, midi, track, out];
  return out;
}
$('mixBtn').onclick = async () => {
  if (!song || !back) return;
  $('mixBtn').disabled = true;
  try {
    const band = await withBand();
    // the song starts LEAD seconds into its own file: with offset 0 both first beats fall together
    const offset = LEAD + (+$('backOffset').value || 0), vdb = +$('voiceLevel').value, bdb = +$('backLevel').value;
    // the cover mix (as ai/cover/mix.py) brings the whole to one loudness: the sliders set the band against her (0 dB apart = as v35)
    const [L, R] = $('coverMix').checked ? coverMix(song.audio, band, { offset, level: COVER.level * 10 ** ((bdb - vdb + 4) / 20) })
      : mixdown(song.audio, band, { offset, voice: vdb, backing: bdb });
    song.mix = [L, R];
    if (mixUrl) URL.revokeObjectURL(mixUrl);
    mixUrl = URL.createObjectURL(toWav([L, R], 44100));
    $('mixPlayer').src = mixUrl; $('mixPlayer').hidden = false; $('mixDownload').href = mixUrl; $('mixDownload').hidden = false;
    $('mixInfo').textContent = '믹스를 완료했습니다. 가사 영상에도 믹스한 음원을 사용합니다'; showVideoCard();
  } catch (err) { $('mixInfo').textContent = err.message; }
  finally { $('mixBtn').disabled = false; }
};

// ---------------------------------------------------------------- MIDI
let midi = null;                                   // kept only in memory, never saved or shared
$('midiFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    midi = parseMidi(await f.arrayBuffer());
    const list = trackList(midi).filter(t => t.channel !== 9);           // channel 10: drums
    if (!list.length) throw new Error('음표가 있는 트랙이 없습니다');
    $('midiTrack').innerHTML = '';
    for (const t of list) $('midiTrack').add(new Option(`${t.track}. ${t.name || '(이름 없음)'} · ${t.notes}음 · ${noteName(t.low)}~${noteName(t.high)}`, t.track));
    pickTrack(list); $('midiTrack').disabled = false; $('midiBtn').disabled = false;
    $('bandLayers').disabled = false; $('bandLayers').checked = true;
    $('midiInfo').textContent = '';
  } catch (err) { midi = null; $('midiInfo').textContent = err.message; $('midiBtn').disabled = true; $('bandLayers').disabled = true; $('bandLayers').checked = false; }
};
// default: a singable, mostly one-note-at-a-time track whose note count is closest to the lyrics
function pickTrack(list) {
  const syl = morae(particles($('midiLyrics').value.replace(/^@[\d.]+/gm, ''))).length;
  const score = t => {
    const m = melody(midi, t.track).notes.length, inRange = t.low >= LOW && t.high <= HIGH;
    return (inRange ? 0 : 1e6) + (m < t.notes * .8 ? 1e5 : 0) + Math.abs(m - (syl || m));
  };
  $('midiTrack').value = list.reduce((a, b) => score(b) < score(a) ? b : a).track;
}
$('midiLyrics').addEventListener('change', () => { if (midi) pickTrack(trackList(midi).filter(t => t.channel !== 9)); });
$('midiBtn').onclick = async () => {
  if (hasKanji($('midiLyrics').value)) { try { await readKanji('midiLyrics'); } catch { return; } $('midiInfo').textContent = '한자를 가나로 변환했습니다. 읽기를 확인한 후 다시 눌러 주십시오'; return; }
  const lines = $('midiLyrics').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [, pin = '', text] = /^(@[\d.]+\s*)?(.*)$/.exec(l);
    return pin + toHiragana(particles(text)).replace(/[\s「」『』、。!?！？,.]/g, '');
  });
  if (!lines.length) { $('midiInfo').textContent = '가사를 한 줄 이상 입력해 주십시오'; return; }
  const { bpm, notes: mel, tempoChanges } = melody(midi, +$('midiTrack').value);
  if (!mel.length) { $('midiInfo').textContent = '이 트랙에는 멜로디가 없습니다'; return; }
  try {
    const { sung, info } = alignLines(mel, lines);
    if (!sung.length) { $('midiInfo').textContent = '가사를 멜로디에 맞추지 못했습니다. 다른 트랙을 선택해 주십시오'; return; }
    $('tempo').value = Math.round(bpm * 1000) / 1000;
    replace(clean(toNotes(sung, Infinity, $('midiIntro').checked ? 0 : null)));
    $('midiInfo').textContent = `가사 ${info.lines}줄을 멜로디 ${info.phrases}구간에 맞추어 음표 ${info.sung_notes}개를 생성했습니다`
      + (tempoChanges ? ` (템포가 ${tempoChanges}번 바뀌는 곡이므로 음 길이에 반영했습니다)` : '');
  } catch (e) { $('midiInfo').textContent = e.message; }
};

// ---------------------------------------------------------------- lyric video of the last song
let song = null, videoJob = null, videoUrl = null;
const userLines = id => { const v = $(id).value.split('\n').map(l => l.trim()); while (v.length && !v[v.length - 1]) v.pop(); return v; };
function videoOptions() {
  const n = songLines(song.notes, song.tempo).length, shown = userLines('vLyrics'), tr = userLines('vTrans');
  const notes = [];
  if (shown.length && shown.length !== n) notes.push(`화면 가사가 ${shown.length}줄로 ${n}줄과 달라 악보의 가사를 사용합니다`);
  if (tr.length && tr.length !== n) notes.push(`번역이 ${tr.length}줄로 ${n}줄과 달라 표시하지 않습니다`);
  return { opts: { title: $('vTitle').value.trim(), subtitle: $('vSub').value.trim(),
    shown: shown.length === n ? shown : null, translation: tr.length === n ? tr : null }, notes };
}
function showVideoCard() {
  const lines = songLines(song.notes, song.tempo);
  $('vLines').textContent = lines.length;
  $('vLyrics').placeholder = '화면 가사 (한 줄씩, 선택)\n예:\n' + lines.slice(0, 3).map(l => l.units.map(u => u.text).join('')).join('\n');
  $('videoCard').hidden = false; $('vCanvas').hidden = false; $('vPlayer').hidden = true;
  preview();
}
function preview() {
  if (!song || videoJob) return;
  const { opts, notes } = videoOptions();
  previewFrame($('vCanvas'), song, opts);
  $('vStatus').textContent = notes.join(' / ');
}
for (const id of ['vTitle', 'vSub', 'vLyrics', 'vTrans']) $(id).addEventListener('input', preview);
$('vStop').onclick = () => videoJob?.abort();
$('videoBtn').onclick = async () => {
  if (!song) return;
  const { opts } = videoOptions();
  videoJob = new AbortController();
  $('videoBtn').disabled = true; $('vStop').hidden = false; $('vBar').hidden = false; $('vBar').value = 0;
  $('vCanvas').hidden = false; $('vPlayer').hidden = true; $('vDownload').hidden = true;
  const t0 = performance.now();
  try {
    const r = await makeVideo($('vCanvas'), song, { ...opts, height: +$('vSize').value, signal: videoJob.signal,
      onProgress: p => { $('vBar').value = p; $('vStatus').textContent = `영상 생성 중… ${Math.round(p * 100)}%`; } });
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(r.blob);
    $('vPlayer').src = videoUrl; $('vPlayer').hidden = false; $('vCanvas').hidden = true;
    const name = (opts.title || 'hinase_toki').replace(/[\\/:*?"<>|]/g, '_');
    $('vDownload').href = videoUrl; $('vDownload').download = `${name}.${r.ext}`;
    $('vDownload').textContent = `영상 저장 (${r.ext.toUpperCase()}, ${(r.blob.size / 1e6).toFixed(1)}MB)`; $('vDownload').hidden = false;
    $('vStatus').textContent = `영상 생성 완료 (${Math.round((performance.now() - t0) / 1000)}초 소요)`;
  } catch (e) {
    $('vStatus').textContent = e.name === 'AbortError' ? '중지했습니다' : '영상을 생성하지 못했습니다: ' + e.message;
    if (e.name !== 'AbortError') console.error(e);
  }
  $('videoBtn').disabled = false; $('vStop').hidden = true; $('vBar').hidden = true; videoJob = null;
};

addEventListener('resize', () => { ed.layout(); ed.draw(); });
buildExpr(); showMeta(); refresh();
showView((() => { try { return localStorage.getItem('toki-view'); } catch { return null; } })() ?? 'staff');
setCaret(0);
