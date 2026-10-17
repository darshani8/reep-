#!/usr/bin/env python3
"""Fill the README's "Dataset at a glance" block from public/data/dataset.json. Run after merge.py."""
import collections, json, os, re
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
d = json.load(open(os.path.join(ROOT, "public", "data", "dataset.json"), encoding="utf-8"))
cs, ps = d["companies"], d["techParks"]
cat = collections.Counter(c["category"] for c in cs)
conf = collections.Counter(o["confidence"] for c in cs for o in c["offices"])
offices = sum(len(c["offices"]) for c in cs)
multi = sum(1 for c in cs if len(c["offices"]) > 1)
by_park = collections.Counter(o["techParkId"] for c in cs for o in c["offices"] if o["techParkId"])
names = {p["id"]: p["name"] for p in ps}
top = ", ".join(f"{names[k]} ({n})" for k, n in by_park.most_common(6) if k in names)
block = f"""**Dataset at a glance** (generated {d['generatedAt'][:10]} from {d['provenance']['lenses']} research slices):

| | |
|---|---|
| Companies | **{len(cs)}** — {cat.get('MNC', 0)} MNC, {cat.get('MID_SIZE', 0)} mid-size, {cat.get('STARTUP', 0)} startup, {cat.get('PSU', 0)} PSU |
| Offices (branches) | **{offices}** — {conf.get('high', 0)} well evidenced, {conf.get('medium', 0)} one source, {conf.get('low', 0)} unconfirmed; {multi} companies have more than one Bengaluru office |
| Tech parks and campuses | **{len(ps)}** ({sum(1 for p in ps if p.get('footprint'))} with an OpenStreetMap footprint) |
| Busiest parks | {top} |

Every number above is recomputed by `python3 tools/data/update_readme.py`; `data/report.md` has the full merge log."""
p = os.path.join(ROOT, "README.md")
s = open(p, encoding="utf-8").read()
s = re.sub(r"<!-- GLANCE:START -->.*?<!-- GLANCE:END -->", "<!-- GLANCE:START -->\n" + block + "\n<!-- GLANCE:END -->", s, flags=re.S)
open(p, "w", encoding="utf-8").write(s)
print(block)
