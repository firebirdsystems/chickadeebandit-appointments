/**
 * Pure business logic for Appointments & Check-ups.
 * No DOM, no fetch — importable in both browser and test environments.
 *
 * Every date here is a household-LOCAL calendar date ("yyyy-mm-dd"), never a
 * UTC instant. The caller supplies "today" as a Date built from `hubToday()`
 * (see index.html) so these helpers stay SDK-free while still agreeing with
 * every server-side surface: the glance, the agenda, and the date_reminders
 * cron all resolve `:today` on the household's calendar.
 */

import { isAdult } from "./shared.js";
export { isAdult };

/* ── Vocabulary ─────────────────────────────────────────────────────────────
 * `months` is the cadence the app OFFERS when this kind is picked — a starting
 * point the household edits, not advice. See CADENCE_NOTE, which is rendered
 * next to it wherever a preset is applied.
 */
export const KINDS = [
  { value: "physical",   label: "Annual physical",  icon: "🩺", months: 12 },
  { value: "dental",     label: "Dental cleaning",  icon: "🦷", months: 6 },
  { value: "vision",     label: "Eye exam",         icon: "👓", months: 12 },
  { value: "wellchild",  label: "Well-child visit", icon: "🧸", months: 12 },
  { value: "therapy",    label: "Therapy",          icon: "💬", months: 1 },
  { value: "specialist", label: "Specialist",       icon: "🏥", months: 6 },
  { value: "screening",  label: "Screening",        icon: "🔬", months: 12 },
  { value: "vaccine",    label: "Vaccination",      icon: "💉", months: 12 },
  { value: "other",      label: "Other",            icon: "📌", months: 12 },
];

export const CADENCE_NOTE = "A typical cadence, not medical advice — ask your provider.";

/**
 * The well-child schedule, in MONTHS OF AGE, as the intervals between visits
 * rather than as fixed dates: after the 36-month visit the cadence is yearly.
 * Used only to suggest an interval for a young child; the row stores one
 * `interval_months` like every other appointment, so a household that wants the
 * real tapering schedule edits the number as the child grows.
 */
export const WELL_CHILD_VISIT_AGES_MONTHS = [2, 4, 6, 9, 12, 15, 18, 24, 30, 36];

/** Who the reminder EMAIL reaches. Not an access control — `visibility` is. */
export const REMIND_SCOPES = [
  { value: "household", label: "Everyone with an email" },
  { value: "private",   label: "Only the person it's for" },
];

/** Who can SEE the row. `private` is scoped to whoever created it, because
 *  that is the column the row policy owns (`created_by`); see manifest.json. */
export const VISIBILITIES = [
  { value: "household", label: "Everyone in the household" },
  { value: "private",   label: "Only me" },
];

/** Days before a due date that the "time to book" nudge fires when nothing else
 *  is chosen. A month is roughly how far out a routine appointment books. */
export const DEFAULT_LEAD_DAYS = 30;

export const LEAD_CHOICES = [7, 14, 30, 60, 90];

const KIND_BY_VALUE = new Map(KINDS.map((k) => [k.value, k]));

export function kindMeta(v) {
  return KIND_BY_VALUE.get(v) ?? KIND_BY_VALUE.get("other");
}

/**
 * The cadence to offer for a kind, given the person's age in years when known.
 *
 * Two age-dependent cases, both conservative and both editable:
 *  - well-child visits are far more frequent under three (see
 *    WELL_CHILD_VISIT_AGES_MONTHS — the gaps average about three months);
 *  - an adult with no correction is commonly told two years between eye exams,
 *    while a child's is yearly.
 *
 * Everything else is the kind's own default. `ageYears` may be null, in which
 * case the kind default is used unchanged — guessing an age would be worse than
 * offering nothing.
 *
 * **The app passes null today, and that is not an oversight.** `family.members`
 * projects `id`, `name`, `role`, `isAdmin`, `hasEmail` and `hasLogin` and
 * nothing else — `toFamilyContextMember` in the hub's `family-context.ts`
 * strips the birthdate before any app sees it, deliberately, since `min_age` is
 * the only rule allowed to read it. So there is no age source on the client,
 * and an app-side helper that reached for `member.birthday` would silently read
 * `undefined` and quietly stop tightening anything. The age arm stays here
 * because it is the correct rule and is unit-tested; the UI surfaces the
 * well-child schedule as copy instead, which is honest about what it knows.
 */
