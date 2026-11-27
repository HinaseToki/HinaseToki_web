// Korean spelling of Japanese (코레와 -> これわ): a syllable's onset, vowel and final consonant -> kana.
// Same tables as ai/core/hangul.py (tests/test_hangul.py compares every syllable).
const ON = ["g", "k", "n", "d", "t", "r", "m", "b", "p", "s", "ss", "", "j", "tt", "ch", "k", "t", "p", "h"];
const VO = ["a", "e", "ya", "e", "o", "e", "yo", "e", "o", "wa", "we", "we", "yo", "u", "wo", "we", "wi", "yu", "eu", "i", "i"];
const FI = ["", "っ", "っ", "っ", "ん", "ん", "ん", "っ", "る", "る", "ん", "る", "る", "る", "る", "る", "ん", "っ", "っ", "っ", "っ", "ん", "っ", "っ", "っ", "っ", "っ", "っ"];
const ROWS = {"": "あいうえお", "k": "かきくけこ", "g": "がぎぐげご", "s": "さしすせそ", "j": "ざじずぜぞ", "t": "たちつてと", "d": "だぢづでど", "n": "なにぬねの", "h": "はひふへほ", "b": "ばびぶべぼ", "p": "ぱぴぷぺぽ", "m": "まみむめも", "r": "らりるれろ"};
const I = {"k": "き", "g": "ぎ", "s": "し", "j": "じ", "n": "に", "h": "ひ", "b": "び", "p": "ぴ", "m": "み", "r": "り"};
const SPECIAL = {"t|i": "てぃ", "t|u": "とぅ", "t|eu": "と", "t|a": "た", "t|e": "て", "t|o": "と", "d|i": "でぃ", "d|u": "どぅ", "d|eu": "ど", "d|a": "だ", "d|e": "で", "d|o": "ど", "ss|eu": "つ", "tt|eu": "つ", "tt|u": "つ", "ch|a": "ちゃ", "ch|i": "ち", "ch|u": "ちゅ", "ch|eu": "つ", "ch|e": "ちぇ", "ch|o": "ちょ", "ch|ya": "ちゃ", "ch|yu": "ちゅ", "ch|yo": "ちょ", "j|u": "じゅ", "j|eu": "ず", "s|wi": "し", "h|wa": "ふぁ", "h|wi": "ふぃ", "h|we": "ふぇ", "h|wo": "ふぉ", "|ya": "や", "|yu": "ゆ", "|yo": "よ", "|wa": "わ", "|wi": "うぃ", "|we": "うぇ", "|wo": "うぉ"};
const AS = { ss: 's', tt: 't', ch: 't' }, SMALL = { ya: 'ゃ', yu: 'ゅ', yo: 'ょ' };
const PLAIN = { ya: 'a', yu: 'u', yo: 'o', wa: 'a', wi: 'i', we: 'e', wo: 'o', eu: 'u' };

function syllable(ch) {
  if (ch === '응') return 'ん';
  const c = ch.charCodeAt(0) - 0xAC00, fi = FI[c % 28], vo = VO[Math.floor(c % 588 / 28)];
  let on = ON[Math.floor(c / 588)];
  if (`${on}|${vo}` in SPECIAL) return SPECIAL[`${on}|${vo}`] + fi;
  on = AS[on] ?? on;
  if (`${on}|${vo}` in SPECIAL) return SPECIAL[`${on}|${vo}`] + fi;
  if (SMALL[vo] && I[on]) return I[on] + SMALL[vo] + fi;
  const v = PLAIN[vo] ?? vo;
  return (SPECIAL[`${on}|${v}`] ?? ROWS[on]['aiueo'.indexOf(v)]) + fi;
}

export const hasHangul = s => /[가-힣]/.test(s);
export const hangulToKana = text => text.replace(/[가-힣]/g, syllable);
