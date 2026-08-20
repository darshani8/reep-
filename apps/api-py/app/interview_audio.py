"""On-disk store for interview audio — a SIBLING of app/filestore.py, never a reuse of it.

Interview Engine v3 §8.4 argued, at length and correctly, that audio should not
be captured in that pass. The product owner has since required a stored
recording for authorised developer review of the interview engine, so this
module is the "later pass" §8.4's closing paragraph sketches. Every one of its
four objections is answered HERE, in code, rather than waved off — and the
answers are the reason each design decision below looks paranoid:

1.  **"There is no encoder."** True of Opus and irrelevant to WAV. The bytes
    already crossing the relay are PCM16 LE mono 24 kHz, which is exactly the
    payload of a RIFF/WAVE file; the stdlib `wave` module writes the 44-byte
    header around them. No dependency, no transcode, and NOT ONE CPU CYCLE of
    encoding on the audio path — `feed()` is a list append.

    `wave.Wave_write.writeframes` also re-patches the RIFF size fields after
    every call (unlike `writeframesraw`), so the file on disk is a PLAYABLE WAV
    at all times, not only after a clean close. A worker killed with -9
    mid-interview therefore leaves a shorter recording rather than a corrupt
    one. That property is worth the per-flush seek and is the reason nothing
    here reaches for the private `_patchheader`.

2.  **"48 kB/s, 43 MB an interview, 4.3 GB/hour at the 100-session cap, on a box
    with no quota."** Three answers, in order of how much they save:
    `settings.interview_recording_enabled` is FALSE by default, so the usual
    deployment stores nothing at all; `settings.interview_recording_max_bytes`
    is a HARD per-session ceiling after which capture stops and
    `audio_truncated` is set — never a silent truncation; and every file is
    destroyed by `retention.purge_expired` through `delete_session_audio`
    below, on the same 180-day clock as the transcript. "Every file" is meant
    literally: retention sweeps by SESSION ID, for every expiring session,
    never by what the row believes about its own audio — a row's flags record
    what the relay managed to write down before it died, and the filesystem is
    the authority on which files exist.

3.  **"filestore.py cannot be reused — it decides type by magic bytes and
    accepts only PDF/PNG/JPEG, and admitting audio loosens the one control that
    makes it trustworthy."** Also correct, which is why filestore.py is not
    touched, not imported here, and not taught about audio. This store has its
    own root directory, its own naming rule and its own validation. What IS
    carried over is its hardening, because those lessons were paid for once:
    reads and deletes reject any path separator or `..`, no client-supplied
    string ever becomes a path component, and the store is the only code that
    knows where the bytes live.

    ONE DELIBERATE DIVERGENCE. filestore names files randomly because their
    names come from a student; ours are named for the `interview_sessions.id`
    that owns them — a server-generated uuid4 hex that no client ever supplies,
    and still validated on the way in. The reason is deletion: if the row's
    `audio_path` is ever lost (the finalizing UPDATE failed, a migration went
    sideways), a recording of a named student would become undiscoverable and
    therefore undeletable. Naming the file after the session means retention can
    always find it from the row's primary key alone.

4.  **"Voice is biometric-adjacent — a different consent and legal posture."**
    The strongest objection, and the one with the least forgiving failure. So:
    NO BYTES ARE WRITTEN unless `settings.interview_recording_enabled` is true
    AND the student holds a live `interview_consents` row, of the current
    version, whose `scope_store_audio` is true. Both gates are in `recorder_for`
    below and it is the ONLY constructor callers should use. The consent check
    fails CLOSED — an unreachable database means "do not record", never "record
    anyway".

WHERE THE BYTES COME FROM AND HOW THEY LEAVE THE LOOP. `feed()` is called from
the relay's audio hot path (~25 frames/s/session in each direction) and NEVER
does I/O: it appends to an in-memory list and returns. A flush is scheduled as a
task only once ~256 kB has accumulated (~5 s of audio), and the write itself
runs on `asyncio.to_thread` — the same discipline every other blocking call in
this feature uses, and the reason a slow disk cannot stall a live interview's
audio. Buffering rather than a dedicated writer thread per session is deliberate:
at the 100-session cap a thread apiece would be 100 OS threads blocked on a
queue, while `to_thread` reuses the executor the relay already has, and it keeps
one concurrency model in a module that is hard enough to reason about with one.

The buffer is bounded (`_MAX_BUFFERED_BYTES`). If flushes fall so far behind
that the bound is reached, capture STOPS and the truncation flag is set — it
does not skip a chunk and carry on. A file with a hole in the middle is a
recording that replays as if the student went quiet; a file that simply ends is
a fact the flag already describes.

TWO FILES PER INTERVIEW, ONE PER SPEAKER, and never one mixed stereo file. The
uplink and the downlink are not time-aligned — the student's audio is what their
microphone captured, the interviewer's is what the model emitted, and the gap
between them is network latency plus the browser's play queue. Interleaving them
into one timeline would be an invented fact in a record kept for review.
"""

