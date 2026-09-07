import { describe, it, expect } from "vitest";
import {
  KINDS, LEAD_CHOICES, DEFAULT_LEAD_DAYS,
  kindMeta, suggestedIntervalMonths, isIsoDate, daysUntil, addMonths, shortDate, longDate,
  formatTime, dueLabel, maxLeadDays, clampLeadDays, leadChoicesFor, remindOnDate,
  normalizeIntervalMonths, rollForwardDate, wantsBookingNudge, announcesBooking, isAnnounceable, nudgeRetractionReason, nudgeInputsChanged, bookingChanged,
  reviewTitle, bookingTitle, eventSummary, needsBooking, sortedAppointments,
  lastVisitByAppointment, canManage, canSeeAppointment, searchableFields,
} from "../src/logic.js";

/** The household's "today" as these helpers expect it: a local noon Date. */
const day = (iso) => new Date(`${iso}T12:00:00`);
const TODAY = day("2026-09-06");

const appt = (over = {}) => ({
  id: "a1", person_id: "m-kid", kind: "dental", title: "Dentist",
  provider_name: "Bright Smiles", provider_phone: "", provider_url: "",
  interval_months: 6, next_due_date: "2026-10-01", scheduled_date: "", scheduled_time: "",
  lead_days: 30, remind: 1, remind_scope: "household", visibility: "household",
  status: "active", notes: "", created_by: "m-parent", ...over,
});

describe("vocabulary", () => {
  it("falls back to 'other' for an unknown kind rather than throwing", () => {
    expect(kindMeta("not-a-kind").value).toBe("other");
    expect(kindMeta("dental").months).toBe(6);
  });

  it("every kind carries a positive cadence", () => {
    for (const k of KINDS) expect(k.months, k.value).toBeGreaterThan(0);
  });
});

describe("suggestedIntervalMonths", () => {
  it("suggests the kind's own cadence when the roster has no birthday", () => {
    expect(suggestedIntervalMonths("dental", null)).toBe(6);
    expect(suggestedIntervalMonths("physical", null)).toBe(12);
  });

  it("tightens well-child visits under three and relaxes them after", () => {
    expect(suggestedIntervalMonths("wellchild", 1)).toBe(3);
    expect(suggestedIntervalMonths("wellchild", 5)).toBe(12);
  });

  it("offers adults two years between eye exams, children one", () => {
    expect(suggestedIntervalMonths("vision", 40)).toBe(24);
    expect(suggestedIntervalMonths("vision", 9)).toBe(12);
  });
});

describe("normalizeIntervalMonths", () => {
  it("narrows a stored cadence to a positive integer, or null", () => {
    expect(normalizeIntervalMonths(6)).toBe(6);
    expect(normalizeIntervalMonths("12")).toBe(12);
    expect(normalizeIntervalMonths(6.9)).toBe(6);
    expect(normalizeIntervalMonths(null)).toBeNull();
    expect(normalizeIntervalMonths(undefined)).toBeNull();
    expect(normalizeIntervalMonths("")).toBeNull();
    expect(normalizeIntervalMonths(0)).toBeNull();
    expect(normalizeIntervalMonths(-6)).toBeNull();
    expect(normalizeIntervalMonths(99999)).toBeNull();
  });

  it("refuses markup a member could store in the INTEGER column", () => {
    // SQLite affinity is not type enforcement and the codec round-trips
    // whatever was written, so any member can POST
    // `UPDATE ... SET interval_months = '"><script>...'` to /api/db against a
    // row they may write. The editor renders this value into <option> markup.
    expect(normalizeIntervalMonths('"><script>alert(1)</script>')).toBeNull();
    expect(normalizeIntervalMonths("6 onmouseover=alert(1)")).toBeNull();
    expect(normalizeIntervalMonths({})).toBeNull();
  });
});

