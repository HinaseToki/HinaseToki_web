// A score re-timed from a reference score (a UTAU .ust of the same song): the reference's rhythm and pitch with
// this score's own lyrics. The same rules as ai/tools/ust_score.py (tests/test_web.py runs both):
// lined up by their lyrics; the beat offset and transposition are the ones most matched notes agree on; held
// vowels after a sung note stay, ad-libs after a rest, "ら" scat and breath marks ("br") are left out; the length stays.
const VOWELS = new Set('あいうえお'), SKIP = new Set(['R', 'r', 'br', 'ら', '']);
const round3 = x => Math.round(x * 1000) / 1000;

// difflib.SequenceMatcher(a, b, autojunk=False): its matching blocks and opcodes, the same as Python's
export function opcodes(a, b) {
  const b2j = new Map();
  b.forEach((x, j) => { if (!b2j.has(x)) b2j.set(x, []); b2j.get(x).push(j); });
  const longest = (alo, ahi, blo, bhi) => {
    let bi = alo, bj = blo, size = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1; next.set(j, k);
        if (k > size) { bi = i - k + 1; bj = j - k + 1; size = k; }
      }
      j2len = next;
    }
    while (bi > alo && bj > blo && a[bi - 1] === b[bj - 1]) { bi--; bj--; size++; }
    while (bi + size < ahi && bj + size < bhi && a[bi + size] === b[bj + size]) size++;
    return [bi, bj, size];
  };
  const queue = [[0, a.length, 0, b.length]], found = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop(), [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    found.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const blocks = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of found) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else { if (k1) blocks.push([i1, j1, k1]); [i1, j1, k1] = [i2, j2, k2]; }
  }
  if (k1) blocks.push([i1, j1, k1]);
  blocks.push([a.length, b.length, 0]);
  const ops = []; let i = 0, j = 0;
  for (const [ai, bj, size] of blocks) {
    const tag = i < ai && j < bj ? 'replace' : i < ai ? 'delete' : j < bj ? 'insert' : '';
    if (tag) ops.push([tag, i, ai, j, bj]);
    i = ai + size; j = bj + size;
    if (size) ops.push(['equal', ai, i, bj, j]);
  }
  return { blocks, ops };
}

const timed = notes => { let t = 0; return notes.map(n => { const r = [t, n.lyric, n.beats, n.midi]; t += n.beats; return r; }); };
const mostCommon = xs => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); let best, n = 0; for (const [k, v] of c) if (v > n) { best = k; n = v; } return best; };

// ref, score: notes {lyric, midi|null, beats}. Returns {notes, offset, shift, changes}.
export function retime(ref, score, { offset = null, shift = null } = {}) {
  const total = score.reduce((s, n) => s + n.beats, 0);
  const sung = timed(score).filter(n => n[3] != null);
  const U = []; let prev = false;
  for (const [t, ly, n, m] of timed(ref)) {
    if (m == null || SKIP.has(ly)) { prev = false; continue; }
    U.push([t, ly, n, m, prev]); prev = true;
  }
  if (!U.length || !sung.length) throw new Error('참고 악보나 현재 악보에 부를 음표가 없습니다');
  const { blocks, ops } = opcodes(U.map(u => u[1]), sung.map(o => o[1]));
  const pairs = blocks.flatMap(([i, j, k]) => Array.from({ length: k }, (_, d) => [U[i + d], sung[j + d]]));
  if (!pairs.length) throw new Error('참고 악보와 가사가 맞는 음표가 없습니다');
  offset ??= mostCommon(pairs.map(([u, o]) => round3(o[0] - u[0])));
  shift ??= mostCommon(pairs.map(([u, o]) => o[3] - u[3]));
  for (const u of U) { u[0] += offset; u[3] += shift; }
  const out = [], changes = [];
  for (const [op, a1, a2, b1, b2] of ops) {
    const us = U.slice(a1, a2), os = sung.slice(b1, b2);
    if (op === 'equal') out.push(...us.map(u => [u[0], u[1], u[2], u[3]]));
    else if (op === 'replace' && us.length === os.length) out.push(...us.map((u, k) => [u[0], os[k][1], u[2], u[3]]));
    else if (op === 'replace' || op === 'delete') {
      let k = 0;
      us.forEach((u, i) => {
        const held = VOWELS.has(u[1]) && u[4];
        if (op === 'replace' && k < os.length && !held) {
          const nextHeld = i + 1 < us.length && VOWELS.has(us[i + 1][1]) && us[i + 1][4];
          out.push([u[0], nextHeld ? os[k][1].replace(/っ+$/, '') : os[k][1], u[2], u[3]]); k++;
        } else if (held) out.push([u[0], u[1], u[2], u[3]]);
      });
      changes.push([op, us[0][0], os.map(o => o[1]), us.map(u => u[1])]);
    }
    if (op === 'insert') {
      for (const o of os) if (!out.concat(U).some(n => n[0] < o[0] + o[2] - 1e-9 && o[0] < n[0] + n[2] - 1e-9)) out.push([...o]);
      changes.push(['score only', os[0][0], os.map(o => o[1]), []]);
    }
  }
  const list = out.filter(n => n[0] < total).sort((x, y) => x[0] - y[0]), notes = [];
  let t = 0;
  for (let [s, ly, n, m] of list) {
    if (ly === 'うぉ') ly = 'を';
    if (s < t - 1e-9) { n -= t - s; s = t; }
    if (n <= 1e-9) continue;
    if (s > t + 1e-9) notes.push({ lyric: '', midi: null, beats: s - t });
    n = Math.min(n, total - s);
    notes.push({ lyric: ly, midi: m, beats: n });
    t = s + n;
  }
  if (total > t + 1e-9) notes.push({ lyric: '', midi: null, beats: total - t });
  return { notes, offset, shift, changes };
}
