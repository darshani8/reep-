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
| `apps/api-py/app/routers/interview.py` | the boundary: auth, STUDENT check, concurrency cap, specialization validation, conversation, turn writer |
| `apps/api-py/app/interview_relay.py` | the engine: one `_RelaySession` per interview, both pumps, the guardrails |
| `apps/api-py/app/interview_matrix.py` | the Specialization Matrix (HR/DM/BA/FA personas, frameworks, opening questions) and the interview phase state machine |
| `apps/web/src/app/core/interview.service.ts` | the client: audio graph, uplink, close-code messages |

## Endpoints

```
GET /api/interview/status   -> {available, reason, active_sessions, max_sessions}
WS  /api/interview          -> one interview; ?specialization=hr|dm|ba|fa optional
```

`GET /status` exists because a **rejected WebSocket handshake reaches the browser
as a bare 1006 with no code and no reason**. It is the only place a student can be
told *why* — not configured, not signed in, not a student. It answers `200` with
`available:false` even for a non-student (where `/api/voice/status` raises 403),
because the client treats any non-2xx as "probe unavailable" and would throw the
explanation away.

## The Specialization Matrix

The student picks a track on the assistant screen; the client sends it as
`?specialization=` on the socket (a query param because a browser WebSocket
cannot set headers — safe precisely because it is a UI choice, not a student
record). `app/interview_matrix.py` owns the four rows — AI persona, core
frameworks, opening question — **verbatim from the product spec**, and
`InterviewStateMachine`, which advances the interview through explicit phases
on each *completed student answer*:

```
opening  --1 answer-->  probing  --3-->  deep_dive  --5-->  wrap_up
```

(Any phase can also go straight to `ended`; `wrap_up` is sticky.) The relay
composes instructions as **base persona verbatim + specialization block +
phase directive**, sends the opening composition in the startup
`session.update`, and pushes an **instructions-only** `session.update` on every
phase change (the voice is frozen once the model has spoken, so nothing else
may ride that update). The browser learns the phase from `reep.ready` and
`reep.phase` events. **No `?specialization=` runs the generic interview with
the untouched base persona** — and an unknown key is refused with close 4010
rather than silently downgraded to it.

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
`GET /api/agent/history` returns them unchanged. There is no parallel store.

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

## Configuration

Everything lives in `apps/api-py/.env` — the one file all processes share. See the
`Realtime mock interview` block in `.env.example`. **Blank `OPENAI_API_KEY` is
off**, and only for this feature: `/status` reports unavailable and the socket
closes 4001. Nothing else in the dashboard is affected.

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
| 1000 | interview complete |
| 1001 / 1012 | server restarting (1012 is what uvicorn itself sends) |
| 1006 | handshake refused or network dropped — no reason available |
| 1008 | not signed in, or not a STUDENT |
| 1011 | internal error |
| 1013 | per-worker concurrency cap |
| 4001 | `OPENAI_API_KEY` not set, or upstream 401 |
| 4002 | upstream 403/429/5xx/handshake failure |
| 4003 | Origin refused (a deployment mistake) |
| 4008 | idle cap — no inbound audio |
| 4009 | hard session cap |
| 4010 | unknown `?specialization=` (a stale client, never the student's fault) |

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

## What this replaced

`POST /api/agent/ask` and the LiveKit voice stack are **retained, mounted and
working** — they are the rollback path, not dead code. See the header on
`app/routers/agent.py` for the route-by-route audit of what is still live.
