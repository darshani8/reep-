#!/usr/bin/env python3
"""qa.py -- deterministic checks over public/data/dataset.json that find records worth a closer look.

    python3 tools/data/qa.py                    # print a summary
    python3 tools/data/qa.py --json out.json    # also write every flag, keyed by company id

It changes nothing. Each flag names a company, the office if any, the check, and a sentence. The
verification pass sends exactly the flagged companies to reviewers, so a check here is cheaper than a
reviewer re-reading a record that is fine.
"""
import argparse
import collections
import json
import math
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SECTORS = {
    "IT services", "Software & internet", "Semiconductors & hardware", "BFSI", "Consulting & professional services",
    "E-commerce & consumer internet", "Fintech", "SaaS", "AI & deep tech", "EdTech", "HealthTech & pharma",
    "Mobility & EV", "Aerospace & defence", "Automotive & industrial", "Energy", "Retail & consumer goods",
    "Telecom & networking", "Media & gaming", "Logistics", "Real estate & infrastructure", "Space", "Other",
}


def km(a_lat, a_lng, b_lat, b_lng):
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    return 2 * r * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def outside_bbox_km(lat, lng, bbox):
    s, n, w, e = bbox
    return km(lat, lng, min(max(lat, s), n), min(max(lng, w), e))


def nk(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def run(path):
    d = json.load(open(path, encoding="utf-8"))
    parks = {p["id"]: p for p in d["techParks"]}
    flags = collections.defaultdict(list)

    def flag(c, check, msg, office=None):
        flags[c["id"]].append({"check": check, "office": office["id"] if office else None, "message": msg})

    for c in d["companies"]:
        if c["sector"] not in SECTORS:
            flag(c, "sector-vocabulary", f"sector '{c['sector']}' is not in the fixed list")
        if c["category"] == "STARTUP" and c.get("founded") and c["founded"] < 2005:
            flag(c, "category", f"STARTUP but founded {c['founded']} (rule: venture-funded and founded 2005 or later)")
        if c["category"] == "PSU" and c["origin"] != "Indian":
            flag(c, "category", "PSU with a foreign parent")
        if all(o["confidence"] == "low" for o in c["offices"]):
            flag(c, "weak-evidence", f"every one of its {len(c['offices'])} offices is unconfirmed")
        if not c["sources"]:
            flag(c, "no-sources", "no source URLs on the company record")
        for o in c["offices"]:
            if not re.search(r"https?://", o["evidence"] or ""):
                flag(c, "evidence-url", "office evidence carries no URL", o)
            p = parks.get(o["techParkId"]) if o["techParkId"] else None
            if p:
                if p.get("bbox"):
                    dist = outside_bbox_km(o["lat"], o["lng"], p["bbox"])
                    if dist > 0.5:
                        flag(c, "pin-vs-park", f"pin is {dist:.1f} km outside {p['name']}'s footprint", o)
                else:
                    dist = km(o["lat"], o["lng"], p["lat"], p["lng"])
                    if dist > 1.5:
                        flag(c, "pin-vs-park", f"pin is {dist:.1f} km from {p['name']}'s centre and the park has no footprint", o)
        offs = c["offices"]
        for i in range(len(offs)):
            for j in range(i + 1, len(offs)):
                a, b = offs[i], offs[j]
                if km(a["lat"], a["lng"], b["lat"], b["lng"]) < 0.4 and a["techParkId"] != b["techParkId"]:
                    flag(c, "near-duplicate-office", f"'{a['label']}' and '{b['label']}' are under 400 m apart but filed under different parks", a)

    # cross-company name overlaps the merge did not join
    names = [(c["id"], c["name"], nk(c["name"])) for c in d["companies"]]
    byid = {c["id"]: c for c in d["companies"]}
    for i, (ia, na, ka) in enumerate(names):
        for ib, nb, kb in names[i + 1:]:
            if min(len(ka), len(kb)) < 4:
                continue
            if (ka.startswith(kb) or kb.startswith(ka)) and abs(len(ka) - len(kb)) <= 14:
                flag(byid[ia], "possible-duplicate", f"name overlaps '{nb}' ({ib}); same organisation or a separate entity?")
                flag(byid[ib], "possible-duplicate", f"name overlaps '{na}' ({ia}); same organisation or a separate entity?")

    tenanted = {o["techParkId"] for c in d["companies"] for o in c["offices"]}
    empty_parks = [p["name"] for p in d["techParks"] if p["id"] not in tenanted]
    return d, flags, empty_parks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=os.path.join(ROOT, "public", "data", "dataset.json"))
    ap.add_argument("--json", help="write every flag here")
    a = ap.parse_args()
    d, flags, empty_parks = run(a.dataset)
    by_check = collections.Counter(f["check"] for fs in flags.values() for f in fs)
    print(f"{len(flags)} of {len(d['companies'])} companies flagged")
    for k, n in by_check.most_common():
        print(f"  {k}: {n}")
    print(f"tech parks with no mapped tenant: {len(empty_parks)}")
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump({"flags": flags, "emptyParks": empty_parks}, fh, ensure_ascii=False, indent=1)
        print("wrote", a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