export function suggestedIntervalMonths(kind, ageYears = null) {
  const base = kindMeta(kind).months;
  if (ageYears == null || !Number.isFinite(ageYears)) return base;
  if (kind === "wellchild") return ageYears < 3 ? 3 : 12;
  if (kind === "vision") return ageYears >= 18 ? 24 : 12;
  return base;
}

/**
 * A stored `interval_months` narrowed to a positive integer, or null.
 *
 * Every read of that column goes through this. SQLite column affinity is not
 * type enforcement and the encryption codec round-trips whatever was written,
 * so an `INTEGER` column can hold attacker-chosen text: any member can POST
 * `UPDATE … SET interval_months = '"><script>…'` to `/api/db` against a row
 * they can write. The editor renders the value into `<option value="…">`
 * markup, which makes an unnarrowed read a stored-XSS vector.
 */
export function normalizeIntervalMonths(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const months = Math.trunc(n);
  return months > 0 && months <= 1200 ? months : null;
}

/* ── Dates ──────────────────────────────────────────────────────────────────
 * "yyyy-mm-dd" in, "yyyy-mm-dd" out. Dates are parsed from PARTS, never with
 * `new Date("2026-08-30")` — that string parses as UTC midnight and formats as
 * the previous day for every household west of Greenwich.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar date in `yyyy-mm-dd`, or null.
 *
 * Shape alone is not enough. JavaScript NORMALIZES an impossible date rather
 * than rejecting it — `new Date(2026, 1, 31)` is March 3 — so a shape-only
 * check would let "2026-02-31" render as "Feb 31" in the app, behave as March 3
 * in every calculation here, and be refused outright by the hub's own reminder
 * parser: three different answers for one row, none of them flagged.
 *
 * It is reachable. `automation_actions.add_appointment` declares
 * `next_due_date` as a `text` param and the automation schema has no pattern
 * constraint, so any rule author can write any string into the column. The
 * round-trip below is what makes that a visibly empty date instead of a silent
 * three-way disagreement.
 */
