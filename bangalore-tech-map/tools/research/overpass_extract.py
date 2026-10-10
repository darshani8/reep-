#!/usr/bin/env python3
"""Pull every NAMED office POI and every tech/business park polygon inside the Bengaluru box from OSM.
Writes ../data/osm-offices.json and ../data/osm-techparks.json. Run once; it is slow (minutes)."""
import json, os, sys, time, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "data", "osm")
MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter"]
BBOX = "12.75,77.35,13.25,77.90"
UA = "bangalore-tech-map-research/0.1 (student project; contact via github darshani8)"

def run(q):
    last = None
    for m in MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(m, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.loads(r.read().decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                last = exc; time.sleep(5)
    raise SystemExit(f"overpass failed: {last}")

OFFICES = f"""[out:json][timeout:280];
( node["office"]["name"]({BBOX}); way["office"]["name"]({BBOX}); relation["office"]["name"]({BBOX});
  node["building"~"^(office|commercial)$"]["name"]({BBOX}); way["building"~"^(office|commercial)$"]["name"]({BBOX}); );
out center tags;"""
PARKS = f"""[out:json][timeout:280];
( way["landuse"~"^(commercial|industrial)$"]["name"]({BBOX}); relation["landuse"~"^(commercial|industrial)$"]["name"]({BBOX});
  way["name"~"Tech ?Park|Tech ?Village|Business Park|Ecoworld|Ecospace|SEZ|IT Park|Software|Techno|Campus|Knowledge Park|Technopolis|Tech Zone|Tech Square",i]["landuse"]({BBOX});
  way["name"~"Tech ?Park|Tech ?Village|Business Park|Ecoworld|Ecospace|SEZ|IT Park|Technopolis|Tech Zone|Tech Square",i]["building"]({BBOX}); );
out geom tags;"""

os.makedirs(DATA, exist_ok=True)
off = run(OFFICES)
rows = []
for el in off.get("elements", []):
    t = el.get("tags", {})
    lat = el.get("lat") or (el.get("center") or {}).get("lat"); lon = el.get("lon") or (el.get("center") or {}).get("lon")
    if lat is None: continue
    rows.append({"osm": f"{el['type']}/{el['id']}", "name": t.get("name"), "office": t.get("office"), "building": t.get("building"),
                 "brand": t.get("brand"), "operator": t.get("operator"), "website": t.get("website") or t.get("contact:website"),
                 "street": t.get("addr:street"), "housenumber": t.get("addr:housenumber"), "suburb": t.get("addr:suburb") or t.get("addr:city"),
                 "postcode": t.get("addr:postcode"), "lat": round(lat, 6), "lng": round(lon, 6)})
json.dump(rows, open(os.path.join(DATA, "osm-offices.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("offices:", len(rows))
time.sleep(3)
parks = run(PARKS)
prow = []
for el in parks.get("elements", []):
    t = el.get("tags", {}); geom = el.get("geometry") or []
    if el["type"] == "relation":
        geom = [g for m in el.get("members", []) for g in (m.get("geometry") or [])]
    if not geom: continue
    lats = [g["lat"] for g in geom]; lons = [g["lon"] for g in geom]
    prow.append({"osm": f"{el['type']}/{el['id']}", "name": t.get("name"), "landuse": t.get("landuse"), "building": t.get("building"),
                 "operator": t.get("operator"), "lat": round(sum(lats)/len(lats), 6), "lng": round(sum(lons)/len(lons), 6),
                 "bbox": [round(min(lats),6), round(max(lats),6), round(min(lons),6), round(max(lons),6)],
                 "ring": [[round(g["lon"],6), round(g["lat"],6)] for g in geom] if el["type"] == "way" else None})
json.dump(prow, open(os.path.join(DATA, "osm-techparks.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("parks:", len(prow))
