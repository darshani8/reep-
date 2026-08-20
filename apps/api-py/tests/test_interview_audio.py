"""Interview audio capture — the four objections v3 §8.4 raised, as tests.

§8.4 said "do not implement byte capture in this pass" and gave four reasons.
The product owner has since required a stored recording for authorised developer
review, so capture exists — and every test below is one of those objections
turned into something that fails if the answer stops holding:

  1. "No encoder."            -> test_the_file_is_a_playable_wav_and_its_duration_matches_the_bytes
  2. "48 kB/s, no quota."     -> TestTheCap, and test_retention_can_delete_by_session_id_alone
  3. "filestore can't be it." -> TestNames (its hardening, carried over, in a store of our own)
  4. "Voice is biometric."    -> TestTheTwoGates — no flag, no bytes; no consent, no bytes

Most of it needs no database and no socket. The consent gate and the download
endpoint do, and those are @requires_db.

EVERY TEST WRITES INTO tmp_path. The `store` fixture repoints the store root, so
a failing run cannot leave a WAV file in the developer's real var/ directory —
which for this feature would be somebody's actual voice.
"""

import asyncio
import uuid
import wave
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete

from conftest import requires_db

from app import interview_audio
from app.config import settings
from app.db import SessionLocal
from app.interview_audio import (
    TRACK_INTERVIEWER,
    TRACK_STUDENT,
    TRACKS,
    AudioStoreError,
    CaptureResult,
    InterviewRecorder,
    audio_consent_granted,
    delete_session_audio,
    read_track,
    recorder_for,
    track_path,
)
from app.interview_relay import (
    _AUDIO_TRACK_INTERVIEWER,
    _AUDIO_TRACK_STUDENT,
    _CLOSE_OK,
    _RelaySession,
)

# 24 kHz, 16-bit, mono: 48000 bytes is exactly one second of it. Every duration
# assertion below is derived from this rather than from a magic number, so a
# format change breaks the arithmetic loudly instead of shifting a constant.
BYTES_PER_SECOND = 48000


