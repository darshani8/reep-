# Bengaluru Tech Map

An interactive map of the companies in Bengaluru (Bangalore): **multinationals** (foreign and Indian),
established **mid-size companies**, **startups** and **public-sector** employers — each
with every Bengaluru **branch** that could be substantiated, and the **tech parks** they sit in.

Angular 22 · MapLibre GL JS 6 · OpenFreeMap vector tiles · no API keys.

<!-- GLANCE:START -->
**Dataset at a glance** (generated 2026-10-10 from 42 research slices):

| | |
|---|---|
| Companies | **860** — 489 MNC, 125 mid-size, 212 startup, 34 PSU |
| Offices (branches) | **1531** — 810 well evidenced, 553 one source, 168 unconfirmed; 303 companies have more than one Bengaluru office |
| Tech parks and campuses | **216** (158 with an OpenStreetMap footprint) |
| Busiest parks | RMZ Ecoworld (80), Manyata Tech Park (60), Bagmane Tech Park (42), Electronics City Phase 1 (39), Embassy TechVillage (39), Embassy GolfLinks Business Park (33) |

Every number above is recomputed by `python3 tools/data/update_readme.py`; `data/report.md` has the full merge log.
<!-- GLANCE:END -->

## Running it

```bash
nvm use            # Node 24 (see .nvmrc); Angular CLI 22.2 needs Node 22.22.3+ or 24
npm ci
npm start          # http://localhost:4200
```

`npm test` runs the unit tests (vitest), `npm run build` makes the production bundle in
`dist/bangalore-tech-map/browser/` — a static site that any host can serve.

The map is pinned to Bengaluru: it cannot be panned out of the metro box, and the dataset refuses any
coordinate outside it (lat 12.75–13.25, lng 77.35–77.90). Hosur, Mysuru and the rest of Karnataka are
out of scope on purpose.

## What is on the screen

- **Map** — every office is a dot coloured by category (MNC blue, mid-size orange, startup pink, PSU
  green — an Okabe-Ito colour-blind-safe palette; category is always also written as text). Nearby
  offices cluster; a cluster takes the colour of the category most of its offices belong to, and a
  click opens it. Tech parks are white markers with a dark ring, their OpenStreetMap footprint drawn
  as a dashed outline when it is known. The bigger dot is the company's Bengaluru HQ.
- **Left panel** — search (company, alias, sector, locality or tech park), category and
  origin toggles with counts, a tech-park filter, sector checkboxes, and switches for closed offices
  and the evidence floor. The list under it shows what matches; clicking a row flies the map there.
- **Right panel** — the selected company: what it does, global HQ, founded, headcount where a source
  states it, website, and every Bengaluru office with its building, park, locality, address, status,
  confidence and an **evidence line** naming the source that places it there. Clicking a park opens
  the park: developer, size, every mapped company in it, and the tenants the research named but could
  not pin to an exact office.
- The URL mirrors the view (`?q=…&park=…&company=…&office=…`) so a view can be shared.

## Why MapLibre GL JS

The brief asked for the latest, best map library. The choice was made against four alternatives:

| Library | Why not / why |
|---|---|
| **MapLibre GL JS 6** (chosen) | Open-source (BSD), WebGL2 vector tiles, GPU-accelerated, smooth zoom, built-in clustering, data-driven styling by expression, 60 fps with thousands of points. Actively developed (6.13 as of Oct 2026). No vendor lock-in, no key. |
| Leaflet | Mature and small, but raster tiles and DOM markers; a few thousand markers need a plugin, labels do not collide-avoid, no vector styling. The right choice for a simple pin map, not for a dense city dataset. |
| OpenLayers | Capable and open, heavier API, weaker out-of-the-box vector-tile styling than MapLibre. |
| Mapbox GL JS | The library MapLibre was forked from; now proprietary and billed per load, and needs a token. |
| Google Maps | Needs a billing-enabled key; styling and clustering are more constrained; data is not open. |

