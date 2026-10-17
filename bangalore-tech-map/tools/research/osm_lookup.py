#!/usr/bin/env python3
"""osm_lookup.py -- find every OpenStreetMap office POI in Bengaluru whose name matches a regex.
Usage: python3 osm_lookup.py "infosys" ["wipro" ...]     (case-insensitive regex, one JSON line per match)
Use it to discover a company's BRANCHES that OSM mappers have recorded, then confirm each with the web.
A POI's absence here means nothing (OSM coverage is partial); its presence is one piece of evidence."""
import json, os, re, sys, signal
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, "..", "..", "data", "osm", "osm-offices.json"), encoding="utf-8"))
for pat in sys.argv[1:]:
    rx = re.compile(pat, re.I)
    hits = [r for r in rows if r["name"] and (rx.search(r["name"]) or (r.get("brand") and rx.search(r["brand"])) or (r.get("operator") and rx.search(r["operator"])))]
    print(json.dumps({"pattern": pat, "matches": len(hits)}))
    for h in hits[:60]:  # noqa
        print(json.dumps(h, ensure_ascii=False))