def _pcm(nbytes: int) -> bytes:
    """`nbytes` of non-silent, sample-aligned PCM16."""
    assert nbytes % 2 == 0
    return bytes(range(256)) * (nbytes // 256) + b"\x00" * (nbytes % 256)


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Point the audio store at a throwaway directory and hand back its root.

    The root is derived from `settings.uploads_path` (a SIBLING of it — see
    _store_root), so moving `upload_dir` moves both. That coupling is asserted
    here rather than assumed: if the derivation changes, this fixture stops
    isolating the tests and somebody's voice ends up in var/.
    """
    monkeypatch.setattr(settings, "upload_dir", str(tmp_path / "uploads"))
    root = tmp_path / "interview-audio"
    assert interview_audio._store_root() == root
    return root


def _read_wav(path):
    """(params, frames) of a stored track, read with the stdlib reader.

    Deliberately `wave` rather than a hand-rolled header parse: the claim being
    tested is "this is a WAV any player can open", and the stdlib reader is the
    nearest thing to a player this suite can hold.
    """
    with wave.open(str(path), "rb") as w:
        return w.getparams(), w.readframes(w.getnframes())


def _close(recorder: InterviewRecorder) -> CaptureResult:
    return asyncio.run(recorder.aclose())


# ---------------------------------------------------------------------------
# Objection 1 — "there is no encoder"
# ---------------------------------------------------------------------------
class TestTheFileItself:
    def test_the_file_is_a_playable_wav_and_its_duration_matches_the_bytes(self, store):
        """PCM16 24 kHz mono needs no encoder — it needs a RIFF header.

        If this goes red the recording is not audio any more, and the way that
        usually happens is somebody changing the sample rate on one side of the
        relay only: the file still opens, the voice plays back at the wrong
        speed, and it sounds like a defect in the student.
        """
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)
        payload = _pcm(BYTES_PER_SECOND * 2)  # two seconds
        recorder.feed(TRACK_STUDENT, payload)
        result = _close(recorder)

        assert result.recorded is True
        assert result.truncated is False
        assert result.duration_ms == 2000

        params, frames = _read_wav(track_path(result.path, TRACK_STUDENT))
        assert params.nchannels == 1
        assert params.sampwidth == 2
        assert params.framerate == 24000
        assert params.nframes == len(payload) // 2
        assert frames == payload

    def test_the_two_speakers_are_two_mono_files_and_never_one_mixed_one(self, store):
        """They are not time-aligned, so interleaving them would invent a fact.

        The student's track is what their microphone captured; the interviewer's
        is what the model emitted. Splicing them onto one timeline would put
        words in a reviewer's ear in an order nobody spoke them in.
        """
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)
        recorder.feed(TRACK_STUDENT, _pcm(4800))
        recorder.feed(TRACK_INTERVIEWER, _pcm(9600))
        result = _close(recorder)

        student, interviewer = (
            track_path(result.path, TRACK_STUDENT),
            track_path(result.path, TRACK_INTERVIEWER),
        )
        assert student.is_file() and interviewer.is_file()
        assert student != interviewer
        assert _read_wav(student)[0].nframes == 2400
        assert _read_wav(interviewer)[0].nframes == 4800
        # The SPAN of the recording, not the sum: the two tracks are concurrent.
        assert result.duration_ms == (9600 * 1000) // BYTES_PER_SECOND

    def test_an_interview_with_no_audio_leaves_no_file_at_all(self, store):
        """Not an empty 44-byte header a reviewer has to play to discover is empty.

        `recorded=False` is then the honest answer with nothing to clean up, and
        retention has nothing to find because there is nothing there.
        """
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)
        result = _close(recorder)

        assert result == CaptureResult(
            recorded=False, path=None, total_bytes=0, duration_ms=0, truncated=False
        )
        assert not list(store.glob("*.wav"))

    def test_the_header_is_current_before_the_file_is_closed(self, store):
        """A worker killed mid-interview must leave a SHORTER recording, not a
        corrupt one.

        `wave.writeframes` re-patches the RIFF size fields after every write;
        `writeframesraw` does not. Swapping one for the other is a plausible
        micro-optimisation that would silently make every recording unplayable
        unless the process exited cleanly — which is exactly the process that
        does not exit cleanly.
        """
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)

        async def scenario():
            recorder.feed(TRACK_STUDENT, _pcm(BYTES_PER_SECOND))
            # Flush without closing: this is the state a SIGKILL interrupts.
            await recorder._flush()
            return recorder.snapshot()

        snapshot = asyncio.run(scenario())
        params, frames = _read_wav(track_path(snapshot.path, TRACK_STUDENT))
        assert params.nframes == BYTES_PER_SECOND // 2
        assert len(frames) == BYTES_PER_SECOND

    def test_an_odd_byte_is_carried_rather_than_written(self, store):
        """Half a PCM16 sample at the end of a flush is a click and a frame count
        that no longer matches the data. The relay carries its stray byte into
        the next frame for the same reason (`_pcm_carry`)."""
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)

        async def scenario():
            recorder.feed(TRACK_STUDENT, _pcm(1000) + b"\x7f")
            await recorder._flush()
            recorder.feed(TRACK_STUDENT, b"\x7f")
            return await recorder.aclose()

        result = asyncio.run(scenario())
        params, frames = _read_wav(track_path(result.path, TRACK_STUDENT))
        assert params.nframes == 501
        assert len(frames) == 1002


# ---------------------------------------------------------------------------
# Objection 2 — "48 kB/s, 43 MB an interview, 4.3 GB/hour, and no quota"
# ---------------------------------------------------------------------------
class TestTheCap:
    def test_the_cap_stops_capture_and_says_so(self, store):
        """A HARD ceiling, and NEVER a silent truncation.

        A truncated recording that does not announce itself is a recording that
        gets replayed as if it were complete: "she never answered the last
        question" when in fact the file ended.
        """
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=1000)
        recorder.feed(TRACK_STUDENT, _pcm(600))
        recorder.feed(TRACK_STUDENT, _pcm(600))  # only 400 of these fit
        # Everything after the cap is refused outright rather than queued.
        recorder.feed(TRACK_STUDENT, _pcm(600))
        result = _close(recorder)

        assert result.recorded is True
        assert result.truncated is True
        assert _read_wav(track_path(result.path, TRACK_STUDENT))[0].nframes == 500

    def test_the_cap_is_the_whole_session_not_one_track(self, store):
        """Both directions are the same disk. A per-track cap would let one
        interview use twice the ceiling an operator set."""
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=1000)
        recorder.feed(TRACK_STUDENT, _pcm(800))
        recorder.feed(TRACK_INTERVIEWER, _pcm(800))
        result = _close(recorder)

        student = _read_wav(track_path(result.path, TRACK_STUDENT))[0].nframes
        interviewer = _read_wav(track_path(result.path, TRACK_INTERVIEWER))[0].nframes
        assert student * 2 + interviewer * 2 == 1000
        assert result.truncated is True

    def test_the_cap_cuts_on_a_sample_boundary(self, store):
        """An odd cap must not leave half a sample at the end of the file."""
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=999)
        recorder.feed(TRACK_STUDENT, _pcm(2000))
        result = _close(recorder)

        assert _read_wav(track_path(result.path, TRACK_STUDENT))[0].nframes == 499

    def test_a_cap_of_zero_records_nothing_at_all(self, store):
        """The setting is the off switch of last resort, and a nonsensical value
        must mean "record nothing" rather than "record without limit"."""
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=0)
        recorder.feed(TRACK_STUDENT, _pcm(4800))
        result = _close(recorder)

        assert result.recorded is False
        assert result.truncated is True  # it ended early, and the flag says so
        assert not list(store.glob("*.wav"))

    def test_a_stalled_disk_stops_capture_instead_of_growing_the_buffer(
        self, store, monkeypatch
    ):
        """The bound that stops a wedged disk becoming a memory leak.

        And it STOPS rather than dropping a chunk and carrying on: a file with a
        hole in the middle replays as a student who went quiet, which is a lie
        the truncation flag cannot correct.
        """
        monkeypatch.setattr(interview_audio, "_MAX_BUFFERED_BYTES", 4096)
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)
        # Never awaited, so no flush ever runs: exactly what a disk that has
        # stopped answering looks like from up here.
        for _ in range(10):
            recorder.feed(TRACK_STUDENT, _pcm(1024))

        assert recorder._buffered <= 4096 + 1024
        assert recorder.snapshot().truncated is True


# ---------------------------------------------------------------------------
# Objection 3 — "filestore.py cannot be reused"
# ---------------------------------------------------------------------------
class TestNames:
    """filestore's hardening, carried over into a store with its own rules.

    filestore.py is NOT touched, NOT imported by the writer and NOT taught about
    audio — admitting it there would loosen the magic-byte rule that makes that
    store trustworthy. What travels is the lesson: no client string ever becomes
    a path component, and reads AND deletes both refuse a separator.
    """

    @pytest.mark.parametrize(
        "hostile",
        [
            "../../../etc/passwd",
            "..\\..\\windows\\system32\\config\\sam",
            "a/b",
            "a\\b",
            "..",
            "",
            "x" * 65,
            "sess id",
            "sess.id",  # the separator between stem and track, and not part of a stem
        ],
    )
    def test_a_traversal_attempt_is_refused_everywhere(self, store, hostile):
        with pytest.raises(AudioStoreError):
            track_path(hostile, TRACK_STUDENT)
        with pytest.raises(AudioStoreError):
            read_track(hostile, TRACK_STUDENT)
        with pytest.raises(AudioStoreError):
            InterviewRecorder(hostile, max_bytes=1000)
        if hostile:
            # An EMPTY name is the one case delete treats as "there is nothing
            # here", because that is what a NULL `audio_path` looks like by the
            # time it reaches this function — and raising on it would hold every
            # never-recorded row back from retention forever.
            with pytest.raises(AudioStoreError):
                delete_session_audio(hostile, hostile)

    def test_an_unknown_track_is_refused(self, store):
        """The track is the other half of the filename, so it is validated the
        same way. `?track=../x` must never reach the filesystem."""
        with pytest.raises(AudioStoreError):
            track_path(uuid.uuid4().hex, "../x")

    def test_files_are_named_for_the_session_that_owns_them(self, store):
        """The one deliberate divergence from filestore's random names.

        filestore randomises because its names come from a student. Ours is a
        server-generated session id, and naming the file after it is what makes
        the recording findable when the row's `audio_path` is lost — the only
        state in which a recording of a named student becomes undeletable.
        """
        session_id = uuid.uuid4().hex
        recorder = InterviewRecorder(session_id, max_bytes=10_000_000)
        recorder.feed(TRACK_STUDENT, _pcm(4800))
        result = _close(recorder)

        assert result.path == session_id
        assert (store / f"{session_id}.student.wav").is_file()

    def test_reading_a_missing_track_raises_file_not_found(self, store):
        with pytest.raises(FileNotFoundError):
            read_track(uuid.uuid4().hex, TRACK_INTERVIEWER)


class TestDeletion:
    """`delete_session_audio` is retention's ONLY door into this store."""

    def _recorded(self) -> CaptureResult:
        recorder = InterviewRecorder(uuid.uuid4().hex, max_bytes=10_000_000)
        recorder.feed(TRACK_STUDENT, _pcm(4800))
        recorder.feed(TRACK_INTERVIEWER, _pcm(4800))
        return _close(recorder)

    def test_delete_removes_both_tracks(self, store):
        result = self._recorded()
        delete_session_audio(result.path, result.path)
        assert not list(store.glob("*.wav"))

    def test_retention_can_delete_by_session_id_alone(self, store):
        """`audio_path` NULL and bytes on disk is the state that matters.

        It happens when the finalizing UPDATE never landed. Retention passes the
        row's primary key as well as its path for exactly this case, and if this
        stops working a recording becomes undiscoverable — which is the one
        failure nobody can fix afterwards.
        """
        result = self._recorded()
        delete_session_audio(result.path, None)
        assert not list(store.glob("*.wav"))

    def test_delete_is_idempotent(self, store):
        """The reaper runs again tomorrow; a second pass must not start raising."""
        result = self._recorded()
        assert delete_session_audio(result.path, result.path) == 2  # both tracks
        assert delete_session_audio(result.path, result.path) == 0  # must not raise
        assert delete_session_audio(uuid.uuid4().hex) == 0  # never recorded at all

    def test_deleting_a_session_that_never_recorded_touches_nothing(self, store):
        """The property `retention._delete_interview_audio` now leans its whole
        weight on: it calls this for EVERY expiring session, and in the default
        deployment (`interview_recording_enabled` false) not one of them ever
        wrote a byte, so there is no store directory at all.

        Resolving a path must therefore neither raise nor CREATE the store — an
        empty `interview-audio/` appearing in var/ on a deployment that records
        nothing is the harmless half of that; a read-only or unmounted volume
        raising, and retention reading the raise as "bytes may still be on
        disk", is the half that would hold every interview row back from
        hard-delete forever.
        """
        assert not store.exists()
        assert delete_session_audio(uuid.uuid4().hex) == 0
        assert delete_session_audio(uuid.uuid4().hex, uuid.uuid4().hex) == 0
        assert not store.exists(), "resolving a path must not conjure a store"

    def test_an_unusable_stored_path_still_deletes_what_it_can_and_then_raises(
        self, store
    ):
        """Retention holds the ROW back when this raises, deliberately: a row is
        the last pointer to a recording, and deleting it would leave the file
        undiscoverable."""
        result = self._recorded()
        with pytest.raises(AudioStoreError):
            delete_session_audio(result.path, "../somewhere/else")
        # The files it COULD name are gone even though it went on to raise.
        assert not list(store.glob("*.wav"))


@requires_db
class TestRetentionSweepsTheDiskNotTheRow:
    """THE RESIDUAL: a recording whose row never learned it existed.

    `interview_sessions.audio_recorded` and `audio_path` record what the RELAY
    BELIEVED and got as far as writing down. A session whose Layer 1 finalizer
    never ran — an exception its `except*` clauses do not match — still has its
    files closed by `run()`'s `finally`, so the WAVs are on disk while the row
    says `false` / `NULL`. Retention used to select what to delete by those two
    columns, which asks the row a question only the filesystem can answer, and
    the answer it gave was "there is no audio here" about a named student's
    voice. This is the test that fails if anyone puts that filter back.
    """

    def test_files_are_deleted_even_when_the_row_never_learned_it_had_audio(
        self, store
    ):
        from app import retention
        from app.models.interview import InterviewSession
        from app.models.user import Role, Student, User

        now = datetime.now(timezone.utc)
        tag = uuid.uuid4().hex[:8]
        with SessionLocal() as db:
            user = User(
                email=f"ivresidual-{tag}@bgscet.ac.in",
                name="Interview Audio Residual",
                role=Role.STUDENT,
                password_hash="x",
            )
            db.add(user)
            db.flush()
            student = Student(user_id=user.id)
            db.add(student)
            db.flush()
            started = now - timedelta(days=400)
            row = InterviewSession(
                student_id=student.id,
                status="abandoned",
                terminal_reason="orphaned (no heartbeat)",
                started_at=started,
                heartbeat_at=started,
                # Soft-deleted longer ago than SOFT_DELETE_GRACE_DAYS, so this
                # pass is the one that destroys it for good.
                deleted_at=now
                - timedelta(days=retention.SOFT_DELETE_GRACE_DAYS + 10),
                # The state under test, spelled out rather than left to defaults:
                # the relay died before it could tell the row anything.
                audio_recorded=False,
                audio_path=None,
            )
            db.add(row)
            db.commit()
            session_id, student_id, user_id = row.id, student.id, user.id

        try:
            # Real bytes, written by the real recorder, under the real naming
            # rule — the id is the filename, which is the whole reason a sweep by
            # primary key alone can find them.
            rec = InterviewRecorder(session_id, max_bytes=10_000_000)
            rec.feed(TRACK_STUDENT, _pcm(BYTES_PER_SECOND))
            rec.feed(TRACK_INTERVIEWER, _pcm(BYTES_PER_SECOND))
            _close(rec)
            files = [track_path(session_id, track) for track in TRACKS]
            assert all(p.is_file() for p in files), "fixture must leave audio on disk"

            with SessionLocal() as db:
                fresh = db.get(InterviewSession, session_id)
                assert fresh.audio_recorded is False
                assert fresh.audio_path is None
                summary = retention.purge_expired(db, now=now)

            assert not any(p.exists() for p in files), (
                "a named student's voice outlived its retention window because "
                "the row it hung off never learned it was recorded"
            )
            assert summary["interview_audio_deleted"] >= 1
            assert summary["interviews_hard_delete_blocked"] == 0
            with SessionLocal() as db:
                assert db.get(InterviewSession, session_id) is None
        finally:
            with SessionLocal() as db:
                db.execute(
                    delete(InterviewSession).where(
                        InterviewSession.student_id == student_id
                    )
                )
                db.execute(delete(Student).where(Student.id == student_id))
                db.execute(delete(User).where(User.id == user_id))
                db.commit()


# ---------------------------------------------------------------------------
# Objection 4 — "voice is biometric-adjacent"
# ---------------------------------------------------------------------------
class TestTheTwoGates:
    """No flag, no bytes. No consent, no bytes. Ever.

    `recorder_for` is the only supported constructor precisely so that "when
    does REEP record a student's voice?" has one answer in one function.
    """

    def test_the_default_deployment_records_nothing(self, store, monkeypatch):
        """`interview_recording_enabled` is False in app/config.py and this is
        what that means at the capture site."""
        monkeypatch.setattr(settings, "interview_recording_enabled", False)

        def _explode(_user_id):  # pragma: no cover -- must not be reached
            raise AssertionError("the consent query ran with recording disabled")

        monkeypatch.setattr(interview_audio, "audio_consent_granted", _explode)
        assert recorder_for(uuid.uuid4().hex, "user-1") is None
        assert not list(store.glob("*.wav"))

    def test_no_consent_means_no_recorder(self, store, monkeypatch):
        monkeypatch.setattr(settings, "interview_recording_enabled", True)
        monkeypatch.setattr(interview_audio, "audio_consent_granted", lambda _u: False)
        assert recorder_for(uuid.uuid4().hex, "user-1") is None
        assert not list(store.glob("*.wav"))

    def test_both_gates_open_produces_a_recorder(self, store, monkeypatch):
        monkeypatch.setattr(settings, "interview_recording_enabled", True)
        monkeypatch.setattr(interview_audio, "audio_consent_granted", lambda _u: True)
        recorder = recorder_for(uuid.uuid4().hex, "user-1")
        assert isinstance(recorder, InterviewRecorder)
        assert recorder._max_bytes == settings.interview_recording_max_bytes

    @requires_db
    def test_consent_is_read_from_the_row_and_fails_closed(self, store, consent_user):
        """The grant is a ROW, and every way of not having one reads as False.

        Four cases, and the last two are the ones a boolean-on-users could not
        express: a grant that covers the interview but NOT the recording, and a
        grant that was withdrawn.
        """
        from app.models.interview import InterviewConsent

        user_id = consent_user

        # No grant at all.
        assert audio_consent_granted(user_id) is False

        def _grant(**kw):
            with SessionLocal() as db:
                db.execute(
                    delete(InterviewConsent).where(InterviewConsent.user_id == user_id)
                )
                db.add(
                    InterviewConsent(
                        user_id=user_id,
                        version=settings.interview_consent_version,
                        scope_live_ai=True,
                        scope_store_transcript=True,
                        **kw,
                    )
                )
                db.commit()

        # Consented to the interview and the transcript, refused the recording:
        # a lawful, expected outcome, and the interview still runs.
        _grant(scope_store_audio=False)
        assert audio_consent_granted(user_id) is False

        # Withdrawn. The row survives (the historical fact matters) and stops
        # counting the moment it is stamped.
        _grant(scope_store_audio=True, revoked_at=datetime.now(timezone.utc))
        assert audio_consent_granted(user_id) is False

        # Granted against copy from a different version of the terms — consent
        # is to WORDING, and is not retroactive.
        _grant(scope_store_audio=True)
        with SessionLocal() as db:
            db.execute(
                delete(InterviewConsent).where(InterviewConsent.user_id == user_id)
            )
            db.add(
                InterviewConsent(
                    user_id=user_id,
                    version="1999-01",
                    scope_live_ai=True,
                    scope_store_transcript=True,
                    scope_store_audio=True,
                )
            )
            db.commit()
        assert audio_consent_granted(user_id) is False

        # And the one arrangement that permits a recording.
        _grant(scope_store_audio=True)
        assert audio_consent_granted(user_id) is True

    def test_an_unreadable_database_means_do_not_record(self, monkeypatch):
        """"We could not check whether the student agreed" and "the student
        agreed" are not the same sentence, and only one of them may end with a
        recording of their voice."""

        class _Boom:
            def __enter__(self):
                raise RuntimeError("database is down")

            def __exit__(self, *exc):  # pragma: no cover
                return False

        monkeypatch.setattr("app.db.SessionLocal", lambda: _Boom())
        assert audio_consent_granted("user-1") is False


@pytest.fixture
def consent_user():
    """A throwaway user to hang consent rows off, and its id."""
    from app.models.interview import InterviewConsent
    from app.models.user import Role, User

    with SessionLocal() as db:
        user = User(
            email=f"ivaudio-{uuid.uuid4().hex[:10]}@bgscet.ac.in",
            name="Interview Audio Fixture",
            role=Role.STUDENT,
            password_hash="x",
        )
        db.add(user)
        db.commit()
        user_id = user.id

    yield user_id

    with SessionLocal() as db:
        db.execute(delete(InterviewConsent).where(InterviewConsent.user_id == user_id))
        db.execute(delete(User).where(User.id == user_id))
        db.commit()


# ---------------------------------------------------------------------------
# The relay side — capture is on the audio path, and cannot end an interview
# ---------------------------------------------------------------------------
class _FakeBrowser:
    def __init__(self) -> None:
        self.audio: list[bytes] = []

    async def send_bytes(self, data: bytes) -> None:
        self.audio.append(data)

    async def send_json(self, payload: dict) -> None:  # pragma: no cover
        pass


class _FakeUpstream:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, raw: str) -> None:
        self.sent.append(raw)


