import { toWav, modelCache, fetchManifest, LEAD } from './synth.js';
import { SynthClient } from './client.js';
import { toHiragana, morae, particles } from './kana.js';
import { parseMidi, trackList, melody, alignLines, toNotes, noteName } from './midi.js';
import { exportMidi, exportUstx, readScoreFile, writeProject } from './formats.js';
import { HIGH, LOW, History, RANGE, addNote, clean, fromText, onsets, removeNotes, setExpr, setLyrics, toText, totalBeats, transpose } from './score.js';
import { Roll } from './roll.js';
import { mixdown, coverMix, COVER } from './mix.js';
import { hasKanji, kanaOf } from './kanji.js';
import { makeVideo, previewFrame, songLines } from './video.js';

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
// from the share link, else the last one used, else the first example
function loadScore() {
  try {
    if (location.hash.length > 1) {
      const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(location.hash.slice(1)), c => c.charCodeAt(0))));
      if (d.tempo) $('tempo').value = Math.min(400, Math.max(20, +d.tempo || 110));
      return clean(d.notes);
    }
    const saved = JSON.parse(localStorage.getItem('toki-score') || 'null');
    if (saved?.notes?.length) { $('tempo').value = Math.min(400, Math.max(20, +saved.tempo || 110)); return clean(saved.notes); }
  } catch {}
  return fromPreset('こんにちは');
}
let notes = loadScore();
const history = new History(notes);
const save = () => { try { localStorage.setItem('toki-score', JSON.stringify({ tempo: tempoOf(), notes })); } catch {} };

const roll = new Roll($('rollBox'), $('roll'), $('rollSpacer'), {
  notes: () => notes,
  edit: (now, selection) => edit(now, selection),
  select: () => showSelection(),
  preview: midi => beep(midi, (ctx ??= new AudioContext()).currentTime, .2),
  lyric: i => askLyric(i),
});

function edit(now, selection = null) {
  notes = now; history.push(notes);
  if (selection) roll.selected = new Set(selection); else roll.selected = new Set([...roll.selected].filter(i => notes[i] && notes[i].midi != null));
  refresh();
}
function refresh() {
  save(); roll.layout(); roll.draw(); showSelection();
  if ($('tableBox').open) table();
  if (document.activeElement !== $('text')) $('text').value = toText(notes);
  $('undoBtn').disabled = !history.past.length; $('redoBtn').disabled = !history.future.length;
}
const replace = now => { roll.selected = new Set(); edit(now); roll.fit(); };
const travel = state => { if (!state) return; notes = state; roll.selected = new Set(); refresh(); };
$('undoBtn').onclick = () => travel(history.undo());
$('redoBtn').onclick = () => travel(history.redo());
addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  e.preventDefault(); travel(e.shiftKey ? history.redo() : history.undo());
});

