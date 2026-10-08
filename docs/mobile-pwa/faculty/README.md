# Faculty screens at phone width — before / after

390×844 in Chromium, `/api` stubbed with plausible data (no backend), taken
before the phone layout work (`*-before.png`, base `2f3dfac`) and after it
(`*-after.png`). The after shots include the orchestrator's phone shell
(bottom tab bar, orb above it), merged from `ccr-30eaf725-muwz6x`. At 1280px every screen renders
pixel-identical before and after.

| Screen | Shots |
| --- | --- |
| Mentee Log | `mentees` (list), `mentees-detail` (pushed log after a tap) |
| Faculty notebook | `notebook`, `notebook-form` (Add entry open) |
| Verifications | `verifications`, `verifications-open` (one claim, pinned decisions) |
| Leave | `leave`, `leave-form`, `leave-form-bottom`, `leave-view` |
| Signature | `signature` |
| Upskilling | `upskilling` |
| REEP Agent | `agent`, `agent-thread` |

## Re-running the shots: `harness/`

`harness/shoot.mjs` drives Chromium through every screen above with each `/api`
request stubbed from `harness/fixtures.mjs` (a MENTOR session, fixed dates), so
it needs `ng serve` and nothing else. `harness/diff.py` pixel-diffs two runs.

```
cd apps/web && npx ng serve                       # Angular CLI needs Node >= 22.22.3
# from the repository root (root `npm ci` provides playwright):
PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  node docs/mobile-pwa/faculty/harness/shoot.mjs /tmp/before before   # 390x844 by default
#   ...change the code, let ng serve rebuild...
PW_CHROMIUM=... node docs/mobile-pwa/faculty/harness/shoot.mjs /tmp/after after
python3 docs/mobile-pwa/faculty/harness/diff.py /tmp/before /tmp/after  # exit 1 if anything moved
```

Optional arguments after the tag: `width height only` (for example
`1280 900 notebook,mentees` for desktop, two screens). `BASE_URL` overrides
`http://localhost:4200`; without `PW_CHROMIUM` Playwright uses its own browser.
Diff raw harness output only: the PNGs committed beside this README are
reduced to 96 colours and will never match a fresh run.
