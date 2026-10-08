# Student screens at phone width

`before/` and `after/` are the first screen of each student route at 390x844,
taken in Chromium with `/api` stubbed (no backend), before and after the
phone pass. Desktop (1280px) was compared pixel for pixel before and after and
is unchanged.

Regenerate from the repository root with `ng serve` running:

    node docs/mobile-pwa/student/harness/shoot.mjs http://localhost:4200 /tmp/shots
    W=1280 node docs/mobile-pwa/student/harness/shoot.mjs http://localhost:4200 /tmp/shots-desktop

`harness/fixtures.mjs` is the stub data (one student, Asha Rao, on 2026-10-07).
It is test data only and is not shipped.