// the lyric of a note, typed right on the roll; several syllables go on into the next notes
let editing = null;
function askLyric(i) {
  const box = roll.noteBox(i), f = $('lyricEdit');
  editing = i; roll.setSelected([i]); f.hidden = false; f.value = notes[i].lyric;
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
    s.onchange = () => edit(setExpr(notes, roll.selected, k, +s.value), roll.selected);
    l.append(label, s, o); $('exprRows').append(l);
  }
  const b = document.createElement('button');
  b.className = 'ghost'; b.textContent = '표현 초기화'; b.type = 'button';
  b.onclick = () => edit(Object.keys(EXPR).reduce((ns, k) => setExpr(ns, roll.selected, k, null), notes), roll.selected);
  $('exprRows').append(b);
}
function showSelection() {
  const sel = [...roll.selected].filter(i => notes[i]?.midi != null).sort((a, b) => a - b), first = notes[sel[0]];
  $('expr').disabled = !sel.length; $('delBtn').disabled = !sel.length;
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
$('addBtn').onclick = () => { const r = addNote(notes, totalBeats(notes), notes.findLast(n => n.midi != null)?.midi ?? 67, 1); edit(r.notes, [r.index]); roll.show(totalBeats(notes)); };
$('restBtn').onclick = () => edit([...notes, { lyric: '', midi: null, beats: 1 }]);
$('delBtn').onclick = () => edit(removeNotes(notes, roll.selected), []);
$('grid').onchange = e => { roll.grid = +e.target.value; };
$('zoomIn').onclick = () => roll.zoom(1.4); $('zoomOut').onclick = () => roll.zoom(1 / 1.4); $('zoomFit').onclick = () => roll.fit();
$('transpose').onchange = e => { const k = +e.target.value; e.target.value = 0; edit(transpose(notes, roll.selected.size ? roll.selected : null, k), roll.selected); };
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
$('splitBtn').onclick = async () => { try { await readKanji('lyricLine'); } catch { return; } const ms = morae($('lyricLine').value); if (ms.length) edit(setLyrics(notes, roll.selected.size ? Math.min(...roll.selected) : 0, ms)); };

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
let melodyTones = [];
$('previewBtn').onclick = () => {
  if (melodyTones.length) { for (const o of melodyTones) o.stop(); melodyTones = []; $('previewBtn').textContent = '멜로디 미리 듣기'; return; }
  ctx ??= new AudioContext();
  const beat = 60 / tempoOf(); let t = ctx.currentTime + .05;
  for (const n of notes) { if (n.midi != null) melodyTones.push(beep(n.midi, t, n.beats * beat)); t += n.beats * beat; }
  const last = melodyTones[melodyTones.length - 1];
  if (last) { $('previewBtn').textContent = '멜로디 정지'; last.onended = () => { melodyTones = []; $('previewBtn').textContent = '멜로디 미리 듣기'; }; }
};

$('shareBtn').onclick = async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ tempo: tempoOf(), notes })); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
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
  toki: () => saveFile(writeProject({ tempo: tempoOf(), notes }), 'toki_project.json', 'application/json'),
  ustx: () => saveFile(exportUstx(notes, tempoOf()), 'toki.ustx', 'text/yaml'),
  mid: () => saveFile(exportMidi(notes, tempoOf()), 'toki.mid', 'audio/midi'),
  txt: () => saveFile(`tempo: ${tempoOf()}\n${toText(notes)}\n`, 'toki.txt', 'text/plain'),
})[b.dataset.save]();
$('scoreFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const r = await readScoreFile(f); $('tempo').value = r.tempo; replace(r.notes.map(n => n.midi == null ? n : { ...n, lyric: toHiragana(n.lyric) })); say(`${f.name}: 음표 ${notes.filter(n => n.midi != null).length}개를 불러왔습니다`); }
  catch (err) { say(err.message); }
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
    const info = await synth.load(p => { $('loadBar').value = p; $('loadInfo').textContent = `음성 모델 다운로드 중… ${Math.round(p * 100)}%`; },
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
    $('loadInfo').textContent = `최초 1회 음성 모델(${mb}MB)을 내려받습니다. 모든 합성은 이 기기에서 처리됩니다.`;
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
  $('singBtn').disabled = true; $('stopBtn').hidden = false; $('singBar').hidden = false; $('singBar').value = 0;
  job = new AbortController();
  const steps = +$('steps').value, mine = structuredClone(notes), tempo = tempoOf();
  try {
    const r = await synth.sing(mine, { tempo, steps, varSteps: steps >= 40 ? 20 : 10, clamp: $('clamp').checked, vibrato: $('vibrato').checked, takes,
      signal: job.signal, onStage: (s, p) => { say(s); $('singBar').value = p; } });
    if (songUrl) URL.revokeObjectURL(songUrl);
    songUrl = URL.createObjectURL(toWav(r.audio, r.sampleRate));
    $('player').src = songUrl; $('player').hidden = false; $('player').play().catch(() => {});
    $('download').href = songUrl; $('download').hidden = false;
    song = { audio: r.audio, sampleRate: r.sampleRate, notes: mine, tempo, phrases: r.phrases };
    showPhrases(); showVideoCard(); $('mixBox').hidden = false;
    const w = warnings();
    say(w.length ? w.slice(0, 3).join(' / ') + (w.length > 3 ? ` 외 ${w.length - 3}개` : '') : '');
  } catch (e) { say(e.name === 'AbortError' ? '중지했습니다' : e.message); if (e.name !== 'AbortError') console.error(e); }
  $('singBtn').disabled = false; $('stopBtn').hidden = true; $('singBar').hidden = true; job = null;
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
  if (p.paused || p.ended) { roll.playhead = p.ended ? null : roll.playhead; roll.draw(); return; }
  roll.playhead = Math.max(0, (p.currentTime - LEAD) * (song?.tempo ?? tempoOf()) / 60);
  roll.show(roll.playhead); roll.draw(); requestAnimationFrame(follow);
}
$('player').addEventListener('play', () => requestAnimationFrame(follow));
$('player').addEventListener('ended', () => { roll.playhead = null; roll.draw(); });

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
$('mixBtn').onclick = () => {
  if (!song || !back) return;
  // the song starts LEAD seconds into its own file: with offset 0 both first beats fall together
  const offset = LEAD + (+$('backOffset').value || 0), vdb = +$('voiceLevel').value, bdb = +$('backLevel').value;
  // the cover mix (as ai/cover/mix.py) brings the whole to one loudness: the sliders set the band against her (0 dB apart = as v35)
  const [L, R] = $('coverMix').checked ? coverMix(song.audio, back, { offset, level: COVER.level * 10 ** ((bdb - vdb + 4) / 20) })
    : mixdown(song.audio, back, { offset, voice: vdb, backing: bdb });
  song.mix = [L, R];
  if (mixUrl) URL.revokeObjectURL(mixUrl);
  mixUrl = URL.createObjectURL(toWav([L, R], 44100));
  $('mixPlayer').src = mixUrl; $('mixPlayer').hidden = false; $('mixDownload').href = mixUrl; $('mixDownload').hidden = false;
  $('mixInfo').textContent = '믹스를 완료했습니다. 가사 영상에도 믹스한 음원을 사용합니다'; showVideoCard();
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
    $('midiInfo').textContent = '';
  } catch (err) { midi = null; $('midiInfo').textContent = err.message; $('midiBtn').disabled = true; }
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

addEventListener('resize', () => { roll.layout(); roll.draw(); });
buildExpr(); refresh(); roll.fit();