Tiles come from [OpenFreeMap](https://openfreemap.org) (OpenMapTiles schema, Positron style), which
is free to use without a key or quota. `MAP_STYLE_URL` in `src/app/core/bengaluru.ts` is the one line to
change for another style or tile provider.

## How the data was gathered

The dataset is **research as code**. Nothing in the app is hand-typed into the JSON; everything comes
from slices in `data/raw/` that `tools/data/merge.py` merges, validates and writes to
`public/data/dataset.json`.

1. **OpenStreetMap extract.** `tools/research/overpass_extract.py` pulled every named office POI
   (4,400+) and every tech/business-park polygon (1,600+) inside the Bengaluru box (`data/osm/`).
2. **Fan-out research.** Thirty-two research lenses were run by AI agents following the brief in
   `tools/research/research-workflow.js`: twenty **geography** lenses (one per tech park or corridor:
   Manyata, Embassy TechVillage, the ORR stretches, the Bagmane parks, ITPL and the rest of Whitefield,
   Electronics City, EGL and Indiranagar, the Koramangala–HSR startup corridor, Sarjapur Road, the CBD,
   Hebbal, Bannerghatta Road, Global Village, Peenya, Old Madras Road, Devanahalli, Hosur Road) and
   twelve **entity** lenses (US big tech, enterprise software, semiconductors, BFSI and consulting
   GCCs, Indian IT majors, mid-size non-IT companies, unicorns, two startup lenses, PSUs,
   aerospace/auto/industrial MNCs, energy/pharma/retail GCCs). Each agent searched for primary
   sources — the company's own locations page, lease news, the park's tenant page — geocoded the
   building with `tools/research/geocode.py` (Nominatim, then Photon, restricted to Bengaluru) or took
   the OSM POI, and wrote one slice with an evidence sentence and a confidence word on every office.
3. **Merge.** Records are matched by normalised name and alias, offices by park+building or by being
   within 150 m; two independent lenses agreeing raises an office to "well evidenced". Anything outside
   Bengaluru is dropped and listed in `data/report.md`.
4. **Completeness critics and gap-fill.** Four critic agents read the merged list from different angles
   (largest employers, the GCC landscape, startups and unicorns, Indian companies and PSUs) and named
   what was missing; a duplicate hunter looked for one organisation under two names. The missing
   companies were researched like any other lens and landed as `data/raw/X*-gaps.json`.
5. **Verification.** `tools/data/qa.py` flags records worth a second look (every office unconfirmed, a
   pin outside its park's footprint, two records of one office, a category that breaks the rule).
   Verifier agents checked each flagged company against company pages, filings and lease news and wrote
   their findings as `data/corrections/*.json`: drop, merge, fix a pin, re-categorise, add a missing
   campus. A second round (`W*.json`) checked what the gap-fill and the first round left flagged.
   Every applied correction is listed with its source in `data/report.md`.
6. **One sector list.** The filter panel offers a fixed list of 22 sectors (`SECTORS` in
   `tools/data/merge.py`). A slice that described a sector in free text is outvoted by any slice that
   used the list, and `data/corrections/Z01-sector-vocabulary.json` maps the rest by hand, following the
   precedent already in the data (Finastra and Visa are Fintech, so banking-software vendors and payment
   networks are too).

Evidence sentences cite a web page or an OpenStreetMap object (`way/391787112`); the app turns both
into links, so every pin can be traced back to what placed it.

What the data is **not**: a live feed. Offices move, startups fold, parks change hands. Every office
carries the date-free evidence that placed it, and a confidence word — _well evidenced_, _one source_,
_unconfirmed_ — so a reader can judge. Treat a pin as "where the evidence put it when the data was
gathered".

### Adding or correcting a company

Add a slice to `data/raw/` (shape in `data/raw/README.md`), then:

```bash
python3 tools/data/merge.py           # writes public/data/dataset.json and data/report.md
python3 tools/data/update_readme.py   # refreshes the numbers at the top of this file
python3 tools/data/qa.py              # lists records worth a second look (changes nothing)
npm test                              # the dataset integrity test re-checks the shipped file
```

CI runs `merge.py --check`, which fails unless the committed `dataset.json` is exactly what the
slices and corrections produce.

Do not edit `public/data/dataset.json` by hand; the next merge overwrites it.

## Project layout

```
src/app/core/        bengaluru.ts (bounds, style), filters.ts (pure filter logic), slug.ts, evidence.ts (links in evidence),
                     dataset.service.ts (loads the JSON), map-state.service.ts (filters, selection, GeoJSON)
src/app/map/         map.component.ts — the MapLibre map (lazy-loaded with @defer)
src/app/panels/      filter panel, company list, company detail, park detail, legend, about dialog
src/app/data/        types.ts (the dataset contract), dataset.spec.ts (integrity of the shipped file)
public/data/         dataset.json — what the app fetches
data/raw/            research slices (one per lens)       data/osm/  OpenStreetMap extracts
tools/data/merge.py  slices → dataset                      tools/research/  the research helpers and brief
```

## Credits and licences

Code: MIT (see `LICENSE`). Base map © [OpenFreeMap](https://openfreemap.org) / OpenMapTiles.
Map data and office coordinates © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
ODbL 1.0. Company facts are compiled from public sources cited on each record.