from __future__ import annotations

import asyncio
import logging
import re
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Final

from .config import settings

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# The format, which is not negotiable: it is whatever the relay already carries
# ---------------------------------------------------------------------------

# PCM16 LE mono 24 kHz — the wire format of BOTH directions of /api/interview
# (see the module header of app/interview_relay.py). These are not a preference;
# changing one without changing the relay produces a file that plays back at the
# wrong speed, which sounds like a defect in the student rather than in us.
_SAMPLE_RATE_HZ: Final[int] = 24000
_SAMPLE_WIDTH_BYTES: Final[int] = 2
_CHANNELS: Final[int] = 1
_BYTES_PER_SECOND: Final[int] = _SAMPLE_RATE_HZ * _SAMPLE_WIDTH_BYTES * _CHANNELS

TRACK_STUDENT: Final[str] = "student"
TRACK_INTERVIEWER: Final[str] = "interviewer"
# The order is the order a reviewer wants them offered in.
TRACKS: Final[tuple[str, ...]] = (TRACK_STUDENT, TRACK_INTERVIEWER)

# Accumulate this much before touching the disk: ~5 s of audio, one write per
# track per five seconds per session rather than one per 20 ms frame. Small
# enough that a killed worker loses seconds, large enough that the syscall rate
# at the 100-session cap stays in the tens per second.
_FLUSH_BYTES: Final[int] = 256 * 1024

# The bound that stops a wedged disk becoming a memory leak. Reaching it means
# flushes are more than ~85 s behind on one session, which is not a disk this
# recording is going to survive anyway.
_MAX_BUFFERED_BYTES: Final[int] = 4 * 1024 * 1024

# A stored name is one of OUR ids, never anything a client sent. Anchored, no
# alternation, no nested quantifier — linear time on any input, because a regex
# that guards a path must not itself be the way in (the audit's ReDoS finding).
_STEM_RE: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9_-]{1,64}")


class AudioStoreError(RuntimeError):
    """The store was asked for something it must refuse — a name it cannot trust."""


@dataclass(frozen=True, slots=True)
class CaptureResult:
    """What was actually kept, in the shape `interview_sessions` records it.

    `recorded` is the field callers must branch on, and `path` is the field they
    must NOT — app/models/interview.py sets out the four different facts a NULL
    path collapses into one. `recorded` is true if and only if bytes reached the
    disk under `path`, which is also the condition under which retention has
    something to destroy.
    """

    recorded: bool
    path: str | None
    total_bytes: int
    duration_ms: int
    truncated: bool


_NOTHING_RECORDED: Final[CaptureResult] = CaptureResult(
    recorded=False, path=None, total_bytes=0, duration_ms=0, truncated=False
)