describe("dates", () => {
  it("parses a date from parts, so it cannot slide west of Greenwich", () => {
    // `new Date("2026-08-30")` is UTC midnight and formats as Aug 29 in the
    // Americas. These helpers must never do that.
    expect(shortDate("2026-08-30")).toBe("Aug 30");
    expect(longDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("returns the input unchanged for a non-date", () => {
    expect(shortDate("")).toBe("");
    expect(shortDate("later")).toBe("later");
    expect(isIsoDate("2026-9-6")).toBe(false);
  });

  it("rejects a date that only LOOKS like one", () => {
    // Shape alone is not validity, and the gap is not academic: JavaScript
    // normalizes rather than rejecting, so "2026-02-31" would render as
    // "Feb 31" here, behave as March 3 in every calculation, and be refused by
    // the hub's reminder parser — three answers for one row, none flagged.
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-13-40")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
    expect(isIsoDate("2027-02-29")).toBe(false);
    // ...while the real ones, leap day included, still pass.
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-12-31")).toBe(true);
  });

  it("refuses to compute on an impossible date rather than normalizing it", () => {
    expect(daysUntil("2026-02-31", TODAY)).toBeNull();
    expect(addMonths("2026-02-31", 6)).toBe("");
    // It renders as the raw string, which is honest — "Feb 31" would not be.
    expect(shortDate("2026-02-31")).toBe("2026-02-31");
  });

  it("reaches the app through the automation, which is why it is checked here", () => {
    // add_appointment declares next_due_date as a `text` param and the
    // automation schema carries no pattern constraint, so any rule author can
    // write any string into that column.
    const junk = appt({ next_due_date: "2026-02-31" });
    expect(wantsBookingNudge(junk)).toBe(false);
    expect(needsBooking(junk, TODAY)).toBe(false);
    expect(remindOnDate(junk.next_due_date, 30, 6, TODAY)).toBeNull();
  });

  it("counts whole days to a date, negative when overdue", () => {
    expect(daysUntil("2026-09-06", TODAY)).toBe(0);
    expect(daysUntil("2026-09-07", TODAY)).toBe(1);
    expect(daysUntil("2026-09-01", TODAY)).toBe(-5);
    expect(daysUntil("", TODAY)).toBeNull();
  });

  it("adds months the way SQLite's date(x, '+n months') does — overflow, not clamp", () => {
    // Jan 31 + 1 month is Mar 3, not Feb 28. Matching SQLite exactly is the
    // point: anything that ever recomputes this in SQL must agree.
    expect(addMonths("2026-01-31", 1)).toBe("2026-03-03");
    expect(addMonths("2026-03-14", 6)).toBe("2026-09-14");
    expect(addMonths("2026-12-01", 12)).toBe("2027-12-01");
    expect(addMonths("2026-03-14", -1)).toBe("2026-02-14");
    expect(addMonths("", 6)).toBe("");
  });

  it("renders a floating wall time without converting it", () => {
    expect(formatTime("10:30")).toBe("10:30 AM");
    expect(formatTime("00:05")).toBe("12:05 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatTime("14:30")).toBe("2:30 PM");
    expect(formatTime("")).toBe("");
    expect(formatTime("25:00")).toBe("");
  });

  it("labels a countdown in words", () => {
    expect(dueLabel(null)).toBe("—");
    expect(dueLabel(0)).toBe("Due today");
    expect(dueLabel(1)).toBe("Due tomorrow");
    expect(dueLabel(-1)).toBe("1 day overdue");
    expect(dueLabel(-3)).toBe("3 days overdue");
    expect(dueLabel(12)).toBe("Due in 12 days");
    expect(dueLabel(90)).toBe("Due in 3 months");
    expect(dueLabel(400)).toBe("Due in 1 year");
  });
});

describe("lead times", () => {
  it("caps a recurring lead below one interval so the row cannot go silent", () => {
    // The hub suppresses a row whose last_reminded_at falls inside the current
    // occurrence's `lead_days + 1` window. A window wider than the gap between
    // occurrences swallows every later one — the row nudges exactly once, ever.
    expect(maxLeadDays(1)).toBe(26);
    expect(maxLeadDays(6)).toBe(166);
    expect(maxLeadDays(12)).toBe(334);
    for (const months of [1, 2, 3, 6, 12]) {
      expect(maxLeadDays(months), `${months} months`).toBeLessThan(months * 28);
    }
  });

  it("gives a one-off a year, since it has no next occurrence to collide with", () => {
    expect(maxLeadDays(null)).toBe(365);
    expect(maxLeadDays(0)).toBe(365);
  });

  it("never clamps a lead time to zero", () => {
    // Zero would silently turn "tell me in time to book" into "tell me the
    // morning it is due".
    expect(clampLeadDays(0, 6)).toBe(DEFAULT_LEAD_DAYS);
    expect(clampLeadDays(-5, 6)).toBe(DEFAULT_LEAD_DAYS);
    expect(clampLeadDays("nonsense", 6)).toBe(DEFAULT_LEAD_DAYS);
    expect(clampLeadDays(90, 1)).toBe(26);
    expect(clampLeadDays(14, 6)).toBe(14);
  });

  it("the default lead survives the shortest cadence the app offers", () => {
    const shortest = Math.min(...KINDS.map((k) => maxLeadDays(k.months)));
    expect(clampLeadDays(DEFAULT_LEAD_DAYS, 1)).toBeLessThanOrEqual(shortest);
  });

  it("always offers the current value, so changing the cadence cannot silently mean 'off'", () => {
    // The picker doubles as the on/off switch with "No reminder" first, so a
    // list missing the current value selects NOTHING and the browser falls back
    // to the first option.
    expect(leadChoicesFor(1, 26)).toContain(26);
    expect(leadChoicesFor(6, 45)).toContain(45);
    expect(leadChoicesFor(12)).toEqual(expect.arrayContaining(LEAD_CHOICES));
    for (const d of leadChoicesFor(1)) expect(d).toBeLessThanOrEqual(maxLeadDays(1));
    expect(leadChoicesFor(1)).toContain(26); // the cap itself, which no listed choice reaches
  });
});

describe("remindOnDate", () => {
  it("is the due date minus the lead time", () => {
    expect(remindOnDate("2026-12-01", 30, 6, TODAY)).toBe("2026-11-01");
  });

  it("never dates a nudge in the past — it moves to today instead", () => {
    // An appointment entered a week before it comes due still deserves its
    // entry, dated where it will be seen.
    expect(remindOnDate("2026-09-10", 30, 6, TODAY)).toBe("2026-09-06");
    // Exactly on the boundary: due − lead is yesterday, so it floors to today.
    expect(remindOnDate("2026-10-01", 30, 6, TODAY)).toBe("2026-09-06");
  });

  it("says nothing at all once the due date itself has passed", () => {
    // Mirrors the hub: a past one-shot date never reminds, so an un-rolled
    // overdue appointment falls silent by email. The badge carries "overdue".
    expect(remindOnDate("2026-09-05", 30, 6, TODAY)).toBeNull();
    expect(remindOnDate("", 30, 6, TODAY)).toBeNull();
  });

  it("clamps the lead before subtracting it", () => {
    expect(remindOnDate("2026-10-01", 90, 1, TODAY)).toBe("2026-09-06"); // 26-day cap → 2026-09-05, floored to today
    expect(remindOnDate("2026-12-01", 90, 1, TODAY)).toBe("2026-11-05");
  });
});

describe("rollForwardDate", () => {
  it("measures from the visit, not from the date that was due", () => {
    // A cleaning attended two months late is next due six months after it
    // happened, not six months after the day it was missed.
    expect(rollForwardDate(appt({ interval_months: 6, next_due_date: "2026-07-01" }), "2026-09-06"))
      .toBe("2027-03-06");
  });

  it("leaves a one-off with no next date", () => {
    expect(rollForwardDate(appt({ interval_months: null }), "2026-09-06")).toBe("");
    expect(rollForwardDate(appt({ interval_months: 0 }), "2026-09-06")).toBe("");
  });
});

describe("a private row is never announced", () => {
  // The calendar's create_event sets no visibility, so the entry it makes lands
  // on calendar's own DEFAULT of 'everyone' — household-wide. Announcing a
  // private row would publish its title, person, provider and phone to everyone
  // and defeat the row policy that hid the row itself.
  const priv = (over = {}) => appt({ visibility: "private", ...over });

  it("suppresses both announcements outright", () => {
    expect(isAnnounceable(appt())).toBe(true);
    expect(isAnnounceable(priv())).toBe(false);
    expect(wantsBookingNudge(priv())).toBe(false);
    expect(announcesBooking(priv({ scheduled_date: "2026-09-20" }))).toBe(false);
    expect(announcesBooking(appt({ scheduled_date: "2026-09-20" }))).toBe(true);
  });

  it("retracts an entry that is already standing when a row turns private", () => {
    // The dangerous transition: the entry is on the household calendar RIGHT
    // NOW, and the save that hides the row has to take it down too.
    expect(nudgeRetractionReason(appt(), priv())).toBe("private");
    expect(nudgeRetractionReason(appt({ scheduled_date: "2026-09-20" }), priv({ scheduled_date: "2026-09-20" })))
      .toBe(null); // the booking half already had no nudge to retract...
    expect(announcesBooking(appt({ scheduled_date: "2026-09-20" }))).toBe(true);
    expect(announcesBooking(priv({ scheduled_date: "2026-09-20" }))).toBe(false);
  });

  it("announces afresh when a row is opened back up", () => {
    // Visibility is a nudge INPUT, or a private→household flip with unchanged
    // dates would never re-announce and the entry would stay missing for good.
    expect(nudgeInputsChanged(priv(), appt())).toBe(true);
  });

  it("still gets its email — that lane is a different column", () => {
    // date_reminders reads remind_scope, not visibility, so a private row is
    // silent to other APPS while still reaching its own person by mail.
    expect(priv({ remind_scope: "private" }).remind_scope).toBe("private");
    expect(isAnnounceable(priv({ remind_scope: "household" }))).toBe(false);
  });
});

describe("nudge state", () => {
  it("wants a nudge only for an active, reminding, dated, unbooked row", () => {
    expect(wantsBookingNudge(appt())).toBe(true);
    expect(wantsBookingNudge(appt({ status: "archived" }))).toBe(false);
    expect(wantsBookingNudge(appt({ remind: 0 }))).toBe(false);
    expect(wantsBookingNudge(appt({ next_due_date: "" }))).toBe(false);
    // Already booked: the household answered the question the nudge was asking.
    expect(wantsBookingNudge(appt({ scheduled_date: "2026-09-20" }))).toBe(false);
  });

  it("retracts only on a real transition out of announcing", () => {
    // A row that never announced anything has nothing to retract, and
    // publishing for one would spend an automation run to update zero rows.
    expect(nudgeRetractionReason(appt({ remind: 0 }), appt({ remind: 0 }))).toBeNull();
    expect(nudgeRetractionReason(appt(), appt())).toBeNull();
    expect(nudgeRetractionReason(null, appt())).toBeNull();
  });

  it("names booking as the reason before archiving or the toggle", () => {
    // Booking the slot is the answer the household actually gave; the other two
    // are housekeeping that may ride along in the same save.
    expect(nudgeRetractionReason(appt(), appt({ scheduled_date: "2026-09-20", status: "archived", remind: 0 })))
      .toBe("booked");
    expect(nudgeRetractionReason(appt(), appt({ status: "archived", remind: 0 }))).toBe("archived");
    expect(nudgeRetractionReason(appt(), appt({ remind: 0 }))).toBe("reminder_off");
    expect(nudgeRetractionReason(appt(), appt({ next_due_date: "" }))).toBe("cancelled");
  });

  it("does not re-announce for an edit that cannot move the nudge", () => {
    // Renaming a row to fix a typo would otherwise publish a second event for a
    // cycle that already has its calendar entry.
    expect(nudgeInputsChanged(appt(), appt({ title: "Dentist (Dr. Ruiz)", notes: "bring the card" }))).toBe(false);
    expect(nudgeInputsChanged(appt(), appt({ next_due_date: "2026-11-01" }))).toBe(true);
    expect(nudgeInputsChanged(appt(), appt({ lead_days: 14 }))).toBe(true);
    expect(nudgeInputsChanged(null, appt())).toBe(true);
  });

  it("announces a booking when the slot appears or moves, not on every save", () => {
    expect(bookingChanged(appt(), appt({ scheduled_date: "2026-09-20" }))).toBe(true);
    expect(bookingChanged(appt({ scheduled_date: "2026-09-20" }), appt({ scheduled_date: "2026-09-21" }))).toBe(true);
    expect(bookingChanged(
      appt({ scheduled_date: "2026-09-20", scheduled_time: "10:30" }),
      appt({ scheduled_date: "2026-09-20", scheduled_time: "14:00" }),
    )).toBe(true);
    expect(bookingChanged(appt({ scheduled_date: "2026-09-20" }), appt({ scheduled_date: "2026-09-20", notes: "x" }))).toBe(false);
    expect(bookingChanged(appt(), appt())).toBe(false);
  });
});

describe("event copy", () => {
  it("reads as the action the calendar day is asking for", () => {
    expect(reviewTitle(appt(), "Sam")).toBe("Book: Dentist — Sam");
    expect(reviewTitle(appt(), "")).toBe("Book: Dentist");
    expect(bookingTitle(appt(), "Sam")).toBe("Dentist — Sam");
  });

  it("summarises the booked slot when there is one, the due date otherwise", () => {
    expect(eventSummary(appt({ scheduled_date: "2026-09-20", scheduled_time: "10:30" })))
      .toBe("Bright Smiles · Sep 20, 2026 at 10:30 AM");
    expect(eventSummary(appt())).toBe("Bright Smiles · due Oct 1, 2026");
    expect(eventSummary(appt({ provider_name: "", next_due_date: "" }))).toBe("");
  });
});

describe("needsBooking", () => {
  it("mirrors the glance badge exactly", () => {
    expect(needsBooking(appt({ next_due_date: "2026-09-20" }), TODAY)).toBe(true);  // 14 days out, 30-day lead
    expect(needsBooking(appt({ next_due_date: "2026-12-20" }), TODAY)).toBe(false); // outside the lead window
    expect(needsBooking(appt({ next_due_date: "2026-08-01" }), TODAY)).toBe(true);  // overdue still needs booking
    expect(needsBooking(appt({ next_due_date: "2026-09-20", scheduled_date: "2026-09-19" }), TODAY)).toBe(false);
    expect(needsBooking(appt({ next_due_date: "2026-09-20", remind: 0 }), TODAY)).toBe(false);
    expect(needsBooking(appt({ next_due_date: "2026-09-20", status: "archived" }), TODAY)).toBe(false);
    expect(needsBooking(appt({ next_due_date: "" }), TODAY)).toBe(false);
  });

  it("uses the row's clamped lead, not its raw one", () => {
    // A stored lead of 90 on a monthly cadence clamps to 26, so a row 40 days
    // out is NOT yet due to book — and the hub's own suppression window agrees.
    expect(needsBooking(appt({ interval_months: 1, lead_days: 90, next_due_date: "2026-10-16" }), TODAY)).toBe(false);
    expect(needsBooking(appt({ interval_months: 12, lead_days: 90, next_due_date: "2026-10-16" }), TODAY)).toBe(true);
  });
});

describe("sortedAppointments", () => {
  it("puts the soonest first and anything undated last", () => {
    const rows = [
      appt({ id: "c", next_due_date: "" }),
      appt({ id: "b", next_due_date: "2026-12-01" }),
      appt({ id: "a", next_due_date: "2026-09-10" }),
    ];
    expect(sortedAppointments(rows, TODAY).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties on id so the list cannot reshuffle between loads", () => {
    const rows = [appt({ id: "z" }), appt({ id: "a" })];
    expect(sortedAppointments(rows, TODAY).map((r) => r.id)).toEqual(["a", "z"]);
  });
});

describe("lastVisitByAppointment", () => {
  const v = (id, appointment_id, visit_date) => ({ id, appointment_id, visit_date });

  it("keeps the newest visit per appointment", () => {
    const map = lastVisitByAppointment([
      v("1", "a", "2026-01-10"), v("2", "a", "2026-07-04"), v("3", "b", "2025-11-02"),
    ]);
    expect(map.get("a").visit_date).toBe("2026-07-04");
    expect(map.get("b").visit_date).toBe("2025-11-02");
    expect(map.get("c")).toBeUndefined();
  });

  it("resolves two visits on one day deterministically, not by arrival order", () => {
    const forward = lastVisitByAppointment([v("1", "a", "2026-07-04"), v("2", "a", "2026-07-04")]);
    const reverse = lastVisitByAppointment([v("2", "a", "2026-07-04"), v("1", "a", "2026-07-04")]);
    expect(forward.get("a").id).toBe(reverse.get("a").id);
  });

  it("handles an empty or missing tail", () => {
    expect(lastVisitByAppointment([]).size).toBe(0);
    expect(lastVisitByAppointment(undefined).size).toBe(0);
  });
});

describe("client gates mirror the server", () => {
  it("offers management to adults only, with no creator exception", () => {
    // column_write_acls pins every content column to writable_by: ["adult"], so
    // a gate that let a child edit "their own" row would show buttons the hub
    // answers with a 403.
    expect(canManage({ id: "m1", role: "adult" })).toBe(true);
    expect(canManage({ id: "m1", role: "child" })).toBe(false);
    expect(canManage(null)).toBe(false);
  });

  it("shows a private row to its creator only", () => {
    const parent = { id: "m-parent", role: "adult" };
    const other = { id: "m-other", role: "adult" };
    const kid = { id: "m-kid", role: "child" };
    const priv = appt({ visibility: "private" });
    expect(canSeeAppointment(priv, parent)).toBe(true);
    // Adulthood is not a bypass here — that is the whole point of the lane.
    expect(canSeeAppointment(priv, other)).toBe(false);
    // Not even the person it is FOR: the policy owns `created_by`, not
    // `person_id`, because owner_or_visibility forces its owner column on
    // INSERT and person_id must stay free for a parent to set.
    expect(canSeeAppointment(priv, kid)).toBe(false);
    expect(canSeeAppointment(appt(), other)).toBe(true);
    expect(canSeeAppointment(appt(), kid)).toBe(true);
  });
});

describe("search", () => {
  it("finds a row by its provider and its notes, not just the title", () => {
    const fields = searchableFields(appt({ notes: "bring the insurance card" }));
    expect(fields).toContain("Bright Smiles");
    expect(fields).toContain("bring the insurance card");
    expect(fields).toContain("Dental cleaning");
  });
});