function partsOf(iso) {
  const m = ISO_DATE.exec(String(iso ?? ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // A date that does not survive being rebuilt from its own parts never
  // existed: the constructor rolls Feb 31 into March and the day no longer
  // matches. Two-digit years are rejected by the same test (new Date(26, …)
  // means 1926), which is correct — there are no appointments in year 0026.
  const probe = new Date(y, mo - 1, d, 12);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return { y, m: mo, d };
}

/** True for a real calendar date in `yyyy-mm-dd`. See partsOf: this rejects
 *  "2026-02-31", not just "not-a-date". */
export function isIsoDate(v) {
  return partsOf(v) !== null;
}

/** Noon keeps a DST shift from tipping a date into an adjacent day. */
function dateOf(iso) {
  const p = partsOf(iso);
  if (!p) return null;
  const d = new Date(p.y, p.m - 1, p.d, 12);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isoOf(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function atNoon(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
}

/** Whole days from `from` until an ISO date (negative = overdue). Null if unset. */
export function daysUntil(iso, from = new Date()) {
  const d = dateOf(iso);
  if (!d) return null;
  return Math.round((atNoon(d) - atNoon(from)) / 86400000);
}

/**
 * `iso` advanced by `n` calendar months.
 *
 * Overflow NORMALIZES rather than clamping — Jan 31 + 1 month is Mar 3, not
 * Feb 28 — because that is exactly what SQLite's `date(x, '+n months')` does,
 * and the roll-forward has to agree with anything that ever recomputes it in
 * SQL. `new Date(y, m + n, d)` already carries the overflow into the next
 * month, so this is one implementation rather than two that drift. The user can
 * edit the date afterwards; a silent disagreement between two engines they
 * cannot see is the worse failure.
 */
export function addMonths(iso, n) {
  const p = partsOf(iso);
  const months = Math.trunc(Number(n));
  if (!p || !Number.isFinite(months)) return "";
  return isoOf(new Date(p.y, p.m - 1 + months, p.d, 12));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-14" → "Mar 14". Parsed as a plain calendar date, never a UTC instant. */
export function shortDate(iso) {
  const p = partsOf(iso);
  if (!p || p.m < 1 || p.m > 12) return String(iso ?? "");
  return `${MONTHS[p.m - 1]} ${p.d}`;
}

/** "2026-03-14" → "Mar 14, 2026", for a date far enough out that the year matters. */
export function longDate(iso) {
  const p = partsOf(iso);
  if (!p || p.m < 1 || p.m > 12) return String(iso ?? "");
  return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/** "14:30" → "2:30 PM". A floating household-local wall time, never converted. */
export function formatTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
  if (!m) return "";
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return "";
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** "Due today" / "Due in 12 days" / "3 days overdue" / "—". */
export function dueLabel(days) {
  if (days == null) return "—";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 31) return `Due in ${days} days`;
  if (days < 365) return `Due in ${Math.round(days / 30)} months`;
  return `Due in ${Math.max(1, Math.round(days / 365))} year${days < 550 ? "" : "s"}`;
}

/* ── Lead times ─────────────────────────────────────────────────────────────
 * One lead time drives both delivery channels: the calendar entry an automation
 * rule creates from `appointment.due_soon`, and the hub's date_reminders email.
 * Keeping the arithmetic here keeps them identical.
 */

/**
 * The largest lead time a cadence can carry.
 *
 * The hub suppresses a reminder whose `last_reminded_at` stamp falls inside the
 * current occurrence's window, which opens `lead_days + 1` days before the
 * date. If that window is wider than the gap between two occurrences, the stamp
 * from the previous cycle always lands inside the next one's window and the
 * appointment goes permanently silent after its first nudge. So a recurring row
 * caps its lead at less than one interval, counting a month as its shortest
 * (28 days) and leaving a day of timezone slop: monthly therapy caps at 26,
 * six-monthly dental at 166.
 *
 * A one-off has no next occurrence to collide with, so it caps only at a year.
 *
 * The app also clears the stamp whenever the due date moves, which fixes the
 * same hazard from the other side; this cap is what holds if a row is edited by
 * hand or reaches its next cycle some other way.
 */
export function maxLeadDays(intervalMonths) {
  const n = Math.trunc(Number(intervalMonths));
  if (!Number.isFinite(n) || n <= 0) return 365;
  return Math.max(1, Math.min(365, n * 28 - 2));
}

/** A lead time coerced into range for its cadence. Invalid input falls back to
 *  the default (itself clamped), never to zero — zero would silently turn
 *  "tell me in time to book" into "tell me the morning it is due". */
export function clampLeadDays(days, intervalMonths) {
  const max = maxLeadDays(intervalMonths);
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n < 1) return Math.min(DEFAULT_LEAD_DAYS, max);
  return Math.min(n, max);
}

/**
 * The lead choices offered for a cadence — those it can honor, plus the
 * cadence's own cap when no listed choice reaches it, plus `current` when the
 * row already carries a value the standard list does not contain.
 *
 * That last clause is not cosmetic. The picker doubles as the on/off switch,
 * with "No reminder" first, so an option list that fails to contain the current
 * value leaves NOTHING selected and the browser falls back to the first
 * option — turning "30 days before" into "No reminder" the moment the cadence
 * changes. It bites exactly the values that reach a row through a cap.
 */
export function leadChoicesFor(intervalMonths, current) {
  const max = maxLeadDays(intervalMonths);
  const usable = LEAD_CHOICES.filter((d) => d <= max);
  if (!usable.includes(max)) usable.push(max);
  const cur = Math.trunc(Number(current));
  if (Number.isFinite(cur) && cur >= 1 && cur <= max && !usable.includes(cur)) usable.push(cur);
  return usable.sort((a, b) => a - b);
}

/**
 * The day the "time to book" nudge is for: `lead_days` before the due date, but
 * never in the past. An appointment entered three days before it comes due
 * still deserves its entry — dated today, where it will be seen — rather than
 * one dated last month that no calendar will surface.
 *
 * Returns null when there is no usable due date, or when the due date itself
 * has already passed. That mirrors the hub: a past one-shot date never
 * reminds, so an un-rolled overdue appointment falls silent by email and the
 * badge, not the inbox, is what carries "overdue".
 */
export function remindOnDate(nextDueIso, leadDays, intervalMonths, from = new Date()) {
  const due = dateOf(nextDueIso);
  if (!due) return null;
  const today = atNoon(from);
  if (atNoon(due) < today) return null;
  const lead = clampLeadDays(leadDays, intervalMonths);
  const remindOn = new Date(due.getFullYear(), due.getMonth(), due.getDate() - lead, 12);
  return remindOn < today ? isoOf(today) : isoOf(remindOn);
}

/* ── Roll-forward ───────────────────────────────────────────────────────────── */

/**
 * The due date an appointment lands on after a visit on `visitDateIso`.
 *
 * Measured from the VISIT, not from the date that was due: a dental cleaning
 * attended two months late is next due six months after it happened, not six
 * months after the day it was missed. A one-off (no `interval_months`) has no
 * next date and returns "" — the row stays for its history and stops nudging.
 */
export function rollForwardDate(appt, visitDateIso) {
  const months = Math.trunc(Number(appt?.interval_months));
  if (!Number.isFinite(months) || months <= 0) return "";
  return addMonths(visitDateIso, months);
}

/* ── Nudge state ────────────────────────────────────────────────────────────── */

/**
 * Whether this row may be ANNOUNCED to other apps at all.
 *
 * A `private` row may not be, and this is a confidentiality boundary rather
 * than a preference. The only consumer today is the calendar's `create_event`
 * action, which does not set a visibility and therefore lands on the calendar's
 * column DEFAULT of `'everyone'` — inside the calendar's own
 * `everyone_values: ["everyone"]`, so household-wide. Publishing a private
 * referral would put its title, the person's name, the provider and the phone
 * number (see eventSummary) in front of the household, defeating the row policy
 * that hid the row itself.
 *
 * Nothing in the payload can fix that: even a fully redacted entry would still
 * tell the household that this person has an appointment on that day. So the
 * announcement is suppressed entirely, which fails closed. A private row still
 * gets its EMAIL — date_reminders reads `remind_scope`, a separate column, and
 * mails only the person it is for.
 *
 * Widening this needs a `visibility` param on calendar's `create_event`, which
 * is a protocol change to another app and a conversation, not an edit here.
 */
export function isAnnounceable(appt) {
  return appt?.visibility === "household";
}

/**
 * Whether an appointment should announce an upcoming booking at all.
 * Archived rows have no cadence to keep, un-nudged rows opted out, a row with
 * no due date has nothing to say, a row already booked has had its answer, and
 * a private row is never announced (see isAnnounceable).
 */
export function wantsBookingNudge(appt) {
  return !!appt
    && appt.status === "active"
    && isAnnounceable(appt)
    && Number(appt.remind) !== 0
    && isIsoDate(appt.next_due_date)
    && !isIsoDate(appt.scheduled_date);
}

/** Whether the BOOKED slot itself may be announced — the second, independent
 *  calendar entry. Same visibility rule, for the same reason. */
export function announcesBooking(appt) {
  return !!appt
    && appt.status === "active"
    && isAnnounceable(appt)
    && isIsoDate(appt.scheduled_date);
}

/**
 * Why an edit stopped an appointment from wanting a nudge, or null if it still
 * wants one (or never did). Drives `appointment.cancelled`, which lets a rule
 * take the calendar entry back down.
 *
 * The TRANSITION is what matters, not the end state: a row that never announced
 * anything has nothing to retract, and publishing for one would spend an
 * automation run per save to update zero rows.
 *
 * `booked` is checked before the reminder toggle and before archiving because
 * it is the answer the household actually gave — booking the slot is what makes
 * the "time to book" entry obsolete.
 */
export function nudgeRetractionReason(prev, next) {
  if (!prev || !wantsBookingNudge(prev) || wantsBookingNudge(next)) return null;
  // Checked first, and it is the one reason that is a confidentiality fix
  // rather than housekeeping: a row turned private has an entry standing on the
  // household calendar right now, and taking it down is the point of the save.
  if (!isAnnounceable(next)) return "private";
  if (isIsoDate(next?.scheduled_date)) return "booked";
  if (next?.status !== "active") return "archived";
  if (Number(next?.remind) === 0) return "reminder_off";
  return "cancelled";
}

/** Whether an edit changed anything the booking nudge is SCHEDULED from.
 *  Re-announcing on every save would spend an automation run fixing a typo in
 *  the notes. `title` is deliberately absent: it reaches the event as cosmetic
 *  text, and renaming a row would otherwise publish for a cycle that already
 *  has its entry. The rename shows up on the next cycle. */
export function nudgeInputsChanged(prev, next) {
  if (!prev) return true;
  return ["next_due_date", "lead_days", "remind", "interval_months", "status", "scheduled_date", "visibility"]
    .some((k) => String(prev[k] ?? "") !== String(next[k] ?? ""));
}

/** Whether the BOOKED slot moved — the trigger for `appointment.booked`. */
export function bookingChanged(prev, next) {
  if (!next) return false;
  if (!isIsoDate(next.scheduled_date)) return false;
  if (!prev) return true;
  return String(prev.scheduled_date ?? "") !== String(next.scheduled_date ?? "")
    || String(prev.scheduled_time ?? "") !== String(next.scheduled_time ?? "");
}

/* ── Event copy ─────────────────────────────────────────────────────────────── */

/** "Book: Dentist — Sam". Reads as the action the calendar day is asking for. */
export function reviewTitle(appt, personName) {
  return personName ? `Book: ${appt.title} — ${personName}` : `Book: ${appt.title}`;
}

/** "Dentist — Sam, Mar 14 at 2:30 PM". The booked entry's own heading. */
export function bookingTitle(appt, personName) {
  const who = personName ? ` — ${personName}` : "";
  return `${appt.title}${who}`;
}

/** Second line of a calendar entry: who it is with, and when. */
export function eventSummary(appt) {
  const bits = [];
  if (appt.provider_name) bits.push(appt.provider_name);
  if (isIsoDate(appt.scheduled_date)) {
    const t = formatTime(appt.scheduled_time);
    bits.push(t ? `${longDate(appt.scheduled_date)} at ${t}` : longDate(appt.scheduled_date));
  } else if (isIsoDate(appt.next_due_date)) {
    bits.push(`due ${longDate(appt.next_due_date)}`);
  }
  if (appt.provider_phone) bits.push(appt.provider_phone);
  return bits.join(" · ");
}

/* ── Derived views ──────────────────────────────────────────────────────────── */

/**
 * Whether a row counts toward the "to book" badge.
 *
 * Mirrors the glance query in manifest.json exactly — active, reminding, not
 * already booked, and inside its own lead window. Two copies of one rule is a
 * risk, so any change here belongs in both places; the manifest one is what the
 * homepage badge shows and this one is what the app's own header shows, and a
 * household seeing two different numbers for the same question is the defect.
 */
export function needsBooking(appt, from = new Date()) {
  if (appt?.status !== "active") return false;
  if (Number(appt.remind) === 0) return false;
  if (isIsoDate(appt.scheduled_date)) return false;
  const days = daysUntil(appt.next_due_date, from);
  if (days == null) return false;
  return days <= clampLeadDays(appt.lead_days, appt.interval_months);
}

/** Soonest first, with anything undated last; booked rows keep their due order
 *  so "what is coming" reads in one pass. Ties break on id so the list does not
 *  reshuffle between loads. */
export function sortedAppointments(list, from = new Date()) {
  return [...list]
    .map((a) => ({ ...a, _days: daysUntil(a.next_due_date, from) }))
    .sort((a, b) => {
      const da = a._days ?? Infinity;
      const db = b._days ?? Infinity;
      return da - db || String(a.id).localeCompare(String(b.id));
    });
}

/**
 * The newest visit per appointment, from the recent tail the preload carries.
 *
 * Done here rather than in SQL on purpose: a `MAX(visit_date) … GROUP BY` fed
 * through a derived table is rejected by the hub's row-policy rewriter, which
 * fails closed on a governed table reachable only from inside a subquery. So
 * the app reads a bounded, ordered tail and folds it — one statement, one
 * index, no policy hole.
 *
 * Ties on the same day break on the row id, so a day with two logged visits
 * resolves deterministically rather than by arrival order.
 */
export function lastVisitByAppointment(visits) {
  const out = new Map();
  for (const v of visits ?? []) {
    const cur = out.get(v.appointment_id);
    if (!cur) { out.set(v.appointment_id, v); continue; }
    const newer = String(v.visit_date) > String(cur.visit_date)
      || (v.visit_date === cur.visit_date && String(v.id) > String(cur.id));
    if (newer) out.set(v.appointment_id, v);
  }
  return out;
}

/**
 * Whether this member may manage appointments.
 *
 * Mirrors the server exactly: `column_write_acls` pins every content column on
 * both tables to `writable_by: ["adult"]`, and `delete_adult_only` covers
 * DELETE. A gate any looser here shows buttons the hub answers with a 403.
 */
export function canManage(me) {
  return isAdult(me);
}

/**
 * Whether this member can SEE a row — the client mirror of the
 * `owner_or_visibility` policy on `created_by`.
 *
 * The server already filters, so this is not the boundary; it exists so demo
 * mode and optimistic local state show the same list the next reload will.
 */
export function canSeeAppointment(appt, me) {
  if (!appt) return false;
  if (appt.visibility === "household") return true;
  return !!me && appt.created_by === me.id;
}

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * The provider and the notes count as well as the title — "who did we see for
 * the eye thing" is a provider question, and the reason lives in the notes.
 */
export function searchableFields(item) {
  return [item.title, kindMeta(item.kind).label, item.provider_name, item.notes];
}