# ---------------------------------------------------------------------------
# Where the bytes live
# ---------------------------------------------------------------------------
def _store_root() -> Path:
    """The interview-audio root as a PATH. Resolving it creates nothing.

    Directory creation belongs to `_write_blobs`, the one function that actually
    needs the directory to exist, and it lives there for a reason that is not
    tidiness: `retention.purge_expired` now calls `delete_session_audio` for
    EVERY expiring session, most of which never recorded a byte. If resolving a
    path also ran `mkdir`, every retention sweep on a deployment that records
    nothing would conjure an empty audio store — and on a read-only or
    unmounted volume it would RAISE, which retention reads as "bytes may still
    be on disk" and answers by holding the row back from hard-delete. A path is
    a name. Naming a file must not have side effects.

    A SIBLING of `settings.uploads_path` rather than a subdirectory of it, so
    that an operator who moved uploads onto a mounted volume gets the audio on
    that volume too (the common reason to move it is that the container's own
    disk is ephemeral, and a lost recording is exactly the thing that reads as
    "the system deleted my evidence"), while `ls` still shows two separate
    stores with two separate sets of rules.

    There is no `INTERVIEW_AUDIO_DIR` setting today because app/config.py is
    owned by another track this wave. `getattr` picks one up the day it is added
    — mirror `uploads_path` and name it `interview_audio_dir`.
    """
    configured = str(getattr(settings, "interview_audio_dir", "") or "").strip()
    if configured:
        return Path(configured)
    return settings.uploads_path.parent / "interview-audio"


def _safe_stem(stem: str) -> str:
    """Validate a stored name, or refuse.

    filestore.read_bytes' guard, tightened from a blocklist of separators to an
    ALLOWLIST of characters. A blocklist has to anticipate every separator the
    platform honours; this has to anticipate nothing, and there is no legitimate
    stored name here that is not an id we generated.
    """
    if not isinstance(stem, str) or not _STEM_RE.fullmatch(stem):
        raise AudioStoreError(f"Refusing an untrusted interview-audio name: {stem!r}")
    return stem


def _safe_track(track: str) -> str:
    if track not in TRACKS:
        raise AudioStoreError(f"Unknown interview-audio track: {track!r}")
    return track


def track_path(stem: str, track: str) -> Path:
    """Absolute path of one track's file. Validates both components first.

    The ONLY place a stored name becomes a filesystem path. Every read, write
    and delete goes through here, so the traversal guard cannot be forgotten by
    a caller that builds its own path "just this once".
    """
    return _store_root() / f"{_safe_stem(stem)}.{_safe_track(track)}.wav"


def download_name(stem: str, track: str) -> str:
    """The filename a reviewer's browser should see. Contains no student name.

    A recording is served to DIRECTOR/ADMIN only, but it still lands in a
    downloads folder that syncs, backs up and gets searched. Naming it after the
    interview id keeps the association in the database, where access control
    lives, instead of in a filename.
    """
    return f"interview-{_safe_stem(stem)}-{_safe_track(track)}.wav"


def read_track(stem: str, track: str) -> Path:
    """Resolve one track for playback. Raises FileNotFoundError when absent.

    Returns a PATH rather than bytes on purpose: a 15-minute recording is ~43 MB
    and the download endpoint streams it, where uploads (10 MB, and a mentor
    opening one at a time) are read whole.
    """
    path = track_path(stem, track)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path


def available_tracks(stem: str) -> list[str]:
    """Which of the two tracks actually exist on disk, in playback order."""
    return [track for track in TRACKS if track_path(stem, track).is_file()]


