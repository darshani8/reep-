# Corrections

One JSON file per verification pass, applied by `tools/data/merge.py` after the slices are merged,
in file-name order. Shape:

```jsonc
{
  "key": "V01-batch-01",
  "corrections": [
    { "company": "<id, name or alias>", "verdict": "keep" | "drop" | "merge_into", "into": "<company>", "note": "why",
      "set": { "category": "MNC", "origin": "Foreign", "sector": "...", "isUnicorn": true, "description": "..." },
      "offices": [ { "office": "<the office id from the dataset (ibm~3f9a1c), a 1-based position, or the label>", "verdict": "keep" | "drop" | "fix",
                     "set": { "lat": 12.9, "lng": 77.6, "techPark": "<park name>", "building": "...", "status": "closed", "confidence": "high", "evidence": "..." },
                     "note": "why" } ],
      "addOffices": [ { "label", "techPark", "building", "locality", "address", "lat", "lng", "isHq", "status", "confidence", "evidence" } ] }
  ],
  "parkMerges": [ { "from": "<park>", "into": "<park>", "note": "why" } ],
  "parkFixes": [ { "park": "<park>", "set": { "lat": 13.0, "lng": 77.6, "developer": "...", "areaSqFtMillions": 3.2, "description": "..." }, "note": "why" } ],
  "notes": "free text"
}
```

A correction that names nothing (a company dropped by an earlier file, an office position that no
longer exists after a re-merge) is listed under "Problems" in `data/report.md` and ignored, never
applied to the wrong row.
