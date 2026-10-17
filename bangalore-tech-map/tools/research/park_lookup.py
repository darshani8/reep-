#!/usr/bin/env python3
"""park_lookup.py -- find tech/business parks and named campuses in the OSM extract by regex.
Usage: python3 park_lookup.py "manyata" "ecoworld|ecospace" ...
Prints one JSON line per match: osm id, name, landuse/building, centroid lat/lng, bbox [S,N,W,E].
Instant and offline; prefer it over geocode.py for a park's centroid."""
import json, os, re, sys, signal
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, "..", "..", "data", "osm", "osm-techparks.json"), encoding="utf-8"))
for pat in sys.argv[1:]:
    rx = re.compile(pat, re.I)
    hits = [r for r in rows if r["name"] and rx.search(r["name"])]
    print(json.dumps({"pattern": pat, "matches": len(hits)}))
    for h in hits[:40]:
        print(json.dumps({k: v for k, v in h.items() if k != "ring"}, ensure_ascii=False))