class TestTheRelayFeedsIt:
    def test_the_track_names_match_the_store(self):
        """app/interview_relay.py spells the two track names itself rather than
        importing them (it deliberately imports nothing from the audio store, so
        no ORM model can arrive behind it). A mismatch would write files the
        download endpoint cannot find, and nothing would raise."""
        assert (_AUDIO_TRACK_STUDENT, _AUDIO_TRACK_INTERVIEWER) == TRACKS

    def _relay(self, recorder=None):
        browser = _FakeBrowser()
        relay = _RelaySession(browser, "c0ffee123456", on_turn=None, recorder=recorder)
        return relay, browser

    def test_both_directions_are_captured_and_reported_on_the_outcome(self, store):
        """The student's uplink and the interviewer's downlink, through the real
        forwarding paths — including the odd-byte carry and the barge-in drop,
        because a recording that disagrees with what upstream heard is worse
        than no recording: it is a plausible one."""
        session_id = uuid.uuid4().hex
        recorder = InterviewRecorder(session_id, max_bytes=10_000_000)
        relay, browser = self._relay(recorder)
        outcomes = []
        relay._on_finalize = outcomes.append

        async def scenario():
            upstream = _FakeUpstream()
            await relay._forward_client_audio(upstream, _pcm(4800))
            relay._active_response_id = "resp_1"
            await relay._handle_upstream_event(
                {
                    "type": "response.output_audio.delta",
                    "response_id": "resp_1",
                    "delta": __import__("base64").b64encode(_pcm(9600)).decode(),
                }
            )
            await relay._finalize_session(_CLOSE_OK, "Interview complete")

        asyncio.run(scenario())

        outcome = outcomes[0]
        assert outcome.audio_recorded is True
        assert outcome.audio_path == session_id
        assert outcome.audio_truncated is False
        assert outcome.audio_duration_ms == (9600 * 1000) // BYTES_PER_SECOND
        assert _read_wav(track_path(session_id, TRACK_STUDENT))[0].nframes == 2400
        assert _read_wav(track_path(session_id, TRACK_INTERVIEWER))[0].nframes == 4800
        # The recording is a side effect and never a substitute: the student
        # still heard the interviewer.
        assert browser.audio

    def test_no_recorder_means_the_outcome_says_nothing_was_kept(self, store):
        """The default everywhere. `audio_recorded=False` is a fact — "we know
        nothing was kept" — and not an absence of one."""
        relay, _browser = self._relay(None)
        outcomes = []
        relay._on_finalize = outcomes.append

        async def scenario():
            await relay._forward_client_audio(_FakeUpstream(), _pcm(4800))
            await relay._finalize_session(_CLOSE_OK, "Interview complete")

        asyncio.run(scenario())

        outcome = outcomes[0]
        assert outcome.audio_recorded is False
        assert outcome.audio_path is None
        assert outcome.audio_bytes is None
        assert outcome.audio_duration_ms is None
        assert outcome.audio_truncated is False
        assert not list(store.glob("*.wav"))

    def test_a_recorder_that_blows_up_never_ends_the_interview(self, store):
        """The discipline the transcript writes already follow: a live interview
        must never be ended by a failure to keep a record of it."""

        class _Broken:
            def feed(self, track, pcm):
                raise RuntimeError("the disk caught fire")

            def snapshot(self):
                return CaptureResult(False, None, 0, 0, True)

            async def aclose(self):
                raise RuntimeError("still on fire")

        relay, _browser = self._relay(_Broken())
        outcomes = []
        relay._on_finalize = outcomes.append
        upstream = _FakeUpstream()

        async def scenario():
            await relay._forward_client_audio(upstream, _pcm(4800))
            await relay._finalize_session(_CLOSE_OK, "Interview complete")

        asyncio.run(scenario())

        # The student's audio still reached OpenAI, and the record still closed.
        assert upstream.sent
        assert outcomes[0].status == "abandoned"
        # aclose() raised, so the fallback snapshot is what was recorded.
        assert outcomes[0].audio_recorded is False
        assert outcomes[0].audio_truncated is True

    def test_the_files_are_closed_even_when_finalization_never_runs(self, store):
        """run()'s own teardown is the last line of defence: an exception no
        `except*` clause matched leaves the finalizer unrun, and without this the
        session would end holding two open file handles."""
        session_id = uuid.uuid4().hex
        recorder = InterviewRecorder(session_id, max_bytes=10_000_000)
        relay, _browser = self._relay(recorder)

        async def scenario():
            await relay._forward_client_audio(_FakeUpstream(), _pcm(4800))
            # What run()'s finally does, on the path where nothing else ran.
            await relay._close_recorder()

        asyncio.run(scenario())

        assert not recorder._writers
        assert _read_wav(track_path(session_id, TRACK_STUDENT))[0].nframes == 2400


