// Kanji lyrics -> sung kana in the browser: the dictionary (about 17 MB, once) is loaded only when a lyric has kanji.
// The readings lyrics need are the list of ai/core/ja.py (tests/test_readings.py compares them).
import { dictionary } from './cdn.js';

export const WORDS = {"行方": "ゆくえ", "彷徨": "さまよ", "躊躇い": "ためらい", "躊躇う": "ためらう", "木漏れ日": "こもれび", "永久に": "とわに", "一昨日": "おととい", "明後日": "あさって", "今年": "ことし", "傍に": "そばに", "側に": "そばに", "傍で": "そばで", "側で": "そばで", "温もり": "ぬくもり", "身体": "からだ", "止まない": "やまない", "止まぬ": "やまぬ", "月日": "つきひ", "君達": "きみたち", "君たち": "きみたち", "君ら": "きみら", "君等": "きみら"};
// a kanji standing alone (no kanji or digit next to it); the part after | must not follow it
export const ALONE = {"君": "きみ", "人": "ひと", "日": "ひ", "月": "つき", "後": "あと|[ろずれ]", "間": "あいだ|[違にも]", "角": "かど"};
export const PRONOUNS = ["あそこ", "あたし", "あなた", "あれ", "いつ", "いつか", "いま", "おれ", "きみ", "きみたち", "ここ", "こころ", "これ", "すべて", "そこ", "それ", "だれ", "どこ", "どれ", "なに", "ひとつ", "ほんとう", "ぼく", "ぼくたち", "ぼくら", "みんな", "わたし", "わたしたち"];
const K = '一-鿿々〆ヶ0-9０-９', APART = ["君達", "君たち", "君ら", "君等", "側に", "側で", "傍に", "傍で"];
const OVERRIDE = new RegExp([
  ...Object.keys(WORDS).sort((a, b) => b.length - a.length).map(w => APART.includes(w) ? `(?<![${K}ァ-ヶー])${w}` : `(?:${w})`),
  ...Object.entries(ALONE).map(([k, v]) => k === '君' ? `(?<![${K}ァ-ヶー])${k}(?![${K}])` : `(?<![${K}])${k}(?![${K}]${v.includes('|') ? '|' + v.split('|')[1] : ''})`),
].join('|'), 'g');

export const hasKanji = s => /[一-鿿々]/.test(s);
const hira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// [[text, reading | null]]: the parts with a fixed reading (with the particle after them), the rest for the analyser
export function pieces(text) {
  const out = []; let pos = 0;
  for (const m of text.matchAll(OVERRIDE)) {
    if (m.index < pos) continue;
    if (m.index > pos) out.push([text.slice(pos, m.index), null]);
    let r = WORDS[m[0]] ?? ALONE[m[0]].split('|')[0]; pos = m.index + m[0].length;
    if ('はへ'.includes(text[pos] ?? ' ')) r += text[pos++] === 'は' ? 'わ' : 'え';
    out.push([m[0], r]);
  }
  if (pos < text.length) out.push([text.slice(pos), null]);
  return out;
}

export const fromTokens = tokens => tokens.map(t => {
  if (t.pos === '助詞' && t.surface_form === 'は') return 'わ';
  if (t.pos === '助詞' && t.surface_form === 'へ') return 'え';
  return t.reading && hasKanji(t.surface_form) ? hira(t.reading) : t.surface_form;
}).join('');

let ready = null;
export async function kanaOf(text) {
  if (!hasKanji(text)) return text;
  const analyser = await (ready ??= dictionary().catch(e => { ready = null; throw e; }));
  return text.split(/(\s+)/).map(w => hasKanji(w) ? pieces(w.replace(/今日は/g, 'きょうわ')).map(([t, r]) => r ?? fromTokens(analyser.tokenize(t))).join('') : w).join('');
}
