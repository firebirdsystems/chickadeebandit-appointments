# Appointments & Check-ups

The recurring health cadence for everyone in the household — annual physical,
dentist every six months, eye exam, well-child visits, therapy, screenings —
with a "time to book" email ahead of each due date and a visit history per
person.

It fills the gap between `home-maintenance` (house systems),
`vehicle-maintenance` (cars) and `pet-care` (animals): nothing tracked *people's*
recurring medical cadence. `medication-tracker` is daily doses;
`health-cards` is static allergy and insurance information.

Premium-native: `required_capabilities: ["cron", "email"]`, so it installs only
under the premium bundle, like `subscriptions` and `vehicle-maintenance`. The
countdown, the badge, and the published events work regardless; the emailed
nudge is the part the bundle buys.

## Two dates, one reminder anchor

Every appointment carries two distinct dates and the app keeps them apart.

| Column | Means | Reminder? |
|---|---|---|
| `next_due_date` | when the cadence says the next visit is due | **Yes** — `date_reminders` anchors here; the lead time is "time to book" |
| `scheduled_date` (+ `scheduled_time`) | the booked slot, once it exists | No email — it goes to the **calendar**, via a suggested automation |

`date_reminders` takes exactly one anchor column, and the *booking* reminder is
the one that saves a missed check-up. The day-of reminder is the calendar's job.
Keeping them apart is also what stops a booked-but-not-yet-due appointment from
emailing twice.

Logging a visit **rolls** `next_due_date` forward from the visit date, clears
the booking, and clears the reminder stamp. Past dates never remind (the hub
returns nothing for a one-shot date that has gone by), so an un-rolled overdue
appointment falls silent by email — the badge, not the inbox, carries "overdue".

## Access

Health data, so the private lane is the point. `appointments` is
`owner_or_visibility`:

```jsonc
{
  "kind": "owner_or_visibility",
  "member_column": "created_by",        // NOT person_id — see below
  "visibility_column": "visibility",    // household | private
  "everyone_values": ["household"],
  "write_visibility_scoped": true,      // you may write exactly what you may read
  "delete_adult_only": true,
  "column_write_acls": { /* every content column → writable_by: ["adult"] */ },
  "max_rows": 2000
}
```

Three things about that shape are load-bearing, and each is proved in
`scenarios.json` against the real runtime rather than assumed:

- **The owner column is `created_by`, not `person_id`.** `owner_or_visibility`
  *forces* its owner column to the caller on every INSERT
  (`app-db-policies/kinds/owner-or-visibility.ts`). With `person_id` as the owner
  column, a parent adding "Sam's dentist" would silently create it for
  themselves — and silently is the operative word. `person_id` is an ordinary
  column, so a parent may set it to anyone; the adult-only column ACL is what
  stops a child from doing the same.
- **`write_visibility_scoped` is what makes the private lane real.** Without it,
  any adult may `UPDATE`/`DELETE` any row — *including one the visibility rule
  hides from them*. Confidentiality with an open write path is read-only
  theatre. With it, one parent's `private` row is invisible to the other and
  their write matches zero rows. **That comes back HTTP 200 with `changed: 0`,
  not an error**, so every write in `src/index.html` goes through
  `assertChanged()` and treats zero as a failure — rolling the optimistic row
  back and publishing nothing. This is reachable with no attacker at all: the
  other parent turns a shared appointment private, or deletes it, between this
  browser's last load and its next write.
- **"Adults manage, kids read" is not a policy kind.** No `owner_or_visibility`
  flag expresses it: `write_privileged_only` means *a configured hub group*, not
  adults, and with no group configured the hub grants that bypass to nobody, so
  declaring it would lock everyone out. Instead every content column carries
  `column_write_acls: { writable_by: ["adult"] }` and DELETE carries
  `delete_adult_only`. A column added to the schema later without an ACL entry
  is writable by a child — `__tests__/manifest.test.mjs` walks the migration and
  fails if one is missing.

Consequence worth stating plainly: **`private` means private to the adult who
created the row**, including from the person it is *for*. A parent can keep a
referral to themselves; a teen cannot keep one from the parent who manages it.
That is what the owner column can express, and the design's original wording
(the subject sees their own rows regardless of visibility) is not reachable
while `person_id` must stay settable by someone else.

`visits` is `inherit_visibility` on `appointments` with `adults_bypass: true` —
under an `owner_or_visibility` parent, privilege means privileged-group
membership only, so without it a mistyped visit could be corrected by nobody but
whoever logged it, and would freeze permanently once that member left.
`retain_days` expires visit history after five years.