# ---------------------------------------------------------------------------
# The download endpoint — DIRECTOR/ADMIN only, both gates, and a subject re-check
# ---------------------------------------------------------------------------
@pytest.fixture
def audio_world(store):
    """A director, a mentor holding the student's group, the student, and one
    interview with a real recording on disk.

    Built here rather than borrowed from tests/test_interview_access.py's
    `world`: that module is owned by another track this wave, and a shared
    fixture edited from two places is how one of them ends up asserting on rows
    the other changed.
    """
    from types import SimpleNamespace

    from app.models.interview import InterviewSession
    from app.models.user import Mentor, Role, Student, User
    from app.security import SESSION_COOKIE, create_session_token

    tag = uuid.uuid4().hex[:8]
    with SessionLocal() as db:

        def _user(label, role):
            u = User(
                email=f"ivaud-{label}-{tag}@bgscet.ac.in",
                name=f"Interview Audio {label}",
                role=role,
                password_hash="x",
            )
            db.add(u)
            db.flush()
            return u

        director_user = _user("director", Role.DIRECTOR)
        mentor_user = _user("mentor", Role.MENTOR)
        student_user = _user("student", Role.STUDENT)
        mentor = Mentor(user_id=mentor_user.id)
        db.add(mentor)
        db.flush()
        student = Student(user_id=student_user.id, mentor_id=mentor.id)
        db.add(student)
        db.flush()

        started = datetime.now(timezone.utc) - timedelta(minutes=20)
        recorded = InterviewSession(
            student_id=student.id,
            status="completed",
            close_code=1000,
            conn_id=uuid.uuid4().hex[:12],
            started_at=started,
            heartbeat_at=started,
        )
        silent = InterviewSession(
            student_id=student.id,
            status="completed",
            close_code=1000,
            started_at=started,
            heartbeat_at=started,
        )
        db.add_all([recorded, silent])
        db.commit()

        w = SimpleNamespace(
            student_id=student.id,
            recorded_id=recorded.id,
            silent_id=silent.id,
            user_ids=[director_user.id, mentor_user.id, student_user.id],
            student_ids=[student.id],
            mentor_ids=[mentor.id],
        )

        def _auth(**claims):
            return {"Cookie": f"{SESSION_COOKIE}={create_session_token(claims)}"}

        w.as_director = _auth(
            userId=director_user.id, email="d@x", name="D", role="DIRECTOR"
        )
        w.as_mentor = _auth(
            userId=mentor_user.id,
            email="m@x",
            name="M",
            role="MENTOR",
            mentorId=mentor.id,
        )
        w.as_student = _auth(
            userId=student_user.id,
            email="s@x",
            name="S",
            role="STUDENT",
            studentId=student.id,
        )

    # A real recording, written by the real recorder, and the row updated to
    # point at it exactly as the finalizer will.
    rec = InterviewRecorder(w.recorded_id, max_bytes=10_000_000)
    rec.feed(TRACK_STUDENT, _pcm(BYTES_PER_SECOND))
    rec.feed(TRACK_INTERVIEWER, _pcm(BYTES_PER_SECOND * 2))
    result = _close(rec)
    with SessionLocal() as db:
        row = db.get(InterviewSession, w.recorded_id)
        row.audio_recorded = True
        row.audio_path = result.path
        row.audio_bytes = result.total_bytes
        row.audio_duration_ms = result.duration_ms
        db.commit()

    yield w

    with SessionLocal() as db:
        db.execute(
            delete(InterviewSession).where(
                InterviewSession.student_id.in_(w.student_ids)
            )
        )
        db.execute(delete(Student).where(Student.id.in_(w.student_ids)))
        db.execute(delete(Mentor).where(Mentor.id.in_(w.mentor_ids)))
        db.execute(delete(User).where(User.id.in_(w.user_ids)))
        db.commit()


