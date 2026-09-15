"""`python -m app.archive_documents` — the sweep that makes the permanent
document archive a guarantee rather than a best effort.

`document_store.save_bytes` PUTs every new file to the archive INLINE, so a
document is durable within milliseconds of being accepted. That path is
deliberately best-effort: it raises nothing, because an S3 blip must never be
the reason a student is told their valid certificate was rejected (see
`app/document_archive.archive_bytes`). This module is the other half of that
bargain. It walks the stores ON DISK, asks the bucket what it already holds,
and uploads the difference — so an inline failure costs hours instead of the
file.

It is also the ONLY writer that archives INTERVIEW AUDIO. The recorder writes
its two WAVs incrementally and closes them in `run()`'s `finally`; during a
live interview there is no complete file to upload, and a mid-call PUT would
ship a truncated container and put an S3 round trip on the interview's hot
path. The sweep sees a finished file or it sees nothing.

**IT ONLY EVER WRITES.** There is no delete, no rename, no move and no
reconciliation in the other direction. A file on the volume that the bucket
does not have is uploaded; an object in the bucket with no file behind it is
left exactly where it is, because that is the normal and intended state of
every document a student has since deleted from the website — the whole point
of the archive. A sweep that "tidied" those away would delete the only
permanent copy of precisely the records this exists to keep.

**ONE LISTING, NOT ONE QUESTION PER FILE.** The obvious shape is
`is_archived()` per file, which is one `list_objects_v2` round trip each and
turns a ten-thousand-file store into ten thousand API calls every night. The
bucket's keys are listed ONCE per root into a set and the difference is taken
locally. `document_archive.is_archived` stays for the single-file question a
test or an operator asks.

**IT NEEDS NO DATABASE AND DELIBERATELY DOES NOT OPEN ONE.** The filesystem is
the authority on which files exist — `retention._delete_interview_audio` makes
the same argument at length, and its reasoning applies exactly: a row records
what a writer BELIEVED and managed to write down, and the failure mode that
matters is the writer dying before it could. A sweep driven by `uploads` and
`interview_sessions` would silently skip every file whose row never landed.

Exit code 0 means every file the volume holds is in the archive. Non-zero
means at least one is not, so whatever supervises this can tell a quiet night
from a broken one without parsing prose — `app/retention_job.py`'s rule.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import document_archive
from .config import settings
from .document_archive import AUDIO_ROOT, DOCUMENTS_ROOT

log = logging.getLogger("reep.archive_documents")

#: Files the sweep must never upload. `interview_audio` writes `<name>.partial`
#: and renames on success, so a `.partial` on disk is either a recording in
#: flight or the wreckage of a process that died mid-write. Neither is a
#: finished artefact, and in a bucket where every object is locked for years a
#: truncated upload cannot be replaced or removed — which is exactly the trap
#: `AGENTS.md` records about porting the `.partial` rule to S3.
_SKIP_SUFFIXES = (".partial",)


def _store_roots() -> list[tuple[str, Path]]:
    """`(archive root, directory)` for each store, resolved at call time.

    `interview_audio` is imported INSIDE the function, the guard
    `retention._delete_interview_audio` uses and for its reason: this module's
    document half must keep working on a slim image, or any host, where that
    module will not import. An ImportError costs the audio half of one sweep,
    never the whole run.
    """
    roots: list[tuple[str, Path]] = [(DOCUMENTS_ROOT, settings.uploads_path)]
    try:
        from .interview_audio import _store_root

        roots.append((AUDIO_ROOT, _store_root()))
    except ImportError:
        log.warning(
            "app.interview_audio will not import here, so interview recordings "
            "were NOT swept this pass. The document half ran normally."
        )
    return roots


def _files_on_disk(directory: Path) -> list[Path]:
    """Regular files directly in `directory`. Both stores are FLAT by design —
    `document_store` names every file `uuid4().hex + ext` and `interview_audio`
    names its two `<session>.<track>.wav` — so this does not recurse. A
    subdirectory appearing under either root is something this module did not
    put there and must not guess about."""
    if not directory.is_dir():
        return []
    return sorted(
        p
        for p in directory.iterdir()
        if p.is_file() and not p.name.endswith(_SKIP_SUFFIXES)
    )


def _archived_names(root: str, client) -> set[str]:
    """Every `stored_name` the bucket already holds under `root`.

    `list_objects_v2` under `s3:ListBucket`, paginated by hand rather than
    through a paginator so the one call this module makes against boto3 is the
    same one `document_archive.is_archived` and
    `backup_database.month_is_archived` make. Key names, never contents: this
    task holds no `s3:GetObject` and must not start needing one.
    """
    prefix = document_archive.key_for("_", root=root)[: -len("_")]
    bucket = settings.document_archive_bucket.strip()
    names: set[str] = set()
    token: str | None = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            key = obj.get("Key", "")
            if key.startswith(prefix):
                names.add(key[len(prefix) :])
        if not resp.get("IsTruncated"):
            return names
        token = resp.get("NextContinuationToken")
        if not token:
            return names


def run(*, dry_run: bool = False) -> dict[str, int]:
    """Sweep every store. Returns counts; never raises for one bad file.

    A single unreadable file or a single refused PUT is COUNTED AND REPORTED,
    not fatal: the remaining ten thousand files are the reason this runs, and a
    sweep that aborts on the first problem archives nothing on the night one
    file is locked. The exit code carries the failure instead.
    """
    summary = {"seen": 0, "already": 0, "archived": 0, "failed": 0}
    if not document_archive.archive_enabled():
        # SAID OUT LOUD, every run. A deployment with no archive bucket is a
        # supported configuration and it is also a deployment whose files have
        # no copy outliving `backupRetentionDays` — the two facts must never
        # be distinguishable only by someone going to look.
        log.warning(
            "DOCUMENT_ARCHIVE_BUCKET is not set, so this deployment keeps NO "
            "permanent copy of its uploaded files. The only thing behind them "
            "is the daily backup plan's %s-day lifecycle on the volume.",
            "35",
        )
        return summary

    client = document_archive._client()
    for root, directory in _store_roots():
        files = _files_on_disk(directory)
        if not files:
            log.info("%s: nothing on disk at %s", root, directory)
            continue
        try:
            have = _archived_names(root, client)
        except Exception:  # noqa: BLE001
            log.exception(
                "Could not list the archive under %s, so its %d file(s) were not "
                "swept this pass.",
                root,
                len(files),
            )
            summary["failed"] += len(files)
            continue
        for path in files:
            summary["seen"] += 1
            if path.name in have:
                summary["already"] += 1
                continue
            if dry_run:
                log.info("%s: would archive %s", root, path.name)
                summary["archived"] += 1
                continue
            if document_archive.archive_file(path, stored_name=path.name, root=root, client=client):
                summary["archived"] += 1
            else:
                summary["failed"] += 1
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.archive_documents",
        description=(
            "Upload every stored document and finished interview recording that "
            "the permanent archive does not already hold. Writes only: nothing "
            "on the volume or in the bucket is ever deleted, renamed or moved."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be uploaded and upload nothing.",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    summary = run(dry_run=args.dry_run)
    log.info(
        "%s: %d seen, %d already archived, %d %s, %d failed",
        "Dry run" if args.dry_run else "Sweep",
        summary["seen"],
        summary["already"],
        summary["archived"],
        "to upload" if args.dry_run else "archived",
        summary["failed"],
    )
    return 1 if summary["failed"] else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
