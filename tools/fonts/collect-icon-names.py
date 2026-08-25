#!/usr/bin/env python3
"""Regenerate tools/fonts/icon-names.txt from the source tree.

The Material Symbols face is 5.2 MB for the full set, so the app ships a SUBSET
containing only the glyphs it can actually render. That makes the subset a
correctness problem: an icon added to a template but not to the subset renders
as nothing (the .icon box is clamped and hidden — see styles/reep-v2.scss), so
it fails silently rather than loudly.

Run this after adding an icon, then re-run tools/fonts/fetch-fonts.sh:

    python3 tools/fonts/collect-icon-names.py && tools/fonts/fetch-fonts.sh

It reads three places, because a glyph name can come from any of them:
  * a template's `<span class="icon">name</span>`;
  * a ternary inside one, `{{ muted() ? 'mic' : 'mic_off' }}`;
  * the API — SLOT_ICON / SKILL_ICON / STATUS_GLYPH send glyph names down the
    wire, so a backend-only icon would never appear in a template at all.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

# Identifiers that match the shape of a glyph name but are not one. Kept as a
# denylist rather than an allowlist: a new real glyph must land in the subset
# automatically, while these few knowns are cheap to list.
NOT_GLYPHS = {
    "str", "int", "bool", "none", "true", "false", "null", "good", "warn", "risk",
    "neutral", "opsz", "wght", "fill", "grad", "normal", "block", "swap", "icon",
    "glyph", "label", "key", "value", "title", "tone", "route", "status",
    "completed", "in_progress", "not_started", "reading", "writing", "listening",
    "speaking", "dawn", "morning", "midday", "afternoon", "evening", "night",
    "sleeping", "leisure", "lectures", "coursework", "skilling", "draft",
    "submitted", "scored", "pending_review", "hr", "dm", "ba", "fa",
}

GLYPH = r"[a-z][a-z0-9_]{2,}"


def collect() -> set[str]:
    names: set[str] = set()

    for path in (ROOT / "apps/web/src").rglob("*"):
        if path.suffix not in {".html", ".ts"} or not path.is_file():
            continue
        text = path.read_text(errors="ignore")
        names.update(re.findall(rf'class="[^"]*\bicon\b[^"]*"[^>]*>\s*({GLYPH})\s*<', text))
        for block in re.findall(r'class="[^"]*\bicon\b[^"]*"[^>]*>\s*\{\{([^}]*)\}\}', text):
            names.update(re.findall(rf"'({GLYPH})'", block))
        names.update(re.findall(rf"\b(?:icon|glyph)\s*[:=]\s*'({GLYPH})'", text))

    for path in (ROOT / "apps/api-py/app").rglob("*.py"):
        text = path.read_text(errors="ignore")
        for chunk in re.findall(r"\b(?:SLOT_ICON|SKILL_ICON|STATUS_GLYPH|icon)\b.{0,400}", text, re.S):
            names.update(re.findall(rf'"({GLYPH})"', chunk))

    return {n for n in names if n not in NOT_GLYPHS}


def main() -> int:
    out = ROOT / "tools/fonts/icon-names.txt"
    names = sorted(collect())
    previous = out.read_text().split() if out.exists() else []
    out.write_text("\n".join(names) + "\n")

    added = sorted(set(names) - set(previous))
    removed = sorted(set(previous) - set(names))
    print(f"{len(names)} glyph names -> {out.relative_to(ROOT)}")
    if added:
        print("  added:  " + ", ".join(added))
    if removed:
        print("  removed:" + ", ".join(removed))
    if added or removed:
        print("\nRe-run tools/fonts/fetch-fonts.sh to rebuild the subset.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