@pytest.fixture(scope="module")
def api():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import interview_records

    app = FastAPI()
    app.include_router(interview_records.staff_router)
    with TestClient(app) as c:
        yield c


def _audio_url(world, session_id=None, track=None) -> str:
    url = (
        f"/api/mentor/students/{world.student_id}/interviews/"
        f"{session_id or world.recorded_id}/audio"
    )
    return f"{url}?track={track}" if track else url


@requires_db
class TestTheDownload:
    def test_a_director_can_play_both_tracks(self, api, audio_world):
        for track, seconds in ((TRACK_STUDENT, 1), (TRACK_INTERVIEWER, 2)):
            r = api.get(
                _audio_url(audio_world, track=track), headers=audio_world.as_director
            )
            assert r.status_code == 200, r.text
            assert r.headers["content-type"] == "audio/wav"
            assert len(r.content) == 44 + BYTES_PER_SECOND * seconds
            # RFC 6266, both parameters, and a name carrying the interview id
            # rather than the student's — the association lives in the database,
            # where access control lives with it.
            disposition = r.headers["content-disposition"]
            assert disposition.startswith("inline; filename=")
            assert "filename*=UTF-8''" in disposition
            assert audio_world.student_id not in disposition

    def test_the_default_track_is_the_student(self, api, audio_world):
        r = api.get(_audio_url(audio_world), headers=audio_world.as_director)
        assert r.status_code == 200
        assert len(r.content) == 44 + BYTES_PER_SECOND

    def test_a_mentor_in_the_students_own_group_is_still_refused(self, api, audio_world):
        """`require_director` FIRST, and it is not softened by the group gate.

        This mentor passes `_assert_can_access_student` — the student is theirs —
        and still gets nothing, because a stored voice recording is
        DIRECTOR/ADMIN only. The two gates answer different questions and this
        endpoint needs both.
        """
        r = api.get(_audio_url(audio_world), headers=audio_world.as_mentor)
        assert r.status_code == 403

    def test_the_student_does_not_get_playback_of_their_own_recording(
        self, api, audio_world
    ):
        """§5.4 refused to hide the SCORE from the student and this hides the
        audio, which is a different judgement rather than a contradiction: the
        recording tells them nothing they were not present for, and a student
        endpoint would be the widest possible surface for the most sensitive
        bytes REEP holds. There is deliberately no student-side route either —
        see test_there_is_no_student_route_to_audio."""
        r = api.get(_audio_url(audio_world), headers=audio_world.as_student)
        assert r.status_code == 403

    def test_there_is_no_student_route_to_audio(self):
        from app.routers import interview_records

        assert not [
            route
            for route in interview_records.student_router.routes
            if "audio" in route.path
        ]

    def test_an_interview_with_no_recording_is_404_and_not_204(self, api, audio_world):
        """The flag is the fact, never `audio_path is not None`. 404 so a
        director cannot tell "not recorded" from "not a real id"."""
        r = api.get(
            _audio_url(audio_world, session_id=audio_world.silent_id),
            headers=audio_world.as_director,
        )
        assert r.status_code == 404

    def test_a_session_id_belonging_to_another_student_is_404(self, api, audio_world):
        """§7.3's second check. The gate was handed the PATH's student id and can
        say nothing at all about a session id."""
        r = api.get(
            f"/api/mentor/students/{audio_world.student_id}/interviews/"
            f"{uuid.uuid4().hex}/audio",
            headers=audio_world.as_director,
        )
        assert r.status_code == 404

    def test_an_unknown_track_is_422_and_never_a_silent_fallback(self, api, audio_world):
        """A reviewer who asked for the interviewer and was handed the student
        would be listening to the wrong voice with nothing on screen saying so."""
        r = api.get(
            _audio_url(audio_world, track="../../etc/passwd"),
            headers=audio_world.as_director,
        )
        assert r.status_code == 422

    def test_a_row_that_claims_audio_the_disk_does_not_have_is_404(
        self, api, audio_world, store
    ):
        """The reaper ran between the row and the request, or the volume is not
        mounted. Nothing is broken for the caller, so 404 rather than 500 — but
        the server logs it, because a row claiming audio that is gone is how a
        deletion request quietly fails to be honoured."""
        delete_session_audio(audio_world.recorded_id, None)
        r = api.get(_audio_url(audio_world), headers=audio_world.as_director)
        assert r.status_code == 404
