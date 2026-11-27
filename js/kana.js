// Romaji and Korean spelling -> hiragana, and splitting kana text into sung syllables (morae).
import { hangulToKana } from './hangul.js';

const TABLE = {
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ', nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ', mya: 'みゃ', myu: 'みゅ', myo: 'みょ', rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ', ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ', pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ', fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ',
  ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と', na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', hu: 'ふ', he: 'へ', ho: 'ほ', ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ', ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ', wa: 'わ', wo: 'を',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご', za: 'ざ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど', ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ', a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', '-': 'ー',
  she: 'しぇ', sye: 'しぇ', che: 'ちぇ', tye: 'ちぇ', je: 'じぇ', jye: 'じぇ', thi: 'てぃ', dhi: 'でぃ', thu: 'てゅ', dhu: 'でゅ', twu: 'とぅ', dwu: 'どぅ',
  tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ', va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ', wi: 'うぃ', we: 'うぇ', ye: 'いぇ',
  la: 'ら', li: 'り', lu: 'る', le: 'れ', lo: 'ろ', ca: 'か', ci: 'し', cu: 'く', ce: 'せ', co: 'こ', qu: 'く', qa: 'か',
  xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ', fya: 'ふゃ', fyu: 'ふゅ', fyo: 'ふょ',
};
const KEYS = Object.keys(TABLE).sort((a, b) => b.length - a.length);

export function toHiragana(text) {
  const s = hangulToKana(text).toLowerCase();
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (!/[a-z\-]/.test(c)) { out += c; i++; continue; }
    // doubled consonant -> small tsu (kka -> っか); n before a consonant or at the end -> ん
    if (c === s[i + 1] && c !== 'n' && /[bcdfghjkmpqrstvwxyz]/.test(c)) { out += 'っ'; i++; continue; }
    if (c === 'n' && (s[i + 1] === "'" || s[i + 1] === 'n' || i + 1 >= s.length || !/[aiueoy]/.test(s[i + 1]))) {
      out += 'ん'; i += (s[i + 1] === "'" || (s[i + 1] === 'n' && !/[aiueoy]/.test(s[i + 2] ?? ''))) ? 2 : 1; continue;
    }
    if (c === 't' && s.startsWith('tch', i)) { out += 'っ'; i++; continue; }         // matcha
    const k = KEYS.find(k => s.startsWith(k, i));
    if (k) { out += TABLE[k]; i += k.length; } else { out += c; i++; }
  }
  return out;
}

export const kataToHira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// split into morae: a kana plus any small kana after it (きゃ, ふぁ)
export const SMALL = 'ゃゅょぁぃぅぇぉゎ';
// a hiragana word typed before a space that ends in は is the topic particle, sung わ
// (ぼくらは いのちに -> ぼくらわ); same rule as lyric_particles in ai/core/ja.py
const HA_WORDS = new Set(['はは', 'あはは', 'うふふ', 'えへへ']);
export function particles(text) {
  return text.split(/(\s+)/).map(w => (w.length > 1 && w.endsWith('は') && /^[\u3041-\u3096]+$/.test(w) && !HA_WORDS.has(w))
    ? w.slice(0, -1) + 'わ' : w).join('');
}
export function morae(text) {
  const h = kataToHira(toHiragana(particles(text))).replace(/[\s、。,.!?！？「」]/g, '');
  const out = [];
  for (const c of h) {
    if (SMALL.includes(c) && out.length) out[out.length - 1] += c;
    else if (c === 'ー' && out.length) out.push(vowelOf(out[out.length - 1].slice(-1)));
    else out.push(c);
  }
  return out;
}

const ROWS = ['あかさたなはまやらわがざだばぱぁゃ', 'いきしちにひみりぎじぢびぴぃ', 'うくすつぬふむゆるぐずづぶぷぅゅ', 'えけせてねへめれげぜでべぺぇ', 'おこそとのほもよろをごぞどぼぽぉょ'];
// the vowel a kana is sung on (かーー -> あ); あ for anything else
export function vowelOf(c) {
  const r = ROWS.findIndex(row => row.includes(c));
  return r < 0 ? 'あ' : 'あいうえお'[r];
}
