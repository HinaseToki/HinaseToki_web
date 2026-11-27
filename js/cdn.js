// Libraries from the CDN, checked against their hash before they run.
const DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const LIBS = {
  ort: [DIST + 'ort.all.min.mjs', 'sha384-z8tbzfQTTMQGF7D35uxjdHY2wNICBLZgAkQckw9xv4N7C0Pvpdsh4OKzzT4TQSL3'],
  muxer: ['https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.min.mjs', 'sha384-ReD+MPmS81718ptF71npz8Wk2WZ9OgSfqSChm7p31uFHIpp5MyhrT5sMGCUe7c7E'],
};
export async function library(name) {
  const [url, integrity] = LIBS[name];
  const r = await fetch(url, { integrity, mode: 'cors' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return import(URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' })));
}
export async function loadOrt() {
  const m = await library('ort'), ort = m.default ?? m;
  ort.env.wasm.wasmPaths = DIST;
  return ort;
}
// kuromoji (a script, not a module) and its dictionary. Its path handling writes "https:/..." - put right on the way out.
const KUROMOJI = ['https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js', 'sha384-LCHxvFGxgpk9Bl+0+OaV6Rf24HQamJPrNHIo6VGkXkVgGWRvl68eqUwCW5PWqfwh'];
export async function dictionary() {
  const r = await fetch(KUROMOJI[0], { integrity: KUROMOJI[1], mode: 'cors' });
  if (!r.ok) throw new Error(`${KUROMOJI[0]}: ${r.status}`);
  const s = document.createElement('script'); s.src = URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
  await new Promise((yes, no) => { s.onload = yes; s.onerror = () => no(new Error('한자 사전을 열지 못했어요')); document.head.append(s); });
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...a) { return open.call(this, m, String(u).replace(/^https:\/(?!\/)/, 'https://'), ...a); };
  try {
    return await new Promise((yes, no) => globalThis.kuromoji.builder({ dicPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/' }).build((e, t) => e ? no(new Error('한자 사전을 받지 못했어요')) : yes(t)));
  } finally { XMLHttpRequest.prototype.open = open; }
}
