"""Mentor mapping from a spreadsheet — the MATCHING, and nothing else (2026-10-10).

The office's mentor list arrives as a spreadsheet: a column of student names, a
faculty member beside each, and nothing that a database would call a key. This
module turns "Prof. Shakti" and "Yashwanth.S" into *which* faculty account and
*which* roster row, or says honestly that it cannot. The endpoints that read the
file, walk the roster and write the assignment are in
`routers/admin_mentoring.py`; what is here reads no table and raises no
HTTPException, on `app/imports_sheet.py`'s rule, so every decision below is
pinned by a test that needs no database.

THREE ANSWERS, NEVER A GUESS. A name matches EXACTLY (the same words once
titles and punctuation are gone), LOOSELY (one name is the other with words
added — "Kiran" against "Kiran B", "Yashwanth S" against "S Yashwanth Kumar"),
or it is AMBIGUOUS, which is a verdict and not a failure: the preview lists the
candidates with their USN and batch, and the office writes the USN into the
row. A loose match never fires on an initial alone ("S" is not a name), and two
rows that both match loosely are ambiguous, not "first wins".

THE SPECIALIZATION COLUMN IS A TIEBREAK AND NOTHING MORE. The office's sheet
carries one, and when two students share a name it usually says which is which
— the Digital Marketing "Harshitha N" and the HR one. It narrows a tie only when
exactly one candidate's batch label shares more of its words than the others
do; it never turns a non-match into a match, and a row whose specialization
disagrees with the matched student's batch is still that student (the batch is
the roster's fact, the column is the office's shorthand).

THE FILE DISAMBIGUATES ITSELF, ONCE. When a name is ambiguous in one row and
one of its candidates is plainly matched by ANOTHER row, that candidate is
taken: the two "Harshitha N"s are two people, and the sheet listing both is
the office telling us so. `resolve_claims` does exactly that and no more —
it removes candidates, it never adds them.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

#: Honorifics the office writes in front of a faculty member's name and the
#: roster does not carry. Stripped only from the FRONT of a name, so a surname
#: that happens to be one of these is left alone.
TITLES: frozenset[str] = frozenset(
    {"prof", "professor", "dr", "mr", "ms", "mrs", "miss", "smt", "sri", "shri", "sir"}
)

#: Words that say nothing about WHICH batch: every label carries "MBA", the
#: office writes "Core Finance" for a plain Finance stream, and "and" joins the
#: dual ones. Dropped before the specialization tiebreak counts overlaps.
_HINT_STOP: frozenset[str] = frozenset({"and", "the", "of", "core", "mba", "general", "with"})

_PUNCT = re.compile(r"[.,;:_/\\()\[\]\-\"'’]+")

#: A loose match needs at least one REAL word in common; a lone initial
#: matches half the roster.
_MIN_WORD = 3

MATCH_EXACT = "exact"
MATCH_LOOSE = "loose"
MATCH_AMBIGUOUS = "ambiguous"
MATCH_NONE = "none"


def normalise(name: object) -> str:
    """"Prof. Suneel Rao" -> "suneel rao"; "Yashwanth.S" -> "yashwanth s"."""
    words = _PUNCT.sub(" ", str(name or "")).casefold().split()
    while words and words[0] in TITLES:
        words.pop(0)
    return " ".join(words)


def words_of(name: object) -> frozenset[str]:
    return frozenset(normalise(name).split())


@dataclass(frozen=True)
class Person:
    """One row of the roster or the faculty list, as the matcher sees it.

    `key` is the exact handle — a USN for a student, an address for a faculty
    member — and is matched case-insensitively and never loosely. `hint` is the
    text the specialization tiebreak reads: a student's batch label, nothing
    for faculty.
    """

    id: str
    name: str
    key: str | None = None
    hint: str = ""


@dataclass(frozen=True)
class Match:
    kind: str
    hits: tuple[Person, ...] = ()

    @property
    def person(self) -> Person | None:
        """The one person this resolved to, or None for ambiguous / none."""
        if self.kind in (MATCH_EXACT, MATCH_LOOSE) and len(self.hits) == 1:
            return self.hits[0]
        return None


def by_key(key: object, people: Sequence[Person]) -> Person | None:
    """Exact, case-insensitive, whitespace-trimmed match on the handle."""
    wanted = " ".join(str(key or "").split()).casefold()
    if not wanted:
        return None
    for person in people:
        if person.key and " ".join(person.key.split()).casefold() == wanted:
            return person
    return None


def _one_is_the_other_extended(left: frozenset[str], right: frozenset[str]) -> bool:
    if not left or not right:
        return False
    small, big = (left, right) if len(left) <= len(right) else (right, left)
    return small <= big and any(len(word) >= _MIN_WORD for word in small)


def match_name(given: object, people: Sequence[Person], *, hint: object = None) -> Match:
    """The person this name means, by the three-answer rule in the module docstring."""
    wanted = normalise(given)
    if not wanted:
        return Match(MATCH_NONE)
    exact = tuple(person for person in people if normalise(person.name) == wanted)
    if len(exact) == 1:
        return Match(MATCH_EXACT, exact)
    if exact:
        return _tiebreak(MATCH_EXACT, exact, hint)
    wanted_words = frozenset(wanted.split())
    loose = tuple(
        person
        for person in people
        if _one_is_the_other_extended(wanted_words, words_of(person.name))
    )
    if len(loose) == 1:
        return Match(MATCH_LOOSE, loose)
    if loose:
        return _tiebreak(MATCH_LOOSE, loose, hint)
    return Match(MATCH_NONE)


def _tiebreak(kind: str, hits: tuple[Person, ...], hint: object) -> Match:
    """Keep the candidate whose batch label shares most words with the hint —
    only when that candidate is unique; a tie stays ambiguous."""
    wanted = {word for word in words_of(hint) if len(word) >= _MIN_WORD and word not in _HINT_STOP}
    if wanted:
        scored = [(len(wanted & words_of(person.hint)), person) for person in hits]
        best = max(score for score, _person in scored)
        winners = tuple(person for score, person in scored if score == best)
        if best > 0 and len(winners) == 1:
            return Match(kind, winners)
    return Match(MATCH_AMBIGUOUS, hits)


def resolve_claims(matches: Sequence[Match]) -> list[Match]:
    """Second pass over a whole file: a candidate another row has plainly
    matched is withdrawn from every ambiguous row, and a row left with exactly
    one candidate is resolved — loosely, so the preview still says so.

    It only ever REMOVES candidates. A row that stays ambiguous is reported as
    such, and a row with no candidates is untouched.
    """
    claimed = {match.person.id for match in matches if match.person is not None}
    resolved: list[Match] = []
    for match in matches:
        if match.kind != MATCH_AMBIGUOUS:
            resolved.append(match)
            continue
        remaining = tuple(person for person in match.hits if person.id not in claimed)
        if len(remaining) == 1:
            resolved.append(Match(MATCH_LOOSE, remaining))
        else:
            resolved.append(match)
    return resolved


def listed_twice(ids: Sequence[str | None]) -> frozenset[str]:
    """The ids that appear on more than one line. The caller decides what that
    costs — two lines naming one student and two different faculty members is
    a contradiction the file has to settle, not a coin the importer tosses."""
    seen: set[str] = set()
    twice: set[str] = set()
    for one in ids:
        if one is None:
            continue
        if one in seen:
            twice.add(one)
        seen.add(one)
    return frozenset(twice)
