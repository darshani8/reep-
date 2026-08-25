# The realtime mock interviewer

The student-facing assistant on `/student/assistant`. The browser's microphone is
relayed, inside the API process, to the OpenAI Realtime API and back.

```
browser  <--WS /api/interview-->  apps/api-py (uvicorn)  <--WS-->  api.openai.com
```

There is **no fifth process**. The relay runs inside the FastAPI app that already
serves the dashboard, so it shares that app's session cookie, its database and
its deployment. (`apps/interview-realtime/` is the superseded standalone
prototype — see the banner at the top of its `app/server.py`. It has no
authentication and no database; do not run it.)

| file | role |
|---|---|
| `apps/api-py/app/routers/interview.py` | the boundary: auth, STUDENT check, both concurrency caps, **the consent gate**, specialization validation, the conversation and `interview_sessions` row, the turn/report/finalize/heartbeat writers |
| `apps/api-py/app/interview_relay.py` | the engine: one `_RelaySession` per interview, both pumps, the v3 turn protocol, the guardrails |
| `apps/api-py/app/interview_matrix.py` | the Specialization Matrix (HR/DM/BA/FA personas, frameworks, sample questions, per-role voices), the phase state machine, `classify_answer` and the per-turn instruction overrides |
| `apps/api-py/app/routers/interview_records.py` | the READ side and consent: the student's own history, the staff views behind rule 2, `GET/POST/DELETE /api/interview/consent` |
| `apps/api-py/app/models/interview.py` | the four tables |
| `apps/api-py/app/interview_audio.py` | the optional on-disk recording store (off by default — see *Audio*) |
| `apps/api-py/app/retention.py` | the orphan sweeper and the 180-day reaper |
| `apps/web/src/app/core/interview.service.ts` | the client: audio graph, uplink, close-code messages, `reep.report` |
| `apps/web/src/app/features/student/interviews/` | the student's own history, transcript and report screens |

## Endpoints

```
GET    /api/interview/status                          {available, reason, active_sessions, max_sessions}
WS     /api/interview                                 one interview; ?specialization=hr|dm|ba|fa optional

GET    /api/interview/consent                         the caller's own live grant, or null
POST   /api/interview/consent                         grant; 422 on a version this server does not know
DELETE /api/interview/consent                         revoke every live grant this user holds

GET    /api/interview/sessions                        the caller's own interviews
GET    /api/interview/sessions/{id}                   404 — never 403 — for somebody else's
GET    /api/interview/sessions/{id}/transcript
GET    /api/interview/sessions/{id}/report            without `raw_response`

GET    /api/mentor/students/{sid}/interviews          rule 2, then the row's own subject re-checked
GET    /api/mentor/students/{sid}/interviews/{id}
GET    /api/mentor/students/{sid}/interviews/{id}/transcript
GET    /api/mentor/students/{sid}/interviews/{id}/report     `raw_response` only for DIRECTOR/ADMIN
GET    /api/mentor/students/{sid}/interviews/{id}/audio      ADMIN only; ?track=mixed(default)|student|interviewer
```

`GET /status` exists because a **rejected WebSocket handshake reaches the browser
as a bare 1006 with no code and no reason**. It is the only place a student can be
told *why* — not configured, not signed in, not a student. It answers `200` with
`available:false` even for a non-student (where `/api/voice/status` raises 403),
because the client treats any non-2xx as "probe unavailable" and would throw the
explanation away.

It deliberately does **not** report missing consent. The client treats
`available:false` as "do not start", which would hide the very consent panel that
fixes it; the panel is driven by `GET /api/interview/consent` instead.

Every staff endpoint opens with `_assert_can_access_student` imported from
`app/routers/mentor.py` — never a second copy — and then re-checks that the row's
own `student_id` matches the path. A MENTOR with no `Mentor` group sees **nobody**,
by that function, with nothing added here.

## The Specialization Matrix