def delete_session_audio(
    interview_session_id: str, audio_path: str | None = None
) -> int:
    """Remove any stored audio for this interview. Returns how many FILES were
    actually removed — 0 on most calls, because most interviews recorded nothing.

    THE CONTRACT app/retention.py's `_delete_interview_audio` documents, and its
    only implementation. Three properties it depends on, all load-bearing:

    IDEMPOTENT — a file that is already gone is success. The reaper runs again
    tomorrow and a second pass must not start raising.

    A NO-OP FOR A SESSION THAT NEVER RECORDED — including one whose store
    directory does not exist, which is every deployment with
    `interview_recording_enabled` false. `unlink` on a missing file and `unlink`
    under a missing directory both surface as `FileNotFoundError`, and both mean
    the same thing here: nothing of this student's is on that disk. Nothing in
    this function creates a directory (see `_store_root`), so calling it for a
    session that never had audio leaves the filesystem exactly as it found it.

    RAISES ONLY WHEN BYTES MAY STILL BE ON DISK — a name we refuse to resolve, a
    permission error, a device that is gone. Retention holds the database row
    back from hard-delete when this raises, because a row is the last pointer to
    a recording of a named student: destroy it and the file becomes
    undiscoverable, which is the one outcome nobody can fix afterwards.

    Both the recorded path AND the session id are tried, and they are usually the
    same string. `audio_path` defaults to None because the session id alone IS
    enough — it is the file's name, which is the whole reason §8.4's naming rule
    diverges from filestore's. Pass the row's path anyway when you have one: the
    two differ exactly when the finalizing UPDATE failed and the row never
    learned its path, and a caller that thinks about that case is a caller who
    will keep passing it if the naming rule ever changes.

    THE HOLE THIS USED TO DESCRIBE IS CLOSED. Retention once selected rows by
    `audio_recorded OR audio_path`, so a file whose row learned NEITHER — Layer 1
    died before it could record what it believed — was never offered here at all.
    `retention._delete_interview_audio` now calls this for EVERY expiring
    session, which is why the "no-op for a session that never recorded" property
    above is a contract and not a convenience: it is what makes an unconditional
    call cheap enough to be the only sweep this store needs.
    """
    stems = [s for s in dict.fromkeys([audio_path, interview_session_id]) if s]
    unusable: list[str] = []
    removed = 0
    for stem in stems:
        try:
            paths = [track_path(stem, track) for track in TRACKS]
        except AudioStoreError:
            # A stored name we will not turn into a path. Collected rather than
            # raised immediately so the OTHER stem still gets its chance to
            # delete the bytes; reported at the end so retention keeps the row.
            unusable.append(stem)
            continue
        for path in paths:
            try:
                path.unlink()
            except FileNotFoundError:
                # The common answer, and success: no such file, or no such
                # store directory. Caught rather than `missing_ok=True` only so
                # the count above means "bytes destroyed" and not "paths tried"
                # — retention reports that number to an operator.
                continue
            removed += 1
    if unusable:
        raise AudioStoreError(
            "Interview audio may still be on disk under a name this store will "
            f"not resolve: {unusable!r}"
        )
    return removed


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------
class InterviewRecorder:
    """One interview's capture: two mono WAV files, a hard byte cap, and no I/O
    on the caller's thread.

    Lifecycle, and it is the caller's job in this order:

        recorder = recorder_for(interview_session_id, user_id)   # may be None
        recorder.feed(TRACK_STUDENT, pcm)        # loop thread, never blocks
        result = await recorder.aclose()         # once, idempotent

    NOTHING IS OPENED UNTIL THE FIRST BYTE IS FLUSHED. An interview where the
    student never speaks leaves no file at all, rather than a 44-byte header that
    a reviewer has to play to discover is empty — and `recorded=False` then says
    the honest thing without anyone deleting anything.

    `feed` is TOTAL: it does not raise, for any input, ever. It is called from
    the relay's audio path, where an exception would take down a live interview
    over a bookkeeping concern. Failures stop capture, set the truncation flag
    and are logged loudly; the interview continues.
    """

    __slots__ = (
        "_stem",
        "_max_bytes",
        "_buffers",
        "_buffered",
        "_written",
        "_captured",
        "_writers",
        "_lock",
        "_tasks",
        "_stopped",
        "_truncated",
        "_result",
    )

    def __init__(self, interview_session_id: str, max_bytes: int) -> None:
        # Validated HERE, at construction, so a bad id fails when the interview
        # opens rather than when the first frame arrives on the hot path.
        self._stem = _safe_stem(interview_session_id)
        # Floored at zero rather than trusted: a negative or absurd setting must
        # mean "record nothing", not "record without limit".
        self._max_bytes = max(0, int(max_bytes))
        self._buffers: dict[str, list[bytes]] = {track: [] for track in TRACKS}
        self._buffered = 0
        self._written: dict[str, int] = {track: 0 for track in TRACKS}
        self._captured = 0
        # track -> (wave writer, the file handle WE opened for it). Both are
        # kept because `wave` closes only handles it opened itself.
        self._writers: dict[str, tuple[wave.Wave_write, IO[bytes]]] = {}
        # Serialises the flushes. Popping the buffer INSIDE the lock is what
        # keeps the file in wire order: whoever holds the lock writes everything
        # buffered at that moment, and the next holder writes whatever arrived
        # since. Popping outside it would let two flushes write out of order and
        # produce a recording that jumps backwards in time.
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        self._stopped = False
        self._truncated = False
        self._result: CaptureResult | None = None

    # -- the hot path -------------------------------------------------------

    def feed(self, track: str, pcm: bytes) -> None:
        """Accept audio for one track. Never blocks, never raises, never does I/O."""
        try:
            if self._stopped or self._result is not None or not pcm:
                return

            remaining = self._max_bytes - self._captured
            if remaining <= 0:
                self._stop("the per-session byte cap", truncated=True)
                return
            if len(pcm) > remaining:
                # Cut ON A SAMPLE BOUNDARY. Half a PCM16 sample at the end of a
                # file is a click, and every downstream tool has to guess what to
                # do with the odd byte.
                pcm = pcm[: remaining - (remaining % _SAMPLE_WIDTH_BYTES)]
                self._captured += len(pcm)
                if pcm:
                    self._buffers[track].append(pcm)
                    self._buffered += len(pcm)
                self._stop("the per-session byte cap", truncated=True)
                self._schedule_flush()
                return

            self._buffers[track].append(pcm)
            self._buffered += len(pcm)
            self._captured += len(pcm)

            if self._buffered >= _MAX_BUFFERED_BYTES:
                # Flushes are not keeping up. STOP rather than drop a chunk and
                # continue: a recording that ends early is described by the
                # truncation flag, while one with a silent hole in the middle
                # replays as a student who went quiet.
                self._stop("the write buffer bound (the disk is not keeping up)",
                           truncated=True)
                self._schedule_flush()
                return

            if self._buffered >= _FLUSH_BYTES:
                self._schedule_flush()
        except Exception:  # pragma: no cover -- the belt on the braces
            # `feed` is TOTAL, and this clause is why. Nothing about storing a
            # recording is worth ending a live interview for.
            self._stopped = True
            self._truncated = True
            log.exception("Interview audio capture failed and has stopped (%s)", self._stem)

    def _stop(self, why: str, *, truncated: bool) -> None:
        if self._stopped:
            return
        self._stopped = True
        self._truncated = self._truncated or truncated
        # WARNING, not INFO: a truncated recording is a fact somebody reviewing
        # this interview needs to know, and the row's flag alone does not say
        # WHICH cap stopped it.
        log.warning(
            "Interview audio capture for %s stopped at %d bytes: %s",
            self._stem,
            self._captured,
            why,
        )

    def _schedule_flush(self) -> None:
        try:
            task = asyncio.get_running_loop().create_task(self._flush())
        except RuntimeError:  # pragma: no cover -- fed from outside a loop
            # Nothing to schedule onto. The bytes stay buffered and aclose()
            # writes them; this is the shape a unit test that never runs a loop
            # takes, and it must not raise on the hot path.
            return
        # Held so CPython cannot garbage-collect a running task mid-write, the
        # same reason app/interview_relay.py keeps its `_writes` set.
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _flush(self) -> None:
        async with self._lock:
            await self._flush_locked()

    async def _flush_locked(self) -> None:
        blobs: dict[str, bytes] = {}
        for track in TRACKS:
            chunks = self._buffers[track]
            if not chunks:
                continue
            blob = b"".join(chunks)
            chunks.clear()
            tail = len(blob) % _SAMPLE_WIDTH_BYTES
            if tail:
                # An odd tail belongs to the next flush, not to this file: the
                # relay's own `_pcm_carry` makes the same choice one layer up,
                # for the same reason. Re-inserted at the HEAD so it still
                # precedes anything fed while this flush was awaiting the disk.
                chunks.insert(0, blob[-tail:])
                blob = blob[:-tail]
            self._buffered -= len(blob)
            if blob:
                blobs[track] = blob
        if not blobs:
            return
        try:
            # to_thread, NOT an inline write: this is the whole reason the hot
            # path is a list append. A disk that takes 400 ms must cost this
            # session 400 ms of buffering, never 400 ms of every other student's
            # audio on the same worker.
            await asyncio.to_thread(self._write_blobs, blobs)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._stop("a write error", truncated=True)
            log.exception("Could not write interview audio for %s", self._stem)

    def _write_blobs(self, blobs: dict[str, bytes]) -> None:
        """Worker thread. Serialised by the caller's lock, so `wave` sees one writer."""
        for track, blob in blobs.items():
            opened = self._writers.get(track)
            if opened is None:
                # The file handle is opened HERE and handed to `wave`, rather
                # than letting wave.open() take the path, for one reason: we need
                # to flush it ourselves after every write (below), and reaching
                # into `Wave_write._file` to do that would be a private attribute
                # in the one code path that must not break on a Python upgrade.
                path = track_path(self._stem, track)
                # The ONLY mkdir in this module. Resolving a path deliberately
                # creates nothing (see _store_root), so the writer — the one
                # caller that cannot work without the directory — makes it.
                path.parent.mkdir(parents=True, exist_ok=True)
                handle = path.open("wb")
                writer = wave.open(handle, "wb")
                writer.setnchannels(_CHANNELS)
                writer.setsampwidth(_SAMPLE_WIDTH_BYTES)
                writer.setframerate(_SAMPLE_RATE_HZ)
                opened = (writer, handle)
                self._writers[track] = opened
            writer, handle = opened
            # writeframes, NOT writeframesraw: it re-patches the RIFF size
            # fields after every call. The flush is the other half of that, and
            # without it both the header and the audio sit in a Python-level
            # buffer where a killed worker loses them: the file on disk would be
            # zero bytes, not a shorter recording. Together they are what makes
            # the claim "playable at all times" true rather than aspirational.
            writer.writeframes(blob)
            handle.flush()
            self._written[track] += len(blob)

    # -- teardown -----------------------------------------------------------

    def snapshot(self) -> CaptureResult:
        """The best-known result WITHOUT touching the disk, for when close hangs.

        Deliberately optimistic about `recorded`: if bytes reached a file, this
        says so even though the header may not have been patched a final time.
        The alternative — reporting "not recorded" because the close timed out —
        would leave a real recording of a named student on disk with nothing in
        the database pointing at it, and retention only deletes what a row
        admits exists.
        """
        written = sum(self._written.values())
        if not written:
            return CaptureResult(
                recorded=False, path=None, total_bytes=0, duration_ms=0,
                truncated=self._truncated,
            )
        return CaptureResult(
            recorded=True,
            path=self._stem,
            # +44 per file for the RIFF header, so the figure means "disk this
            # interview is using" — which is what the reaper accounts for.
            # Counted off `_written` and not off `_writers`, which aclose()
            # empties as it closes the files.
            total_bytes=written + 44 * sum(1 for n in self._written.values() if n),
            duration_ms=self._duration_ms(),
            truncated=self._truncated,
        )

    def _duration_ms(self) -> int:
        """The LONGER of the two tracks — the span of the recording.

        Not the sum (the two are concurrent, not sequential) and not the
        interview's own duration (a late start, a cap or a failed write each make
        this shorter). app/models/interview.py says the same thing at the column.
        """
        return max(
            (written * 1000) // _BYTES_PER_SECOND for written in self._written.values()
        )

    async def aclose(self) -> CaptureResult:
        """Flush, close both files, and report what was kept. Idempotent."""
        if self._result is not None:
            return self._result
        self._stopped = True

        # Let scheduled flushes finish first; they hold the lock, so this both
        # orders the writes and stops a task writing into a closed file.
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        async with self._lock:
            try:
                await self._flush_locked()
            except Exception:  # pragma: no cover -- _flush_locked swallows its own
                log.exception("Final interview-audio flush failed for %s", self._stem)
            try:
                await asyncio.to_thread(self._close_writers)
            except Exception:
                # The bytes are on disk either way, and `snapshot` already
                # accounts for them. Losing the last header patch costs a few
                # seconds off the reported length, not the recording.
                log.exception("Could not close the interview audio for %s", self._stem)
        self._result = self.snapshot()
        return self._result

    def _close_writers(self) -> None:
        """Close both files. `wave` did not open the handles, so it does not
        close them — that is our job, and a leaked descriptor per interview is
        a worker that runs out of them in a day."""
        while self._writers:
            _track, (writer, handle) = self._writers.popitem()
            try:
                writer.close()
            finally:
                handle.close()


