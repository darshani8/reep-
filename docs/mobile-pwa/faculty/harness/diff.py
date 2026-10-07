"""Pixel-diff two screenshot folders from shoot.mjs.

    python3 diff.py <dirA> <dirB>

Pairs files by name after stripping the tag (`mentees-before.png` and
`mentees-after.png` both pair as `mentees`), prints IDENTICAL or the bounding
box of what changed, and exits 1 if anything differs. Needs Pillow.
"""
import os
import re
import sys

from PIL import Image, ImageChops


def keyed(folder):
    return {re.sub(r"-[^-]+\.png$", "", f): os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".png")}


a, b = keyed(sys.argv[1]), keyed(sys.argv[2])
changed = 0
for name in sorted(set(a) | set(b)):
    if name not in a or name not in b:
        print(f"{name}: only in {'A' if name in a else 'B'}")
        changed += 1
        continue
    ia, ib = Image.open(a[name]).convert("RGB"), Image.open(b[name]).convert("RGB")
    box = None if ia.size != ib.size else ImageChops.difference(ia, ib).getbbox()
    if ia.size != ib.size:
        print(f"{name}: SIZE {ia.size} vs {ib.size}")
        changed += 1
    elif box:
        print(f"{name}: DIFF {box}")
        changed += 1
    else:
        print(f"{name}: IDENTICAL")
sys.exit(1 if changed else 0)