`contexts: ["household"]` and `kiosk: "never"`: there is no version of this data
that belongs in a classroom roster or on a shared wall screen. No `ai_access`
either — apps are invisible to MCP unless they opt in, and this one does not.

### `remind_scope` vs `visibility`

Two different questions, kept in two columns. `visibility` decides who can *see*
the row; `remind_scope` decides who the *email* reaches. A teen's therapy
appointment can be household-visible while only they are emailed, or private and
still emailed. `date_reminders` reads `remind_scope` and `person_id`, never
`visibility`.

`remind_scope` defaults to `household`, which means **a child's appointment
emails the child too** if they have an address on the roster. The protocol has
no third "adults" scope value — the choice today is owner-only or everyone — so
the default is the widest one and a parent narrows it per row. A third scope
value would be a protocol change and is deliberately not special-cased here.

`on_no_recipients` is **`"skip"`**, not `"adults"`. That fallback mails every
adult when the scoped audience comes back empty, and for this app the empty case
is precisely a `private` row whose person has no email — a child, usually. The
fallback would therefore put a private health reminder's title in front of the
other parent, who `visibility: private` forbids from reading the row at all. The
hub's own comment on that branch says the widening "must be the app's explicit
choice, never a fallback it inherits"; this app's choice is no. The cost is that
a private reminder to an address-less person reaches nobody, and the editor says
so on the row rather than letting it vanish.

## Private rows publish nothing

A `private` appointment emits no `appointment.due_soon` and no
`appointment.booked`, and turning a shared row private **retracts** any entry it
already put on the calendar.

That is a confidentiality boundary, not a preference. Calendar's `create_event`
action sets no visibility, so the row it writes lands on calendar's own column
`DEFAULT 'everyone'` — inside its `everyone_values`, i.e. household-wide.
Announcing a private referral would publish its title, the person's name, the
provider and the phone number (`eventSummary`) to the whole household and defeat
the row policy that hid the row in the first place. No payload edit fixes it:
even a fully redacted entry still tells the household that this person has an
appointment on that day. So the announcement is suppressed entirely, which fails
closed, and the editor's note says so for that row instead of promising a
calendar entry that will never come.

Widening this needs a `visibility` param on calendar's `create_event` — a
protocol change to another app, and a conversation rather than an edit here.

## Dates are validated, not just shaped — and not only in the browser

`isIsoDate` rejects `2026-02-31`, not merely `not-a-date`. JavaScript normalizes
an impossible date rather than refusing it, so a shape-only check would let one
row render as "Feb 31" in the app, behave as March 3 in every calculation, and
be refused outright by the hub's reminder parser — three answers for one row,
none of them flagged.

The browser is not where that check belongs, though, because the browser is not
the only writer. `automation_actions.add_appointment` declares `next_due_date`
as a `text` param and `AutomationParamSchema` has no pattern constraint (only
`options`, a closed set, which a date cannot use), so any rule author can write
any string into the column. Client-side validation then produces exactly the
divergence it was meant to prevent: the app says "No date set" and never
announces, email reminders skip the row, and the **glance badge counts it**,
because the badge compares the stored text lexically and `'2026-02-31'` sorts
before the cutoff like any other date. A "1 to book" the household cannot clear
from inside the app.

So the constraint lives on the column:

```sql
next_due_date TEXT NOT NULL DEFAULT ''
  CHECK (next_due_date IS '' OR next_due_date IS date(next_due_date))
```

A round trip through SQLite's own parser, which is a real date check rather than
a shape check, and pins the canonical spelling as a side effect (`2026-2-3` is
out). `IS` rather than `=` is load-bearing: `date()` returns NULL for
unparseable text, `col = NULL` evaluates to NULL, and **a CHECK accepts NULL** —
the `=` spelling looks identical and lets `'later'` straight through.
`scenarios.json` proves the refusal against the real runtime: the insert comes
back **HTTP 400**, and an automation run carrying one is recorded as an `error`
in the rule's run history rather than writing a row nothing can render. The
glance carries the same predicate too, so the badge and the app agree even if
the constraint were ever relaxed.

## Lead times, and why 26 keeps appearing

The hub suppresses a reminder whose `last_reminded_at` stamp falls inside the
current occurrence's window, which opens `lead_days + 1` days before the date. If
that window is wider than the gap between two occurrences, the previous cycle's
stamp always lands inside the next one's window and the appointment goes
**permanently silent after its first nudge**.

So `maxLeadDays()` caps a recurring row's lead at less than one interval,
counting a month as its shortest (28 days) with a day of timezone slop: monthly
therapy caps at 26, six-monthly dental at 166, yearly at 334. A one-off has no
next occurrence to collide with and caps at a year.

