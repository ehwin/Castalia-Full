"""Deploy compiled modules with import preflight, hashes and rollback.

架构：**Lite（Castalia）= 默认记忆引擎**；Anima = 情感变体；Full = 联邦/跨库总线。
所以普通记忆桥跑 Lite，AIRI 跑 Anima，只有联邦接口跑 Full（bus）。

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
MAPPING = [('Castalia', 'run/LobeHub'), ('Castalia', 'run/Castalia'),
           ('Castalia-Full', 'run/Castalia-Federation'), ('Castalia-Anima', 'run/Castalia-Anima')]


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def plan():
    files = []
    stale = []
    for source, target in MAPPING:
        src = ROOT / source / 'dist'
        dst = ROOT / target / 'dist'
        if not (src / 'index.js').is_file() or not dst.is_dir():
            raise ValueError(f'missing build/runtime: {source} -> {target}')
        wanted = set()
        for file in src.rglob('*.js'):
            text = file.read_text(encoding='utf-8')
            for match in re.finditer(r"(?:from\s*|import\s*\()(['\"])(\.[^'\"]+)\1", text):
                module = (file.parent / match.group(2)).resolve()
                if not module.is_file():
                    raise ValueError(f'missing import: {file}: {match.group(2)}')
            dest = dst / file.relative_to(src)
            wanted.add(dest.resolve())
            if not dest.is_file() or sha(file) != sha(dest):
                files.append((file, dest))
        # 运行时多余模块（旧版残留 / 已迁走的 bus 模块）：一并清掉，保证 dist == 源
        for file in dst.rglob('*.js'):
            if file.resolve() not in wanted:
                stale.append(file)
    return files, stale


def atomic_copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dst.parent, prefix='.deploy-'); os.close(fd)
    try:
        shutil.copy2(src, tmp); os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true'); args = parser.parse_args()
    files, stale = plan()
    print(json.dumps({'mapping': MAPPING, 'changedModules': len(files), 'staleModules': len(stale)}, ensure_ascii=False))
    if not args.apply:
        return 1 if (files or stale) else 0
    backup = ROOT / '_归档' / ('runtime-deploy-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True)
    manifest = []
    # Save every old file (and every stale file) before the first runtime mutation.
    for src, dst in files:
        old = backup / dst.relative_to(ROOT)
        if dst.exists():
            old.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(dst, old)
        manifest.append({'source': str(src.relative_to(ROOT)), 'target': str(dst.relative_to(ROOT)),
                         'sha256': sha(src), 'existed': dst.exists()})
    for dst in stale:
        old = backup / dst.relative_to(ROOT)
        old.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(dst, old)
        manifest.append({'source': None, 'target': str(dst.relative_to(ROOT)),
                         'sha256': None, 'existed': True, 'deleted': True})
    (backup / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    installed = []
    try:
        for (src, dst), item in zip(files, manifest):
            atomic_copy(src, dst); installed.append((dst, item))
            if sha(dst) != item['sha256']:
                raise ValueError(f'hash mismatch: {dst}')
        for dst in stale:
            dst.unlink(missing_ok=True)
    except BaseException:
        for dst, item in reversed(installed):
            if item['existed']:
                atomic_copy(backup / dst.relative_to(ROOT), dst)
            else:
                dst.unlink(missing_ok=True)
        raise
    print(f'Deployed {len(files)} modules, pruned {len(stale)} stale; backup: {backup}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