The student picks a track on the assistant screen; the client sends it as
`?specialization=` on the socket (a query param because a browser WebSocket
cannot set headers — safe precisely because it is a UI choice, not a student
record). `app/interview_matrix.py` owns the four rows — AI persona, core
frameworks, the sample question worked in during probing, and **the voice the
role speaks with** — **verbatim from the product spec**, and
`InterviewStateMachine`, which advances the interview through explicit phases
on each *completed student answer*:

```
opening  --1 answer-->  probing  --3-->  deep_dive  --5-->  wrap_up
```

(Any phase can also go straight to `ended`; `wrap_up` is sticky.) *Completed* is
load-bearing and is decided below, not by the model: a barge-in over an
unfinished question, a cough and a two-word answer all fail it. The relay
composes instructions as **base persona verbatim + delivery-style block +
specialization block + phase directive**, sends the opening composition in the
startup `session.update`, and pushes an **instructions-only** `session.update`
on every phase change (the voice is frozen once the model has spoken, so
nothing else may ride that update). The browser learns the phase from
`reep.ready` and `reep.phase` events. **No `?specialization=` runs the generic
interview with the untouched base persona** — and an unknown key is refused
with close 4010 rather than silently downgraded to it.

The arc is shaped like a real interview, not a quiz. **Opening** greets the
student, introduces the interviewer in one sentence, sets expectations (a
focused ~15-minute conversation with honest feedback at the end) and asks the
student to introduce themselves and say what drew them to the track — no domain
questions yet. The matrix's hard scenario question moved to **probing**, worked
in early and rephrased naturally rather than recited cold. And `wrap_up` is a
**two-beat close**: the tick into it first asks *"any questions for us about
the role or the company?"* (the `invite_questions` turn directive), the
student's reply — any reply, never `classify_answer`'d, because "no, I'm good"
is filler words to the word gate — earns the spoken verdict, and only the
verdict's `response.done` requests the scorecard. The forced/clock path skips
the beat and goes straight to the verdict.

Each track also speaks with its own Realtime voice, frozen onto the session in
the single startup `session.update`:

| track | voice | role it voices |
|---|---|---|
| HR | `coral` | the warm CHRO |
| DM | `marin` | the energetic CMO |
| BA | `cedar` | the measured Director of Analytics |
| FA | `ash` | the authoritative MD/CFO |
| *(generic)* | `OPENAI_REALTIME_VOICE` (default `alloy`) | the base interviewer |

An `OPENAI_REALTIME_VOICE` value outside the known set (`alloy, ash, ballad,
coral, echo, sage, shimmer, verse, marin, cedar`) is logged and falls back to
`alloy` — upstream answers an unknown voice with a *silent* fallback to its own
default, which is an interview that runs fine while sounding nothing like what
was configured.

One asymmetry to know about: the phase tick is gated on a specialization being
present, so **the generic interview never reaches `wrap_up`** and therefore never
produces a scorecard. It runs, it records, and it ends at the cap. That is the
pre-matrix behaviour preserved deliberately — the *create* is unconditional,
only the tick is gated — but it is the first thing to revisit if the generic
track is ever offered to students as a real option.

## The turn protocol — the relay owns the turn (v3)

The session is opened with **`turn_detection.create_response: false`**. Upstream
still runs VAD, still commits the input buffer and still transcribes; it no
longer creates responses. **The relay does**, from exactly one call site
(`_advance_turn`) — and that is what makes *"one open question at a time"* a
property of the call graph rather than a sentence in the persona.

The old behaviour asked the next question at end-of-speech, before the
transcript of the answer had arrived. Two independent upstream subsystems with
no happens-before edge between them meant the phase directive was structurally
one response late, a cough created a question, and after the fifth answer the
model asked a sixth one instead of delivering the verdict. None of that was
fixable in a prompt: instructions are the *content* of a response, and the flag
decides how many responses exist and when.

One turn, after:

```
speech_stopped        -> arm the answer deadline (INTERVIEW_TRANSCRIPTION_TIMEOUT_MS)
committed{item_id}    -> re-key that pending entry, re-arm
exactly one of:
    transcription.completed -> transcript,  status ok
    transcription.failed    -> "",          status failed
    the deadline expires    -> "",          status timeout
drain the queue head  -> ONE response.create for the whole batch, never one per item
```

