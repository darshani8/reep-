#!/usr/bin/env python3
"""merge.py -- turn the research slices in data/raw/ into public/data/dataset.json.

    python3 tools/data/merge.py            # merge, validate, write dataset + data/report.md
    python3 tools/data/merge.py --check    # validate only, exit 1 on any problem

The slices are what the research agents wrote (one file per lens; see data/raw/README.md).
This script is DETERMINISTIC and ADDITIVE in spirit: it never invents a coordinate, never
guesses a category it was not given, and reports everything it drops.

Merging rules, in words:
  * A COMPANY is identified by the normalised form of its name and every alias it was given
    (legal suffixes and punctuation stripped). Records sharing a key are one company; the
    record with the most sources names it, the others' names become aliases.
  * A TECH PARK is identified the same way, plus the hand-kept CANON table below so that
    "ITPL", "ITPB" and "International Tech Park Bangalore" are one park. An office whose
    `techPark` names a park nobody described gets a STUB park (centroid of its offices, marked
    unverified) rather than losing the link.
  * Two OFFICES of one company are one office when they sit in the same park and building, or
    within 150 m of each other. The better-evidenced one wins; when two different lenses agree
    the confidence is raised to "high", because independent agreement is what "high" means.
  * Anything outside the Bengaluru box is DROPPED and reported, never nudged inside.
  * After the merge, every file in data/corrections/ is applied in name order: a verification
    pass may DROP a company or an office, SET fields on either, ADD an office, MERGE one company
    into another or one park into another. Every correction carries a note, and the report lists
    each one applied and each one that named nothing (a stale id after a re-merge).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(ROOT, "data", "raw")
CORRECTIONS = os.path.join(ROOT, "data", "corrections")
OSM_PARKS = os.path.join(ROOT, "data", "osm", "osm-techparks.json")
OUT = os.path.join(ROOT, "public", "data", "dataset.json")
REPORT = os.path.join(ROOT, "data", "report.md")

BOUNDS = {"south": 12.75, "north": 13.25, "west": 77.35, "east": 77.90}
CATEGORIES = ("MNC", "MID_SIZE", "STARTUP", "PSU")
ORIGINS = ("Indian", "Foreign")
STATUSES = ("active", "closing", "closed", "planned")
CONFIDENCES = ("high", "medium", "low")
CONF_RANK = {"low": 0, "medium": 1, "high": 2}
SAME_OFFICE_METRES = 150

# Park names that research will spell several ways. Keys and values are NORMALISED (see nk()).
PARK_CANON = {
    "itpl": "internationaltechparkbangalore",
    "itpb": "internationaltechparkbangalore",
    "internationaltechparkbengaluru": "internationaltechparkbangalore",
    "internationaltechnologyparkbangalore": "internationaltechparkbangalore",
    "embassymanyata": "manyata",
    "manyataembassy": "manyata",
    "embassymanyatabusinesspark": "manyata",
    "manyataembassybusinesspark": "manyata",
    "manyatatechpark": "manyata",
    "vrindavantechvillage": "embassytechvillage",
    "embassytechvillage": "embassytechvillage",
    "etv": "embassytechvillage",
    "embassygolflinks": "embassygolflinksbusinesspark",
    "egl": "embassygolflinksbusinesspark",
    "ecoworld": "rmzecoworld",
    "ecospace": "rmzecospace",
    "bagmanewtc": "bagmaneworldtechnologycenter",
    "bagmaneworldtechnologycentre": "bagmaneworldtechnologycenter",
    "electroniccityphase1": "electronicscityphase1",
    "electroniccityphase2": "electronicscityphase2",
    "electroniccity": "electronicscity",
    "worldtradecenterbengaluru": "worldtradecenterbengalurubrigadegateway",
    "wtcbengaluru": "worldtradecenterbengalurubrigadegateway",
    "brigadegateway": "worldtradecenterbengalurubrigadegateway",
    "globalvillage": "globalvillagetechpark",
    "cessna": "cessnabusinesspark",
    "prestigetechpark": "prestigetechpark",
    "karletowncentre": "karletowncentresez",
    "karletowncenter": "karletowncentresez",
    "bhartiyacity": "bhartiyacentreofinformationtechnology",
    "bhartiyacentreforit": "bhartiyacentreofinformationtechnology",
    "salarpuriasoftzone": "salarpuriasattvasoftzone",
    "sattvasoftzone": "salarpuriasattvasoftzone",
    "pritechpark": "pritechparksez",
    "jfwtc": "johnfwelchtechnologycentre",
    "johnfwelchtechnologycenter": "johnfwelchtechnologycentre",
    "saplabsindia": "saplabsindiacampus",
    "bengaluruaerospacepark": "bengaluruaerospacepark",
    "aerospacepark": "bengaluruaerospacepark",
    "hitechdefenceandaerospacepark": "bengaluruaerospacepark",
    "wiprosez": "wiprosezsarjapur",
    "wiprosarjapur": "wiprosezsarjapur",
}
COMPANY_CANON = {
    "jpmorgan": "jpmorganchase",
    "jpmorganchaseco": "jpmorganchase",
    "walmartlabs": "walmartglobaltech",
    "flipkartinternet": "flipkart",
    "goldmansachsservices": "goldmansachs",
    "mindtree": "ltimindtree",
    "lttechnologyservices": "lttechnologyservices",
    "larsentoubrotechnologyservices": "lttechnologyservices",
    "cerner": "oraclehealth",
    "boschglobalsoftwaretechnologies": "boschglobalsoftwaretechnologies",
    "robertboschengineeringandbusinesssolutions": "boschglobalsoftwaretechnologies",
    "infosystechnologies": "infosys",
    "tataconsultancyservices": "tcs",
    "hcltechnologies": "hcltech",
    "hindustanaeronautics": "hal",
    "bharatelectronics": "bel",
    "samsungrdinstitutebangalore": "samsungrdinstituteindiabangalore",
    "sribbangalore": "samsungrdinstituteindiabangalore",
    "microsoftindia": "microsoft",
    "googleindia": "google",
    "amazonindia": "amazon",
    "amazondevelopmentcentreindia": "amazon",
    "amazondevelopmentcenterindia": "amazon",
    "ibmindia": "ibm",
    "oracleindia": "oracle",
    "sapindia": "sap",
    "saplabsindia": "sap",
    "ciscoindia": "cisco",
    "cisco systems": "cisco",
    "intelindia": "intel",
    "nvidiagraphics": "nvidia",
    "qualcommindia": "qualcomm",
    "texasinstrumentsindia": "texasinstruments",
    "wellsfargointernationalsolutions": "wellsfargo",
    "morganstanleyadvantageservices": "morganstanley",
    "societegeneraleglobalsolutioncentre": "societegenerale",
    "anzbengaluru": "anz",
    "anzoperationsandtechnology": "anz",
    "shelltechnologycentrebangalore": "shell",
    "shellindiamarkets": "shell",
    "mercedesbenzresearchanddevelopmentindia": "mercedesbenzresearchanddevelopmentindia",
    "mbrdi": "mercedesbenzresearchanddevelopmentindia",
    "boeingindiaengineeringandtechnologycenter": "boeing",
    "boeingindia": "boeing",
    "targetindia": "target",
    "targetinindia": "target",
    "tescobengaluru": "tesco",
    "loweindia": "lowes",
    "lowesindia": "lowes",
    "lowescompanies": "lowes",
    "accentureindia": "accenture",
    "deloitteindia": "deloitte",
    "deloitteusi": "deloitte",
    "eyindia": "ey",
    "ernstyoung": "ey",
    "kpmgindia": "kpmg",
    "pwcindia": "pwc",
    "pricewaterhousecoopers": "pwc",
    "wiprolimited": "wipro",
    "infosyslimited": "infosys",
    "swiggybundltechnologies": "swiggy",
    "bundltechnologies": "swiggy",
    "olacabs": "ola",
    "anitechnologies": "ola",
    "phonepeprivatelimited": "phonepe",
    "razorpaysoftware": "razorpay",
    "zerodhabroking": "zerodha",
    "meeshofashnear": "meesho",
    "fashneartechnologies": "meesho",
    "bigbasketsupermarketgrocerysupplies": "bigbasket",
    "supermarketgrocerysupplies": "bigbasket",
    "byjusthinkandlearn": "byjus",
    "thinkandlearn": "byjus",
    "credd": "cred",
    "dreamplugtechnologies": "cred",
    "curefit": "cultfit",
    "cure fit": "cultfit",
    "athenaenergy": "atherenergy",
    "dailyhunt": "verseinnovation",
    "mohallatech": "sharechat",
    "udaanhiveloop": "udaan",
    "hivelooptechnology": "udaan",
}
LEGAL_SUFFIXES = (
    "private limited", "pvt ltd", "pvt. ltd.", "pvt. ltd", "pvt ltd.", "limited", "ltd.", "ltd", "inc.", "inc",
    "llc", "l.l.c.", "corporation", "corp.", "corp", "plc", "co.", "gmbh", "s.a.", "ag", "nv", "n.v.", "se",
    "india private limited", "india pvt ltd", "india ltd", "india limited", "india",
)


def nk(text: str) -> str:
    """Normalised key: lower-case, legal suffixes gone, nothing but a-z0-9 left."""
    t = (text or "").strip().lower()
    t = t.replace("&", " and ")
    t = re.sub(r"\s+", " ", t)
    changed = True
    while changed:
        changed = False
        for suf in LEGAL_SUFFIXES:
            if t.endswith(" " + suf) or t == suf:
                t = t[: -len(suf)].strip() if t != suf else ""
                changed = True
    t = re.sub(r"\((.*?)\)", r" \1 ", t)
    return re.sub(r"[^a-z0-9]+", "", t)


def park_key(name: str) -> str:
    k = nk(name)
    return PARK_CANON.get(k, k)


def company_key(name: str) -> str:
    k = nk(name)
    return COMPANY_CANON.get(k, k)


def slugify(text: str) -> str:
    t = text.lower().replace("&", " and ")
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t or "x"


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def inside(lat, lng) -> bool:
    try:
        return BOUNDS["south"] <= float(lat) <= BOUNDS["north"] and BOUNDS["west"] <= float(lng) <= BOUNDS["east"]
    except (TypeError, ValueError):
        return False


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def load_slices():
    slices = []
    for fn in sorted(os.listdir(RAW)) if os.path.isdir(RAW) else []:
        if not fn.endswith(".json"):
            continue
        path = os.path.join(RAW, fn)
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except json.JSONDecodeError as exc:
            print(f"!! {fn}: not valid JSON ({exc}); skipped", file=sys.stderr)
            continue
        key = data.get("key") or fn[:-5]
        slices.append((key, data))
    return slices


# ----------------------------------------------------------------------------- tech parks

def merge_parks(slices, problems):
    uf = UnionFind()
    records = []  # (key_root_candidate, record, lens)
    for lens, data in slices:
        for p in data.get("techParks") or []:
            name = (p.get("name") or "").strip()
            if not name:
                continue
            keys = [park_key(name)] + [park_key(a) for a in (p.get("aliases") or []) if a]
            keys = [k for k in keys if k]
            if not keys:
                continue
            for k in keys[1:]:
                uf.union(keys[0], k)
            records.append((keys[0], p, lens))
    groups = defaultdict(list)
    for k, p, lens in records:
        groups[uf.find(k)].append((p, lens))

    parks = {}
    for root, items in groups.items():
        # the record with the most sources names the park; others become aliases
        items.sort(key=lambda it: (-len(it[0].get("sources") or []), -len(it[0].get("description") or "")))
        best, lens0 = items[0]
        name = best["name"].strip()
        aliases = []
        sources, tenants, lenses = [], [], []
        lats, lngs, bboxes, sizes, developers, descs = [], [], [], [], [], []
        for p, lens in items:
            lenses.append(lens)
            for a in [p.get("name")] + list(p.get("aliases") or []):
                a = (a or "").strip()
                if a and a != name and a not in aliases:
                    aliases.append(a)
            sources += [s for s in (p.get("sources") or []) if s]
            tenants += [t for t in (p.get("notableTenants") or []) if t]
            if inside(p.get("lat"), p.get("lng")):
                lats.append(float(p["lat"])); lngs.append(float(p["lng"]))
            else:
                problems.append(f"park '{p.get('name')}' ({lens}): coordinates outside Bengaluru or missing: {p.get('lat')},{p.get('lng')}")
            bb = p.get("bbox")
            if isinstance(bb, list) and len(bb) == 4 and all(isinstance(x, (int, float)) for x in bb):
                bboxes.append([float(x) for x in bb])
            if isinstance(p.get("areaSqFtMillions"), (int, float)):
                sizes.append(float(p["areaSqFtMillions"]))
            if p.get("developer"):
                developers.append(p["developer"].strip())
            if p.get("description"):
                descs.append(p["description"].strip())
        if not lats:
            problems.append(f"park '{name}': no usable coordinates in any slice; dropped")
            continue
        lat = sorted(lats)[len(lats) // 2]
        lng = sorted(lngs)[len(lngs) // 2]
        bbox = None
        if bboxes:
            bbox = [min(b[0] for b in bboxes), max(b[1] for b in bboxes), min(b[2] for b in bboxes), max(b[3] for b in bboxes)]
        parks[root] = {
            "id": slugify(name),
            "name": name,
            "aliases": aliases,
            "locality": (best.get("locality") or next((p.get("locality") for p, _ in items if p.get("locality")), "") or "").strip(),
            "developer": Counter(developers).most_common(1)[0][0] if developers else None,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "bbox": [round(x, 6) for x in bbox] if bbox else None,
            "areaSqFtMillions": round(max(sizes), 2) if sizes else None,
            "description": max(descs, key=len) if descs else "",
            "notableTenants": sorted(set(tenants), key=str.lower),
            "sources": sorted(set(sources)),
            "footprint": None,
            "verified": True,
            "_keys": set(uf.find(k) for k in [root]),
            "_lenses": sorted(set(lenses)),
        }
    return parks, uf


def resolve_park(parks, uf, name):
    if not name:
        return None
    k = park_key(name)
    root = uf.find(k)
    if root in parks:
        return root
    # a park referenced by key the union-find never saw: try the raw key
    return k if k in parks else None


# ----------------------------------------------------------------------------- companies

def merge_companies(slices, parks, uf, problems):
    cuf = UnionFind()
    records = []
    for lens, data in slices:
        for c in data.get("companies") or []:
            name = (c.get("name") or "").strip()
            if not name:
                continue
            keys = [company_key(name)] + [company_key(a) for a in (c.get("aliases") or []) if a]
            keys = [k for k in keys if k]
            for k in keys[1:]:
                cuf.union(keys[0], k)
            records.append((keys[0], c, lens))
    groups = defaultdict(list)
    for k, c, lens in records:
        groups[cuf.find(k)].append((c, lens))

    companies = []
    stub_parks = {}
    for root, items in groups.items():
        items.sort(key=lambda it: (0 if it[1].startswith("E") else 1, -len(it[0].get("sources") or []), -len(it[0].get("offices") or [])))
        best, lens0 = items[0]
        name = best["name"].strip()
        aliases, sources, lenses = [], [], []
        cats, origins, sectors, descs, websites, founded, heads, unicorn = [], [], [], [], [], [], [], False
        hq_country, hq_city = [], []
        raw_offices = []
        for c, lens in items:
            lenses.append(lens)
            for a in [c.get("name")] + list(c.get("aliases") or []):
                a = (a or "").strip()
                if a and a != name and a not in aliases:
                    aliases.append(a)
            sources += [s for s in (c.get("sources") or []) if s]
            if c.get("category") in CATEGORIES:
                cats.append(c["category"])
            if c.get("origin") in ORIGINS:
                origins.append(c["origin"])
            if c.get("sector"):
                sectors.append(c["sector"].strip())
            if c.get("description"):
                descs.append(c["description"].strip())
            if c.get("website"):
                websites.append(c["website"].strip())
            if isinstance(c.get("founded"), int):
                founded.append(c["founded"])
            if isinstance(c.get("bengaluruEmployeesApprox"), int):
                heads.append(c["bengaluruEmployeesApprox"])
            if c.get("isUnicorn"):
                unicorn = True
            if c.get("hqCountry"):
                hq_country.append(c["hqCountry"].strip())
            if c.get("hqCity"):
                hq_city.append(c["hqCity"].strip())
            for o in c.get("offices") or []:
                raw_offices.append((o, lens))
        if not cats:
            problems.append(f"company '{name}': no category in any slice; dropped")
            continue

        offices = []
        for o, lens in raw_offices:
            lat, lng = o.get("lat"), o.get("lng")
            if not inside(lat, lng):
                problems.append(f"office of '{name}' ({lens}) '{o.get('label')}': outside Bengaluru or missing coordinates ({lat},{lng}); dropped")
                continue
            park_name = o.get("techPark")
            park_root = resolve_park(parks, uf, park_name) if park_name else None
            if park_name and not park_root:
                k = park_key(park_name)
                stub = stub_parks.setdefault(k, {"name": park_name.strip(), "offices": [], "localities": []})
                stub["offices"].append((float(lat), float(lng)))
                if o.get("locality"):
                    stub["localities"].append(o["locality"])
                park_root = "stub:" + k
            offices.append({
                "label": (o.get("label") or "").strip() or "Bengaluru office",
                "_parkRoot": park_root,
                "building": (o.get("building") or None),
                "locality": (o.get("locality") or "").strip(),
                "address": (o.get("address") or "").strip(),
                "lat": round(float(lat), 6),
                "lng": round(float(lng), 6),
                "isHq": bool(o.get("isHq")),
                "status": o.get("status") if o.get("status") in STATUSES else "active",
                "confidence": o.get("confidence") if o.get("confidence") in CONFIDENCES else "low",
                "evidence": (o.get("evidence") or "").strip(),
                "_lens": lens,
            })
        offices = dedupe_offices(offices)
        if not offices:
            problems.append(f"company '{name}': no office inside Bengaluru survived; dropped")
            continue
        cat = Counter(cats).most_common(1)[0][0]
        companies.append({
            "id": slugify(name),
            "name": name,
            "aliases": aliases,
            "category": cat,
            "origin": Counter(origins).most_common(1)[0][0] if origins else "Foreign",
            "hqCountry": Counter(hq_country).most_common(1)[0][0] if hq_country else None,
            "hqCity": Counter(hq_city).most_common(1)[0][0] if hq_city else None,
            "sector": Counter(sectors).most_common(1)[0][0] if sectors else "Other",
            "description": max(descs, key=len) if descs else "",
            "website": websites[0] if websites else None,
            "founded": Counter(founded).most_common(1)[0][0] if founded else None,
            "bengaluruEmployeesApprox": sorted(heads)[len(heads) // 2] if heads else None,
            "isUnicorn": unicorn,
            "offices": offices,
            "sources": sorted(set(sources)),
            "_lenses": sorted(set(lenses)),
        })
    return companies, stub_parks


def dedupe_offices(offices):
    """Same park+building, or within SAME_OFFICE_METRES, is one office. Best evidence wins; two
    lenses agreeing raises confidence to high."""
    offices = sorted(offices, key=lambda o: (-CONF_RANK[o["confidence"]], 0 if o["isHq"] else 1, -len(o["evidence"])))
    kept = []
    for o in offices:
        merged = False
        for k in kept:
            same_place = (
                o["_parkRoot"] and o["_parkRoot"] == k["_parkRoot"]
                and nk(o["building"] or "") == nk(k["building"] or "")
            )
            close = haversine_m(o["lat"], o["lng"], k["lat"], k["lng"]) <= SAME_OFFICE_METRES
            if same_place or close:
                k["isHq"] = k["isHq"] or o["isHq"]
                if o["_lens"] != k["_lens"] and CONF_RANK[o["confidence"]] >= 1 and CONF_RANK[k["confidence"]] >= 1:
                    k["confidence"] = "high"
                if not k["building"] and o["building"]:
                    k["building"] = o["building"]
                if not k["address"] and o["address"]:
                    k["address"] = o["address"]
                if not k["_parkRoot"] and o["_parkRoot"]:
                    k["_parkRoot"] = o["_parkRoot"]
                k.setdefault("_corroborated_by", set()).add(o["_lens"])
                merged = True
                break
        if not merged:
            kept.append(o)
    return kept


# ----------------------------------------------------------------------------- corrections

COMPANY_FIELDS = ("name", "category", "origin", "hqCountry", "hqCity", "sector", "description", "website", "founded",
                  "bengaluruEmployeesApprox", "isUnicorn")
OFFICE_FIELDS = ("label", "building", "locality", "address", "lat", "lng", "isHq", "status", "confidence", "evidence")
PARK_FIELDS = ("name", "locality", "developer", "lat", "lng", "bbox", "areaSqFtMillions", "description")


def load_corrections():
    out = []
    if not os.path.isdir(CORRECTIONS):
        return out
    for fn in sorted(os.listdir(CORRECTIONS)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(CORRECTIONS, fn), encoding="utf-8") as fh:
                out.append((fn[:-5], json.load(fh)))
        except json.JSONDecodeError as exc:
            print(f"!! corrections {fn}: not valid JSON ({exc}); skipped", file=sys.stderr)
    return out


def _find_company(companies, ref):
    """A correction names a company by id, by exact name, or by normalised name/alias."""
    if not ref:
        return None
    for c in companies:
        if c["id"] == ref or c["name"] == ref:
            return c
    k = company_key(ref)
    for c in companies:
        if company_key(c["name"]) == k or any(company_key(a) == k for a in c["aliases"]):
            return c
    return None


def _find_park(parks, ref):
    if not ref:
        return None
    for p in parks.values():
        if p["id"] == ref or p["name"] == ref:
            return p
    k = park_key(ref)
    for p in parks.values():
        if park_key(p["name"]) == k or any(park_key(a) == k for a in p["aliases"]):
            return p
    return None


def apply_corrections(companies, parks, uf, applied, problems):
    """Mutates `companies` (list) and `parks` (dict) in place. Runs BEFORE ids are finalised, so an
    office is addressed by its company plus its 1-based position or its label."""
    for key, data in load_corrections():
        for cx in data.get("corrections") or []:
            ref = cx.get("company")
            company = _find_company(companies, ref)
            if company is None:
                problems.append(f"correction {key}: company '{ref}' not found (stale after a re-merge?); ignored")
                continue
            verdict = cx.get("verdict", "keep")
            note = (cx.get("note") or "").strip()
            if verdict == "drop":
                companies.remove(company)
                applied.append(f"{key}: dropped '{company['name']}' - {note}")
                continue
            if verdict == "merge_into":
                target = _find_company(companies, cx.get("into"))
                if target is None or target is company:
                    problems.append(f"correction {key}: merge target '{cx.get('into')}' for '{company['name']}' not found; ignored")
                    continue
                for a in [company["name"]] + company["aliases"]:
                    if a != target["name"] and a not in target["aliases"]:
                        target["aliases"].append(a)
                target["offices"] = dedupe_offices(target["offices"] + company["offices"])
                target["sources"] = sorted(set(target["sources"]) | set(company["sources"]))
                companies.remove(company)
                applied.append(f"{key}: merged '{company['name']}' into '{target['name']}' - {note}")
                continue
            for f, v in (cx.get("set") or {}).items():
                if f in COMPANY_FIELDS:
                    if f == "category" and v not in CATEGORIES:
                        problems.append(f"correction {key}: bad category '{v}' for '{company['name']}'; ignored"); continue
                    if f == "origin" and v not in ORIGINS:
                        problems.append(f"correction {key}: bad origin '{v}' for '{company['name']}'; ignored"); continue
                    company[f] = v
                    applied.append(f"{key}: '{company['name']}'.{f} = {v!r} - {note}")
            for ox in cx.get("offices") or []:
                office = _find_office(company, ox.get("office"))
                if office is None:
                    problems.append(f"correction {key}: office '{ox.get('office')}' of '{company['name']}' not found; ignored")
                    continue
                onote = (ox.get("note") or note).strip()
                if ox.get("verdict") == "drop":
                    company["offices"].remove(office)
                    applied.append(f"{key}: dropped office '{office['label']}' of '{company['name']}' - {onote}")
                    continue
                for f, v in (ox.get("set") or {}).items():
                    if f == "techPark":
                        root = resolve_park(parks, uf, v) if v else None
                        if v and root is None:
                            problems.append(f"correction {key}: park '{v}' for office of '{company['name']}' not found; ignored"); continue
                        office["_parkRoot"] = root
                        applied.append(f"{key}: office '{office['label']}' of '{company['name']}' moved to park {v!r} - {onote}")
                    elif f in OFFICE_FIELDS:
                        if f in ("lat", "lng"):
                            nl = v if f == "lat" else office["lat"]; ng = v if f == "lng" else office["lng"]
                            if not inside(nl, ng):
                                problems.append(f"correction {key}: new coordinates for '{company['name']}' office are outside Bengaluru; ignored"); continue
                        if f == "status" and v not in STATUSES:
                            problems.append(f"correction {key}: bad status '{v}'; ignored"); continue
                        if f == "confidence" and v not in CONFIDENCES:
                            problems.append(f"correction {key}: bad confidence '{v}'; ignored"); continue
                        office[f] = v
                        applied.append(f"{key}: office '{office['label']}' of '{company['name']}'.{f} = {v!r} - {onote}")
            for o in cx.get("addOffices") or []:
                lat, lng = o.get("lat"), o.get("lng")
                if not inside(lat, lng):
                    problems.append(f"correction {key}: added office for '{company['name']}' is outside Bengaluru; ignored")
                    continue
                park_name = o.get("techPark")
                root = resolve_park(parks, uf, park_name) if park_name else None
                if park_name and root is None:
                    problems.append(f"correction {key}: park '{park_name}' for added office of '{company['name']}' not found; office added without a park")
                company["offices"].append({
                    "label": (o.get("label") or "Bengaluru office").strip(), "_parkRoot": root, "building": o.get("building") or None,
                    "locality": (o.get("locality") or "").strip(), "address": (o.get("address") or "").strip(),
                    "lat": round(float(lat), 6), "lng": round(float(lng), 6), "isHq": bool(o.get("isHq")),
                    "status": o.get("status") if o.get("status") in STATUSES else "active",
                    "confidence": o.get("confidence") if o.get("confidence") in CONFIDENCES else "medium",
                    "evidence": (o.get("evidence") or "").strip(), "_lens": key,
                })
                company["offices"] = dedupe_offices(company["offices"])
                applied.append(f"{key}: added office '{o.get('label')}' to '{company['name']}' - {note}")
            if company["offices"] == []:
                companies.remove(company)
                problems.append(f"correction {key}: '{company['name']}' lost its last office and was dropped")
        for pm in data.get("parkMerges") or []:
            src = _find_park(parks, pm.get("from")); dst = _find_park(parks, pm.get("into"))
            if src is None or dst is None or src is dst:
                problems.append(f"correction {key}: park merge {pm.get('from')!r} -> {pm.get('into')!r} names an unknown park; ignored")
                continue
            src_root = next(r for r, p in parks.items() if p is src)
            dst_root = next(r for r, p in parks.items() if p is dst)
            for a in [src["name"]] + src["aliases"]:
                if a != dst["name"] and a not in dst["aliases"]:
                    dst["aliases"].append(a)
            dst["notableTenants"] = sorted(set(dst["notableTenants"]) | set(src["notableTenants"]), key=str.lower)
            dst["sources"] = sorted(set(dst["sources"]) | set(src["sources"]))
            if not dst["description"] and src["description"]:
                dst["description"] = src["description"]
            for c in companies:
                for o in c["offices"]:
                    if o.get("_parkRoot") == src_root:
                        o["_parkRoot"] = dst_root
            del parks[src_root]
            applied.append(f"{key}: merged park '{src['name']}' into '{dst['name']}' - {pm.get('note', '')}")
        for pf in data.get("parkFixes") or []:
            park = _find_park(parks, pf.get("park"))
            if park is None:
                problems.append(f"correction {key}: park '{pf.get('park')}' not found; ignored")
                continue
            for f, v in (pf.get("set") or {}).items():
                if f in PARK_FIELDS:
                    if f in ("lat", "lng"):
                        nl = v if f == "lat" else park["lat"]; ng = v if f == "lng" else park["lng"]
                        if not inside(nl, ng):
                            problems.append(f"correction {key}: new coordinates for park '{park['name']}' are outside Bengaluru; ignored"); continue
                    park[f] = v
                    if f == "description":
                        park["verified"] = True
                    applied.append(f"{key}: park '{park['name']}'.{f} = {str(v)[:60]!r} - {pf.get('note', '')}")


def _find_office(company, ref):
    """By 1-based position ("2"), by office id suffix ("~2"), or by label."""
    if ref is None:
        return None
    ref = str(ref).strip()
    m = re.search(r"~(\d+)$", ref) or re.fullmatch(r"(\d+)", ref)
    if m:
        i = int(m.group(1)) - 1
        return company["offices"][i] if 0 <= i < len(company["offices"]) else None
    for o in company["offices"]:
        if o["label"] == ref:
            return o
    k = nk(ref)
    for o in company["offices"]:
        if nk(o["label"]) == k:
            return o
    return None


# ----------------------------------------------------------------------------- assembly

def attach_footprints(parks):
    if not os.path.exists(OSM_PARKS):
        return 0
    with open(OSM_PARKS, encoding="utf-8") as fh:
        osm = json.load(fh)
    by_key = {}
    for row in osm:
        if row.get("name") and row.get("ring") and len(row["ring"]) >= 4:
            by_key.setdefault(park_key(row["name"]), row)
    n = 0
    for p in parks.values():
        for cand in [p["name"]] + p["aliases"]:
            row = by_key.get(park_key(cand))
            if row:
                p["footprint"] = row["ring"]
                if not p["bbox"] and row.get("bbox"):
                    p["bbox"] = row["bbox"]
                n += 1
                break
    return n


def build(check_only=False):
    problems = []
    slices = load_slices()
    if not slices:
        print("no slices in data/raw/", file=sys.stderr)
        return 1
    parks, uf = merge_parks(slices, problems)
    companies, stubs = merge_companies(slices, parks, uf, problems)

    # stub parks for tech parks only ever named by an office
    for k, s in stubs.items():
        lat = sum(o[0] for o in s["offices"]) / len(s["offices"])
        lng = sum(o[1] for o in s["offices"]) / len(s["offices"])
        parks["stub:" + k] = {
            "id": slugify(s["name"]),
            "name": s["name"],
            "aliases": [],
            "locality": Counter(s["localities"]).most_common(1)[0][0] if s["localities"] else "",
            "developer": None,
            "lat": round(lat, 6), "lng": round(lng, 6), "bbox": None, "areaSqFtMillions": None,
            "description": "Named as a tenant location by the research; the park itself has not been described or verified yet.",
            "notableTenants": [],
            "sources": [],
            "footprint": None,
            "verified": False,
            "_keys": set(), "_lenses": [],
        }
    applied = []
    apply_corrections(companies, parks, uf, applied, problems)
    footprints = attach_footprints(parks)

    # unique ids
    seen = {}
    for p in parks.values():
        base = p["id"]; n = 2
        while p["id"] in seen:
            p["id"] = f"{base}-{n}"; n += 1
        seen[p["id"]] = True
    seen = {}
    for c in companies:
        base = c["id"]; n = 2
        while c["id"] in seen:
            c["id"] = f"{base}-{n}"; n += 1
        seen[c["id"]] = True

    root_to_id = {root: p["id"] for root, p in parks.items()}
    tenants_by_park = defaultdict(set)
    for c in companies:
        for i, o in enumerate(c["offices"], start=1):
            o["id"] = f"{c['id']}~{i}"
            o["techParkId"] = root_to_id.get(o.pop("_parkRoot")) if o.get("_parkRoot") else None
            if o["techParkId"]:
                tenants_by_park[o["techParkId"]].add(c["name"])
            o.pop("_lens", None); o.pop("_corroborated_by", None)
    for p in parks.values():
        names = set(p["notableTenants"]) | tenants_by_park.get(p["id"], set())
        p["notableTenants"] = sorted(names, key=str.lower)

    companies.sort(key=lambda c: c["name"].lower())
    park_list = sorted(parks.values(), key=lambda p: p["name"].lower())
    for p in park_list:
        p.pop("_keys", None); p.pop("_lenses", None)
    lenses = sorted({lens for lens, _ in slices})
    for c in companies:
        c.pop("_lenses", None)

    dataset = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "bounds": BOUNDS,
        "companies": companies,
        "techParks": park_list,
        "provenance": {
            "lenses": len(lenses),
            "rawSlices": lenses,
            "note": "Merged by tools/data/merge.py from the research slices in data/raw/. Office coordinates come from OpenStreetMap (ODbL) via Nominatim/Photon/Overpass or from the park's centroid; see each office's evidence line.",
        },
    }

    offices = sum(len(c["offices"]) for c in companies)
    by_cat = Counter(c["category"] for c in companies)
    by_conf = Counter(o["confidence"] for c in companies for o in c["offices"])
    stub_count = sum(1 for p in park_list if not p["verified"])
    summary = [
        f"# Dataset report", "",
        f"Generated {dataset['generatedAt']} from {len(lenses)} slices: {', '.join(lenses)}", "",
        f"- companies: {len(companies)} (MNC {by_cat.get('MNC', 0)}, MID_SIZE {by_cat.get('MID_SIZE', 0)}, STARTUP {by_cat.get('STARTUP', 0)}, PSU {by_cat.get('PSU', 0)})",
        f"- offices: {offices} (high {by_conf.get('high', 0)}, medium {by_conf.get('medium', 0)}, low {by_conf.get('low', 0)})",
        f"- tech parks: {len(park_list)} ({stub_count} stubs named only by an office, {footprints} with an OSM footprint)",
        "", "## Problems (dropped or suspicious)", "",
    ] + [f"- {p}" for p in problems] + ([] if problems else ["- none"]) + [
        "", f"## Corrections applied ({len(applied)})", "",
    ] + [f"- {a}" for a in applied] + ([] if applied else ["- none"])
    report = "\n".join(summary) + "\n"
    print(report)
    if check_only:
        return 1 if problems else 0
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(dataset, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    with open(REPORT, "w", encoding="utf-8") as fh:
        fh.write(report)
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024} kB) and {REPORT}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="validate only; do not write")
    ap.add_argument("--raw", help="directory of slices (default data/raw)")
    ap.add_argument("--out", help="dataset path to write (default public/data/dataset.json)")
    ap.add_argument("--report", help="report path to write (default data/report.md)")
    ap.add_argument("--osm-parks", help="OSM park polygons for footprints (default data/osm/osm-techparks.json)")
    ap.add_argument("--corrections", help="directory of correction files (default data/corrections)")
    args = ap.parse_args()
    if args.raw:
        RAW = os.path.abspath(args.raw)
    if args.out:
        OUT = os.path.abspath(args.out)
    if args.report:
        REPORT = os.path.abspath(args.report)
    if args.osm_parks:
        OSM_PARKS = os.path.abspath(args.osm_parks)
    if args.corrections:
        CORRECTIONS = os.path.abspath(args.corrections)
    sys.exit(build(check_only=args.check))