That is also why the column `DEFAULT` and `date_reminders.default_lead_days` are
both **26** rather than the app's taste value of 30: a `DEFAULT` is a constant
and the hub applies `default_lead_days` with no clamp and no knowledge of the
cadence, so both must hold for the shortest cadence the app offers. The app
raises it per row through `clampLeadDays()`, which *does* know the cadence.

The app also clears `last_reminded_at` whenever `next_due_date` moves, which
fixes the same hazard from the other side.

## Roll-forward

Logging a visit is one batch of two statements — `INSERT` the visit, then
`UPDATE` the appointment's `next_due_date` — so a visit can never be recorded
without its roll-forward. Both run under the caller's own policy, so a child
cannot log a visit and a non-owner cannot roll a private row.

The new date is computed in **JavaScript and bound as a parameter**, not
computed in SQL. `addMonths()` reproduces SQLite's `date(x, '+n months')`
exactly, overflow and all (Jan 31 + 1 month is Mar 3, not Feb 28), which means
one implementation of the month arithmetic rather than two that can drift — and
the optimistic row the UI already painted shows the value the write stores.

When `write_effects` lands, this `UPDATE` can move into
`write_effects.visits.insert`; `next_due_date` is already plaintext, which that
design requires of effect-computed columns. Not a dependency today.

## Reads

Both first-render reads are declared in `manifest.preload` *and* mirrored
verbatim in `src/index.html`, so the hub answers the launch batch from rows it
embedded in the document — zero round trips. `__tests__/preload.test.mjs` pins
the two copies together, because a drifted copy is not an error anywhere: it is
a preload that silently never answers.

Notably, the "last visit per appointment" fold is **not** SQL. A
`MAX(visit_date) … GROUP BY` fed through a derived table is rejected by the
row-policy rewriter, which fails closed on a governed table reachable only from
inside a subquery. So the preload reads a bounded, ordered 200-row tail and
`lastVisitByAppointment()` folds it in the browser — one statement, one index,
no policy hole. A single appointment's full history is fetched only when
somebody opens it, and archived rows are fetched only when somebody asks for
them.

## Cadence presets

`KINDS` in `src/logic.js` carries a starting interval per kind, and
`suggestedIntervalMonths()` tightens well-child visits under three and offers
adults two years between eye exams. They are suggestions the household edits,
shown next to `CADENCE_NOTE` — "a typical cadence, not medical advice, ask your
provider" — and nothing in the app decides anything from them. A member with no
birthday on the roster gets the kind's plain default; guessing from a missing
birthday would be worse than offering nothing.

## Events

| Event | Fires |
|---|---|
| `appointment.due_soon` | the due date is set or rolls forward — not on the reminder day |
| `appointment.booked` | a slot is booked or moved |
| `appointment.cancelled` | one announced entry no longer applies |
| `appointment.visit_logged` | a visit is logged |

Two calendar entries can be live at once, so each carries its own reference:
`appointments:<id>` for the "time to book" day and `appointments:<id>:booked`
for the slot. `appointment.cancelled` is published **once per reference**, which
is why the retraction rule fires twice for an appointment carrying both.
Retracting a reference the calendar never saw is a no-op there, so the app only
publishes on a real transition out of "announced" — a retraction on every save
would spend an automation run to update zero rows.

All four are gated `require_role: "adult"`: each drives a trusted write in
another app, and the event bus is a channel row policies cannot see.

Which is also why publishing is not something a call site decides for itself.
`announceFor(appt, type, payload)` takes the **row**, not its id, refuses when
the row is private, and is the only way to publish an assertion about an
appointment. `appointment.visit_logged` is the reason: it carries the title, the
person, the kind and the free-text outcome — a private therapy visit's outcome —
and it was published unconditionally while the two calendar events beside it
were gated. One more `if` would have fixed that one call; the seam fixes the
next one, and `__tests__/manifest.test.mjs` fails on any new `publishSafely()`
call site.

`appointment.cancelled` is the single deliberate exception, and skips the gate
for the opposite reason: a row that has just *become* private is exactly when
the entry standing on the household calendar has to come down. It carries only
what the calendar already published.

Ship the retraction rule alongside either announcement rule, or an entry
outlives the appointment it was made for.

## Development

```bash
make setup     # once per clone — wires the pre-push preflight hook
npm install
npm test
npm run build  # validates the manifest, migrations, agenda and glance
npm run dev    # local dev server with demo data
```

`make setup` is not optional and is invisible to every diff: the hook only runs
when `core.hooksPath=.githooks` is set in *this clone's* local git config, so a
fresh clone starts unwired and pushes with no preflight at all. The tell is a
missing `✓ Preflight passed` line.
