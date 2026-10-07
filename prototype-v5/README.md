# REEP v5 — a clickable prototype

A complete redesign of REEP's interface for the three roles that run the
programme: **Student**, **Faculty** and the **Main Admin**. It is a static,
dependency-free PWA. Every screen works with invented data held in memory, and
every rule the real product enforces is enforced here too. It is a prototype and
not part of the app: nothing in `apps/web` or `apps/api-py` was changed, and none
of this code is meant to be copied into them as is. Use it as the design that the
Angular screens are measured against.

## Run it

```
npx serve prototype-v5          # or:
cd prototype-v5 && python3 -m http.server 8000
```

Open the printed address. The dark bar at the top belongs to the prototype, not
the design. Use it to switch between **Signed out / Student / Faculty / Main
Admin** at any time. Its **State** menu draws any screen in its loading or error
state. Served over `localhost` or HTTPS, the prototype installs as an app
(manifest + service worker) and opens offline.

| File | What it is |
|---|---|
| `index.html` | The prototype: role switcher, hash routing (`#/student/home`, `#/admin/registrations/r3`, …) |
| `components.html` | The design system: tokens, type, buttons, chips, cards, rows, tables that become cards, fields, tabs, sheets and states |
| `FUNCTION-INVENTORY.md` | Every function of the current app for these three roles, the rule it obeys, and the prototype element that carries it |
| `screenshots/` | Key screens of each role at 390×844 (phone) and 1440×900 (desktop) |
| `css/tokens.css` | The `:root` block of `apps/web/src/styles/reep-v2.scss`, copied **verbatim** |
| `css/app.css` | Layout, spacing, motion and components. It adds no colours. |
| `js/` | `core.js` (helpers, sheets, router), `app.js` (shell and navigation as data), one `screens-*.js` per area |
| `tools/build_inventory.py` | Rebuilds the inventory from `tools/inventory/*.md` and the source. It fails if any row has no element. |

## Design principles

1. **Same brand, calmer surface.** The colours, gradients, shadows, radii and
   both typefaces (Plus Jakarta Sans for display, Inter for body, self-hosted)
   are REEP's own tokens, unchanged. Magenta appears only through
   `--primary-gradient`: on the one primary action of a view and on the active
   navigation row. The rest of the interface is white glass on the lilac wash,
   and colour is saved for status.
2. **One primary action per view.** It goes in the page header on desktop and
   in a sticky action bar above the tab bar on a phone. Secondary actions are
   quiet buttons, and destructive ones are red and ask first.
3. **List → detail, everywhere.** Queues, rosters, records and requests are
   lists of 56px rows. On a phone a row pushes a detail screen. The back arrow
   and a swipe from the left edge return. On desktop the same list sits beside
   its detail in a split view, so the office can move through a queue without
   losing its place.
4. **Forms live in sheets.** Editing, deciding and adding open a bottom sheet
   on a phone and a side sheet on desktop. The page stays where it was, and
   the sheet can be dragged down to dismiss.
5. **Decisions carry words.** A rejection, a "request changes", a hold, a
   disable, a remove and a cap reset all refuse a blank reason, exactly as the
   API does. "Delete for good" also needs the six-digit code that is emailed to
   the office.
6. **Status is a word and a colour.** No dot, bar or tint stands alone. Every
   chip says *Approved*, *Pending review*, *Below 75%* or *Not measured*, and a
   missing number is shown as "—", never as 0.
7. **Nothing explains itself.** There are no tooltips that describe a screen,
   no "how to use" cards and no tutorials. Labels are task words ("Approve new
   students", "Assign faculty", "Submit day"). A short factual line under a
   title is allowed when it states a fact, such as "Open until 9 Oct".
8. **Native on a phone, dense on a desk.** The layout is built mobile-first at
   360–430px:
   - a bottom tab bar with four tabs and More;
   - 44px targets and 16px inputs (no iOS zoom);
   - safe-area insets for the notch and home bar;
   - `100dvh` frames.

   At 1024px and above the tab bar becomes a navigation rail with the role's
   groups, and pages become multi-pane.
9. **Navigation is data.** Each role has one list (`NAV` in `js/app.js`). The
   rail, the tab bar and the More screen are all drawn from it, so "which
   screens does this role see" is a list you can read.

## What changed, per role

### Student
- **Five places instead of thirteen sidebar rows.** Home, Jobs, Skills and Time
  log are tabs, and everything else is one tap away under More. The rail groups
  them as Practice, My record and Me.
- **Home leads with the answer.** The readiness ring, its factors and the three
  next actions come first. After them come the programme stages, then SWOC,
  attendance, marks and academic history, in that order.
- **Results & courses is one screen with four tabs** (Results, Attendance,
  Courses, Academic history). It replaces Records, and Courses, which you
  could only reach from inside Records.
- **The time log reads as a day.** A 14-day strip shows each day as
  submitted, draft, locked or not logged. You can step between days, and every
  slot shows a live "balanced / open / over" chip. The rules behave as they do
  in the app:
  - Submit stays disabled until the day reconciles to exactly 24 h.
  - A slot cannot hold more than its length.
  - A day locks two days after it ends.
  - Copy yesterday is offered only when yesterday was submitted.
- **Mock interview.** The interview room is the same in the dock and on its
  own page. Consent is a sheet that appears whenever the college's policy
  differs from what the student agreed to.
- **Account & security** also holds the password change, which opens as a sheet
  and replaces the separate `/account/password` page.

### Faculty
- **My students is the home screen.** Picking a student opens the meeting
  notes and the log-a-meeting form beside the list on desktop, or as a pushed
  screen on a phone.
- **Verify is one queue with a count on its tab.** Each claim and document
  opens a review sheet. Request changes and Reject refuse without a note,
  because that note is all the student is told.
- **Leave is a list, a form and a paper.** The form refuses a To date before
  the From date. The request detail looks like the college's paper, with the
  PROGRAM DIRECTOR block, and has Withdraw while the request is waiting and
  Edit & resubmit after a rejection.
- **The signature moved into Account & signature.** There was a separate
  signature page and a signature card on the account page; one card now does
  the job of both.
- **Granted access** appears as its own rail group only when the office has
  granted a console function (for example, Approve leave).

### Main Admin
- **Home is the day's work.** The waiting counts are large buttons that open
  their queues, and every screen is listed by its task.
- **Applications and Leave** are split-view queues, with Approve, Hold and
  Reject (Reject needs a reason) and Sanction and Reject. Their counts appear
  as badges in the rail and the tab bar.
- **Colleges is one area instead of three screens:**
  - the list of colleges;
  - each college's structure (departments → courses → specializations →
    batches);
  - the six-step "Set up a college" flow, pushed from a button on the list or
    from an "Add …" link in a structure.
- **Who can do what and Feature switches** are tabs of one screen.
- **Remove and Delete for good** are presented as a choice in one sheet:
  - Remove asks for a reason and can be undone.
  - Delete for good shows the plan of what goes and what stays, then needs the
    emailed code, and cannot be undone.
- **Every list becomes cards on a phone**, so the whole console can be used on
  a handset.

## Honest limits
- There is no server. Uploads are checked for type and size in the browser and
  then kept in memory. "Download PDF" and "Open file" show a toast, and Google
  sign-in moves to the student home after a short delay.
- Loading and error states are drawn by one shared pattern. You see them by
  choosing them in the State menu, not by breaking a network call.
- Reloading the page resets all data.
