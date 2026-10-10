# Research tooling

How `data/raw/*.json` was produced, and how to extend it.

| Script | What it does |
|---|---|
| `overpass_extract.py` | Pulls every named office POI and every tech/business-park polygon inside the Bengaluru box from OpenStreetMap (Overpass API) into `data/osm/`. Run once; slow. |
| `park_lookup.py "manyata" "ecoworld\|ecospace"` | Offline regex lookup over the OSM park polygons: centroid and bbox. |
| `osm_lookup.py "^infosys" "goldman"` | Offline regex lookup over the OSM office POIs: the branches mappers have recorded. Evidence, not proof. |
| `geocode.py "Prestige Tech Park, Kadubeesanahalli" ...` | Nominatim (then Photon) geocoder that only returns results inside Bengaluru, cached in `data/geocode-cache.json`, rate-limited across processes. |
| `research-workflow.js` | The orchestration script that fanned 32 research lenses out to agents (20 geography lenses, one per tech park or corridor; 12 entity lenses by company type). The full research brief every agent received is in it. |

The research itself was done by AI agents following the brief in `research-workflow.js`: each agent
searched the web for primary sources (company location pages, lease news, park tenant pages),
geocoded buildings with the helpers above, and wrote one slice to `data/raw/<key>.json` with an
evidence sentence and a confidence word on every office. `tools/data/merge.py` merges the slices.

To add a company by hand you do not need any of this: add a slice file (see `data/raw/README.md`)
and re-run the merge.

OpenStreetMap data is © OpenStreetMap contributors, ODbL 1.0. Nominatim and Photon are public
services with usage policies; `geocode.py` keeps to one request a second and identifies itself.