While the student's answer is transcribing, the relay also forwards
`conversation.item.input_audio_transcription.delta` events to the browser as
`reep.transcript.delta` (`item_id` + `delta`), so the "You" line appears and
revises live instead of popping in whole seconds later. They are **never
persisted and never fed to the arc** — `.completed` remains the single point
where a student turn is recorded or judged — and the beta generation may not
emit them at all, in which case the client simply keeps its completed-only
behaviour.

Between the drain and the create, the relay decides what kind of response to ask
for. The order of the two checks is not interchangeable:

| condition | kind | advances the arc? |
|---|---|---|
| the last question was never finished (barge-in) | `resume` | no |
| the transcript failed or timed out | `unheard` | not until the clarification budget is spent |
| `classify_answer` returns `empty` / `filler` / `too_short` | `clarify` | no |
| otherwise | `next` | **yes** — `student_answered()` ticks the phase machine |

`classify_answer` (`interview_matrix.py`) is a word count against
`INTERVIEW_MIN_ANSWER_WORDS`, deliberately **not** a model call: it runs between
the student finishing and the interviewer replying, so a round trip there would
be latency on every turn of every interview. Clarifications are capped by
`INTERVIEW_MAX_CLARIFICATIONS_PER_QUESTION`; at the cap the relay accepts
whatever it got and moves on, because **a student who genuinely cannot answer
must not be trapped**.

Everything the relay waits for now has a deadline, and that is not decoration:
under `create_response: false` a transcription that never lands is an interview
that never continues, and the idle watchdog does **not** cover it (the browser's
echo-gate keepalive keeps sending frames, so 4008 never fires). A create that is
never acknowledged is retried once and then closes **4011**.

