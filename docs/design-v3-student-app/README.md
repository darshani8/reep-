# v2 UI design handoff — REEP Student App

The source of truth for the current student-facing look. Two files:

- **`HANDOFF.md`** — the handoff document itself: the token table (colour, type,
  radius, shadow, spacing), the shell, all fourteen screens, interactions,
  state, and the validation rules the design implies but does not enforce. This
  is the spec; where the implementation and this document disagree, this
  document is right and the implementation is a bug.
- **`student-app.dc.html`** — the canonical prototype. **A design reference
  authored in HTML, not production code.** Open it in a browser to view.

## What was NOT copied, and why

The prototype is a single-file format: `<x-dc>` wraps the template, a
`<script data-dc-script>` block holds React-class-like logic, `<sc-if>` /
`<sc-for>` are its conditional and list renderers, and **all styling is inline
by necessity of that format**. None of that is architecture. The handoff says so
explicitly, and it is reproduced here as a reference rather than a source:

- the runtime (`support.js`) is **not** in this repo and must not be ported;
- inline styles were extracted into real tokens and component classes in
  `apps/web/src/styles/reep-v2.scss`;
- `<sc-if>` / `<sc-for>` became Angular's `@if` / `@for`;
- navigation, which the prototype held in local state, is real routing.

The earlier, more heavily chromed `REEP Student App Y2K.dc.html` exploration is
**superseded** and deliberately not kept here — carrying a second, contradictory
reference is how two screens end up built from two different designs.

## Implementation status

**All fourteen student screens are built to this spec** — the shell (titlebar,
sidebar profile card, grouped nav, active pill), the floating agent orb and
voice overlay, the landing stage cards, jobs, skilling, leaderboards, the Time
Allocation Ledger, certifications, courses, records, uploads, the English
Baseline, the Mentor Meeting Log, the resume builder, the profile and the
assistant. Where a screen shows real data the copy and the empty/loading/error
states are the handoff's; only the prototype's sample rows (Asha Rao's marks,
"Nikhil Kamath", "LedgerCo") are absent, which is the point of them.

**The design language now covers every role, not only the student.** The
handoff is a student-app document and defines no mentor, director or alumni
screen, so those surfaces are built from the same token layer and the same
component classes — `.card`, `.dt-table`, `.chip`, `.btn`, `.field`, `.dense-stat`,
`.queue-split` — rather than from a second design. A director's Analytics screen
and a student's landing page are recognisably one product.

**What that sweep found**, and what is therefore worth checking before adding a
screen: five classes the design system was assumed to own were in fact defined
inside ONE component's stylesheet, or nowhere at all. `.feedback` (the banner
every write path reports through) lived in `uploads.component.scss`, so eleven
other templates rendered their errors as unstyled body text. `.dt-btn.sm` had
four separate definitions at three different sizes; `.dt-btn.danger` had one, so
Reject buttons on three screens looked neutral. `.chip.neutral` was overridden
locally on three screens with the retired warm-paper fill. The mentor notebook
styled itself against `--border`, `--surface-muted` and `--accent`, none of
which this design system defines — so its selected-student marker fell through
to a literal blue in a lilac-and-magenta app. Academics and Offers had built a
fourth field vocabulary (`.fld` / `.fld__input`) on the MUI-era `--reep-*`
tokens. All of it is now in `reep-v2.scss`, once each.

The rule this proves: **a component stylesheet that defines a name the rest of
the app also uses has not extended the design system, it has forked it** — and
view encapsulation means the fork is invisible everywhere except the one screen
that owns it.
