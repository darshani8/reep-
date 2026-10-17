#!/usr/bin/env python3
"""geocode.py -- geocode place names INSIDE Bengaluru, cached, rate-limited.

Usage:
  python3 geocode.py "Manyata Tech Park" "Embassy TechVillage, Bellandur" ...
  python3 geocode.py --file queries.txt        # one query per line

Prints ONE JSON object per line, in input order:
  {"query": ..., "lat": 13.04, "lng": 77.62, "display_name": ..., "source": "nominatim"|"photon"|null,
   "osm_type": ..., "osm_id": ..., "bbox": [south, north, west, east] | null, "ok": true|false}

Rules baked in:
  * Results are RESTRICTED to the Bengaluru metro box (lat 12.75..13.25, lng 77.35..77.90).
    Anything outside is discarded -> ok:false. Never geocode something outside Bangalore with this.
  * Nominatim first (1.1 s between calls -- their usage policy), Photon (komoot) as fallback.
  * Cache at ../data/geocode-cache.json so repeated runs cost nothing. Delete an entry to re-query.
  * Appending ", Bengaluru" to a bare name is done for you.
"""
import fcntl, json, os, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "..", "..", "data", "geocode-cache.json")
LOCK = CACHE + ".lock"
STAMP = CACHE + ".last"
UA = "bangalore-tech-map-research/0.1 (student project; contact via github darshani8)"
S, N, W, E = 12.75, 13.25, 77.35, 77.90


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _inside(lat, lng):
    return S <= lat <= N and W <= lng <= E


def _nominatim(q):
    # Cross-process politeness: Nominatim allows ~1 request/second for the whole app, and many
    # research agents call this script at once, so the last-call stamp lives in a file.
    try:
        last = float(open(STAMP).read().strip())
    except Exception:  # noqa: BLE001
        last = 0.0
    wait = 1.1 - (time.time() - last)
    if wait > 0:
        time.sleep(wait)
    with open(STAMP, "w") as fh:
        fh.write(str(time.time()))
    params = {"q": q, "format": "jsonv2", "limit": 5, "viewbox": f"{W},{N},{E},{S}", "bounded": 1,
              "countrycodes": "in"}
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    try:
        rows = _get(url)
    except Exception as exc:  # noqa: BLE001
        return None, f"nominatim error: {exc}"
    for row in rows:
        lat, lng = float(row["lat"]), float(row["lon"])
        if _inside(lat, lng):
            bb = row.get("boundingbox")
            return {"lat": lat, "lng": lng, "display_name": row.get("display_name"), "source": "nominatim",
                    "osm_type": row.get("osm_type"), "osm_id": row.get("osm_id"),
                    "bbox": [float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])] if bb else None}, None
    return None, "nominatim: no result inside Bengaluru"


def _photon(q):
    params = {"q": q, "limit": 5, "lat": 12.97, "lon": 77.59, "bbox": f"{W},{S},{E},{N}"}
    url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode(params)
    try:
        data = _get(url)
    except Exception as exc:  # noqa: BLE001
        return None, f"photon error: {exc}"
    for f in data.get("features", []):
        lng, lat = f["geometry"]["coordinates"]
        if _inside(lat, lng):
            p = f.get("properties", {})
            ext = p.get("extent")  # [minLon, maxLat, maxLon, minLat]
            name = ", ".join(x for x in [p.get("name"), p.get("street"), p.get("district"), p.get("city") or "Bengaluru"] if x)
            return {"lat": lat, "lng": lng, "display_name": name, "source": "photon",
                    "osm_type": p.get("osm_type"), "osm_id": p.get("osm_id"),
                    "bbox": [ext[3], ext[1], ext[0], ext[2]] if ext else None}, None
    return None, "photon: no result inside Bengaluru"


def geocode(q, cache):
    key = q.strip().lower()
    if key in cache:
        return cache[key]
    query = q if "bengaluru" in key or "bangalore" in key else f"{q}, Bengaluru"
    hit, err = _nominatim(query)
    if hit is None:
        hit, err2 = _photon(query)
        err = f"{err}; {err2}"
    out = {"query": q, **(hit or {"lat": None, "lng": None, "display_name": None, "source": None,
                                   "osm_type": None, "osm_id": None, "bbox": None}), "ok": hit is not None}
    if hit is None:
        out["error"] = err
    cache[key] = out
    return out


def main(argv):
    queries = []
    if len(argv) >= 2 and argv[0] == "--file":
        with open(argv[1], encoding="utf-8") as fh:
            queries = [ln.strip() for ln in fh if ln.strip()]
    else:
        queries = argv
    if not queries:
        print(__doc__)
        return 2
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    for q in queries:
        with open(LOCK, "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                cache = {}
                if os.path.exists(CACHE):
                    try:
                        with open(CACHE, encoding="utf-8") as fh:
                            cache = json.load(fh)
                    except json.JSONDecodeError:
                        cache = {}
                out = geocode(q, cache)
                tmp = CACHE + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(cache, fh, ensure_ascii=False, indent=0, sort_keys=True)
                os.replace(tmp, CACHE)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        print(json.dumps(out, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