At `wrap_up` the model first invites the student's questions (the beat above),
then speaks its verdict on the reply, and that verdict is persisted as an
interviewer turn — it is part of the interview the student heard. Then the relay
issues **one further, text-only `response.create`** in the same session, which
already holds the whole transcript: a strict-JSON scorecard, parsed defensively,
sent to the browser as `reep.report` and written to `interview_evaluations`.
The scorecard is never spoken (`modalities: ["text"]`, plus a guard that drops
any audio carrying the report's response id) and never appears in the chat
history (`_on_response_done` returns before `_emit_turn` for that id). A student
speaking during it is **ignored** — the one place in this design where that is
the correct action.

Every failure of the report has a status (`unparseable`, `timeout`, `rejected`,
`unavailable`) and **none of them fails the interview**: a row is written in
every case, `reep.report` says `available:false` with the reason, and the socket
closes **1000**. There is deliberately no `4015`: the interview completed; only
the scorecard did not.

## Authentication

The socket uses **REEP's own httpOnly `reep_session` cookie** and the same
`verify_session_token` as every HTTP route — there is no second token scheme.

A browser WebSocket cannot set headers, but it *does* send cookies on a
**same-origin** handshake. `/api` is same-origin by construction:
`apps/web/proxy.conf.json` forwards `/api` to the API with `"ws": true` in dev,
and production serves one origin. The cookie is `SameSite=Lax`, which is what
stops a cross-site page from carrying it onto this handshake at all; the Origin
check in the router is defence in depth on top of that.

**Non-STUDENT callers are refused** (close 1008). Hiding the Start button in the
Angular component is not a gate — a mentor or director holding a valid cookie can
open the socket from devtools, and each open costs a billed upstream session.

The socket is **accepted before any check that can fail**, and every refusal is a
close on the accepted socket. Closing before accept fails the HTTP upgrade, and
the browser then reports 1006 with no code and no reason, so "not signed in"
would be indistinguishable from "the wifi dropped".

## Rule 1 (AGENTS.md): no student record reaches the model

`api.openai.com` is a remote provider, so **nothing personal enters the session**.
This is structural, not a matter of asking the model nicely:

- the only thing the server authors upstream is `_INTERVIEWER_PERSONA`, a fixed
  string with no student data in it;
- the only other thing on the uplink is the student's own microphone;
- `interview_relay.py` imports no ORM model, no `assistant_tools`, no `knowledge`;
- the session id, conversation id and user id never leave the process.

The persona **also tells the model it is blind** — the same disclosure
`voice_agent.py`'s `BASE_INSTRUCTIONS` makes for the LiveKit worker. That sentence
is not redundant with the architecture: a model that is not told it cannot see the
dashboard will invent a CGPA and say it out loud, and the student has no way to
know it was fiction.

**If the interview is ever personalised** (branch, target company, resume text),
that path must go through `complete_chat(..., carries_student_data=True)` in
`app/ai/llm.py` and fall back to the generic persona when the gate refuses — the
same shape as `/student/resume/generate` degrading to `used_ai=false`.

## Persistence — and how to check it

Turns are written through `app/conversations.py` into the **same**
`conversations` / `messages` tables the text agent and the LiveKit worker use, so
`GET /api/agent/history` returns them unchanged. That contract does not bend —
the four tables below are **in addition**, never instead.

Writes are **fire-and-forget**: a failed write must never end an interview that is
otherwise going fine (the same rule as the LiveKit transcript POSTs). That buys
the silent failure mode the voice runbook exists to catch, so after a test call:

```sql
select channel, count(*), max(created_at) from messages group by channel;
```

An `interview` row that does not grow, or a stale `max(created_at)`, means turns
are being dropped. The cause is in the API log, with its exception — grep for
`Dropped interview turn`. The channel is `interview`, **not** `voice`: both are
spoken, but they are different products with different retention questions, and
folding them together would make this query unable to answer "did the interviewer
save anything" independently of LiveKit.

Dedup is on `(conversation_id, provider_turn_id)`, with `u:`/`a:` prefixes because
upstream item ids and response ids are separate sequences.

## The interview record — four tables

`app/models/interview.py`. Every vocabulary column is a plain `String`, not a PG
enum, because these vocabularies will move — a fifth specialization is a data
change today, and turning it into a migration would be a regression. The
vocabulary lives in a comment next to the column.

| table | one row per | what it carries that `messages` cannot |
|---|---|---|
| `interview_sessions` | interview | the subject, the track, the terminal status and close code, `answers_accepted`, `turns_emitted`/`turns_persisted`, the relay's `conn_id`, the upstream session id, the consent grant, the retention deadline |
| `interview_turns` | turn | the **phase** it happened in, whether the transcriber actually heard it (`transcription_status`), how the answer gate judged it (`answer_quality`), whether it ticked the arc (`counted_as_answer`), whether an interviewer turn was cut off (`is_partial`) |
| `interview_evaluations` | interview (UNIQUE) | the scorecard: four nullable 0–100 scores, strengths, improvements, a drill, a summary, and `raw_response` for a DIRECTOR debugging a bad parse |
| `interview_consents` | grant | who agreed, to which version, to which of three scopes, when, from what user agent and a **salted hash** of the address — never the address |

Two things about this record are worth knowing before reading it:

- **A blank `interview_turns.content` is legal and meaningful.** A transcription
  that timed out or failed arrives as `""`, and those are exactly the turns
  `transcription_status` exists to record, so the row is written regardless. Only
  the `messages` row is skipped — an empty chat bubble in
  `GET /api/agent/history` would claim the student said nothing, which is the
  opposite of what happened.
- **The scores are nullable even when `report_status = 'ok'`.** A missing score
  and a zero mean opposite things to whoever reads them, and nothing in this
  stack substitutes one for the other — not the parser, not the writer, not the
  screen.

The two inserts per turn share **one transaction**. A second, independent writer
was considered and rejected: it can partially succeed, which puts the runbook
query above in the position of reporting "saved fine" while the reviewable record
is missing turns.

### A `running` row that is never closed is a record that lies

Three layers close it, in order of how much of the process has to survive:

1. **The relay's own finalizer** — every ordinary exit, including the
   guardrails, a disconnect and a 1011. It is the only layer that knows whether
   the scorecard settled, which is what separates `completed` from `abandoned`.
2. **The router's `finally` backstop** — the relay raising before its own
   finalizer ran, and shutdown cancelling the coroutine. It knows only the close
   code, so it never claims `completed`.
3. **`retention.finalize_orphaned_interviews`** — the process was killed and
   nothing in it ran. Predicate: `status='running' AND heartbeat_at < now -
   INTERVIEW_ORPHAN_GRACE_SECONDS`. Called once at startup from `lifespan`,
   because a worker that just restarted is exactly the process that knows the
   previous one died.

All three are idempotent against each other by one predicate — `AND status =
'running'` — so the loser updates zero rows and says nothing. The heartbeat the
sweeper reads is written by the relay's watchdog once a minute.

### Retention

`INTERVIEW_RETENTION_DAYS` (180) is stamped on the row at open as
`retention_until`, so changing the setting never re-dates an interview a student
was already promised a window for. `retention.purge_expired` then runs the same
two stages conversations already have: past the deadline → soft-delete plus
`redact_pii` over `interview_turns.content` and
`interview_evaluations.raw_response`; soft-deleted past 30 days → hard-delete,
**audio bytes first and rows second**, and a session whose audio could not be
deleted keeps its row so the file stays discoverable.

## Consent

Consent is a **row**, not a `localStorage` key and not
`Conversation.consent_state` (which the student's own "Clear conversation"
destroys — a consent record the subject can delete by accident is not a consent
record).

**Three booleans, not one**, because they are three different disclosures and a
student may reasonably accept two and refuse the third:

| scope | what the student is agreeing to |
|---|---|
| `scope_live_ai` | their microphone audio is streamed to OpenAI's realtime model while the interview runs |
| `scope_store_transcript` | a written transcript and an AI practice score are kept on the college's server, readable by their mentor and the placement director, for 180 days |
| `scope_store_audio` | the audio itself is kept — **optional, unticked, and off by default at both ends** |

`INTERVIEW_CONSENT_VERSION` (`"2026-08"`) is stamped on every grant. Consent is
not retroactive: bump it when the wording changes, and rows carrying the old
string stop counting for the new terms. `POST /api/interview/consent` **422s a
version it does not know**, so a stale cached SPA cannot grant against copy the
student never saw.

**Enforcement, and the ordering it needed.** The socket now requires a live grant
for the current version:

- no live grant → the interview never opens and the socket closes **4013**. The
  check is the first statement of `_open_records`, *before* anything is written,
  so a refusal leaves no conversation and no `interview_sessions` row for the
  sweeper to trip over.
- the grant revoked while an interview is running → the heartbeat notices within
  a minute and the socket closes **4014**.

That gate could only be turned on **after** the browser started posting grants;
enabling it first would have locked every existing student out of the feature on
the deploy that shipped it.

The revocation check is a **poll on the heartbeat, not a push from the DELETE
handler**, and that is deliberate: any registry the DELETE could consult is
per-process, so with N uvicorn workers the revoking request lands on a worker
that is not holding the socket in most cases, and the push would do nothing at
all while looking like it worked. It watches **the exact grant the interview
opened under, by id** — not "is there a live grant for the current version" — so
an operator bumping the version mid-session does not end every interview in
progress with "you withdrew consent".

The two gates fail in **opposite directions, on purpose**. Opening fails
**closed**: an unreachable database refuses the interview, because "we could not
check whether they agreed" and "they agreed" are not the same sentence. The
running check fails **open**: a transient database error must not end a live call
that a real grant authorised.

`interview_sessions.consent_id` pins the exact grant that was live at open, so
*"was this student consented, to what wording, at the time of interview X"* stays
answerable years later — after the grant has been revoked and re-given twice.
Revoking stamps `revoked_at` and never deletes the row.

## Audio — off by default, and "off" is two independent switches

This section replaces an earlier flat *"audio is not recorded"*. Capture now
exists (`app/interview_audio.py`), and a doc that denies a feature that exists is
as much of a trap as a setting that exists and does nothing.

**Nothing is captured unless BOTH of these are true**, and neither is true in a
default deployment:

1. `INTERVIEW_RECORDING_ENABLED=true` in `apps/api-py/.env` (default `false`);
2. the student holds a live consent grant of the current version whose
   `scope_store_audio` is `true` — a separate, **unticked** checkbox whose copy
   says plainly that staff can listen.

Both gates live inside `recorder_for()` so that *"when does REEP record a
student's voice?"* has one answer in one function. It **fails closed** — an
unreachable database means "do not record", never "record anyway" — and it is
called from `routers/interview.py`, because `interview_relay.py` imports no ORM
model and a recording feature is not what that containment gets spent on.

| | |
|---|---|
| **Format** | PCM16 LE mono 24 kHz wrapped in a RIFF/WAVE header by the stdlib `wave` module — the bytes already crossing the relay, so no encoder, no transcode and no new dependency |
| **Files** | **three per interview**: one per speaker (`student`, `interviewer`) plus a derived `mixed` listening copy. The two per-speaker files are still **the record** — do not "clean them up" as duplicates; the mix is regenerable from them and they are not recoverable from it. This row used to say the two must never be mixed, because before the timeline each file was a speech-ONLY concatenation with the silences squeezed out, so laying them side by side put answers under the wrong questions. `app/interview_audio.py` now pads each track against one monotonic session clock, so both files are session-length and the mix is a sum rather than a guess — accurate to a beat, not a frame (the interviewer's track is *when the model's audio was forwarded*, which can run ahead of the wall clock during a burst) |
| **Where** | a sibling of the uploads root, `<uploads>/../interview-audio`, each file named after the `interview_sessions.id` that owns it — so retention can find it from the primary key alone even if `audio_path` is ever lost. Not `app/document_store.py`: that store decides type by magic bytes and accepts only PDF/PNG/JPEG, and admitting audio would loosen the one control that makes it trustworthy |
| **Cap** | `INTERVIEW_RECORDING_MAX_BYTES` is a hard per-session ceiling on **captured PCM**. At the cap capture **stops**, `interview_sessions.audio_truncated` is set, and the interview continues — a call is never dropped to protect a file, and a truncation is never silent. **Size it against 96,000 B/s, not 48,000**: both tracks are padded to the session's wall clock, so an interview burns two streams whether or not anyone is talking. 128 MB is ~22 min, past the 900 s session cap; budget ~256 MB of *disk* per session, because the derived `mixed` copy is written on top of what survived. This row said "64 MB ≈ 45 min" for a release after the padding landed — arithmetic from the speech-only era, under which the cap bound first and quietly cut the last 3.8 minutes off every full-length interview |
| **Truncation** | three things stop a capture, and the WARNING names which: the byte cap above, a timeline gap longer than an interview can run (a suspended host, not a silence), and the write buffer bound — *"the disk is not keeping up"*, which now means only that. It used to fire on a healthy disk: pending silence was materialised into that buffer, so a 90-second answer left the interviewer owing one 4.3 MB lump and the next question ended the recording. Silence is an integer segment now, materialised in the writer, so the buffer holds real audio only |
| **Retrieval** | `GET /api/mentor/students/{sid}/interviews/{id}/audio?track=mixed\|student\|interviewer`, **defaulting to `mixed`**, behind `_require_developer` — **ADMIN only, deliberately narrower than every other read in that router** — **and** `_assert_can_access_student` **and** a re-check that the row's subject is the student in the path. A DIRECTOR gets 403 here and 200 everywhere else in the file; that asymmetry is intended, because a stored voice is an operator's artefact and not placement business. 404 — never 403 — when nothing was recorded, so a caller cannot tell "not recorded" from "not a real id" |
| **Retention** | the same 180-day clock as the transcript. `purge_expired` deletes the bytes **before** the rows; a session whose audio could not be deleted keeps its row, because an orphaned voice file is undiscoverable and therefore undeletable |

Read **`interview_sessions.audio_recorded`**, never `audio_path IS NOT NULL`. A
NULL path collapses four different facts into one — capture disabled, consent
refused, the write failed, the interview predates capture — and the flag is the
only column that distinguishes "we know nothing was kept" from "we do not know".
`audio_truncated` can be true while `audio_recorded` is false: a capture stopped
before its first flush ended early *and* kept nothing.

Those five `audio_*` columns are written by the Layer 1 finalizer, in the same
UPDATE as the terminal status, and they are the **only** record that a file
exists — retention deletes recordings by reading them. A recording whose row
never received them is a named student's voice on disk that nothing will ever
find.

If you are turning this on: it is a stored voice recording of a named student,
readable by staff. That is a materially different consent and legal posture from
a transcript, which is why the default is off, why the consent scope is separate
and unticked, and why the download is DIRECTOR/ADMIN only.

## Configuration

Everything lives in `apps/api-py/.env` — the one file all processes share. See the
`Realtime mock interview` block in `.env.example`. **Blank `OPENAI_API_KEY` is
off**, and only for this feature: `/status` reports unavailable and the socket
closes 4001. Nothing else in the dashboard is affected.

The v3 engine adds a deadline for every wait, because with the upstream no
longer driving, a stalled dependency becomes an interview that never continues
and reports no fault to anyone:

| setting | default | what it bounds |
|---|---|---|
| `INTERVIEW_TRANSCRIPTION_TIMEOUT_MS` | 8000 | the student's transcript after end-of-speech. On expiry the turn is recorded with an unknown transcript and the next question is asked anyway |
| `INTERVIEW_RESPONSE_CREATE_TIMEOUT_MS` | 10000 | our own `response.create` being acknowledged. Retried once, then 4011 |
| `INTERVIEW_REPORT_TIMEOUT_MS` | 20000 | the scorecard. On expiry the evaluation is persisted as `timeout` and the socket still closes 1000 |
| `INTERVIEW_MIN_ANSWER_WORDS` | 4 | the answer gate. 0 disables it — pre-v3 behaviour, where anything at all counted |
| `INTERVIEW_MAX_CLARIFICATIONS_PER_QUESTION` | 1 | how often one question may be re-asked before the interviewer accepts what it got |
| `INTERVIEW_ORPHAN_GRACE_SECONDS` | 1200 | how long a `running` row may sit with no heartbeat before the sweeper calls it abandoned |
| `INTERVIEW_RETENTION_DAYS` | 180 | how long the whole record — transcript, evaluation, any audio — is kept |
| `INTERVIEW_CONSENT_VERSION` | `2026-08` | the terms; bump it when the wording changes |
| `INTERVIEW_RECORDING_ENABLED` | `false` | audio capture — see *Audio* above |
| `INTERVIEW_RECORDING_MAX_BYTES` | 128000000 | the per-session ceiling on captured PCM — see the *Cap* row above before changing it |
| `INTERVIEW_VAD_SILENCE_DURATION_MS` | 600 | the pause that ends a student turn. At the upper edge of the 400–600 ms natural thinking-pause band; under v3 a split at a pause is merged into one answer, so it no longer risks cutting the candidate off |
| `INTERVIEW_VOICE_SPEED` | 1.0 | the interviewer's speaking rate (GA only, `audio.output.speed`, 0.25–1.5). Sent only when not 1.0; never sent on the beta shape |
| `INTERVIEW_TEMPERATURE` | *(unset)* | sampling temperature (0.0–2.0), both session shapes. Sent **only when set** — the default keeps the model's own, because an unverified parameter on `session.update` can kill the handshake |

`OPENAI_API_KEY` is deliberately **not** part of the LLM auto-select chain in
`app/ai/llm.py`: the Realtime API is not OpenAI-compatible chat, and a key pasted
here must not quietly become the provider for resume generation.

The key is attached to exactly one socket (the outbound `Authorization` header),
is never serialised downstream, and is never logged. `app/main.py` pins the
`websockets` logger to INFO because at DEBUG that library prints the outbound
handshake header by header, unredacted — and `--log-level debug` is a documented
troubleshooting step.

## Close codes

The client maps each of these to a sentence (`CLOSE_MESSAGES` in
`interview.service.ts`). An unmapped code degrades to "closed unexpectedly", so
**adding a close code to the server means adding it to that map**.

| code | meaning |
|---|---|
| 1000 | **the interview completed** — the relay closes it itself after `reep.report`. It also still covers a student pressing End at minute three, which is why the *record* does not read a 1000 as `completed` unless the scorecard actually settled |
| 1001 / 1012 | server restarting (1012 is what uvicorn itself sends) |
| 1006 | handshake refused or network dropped — no reason available |
| 1008 | not signed in, not a STUDENT, or a STUDENT session with no `studentId` (`interview_sessions.student_id` is NOT NULL, and meeting that as a 1011 thirty seconds in with an upstream session already billed is worse) |
| 1011 | internal error |
| 1013 | per-worker concurrency cap — the server is full, everyone is affected |
| 4001 | `OPENAI_API_KEY` not set, or upstream 401 |
| 4002 | upstream 403/429/5xx/handshake failure, **or** `create_response: false` was not applied (refusing beats running a known-double interview) |
| 4003 | Origin refused (a deployment mistake) |
| 4008 | idle cap — **no inbound audio**. Not a backstop for a transcription stall: the browser's echo-gate keepalive keeps frames flowing, which is why the answer deadline exists |
| 4009 | hard session cap |
| 4010 | unknown `?specialization=` (a stale client, never the student's fault) |
| 4011 | the relay could not advance the interview — our own `response.create` was never acknowledged, or was refused twice. Deliberately not 4002: that says "upstream is unavailable, retry shortly", this is a working socket on which **our** sequencing came apart |
| 4012 | **this student** already holds `INTERVIEW_MAX_SESSIONS_PER_USER` (default 2) live interviews on this worker. Deliberately not 1013: "the server is full" sends them to support, "your other tab is still open" sends them to the tab |
| 4013 | no live consent grant for the current version |
| 4014 | consent withdrawn while the interview was running |

4008 and 4009 are the only two whose reason names a configurable figure, so they
are the only two the client renders with `detail`.

## Troubleshooting

**"The connection dropped. Check your network." (1006)** — the handshake was
refused before accept, so the API never saw a route. Check the API is on 3300 and
that `/api/interview/status` answers.

**Every session closes immediately (4001)** — `OPENAI_API_KEY` is unset or has a
trailing newline. `/api/interview/status` says so in words.

**Connects, transcribes, plays no sound** — the two API generations name the audio
events differently. The relay matches a *set* of names for exactly this reason; if
it recurs, check `OPENAI_REALTIME_BETA_HEADER` against the model in use.

**The student talks and the interviewer never answers** — server VAD is off. The
relay verifies this from `session.updated` and closes 4002 rather than leaving the
student in silence; the log line names the echoed `turn_detection`.

**"Please accept the interview terms before starting." (4013)** — the student has
no live grant for `INTERVIEW_CONSENT_VERSION`. Normally the consent panel appears
instead, so 4013 means the client's own check disagreed with the server's: a
cached bundle against a bumped version, a hand-rolled socket, or a tab left open
across a revocation. A reload puts the current copy in front of them.

**The interview sounded fine and saved nothing** — the runbook query above is the
first check, and `interview_sessions` is the second: a row whose
`turns_emitted` far exceeds its `turns_persisted` says the relay had the turns
and the database did not take them, with no join required. A row still reading
`running` long after the fact means all three finalization layers missed it,
which in practice means the process was killed and the startup sweeper has not
run since.

**A row says a recording exists and the download 404s** — the file is not on
disk. Logged as a WARNING naming the session id and path, because a row claiming
audio that is not there is how a deletion request quietly fails to be honoured.

## What this replaced

`POST /api/agent/ask` and the LiveKit voice stack are **retained, mounted and
working** — they are the rollback path, not dead code. See the header on
`app/routers/agent.py` for the route-by-route audit of what is still live.
