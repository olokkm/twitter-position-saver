#!/bin/sh
set -e
cd "$(dirname "$0")/.."

echo "Building gear-extension/content.js from userscript..."
node scripts/build-gear-extension.mjs

echo "Packaging twitter-position-saver-gear.xpi (ZIPFoundation-compatible)..."
rm -f twitter-position-saver-gear.xpi
python3 - <<'PY'
import zipfile
from pathlib import Path

root = Path('gear-extension')
out = Path('twitter-position-saver-gear.xpi')
files = ['manifest.json', 'content.js']

with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for name in files:
        data = (root / name).read_bytes()
        info = zipfile.ZipInfo(filename=name)
        # DOS/FAT + no extra fields — avoids ZIPFoundation quirks on Gear/iOS
        info.create_system = 0
        info.create_version = 20
        info.extract_version = 20
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        zf.writestr(info, data)

with zipfile.ZipFile(out) as zf:
    bad = zf.testzip()
    if bad:
        raise SystemExit(f'Corrupt zip entry: {bad}')
    names = zf.namelist()
    if names != files:
        raise SystemExit(f'Unexpected zip contents: {names}')

print(f'  {out} ({out.stat().st_size} bytes)')
PY

echo "Created:"
echo "  twitter-position-saver-gear.xpi"
