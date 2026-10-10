"""Build the requirements traceability matrix from the plan and the three level documents.

Coverage comes from each level's case index (§4: `| ID | requirement(s) | ...`),
which lists every case including those added in re-test rounds. The verdict of
a case is the LAST one recorded across the execution log (§5) and every re-test
log (§5a, §5b, ...), so a case that failed in round 1 and passed on re-test
reads Pass. Prints markdown: the matrix, then the not-passed cases.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

plan, unit, integ, system = (Path(p).read_text() for p in sys.argv[1:5])
disposition = json.loads(Path(sys.argv[5]).read_text()) if len(sys.argv) > 5 else {}

REQ = re.compile(r"^\| (REQ-G[0-9X]-\d\d) \| (.+?) \|\s*$", re.M)
requirements = [(m.group(1), m.group(2)) for m in REQ.finditer(plan)]
CASE = r"(?:UT|IT)-G[0-9X]-\d{3}|ST-\d{3}"


def req_refs(cell: str) -> list[str]:
    """`REQ-G1-01, 03, 04` / `G1-06, G4-02` / `GX-04` → full REQ ids."""
    out, gate = [], None
    for tok in re.split(r"[,;/ ]+", cell):
        m = re.fullmatch(r"(?:REQ-)?(G[0-9X])-(\d\d)", tok.strip("()*`"))
        if m:
            gate = m.group(1)
            out.append(f"REQ-{gate}-{m.group(2)}")
            continue
        m = re.fullmatch(r"(\d\d)", tok.strip("()*`"))
        if m and gate:
            out.append(f"REQ-{gate}-{m.group(1)}")
    return out


def case_index(doc: str) -> dict[str, list[str]]:
    """Every `| CASE | reqs | ...` row in §4 (the case index and later additions)."""
    sec4 = re.search(r"\n## 4\.(.*?)\n## 5", doc, re.S)
    body = sec4.group(1) if sec4 else ""
    cov: dict[str, list[str]] = {}
    for line in body.splitlines():
        m = re.match(rf"\|\s*({CASE})\s*\|([^|]*)\|", line)
        if m:
            refs = req_refs(m.group(2))
            if refs:
                cov.setdefault(m.group(1), [])
                cov[m.group(1)] += [r for r in refs if r not in cov[m.group(1)]]
    # Plus every `| REQ-... | cases |` row in §7 (re-test rounds sometimes list new coverage only there).
    sec7 = re.search(r"\n## 7\.(.*?)(?=\n## 8|\Z)", doc, re.S)
    for line in (sec7.group(1) if sec7 else "").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2 or not re.match(r"REQ-G[0-9X]-\d\d", cells[0]):
            continue
        reqs = re.findall(r"REQ-G[0-9X]-\d\d", cells[0])
        for case in re.findall(CASE, " ".join(cells[1:])):
            cov.setdefault(case, [])
            cov[case] += [r for r in reqs if r not in cov[case]]
    return cov


def verdicts(doc: str) -> dict[str, str]:
    """Last verdict per case across §5, §5a, §5b ... in document order."""
    v: dict[str, str] = {}
    # Base: a verdict written on the case itself in §4 (`#### ID — ...` then `**Verdict:** **X**`).
    for m in re.finditer(rf"\n#### ({CASE})\b(.*?)(?=\n#### |\n## |\n### )", doc, re.S):
        w = re.search(r"Verdict:\**\s*\**(Pass|Fail|Blocked|Not run)\b", m.group(2))
        if w:
            v[m.group(1)] = w.group(1)
    for sec in re.finditer(r"\n## 5[a-z]?\.[^\n]*\n(.*?)(?=\n## )", doc, re.S):
        for line in sec.group(1).splitlines():
            m = re.match(rf"\|\s*\**({CASE})(?:-[a-z0-9]+)?\**\b[^|]*\|(.*)", line)
            if not m:
                continue
            cells = [c.strip() for c in m.group(2).split("|")]
            for c in cells:
                w = re.match(r"\**(Pass|Fail|Blocked|Not run)\b", c)
                if w:
                    v[m.group(1)] = w.group(1)
                    break
    return v


levels = [("L1", case_index(unit), verdicts(unit)), ("L2", case_index(integ), verdicts(integ)), ("L3", case_index(system), verdicts(system))]

by_req: dict[str, list[list[str]]] = {r: [[], [], []] for r, _ in requirements}
for i, (_lvl, cov, _v) in enumerate(levels):
    for case, reqs in cov.items():
        for r in reqs:
            if r in by_req:
                by_req[r][i].append(case)

all_verdicts = {k: v for _l, _c, ver in levels for k, v in ver.items()}
print("| Requirement | L1 unit | L2 integration | L3 system | Cases | Final verdict |")
print("|---|---|---|---|---|---|")
uncovered, notpassed = [], {}
for rid, _text in requirements:
    cols = by_req[rid]
    ids = [c for col in cols for c in col]
    bad = [c for c in ids if all_verdicts.get(c) not in ("Pass",)]
    if not ids:
        uncovered.append(rid)
        verdict = "**NOT COVERED**"
    elif bad:
        verdict = "Pass, except " + "; ".join(f"{c} ({all_verdicts.get(c, 'no verdict')}: {disposition.get(c, '?')})" for c in bad)
        for c in bad:
            notpassed[c] = all_verdicts.get(c, "no verdict")
    else:
        verdict = "**Pass**"
    def fmt(col: list[str]) -> str:
        return ", ".join(sorted(col)) if col else "—"
    print(f"| {rid} | {fmt(cols[0])} | {fmt(cols[1])} | {fmt(cols[2])} | {len(ids)} | {verdict} |")
print()
print(f"<!-- requirements: {len(requirements)}; uncovered: {', '.join(uncovered) or 'none'}; "
      f"cases indexed: L1 {len(levels[0][1])}, L2 {len(levels[1][1])}, L3 {len(levels[2][1])}; "
      f"cases with a verdict: L1 {len(levels[0][2])}, L2 {len(levels[1][2])}, L3 {len(levels[2][2])}; "
      f"not passed: {json.dumps(notpassed)} -->")
missing = {lvl: sorted(set(cov) - set(ver)) for lvl, cov, ver in levels}
print(f"<!-- indexed but no verdict: {json.dumps(missing)} -->")
