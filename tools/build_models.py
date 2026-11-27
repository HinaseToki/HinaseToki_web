"""Copies exported DiffSinger ONNX graphs into models/, split into <95 MB parts (GitHub's 100 MB file
limit), and writes models/manifest.json for js/synth.js.

    python tools/build_models.py <acoustic_dir> <variance_dir> <vocoder.onnx> [out_dir]
"""
import glob, hashlib, json, os, shutil, sys

PART = 95 * 1024 * 1024
ac, va, voc = sys.argv[1:4]
out = sys.argv[4] if len(sys.argv) > 4 else 'models'
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)

def one(pattern):
    hits = glob.glob(pattern)
    assert len(hits) == 1, (pattern, hits)
    return hits[0]

graphs = {'linguistic': one(f'{va}/*.linguistic.onnx'), 'dur': one(f'{va}/*.dur.onnx'),
          'pitch': one(f'{va}/*.pitch.onnx'), 'variance': one(f'{va}/*.variance.onnx'),
          'acoustic': one(f'{ac}/*.onnx'), 'vocoder': voc}
files = {}
digest = hashlib.sha256()   # manifest.version: browsers cache each model build separately
for key, path in graphs.items():
    data = open(path, 'rb').read()
    parts = []
    for i in range(0, len(data), PART):
        name = f'{key}.onnx' + (f'.{i // PART:02d}' if len(data) > PART else '')
        open(f'{out}/{name}', 'wb').write(data[i:i + PART])
        parts.append({'name': name, 'size': len(data[i:i + PART])})
    files[f'{key}.onnx'] = parts
    digest.update(data)
shutil.copy(one(f'{ac}/*.phonemes.json'), f'{out}/phonemes.json')
shutil.copy(f'{ac}/dictionary-ja.txt', f'{out}/dictionary-ja.txt')
manifest = {'graphs': {k: f'{k}.onnx' for k in graphs}, 'files': files, 'phonemes': 'phonemes.json',
            'dictionary': 'dictionary-ja.txt', 'depth': 0.6, 'version': digest.hexdigest()[:12]}
json.dump(manifest, open(f'{out}/manifest.json', 'w'), indent=1)
print(json.dumps({k: [p['size'] for p in v] for k, v in files.items()}))