# ---------------------------------------------------------------------------
# The two gates — the ONLY supported way to obtain a recorder
# ---------------------------------------------------------------------------
def audio_consent_granted(user_id: str) -> bool:
    """Does this user hold a live grant, of the CURRENT version, covering audio?

    FAILS CLOSED. Any error — an unreachable database, a schema mid-migration —
    returns False and logs. "We could not check whether the student agreed" and
    "the student agreed" are not the same sentence, and only one of them may
    result in a recording of their voice.

    The version matters: consent is to WORDING, and `scope_store_audio` on a
    grant against copy that never mentioned audio would be consent to a sentence
    the student never read (§8.2). A new version means asking again.

    Imported lazily so that the file store above stays importable with no
    database at all — `retention.purge_expired` and the unit tests both rely on
    that, and it keeps app/interview_relay.py's "no ORM behind the relay"
    property intact for anything that only ever calls the writer side.
    """
    from sqlalchemy import select

    from .db import SessionLocal
    from .models.interview import InterviewConsent

    try:
        with SessionLocal() as db:
            return bool(
                db.scalar(
                    select(InterviewConsent.id)
                    .where(
                        InterviewConsent.user_id == user_id,
                        InterviewConsent.version == settings.interview_consent_version,
                        InterviewConsent.revoked_at.is_(None),
                        InterviewConsent.scope_store_audio.is_(True),
                    )
                    .limit(1)
                )
            )
    except Exception:
        log.exception(
            "Could not read interview audio consent; NOT recording this interview"
        )
        return False


def recorder_for(interview_session_id: str, user_id: str) -> InterviewRecorder | None:
    """A recorder, or None — and None is the answer in every deployment today.

    THE ONLY CONSTRUCTOR CALLERS SHOULD USE. Both gates live here so that "when
    does REEP record a student's voice?" has one answer in one function, rather
    than a flag checked in one file and a consent row checked in another.

    Order matters for a boring reason: the flag is a memory read and the consent
    check is a query, so a deployment with recording off (all of them, by
    default) never touches the database for this at all.
    """
    if not settings.interview_recording_enabled:
        return None
    if not audio_consent_granted(user_id):
        # INFO, not a warning: a student who has not agreed to be recorded is
        # the expected case, not a fault. It is logged at all because "recording
        # is on and nothing is being written" is otherwise a silent mystery.
        log.info(
            "Interview audio recording is enabled but this student has no live "
            "scope_store_audio grant; nothing will be captured."
        )
        return None
    try:
        return InterviewRecorder(
            interview_session_id, settings.interview_recording_max_bytes
        )
    except Exception:
        # A bad id, or an unwritable root. The interview must still run.
        log.exception(
            "Could not open interview audio capture for session %s; "
            "the interview continues without a recording.",
            interview_session_id,
        )
        return None
