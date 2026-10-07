# Faculty screens at phone width — before / after

390×844 in Chromium, `/api` stubbed with plausible data (no backend), taken
before the phone layout work (`*-before.png`, base `2f3dfac`) and after it
(`*-after.png`). The shell's bottom tab bar was not on the branch yet, so
`--mobile-tabbar-h` reads as 0 in these. At 1280px every screen renders
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
