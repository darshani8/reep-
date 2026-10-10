# Research slices

One JSON file per research lens, written by the research agents described in the root README
("How the data was gathered"). `tools/data/merge.py` merges them into `public/data/dataset.json`.

Each file has the shape:

```jsonc
{
  "key": "G01-manyata",
  "techParks": [ { "name", "aliases", "locality", "developer", "lat", "lng", "bbox", "areaSqFtMillions", "notableTenants", "description", "sources" } ],
  "companies": [ {
      "name", "aliases", "category": "MNC|MID_SIZE|STARTUP|PSU", "origin": "Indian|Foreign",
      "hqCountry", "hqCity", "sector", "description", "website", "founded", "bengaluruEmployeesApprox", "isUnicorn",
      "offices": [ { "label", "techPark", "building", "locality", "address", "lat", "lng", "geocodeSource", "isHq",
                     "status": "active|closing|closed|planned", "confidence": "high|medium|low", "evidence" } ],
      "sources": [ "https://..." ] } ],
  "coverageNotes": "what could not be confirmed and what was left out"
}
```

Lens keys: `G01`–`G20` are geography (one tech park or corridor each); `E01`–`E12` are entity lenses
(US big tech, enterprise software, semiconductors, BFSI and consulting GCCs, Indian IT majors,
mid-size non-IT companies, unicorns, two startup lenses, PSUs, aerospace/auto/industrial MNCs,
energy/pharma/retail GCCs). A company appearing in several slices is merged by name and alias.

To add or correct a company by hand, edit or add a slice here and re-run the merge; do not edit
`public/data/dataset.json` directly, because the next merge would overwrite it.
