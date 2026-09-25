# Interactive diagrams (Archify)

Seven diagrams of REEP, one for each kind of picture
[Archify](https://github.com/tt-a1i/archify) can draw. Each is a single
self-contained HTML file, rendered from the typed JSON source committed beside
it. Download the HTML and open it in any browser. Nothing is installed and no
server is needed. The fonts and the viewer are inlined, which is why each file
is about 0.8 MB. The delta is 2.2 MB, because it carries three views,
Before, Delta and After.

**Every fact on these diagrams was checked against the code at `408b629`**, not
copied from `AGENTS.md`. Where the two disagree, the diagram follows the code.
When the system changes, edit the JSON and re-render it (below). Never
hand-edit the HTML; it is generated.

| File | Archify type | What it shows |
|---|---|---|
| [`reep-runtime.architecture.html`](reep-runtime.architecture.html) | **Architecture**, with source links, five guided chapters, trace motion and the *signal-flow* style | The production request path: SPA → CloudFront + WAF → ALB → the ARM64 api service (which also carries the `/api/interview` relay) → RDS/pgvector, EFS, Bedrock, SES, Google sign-in and the scheduled jobs. Each **SRC** marker opens the exact file and lines at `408b629` (34 links, verified against that commit). |
| [`reep-aws-deployment.architecture.html`](reep-aws-deployment.architecture.html) | **Architecture** under the `deployment-ownership` profile, *blueprint* style | Who owns what on AWS: the four CDK stacks across the global edge, `ap-south-1` (VPC, private subnets, ALB, ECS, Multi-AZ RDS, EFS, the Object-Locked buckets) and the `ap-southeast-1` DR vault, plus the OIDC deploy path. Archify refuses to render this profile unless every node names its owner and region, the database is private and every crossing is named. |
| [`student-onboarding.workflow.html`](student-onboarding.workflow.html) | **Workflow** (schema v2), four lanes | Registration to first sign-in: the one multipart `POST /api/register`, the rule engine, the review queue (HOLD and REJECT as side branches), APPROVE provisioning the account, then `/auth/onboard/start` → `verify` → `password`, ending at `/login`. |
| [`mock-interview.sequence.html`](mock-interview.sequence.html) | **Sequence** | One mock interview, turn by turn: consent POST, the socket's consent/cap checks (4013/4012/4015), the Nova 2 Sonic turn loop with control notes held until `completionEnd`, the `submit_scorecard` tool call and the session row closing. |
| [`nightly-data-protection.dataflow.html`](nightly-data-protection.dataflow.html) | **Data flow**, *editorial* style | How student data outlives the database every night: identity ledger 23:30, AWS Backup 00:30 (35 days, DR copy, monthly archive), `pg_dump -Fc` 01:00, document sweep 02:00, retention sweep 03:00. Every S3 write is drawn as the write-never-read grant it is. |
| [`registration-application.lifecycle.html`](registration-application.lifecycle.html) | **Lifecycle** | A `registrations` row's reachable states (`PENDING_REVIEW`, `HOLD`, `AUTO_APPROVED`, `APPROVED`, `REJECTED`), what moves it between them, and the re-apply path the partial unique index allows. |
| [`interview-stack.delta.html`](interview-stack.delta.html) | **Architecture Delta** (`archify compare`) | The mock-interview stack in August 2026 (OpenAI realtime relay plus the LiveKit voice worker) against September 2026 (Nova 2 Sonic in-process, `INTERVIEW_ENGINE`). The "before" is taken from the design record, because the deleted files are not in this repository's history. The machine receipt `compare` wrote is [`interview-stack.delta.receipt.json`](interview-stack.delta.receipt.json): 4 components added, 7 removed, 4 changed. |

## Reading them

Every file carries Archify's full viewer, whatever it shows:

| Key | Does |
|---|---|
| <kbd>?</kbd> | The diagram's own guide |
| <kbd>/</kbd> | Find a component and focus it; then **Upstream** / **Downstream** traces what is connected to it |
| <kbd>R</kbd> | Probe a route between two components |
| <kbd>L</kbd> | Compare one or two kinds of component (e.g. database vs backend) |
| <kbd>P</kbd>, <kbd>[</kbd> <kbd>]</kbd> | Play the guided chapters |
| <kbd>S</kbd> / <kbd>T</kbd> | Cycle the visual style (classic, signal-flow, blueprint, editorial) / toggle light and dark |
| <kbd>F</kbd> | Presentation mode |
| <kbd>E</kbd> | Export: PNG, JPEG, WebP, dual-theme SVG, a WebM of the trace, and 1200×630 share cards (whole diagram, one route, or one reach) |

Links can open a diagram already focused, e.g. `reep-runtime.architecture.html#view=<chapter-id>`
or `#route=<from>~<to>`.

## Re-rendering

Archify is not vendored here. Use a checkout of it (Node 18 or newer, no `npm install`):

```bash
git clone --depth 1 https://github.com/tt-a1i/archify ../archify
cd ../archify/archify

# edit the JSON, then check it (showcase = all 9 artifact checks, 0 errors, 0 warnings)
node bin/archify.mjs validate architecture ../../reep-/docs/archify/reep-runtime.architecture.json \
  --quality showcase --json --repo-root ../../reep-

# render it; the HTML is replaced only if every check passes
node bin/archify.mjs deliver architecture ../../reep-/docs/archify/reep-runtime.architecture.json \
  ../../reep-/docs/archify/reep-runtime.architecture.html --quality showcase --json --repo-root ../../reep-

# the delta is built from its two snapshots
node bin/archify.mjs compare architecture \
  ../../reep-/docs/archify/interview-stack.base.architecture.json \
  ../../reep-/docs/archify/interview-stack.head.architecture.json \
  ../../reep-/docs/archify/interview-stack.delta.html --json
```

Use the type that matches the file name (`workflow`, `sequence`, `dataflow` or
`lifecycle`). `--repo-root` applies only to architecture diagrams.

**The source links are pinned to one commit.** `meta.repository.revision` in the two
architecture JSON files is `408b629`. If you move a line range, move the pin
too, or the render refuses (every link is re-read from Git at that commit).

For a real-browser check at 1440×900 through 2048×1320, run it on a *copy*,
because it writes screenshots beside the file it checks:

```bash
cp ../../reep-/docs/archify/reep-runtime.architecture.html /tmp/vc/
ARCHIFY_CHROME=/path/to/chrome node bin/archify.mjs visual-check /tmp/vc/reep-runtime.architecture.html --json
```

`visual-check` reports the delta as overflowing the viewport at every size.
That comes from the page format, not from this diagram: a delta page is a
scrolling review page, and Archify's own packaged example delta fails the same
way at the same heights.

The A3 print posters are separate, in [`../diagrams/`](../diagrams/README.md).
