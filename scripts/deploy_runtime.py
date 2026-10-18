"""Deploy complete compiled modules with import preflight, hashes and rollback.

Current ordinary bridges share Full (see castalia_config._bridge); AIRI uses Anima.
This copies code only: no banks, keys, environment or instance configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
MAPPING = [('Castalia-Full','run/LobeHub'), ('Castalia-Full','run/Castalia'),
           ('Castalia-Full','run/Castalia-Federation'), ('Castalia-Anima','run/Castalia-Anima')]

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def plan():
    files=[]
    for source,target in MAPPING:
        src=ROOT/source/'dist'; dst=ROOT/target/'dist'
        if not (src/'index.js').is_file() or not dst.is_dir(): raise ValueError(f'missing build/runtime: {source} -> {target}')
        for file in src.rglob('*.js'):
            text=file.read_text(encoding='utf-8')
            for match in re.finditer(r"(?:from\s*|import\s*\()(['\"])(\.[^'\"]+)\1",text):
                module=(file.parent/match.group(2)).resolve()
                if not module.is_file(): raise ValueError(f'missing import: {file}: {match.group(2)}')
            dest=dst/file.relative_to(src)
            if not dest.is_file() or sha(file)!=sha(dest): files.append((file,dest))
    return files

def atomic_copy(src,dst):
    dst.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(dir=dst.parent,prefix='.deploy-'); os.close(fd)
    try:
        shutil.copy2(src,tmp); os.replace(tmp,dst)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--apply',action='store_true'); args=parser.parse_args()
    files=plan()
    print(json.dumps({'mapping':MAPPING,'changedModules':len(files)},ensure_ascii=False))
    if not args.apply: return 1 if files else 0
    backup=ROOT/'_归档'/('runtime-deploy-'+time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True)
    manifest=[]
    # Save every old file before the first runtime mutation.
    for src,dst in files:
        old=backup/dst.relative_to(ROOT)
        if dst.exists(): old.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(dst,old)
        manifest.append({'source':str(src.relative_to(ROOT)),'target':str(dst.relative_to(ROOT)),
                         'sha256':sha(src),'existed':dst.exists()})
    (backup/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    installed=[]
    try:
        for (src,dst),item in zip(files,manifest):
            atomic_copy(src,dst); installed.append((dst,item))
            if sha(dst)!=item['sha256']: raise ValueError(f'hash mismatch: {dst}')
    except BaseException:
        for dst,item in reversed(installed):
            if item['existed']: atomic_copy(backup/dst.relative_to(ROOT),dst)
            else: dst.unlink(missing_ok=True)
        raise
    print(f'Deployed {len(files)} modules; backup: {backup}')
    return 0

if __name__=='__main__': raise SystemExit(main())
