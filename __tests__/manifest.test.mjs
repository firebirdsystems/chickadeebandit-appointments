import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import { KINDS, REMIND_SCOPES, VISIBILITIES, DEFAULT_LEAD_DAYS, maxLeadDays, clampLeadDays } from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const migration = readFileSync(join(__dirname, "../migrations/001_init.sql"), "utf-8");
const indexHtml = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

/** Mirrors the hub's `shouldSkipEncrypt`: a column is plaintext if it carries a
 *  skip suffix, is on the built-in list, or the app declared it. */
const BUILT_IN_PLAINTEXT = new Set([
  "id", "created_at", "updated_at", "status", "type", "category", "visibility",
  "audience", "key", "version", "source", "icon", "emoji",
]);
const isPlaintext = (col) =>
  BUILT_IN_PLAINTEXT.has(col)
  || /_(at|date|time|id|by)$/.test(col)
  || manifest.db_plaintext_columns.includes(col);

/** Integer columns are never encrypted whatever their name — the codec only
 *  encrypts string params. They are still DECLARED plaintext (see the manifest)
 *  because a form value arrives as a string: one `remind: "1"` reaching the
 *  codec would be stored as ciphertext and `remind = 1` would then match
 *  nothing, silencing that row's reminder forever with nothing to report it. */
const INTEGER_COLUMNS = new Set(["interval_months", "lead_days", "remind"]);

/** Columns of one CREATE TABLE in migrations/001_init.sql. */
function columnsOf(table) {
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migration);
  if (!body) throw new Error(`no CREATE TABLE for ${table}`);
  return body[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--") && !/^(FOREIGN KEY|PRIMARY KEY|CHECK|REFERENCES|CONSTRAINT|UNIQUE)/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter((c) => /^[a-z_]+$/.test(c));
}

const APPT_COLUMNS = columnsOf("app_appointments__appointments");
const VISIT_COLUMNS = columnsOf("app_appointments__visits");

describe("manifest.json", () => {
  it("has required string fields", () => {
    for (const field of ["id", "name", "version", "description", "entrypoint", "runtime", "icon"]) {
      expect(manifest[field], `missing field: ${field}`).toBeTruthy();
    }
  });
  it("entrypoint/runtime/storage are standard", () => {
    expect(manifest.entrypoint).toBe("index.html");
    expect(manifest.runtime).toBe("static");
    expect(manifest.storage).toBe("db");
  });
  it("version follows semver", () => expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/));
  it("has a nav label", () => expect(manifest.nav?.label).toBeTruthy());

  it("keeps health data out of shared spaces and off kiosks", () => {
    // A shared space (a classroom roster, a co-parenting space) is a different
    // household's people. There is no version of this app's data that belongs
    // there, and `contexts` is the single switch that decides it. `kiosk:
    // "never"` makes the app un-allowlistable on a shared wall screen by
    // construction rather than by an admin remembering.
    expect(manifest.contexts).toEqual(["household"]);
    expect(manifest.kiosk).toBe("never");
  });

  it("declares no AI access", () => {
    // Appointments, providers, and outcomes are health data. Apps are invisible
    // to MCP unless they opt in; this one does not, deliberately.
    expect(manifest.ai_access).toBeUndefined();
  });

  it("declares the capabilities the reminder protocol consumes", () => {
    expect(manifest.required_capabilities).toEqual(expect.arrayContaining(["cron", "email"]));
  });

  it("keeps each migration under the hub's 8,000-character ceiling", () => {
    // The hub refuses a migration file over 8,000 chars at publish, and this
    // one is comment-heavy by design. Comments are the cheapest thing to lose
    // and the last thing you notice losing, so the budget is asserted rather
    // than discovered on release day.
    expect(migration.length).toBeLessThanOrEqual(8000);
  });

  it("ends the migration on a statement, never on a comment", () => {
    // The runner splits on top-level `;`, so anything trailing the final one
    // becomes a comment-only "statement" D1 answers with "contains no
    // statements". A migration's version is recorded only after every statement
    // succeeds, so the retry fails identically forever and the app can never be
    // installed in that household.
    expect(migration.trimEnd().endsWith(";")).toBe(true);
  });
});

describe("row policies", () => {
  const appts = manifest.row_policies.appointments;
  const visits = manifest.row_policies.visits;

  it("owns rows by created_by, never by person_id", () => {
    // owner_or_visibility FORCES its owner column to the caller on INSERT
    // (app-db-policies/kinds/owner-or-visibility.ts). With person_id as the
    // owner column, a parent adding "Sam's dentist" would silently create it
    // for themselves — the single most important thing this app must not do.
    expect(appts.kind).toBe("owner_or_visibility");
    expect(appts.member_column).toBe("created_by");
    expect(appts.member_column).not.toBe("person_id");
    expect(APPT_COLUMNS).toContain("person_id");
  });

  it("scopes writes to what the caller can read, so a private row is unwritable too", () => {
    // Without this, ANY adult may UPDATE/DELETE any row — including one the
    // visibility rule hides from them. Confidentiality without it is read-only
    // theatre: adult B cannot see adult A's private row but could still blind
    // -write or wipe it.
    expect(appts.write_visibility_scoped).toBe(true);
    expect(appts.everyone_values).toEqual(["household"]);
    expect(appts.visibility_column).toBe("visibility");
  });

  it("does not claim a privileged group it has not configured", () => {
    // write_privileged_only / insert_privileged_only mean "members of a
    // configured hub group", NOT "adults", and with no group configured the hub
    // grants the bypass to nobody — the manifest would be rejected outright.
    expect(appts.write_privileged_only).toBeUndefined();
    expect(appts.insert_privileged_only).toBeUndefined();
    expect(appts.privileged_groups).toBeUndefined();
  });

  it("gates every content column on both tables to adults", () => {
    // This is what makes "adults manage, kids read" enforceable. The kind
    // itself cannot express it (owner_or_visibility lets any member insert
    // their own row), so each writable column carries an adult ACL and DELETE
    // carries delete_adult_only. A column added to the schema later without an
    // entry here is writable by a child — which is what this test is for.
    const structural = new Set(["id", "created_by", "created_at", "updated_at", "last_reminded_at", "source_event_id"]);
    for (const col of APPT_COLUMNS) {
      if (structural.has(col)) continue;
      expect(appts.column_write_acls[col], `appointments.${col} has no write ACL`)
        .toEqual({ writable_by: ["adult"] });
    }
    const visitStructural = new Set(["id", "logged_by", "created_at"]);
    for (const col of VISIT_COLUMNS) {
      if (visitStructural.has(col)) continue;
      expect(visits.column_write_acls[col], `visits.${col} has no write ACL`)
        .toEqual({ writable_by: ["adult"] });
    }
    expect(appts.delete_adult_only).toBe(true);
  });

  it("names only real columns in its write ACLs", () => {
    for (const col of Object.keys(appts.column_write_acls)) expect(APPT_COLUMNS).toContain(col);
    for (const col of Object.keys(visits.column_write_acls)) expect(VISIT_COLUMNS).toContain(col);
  });

  it("caps the table so a runaway automation cannot fill the database", () => {
    expect(appts.max_rows).toBe(2000);
  });

  it("inherits visit access from the appointment, with an adult able to correct one", () => {
    expect(visits.kind).toBe("inherit_visibility");
    expect(visits.parent_table).toBe("appointments");
    expect(visits.fk_column).toBe("appointment_id");
    expect(visits.writer_column).toBe("logged_by");
    // Under an owner_or_visibility parent, privilege means privileged-group
    // membership ONLY — adults get nothing — so without this a stray visit
    // could be corrected by nobody but whoever logged it, and freezes for good
    // once that member leaves the household.
    expect(visits.adults_bypass).toBe(true);
  });

  it("expires visit history on a plaintext date column", () => {
    expect(visits.retain_days.timestamp_column).toBe("visit_date");
    expect(isPlaintext(visits.retain_days.timestamp_column)).toBe(true);
    expect(visits.retain_days.default).toBe(1825);
    expect(VISIT_COLUMNS).toContain(visits.retain_days.id_column);
  });

  it("takes a deleted appointment's visits with it, both ways", () => {
    // The real FK cascade is the primary path; the manifest edge is what the
    // hub's own reclaim graph reads, and it is what holds if foreign keys are
    // ever off. Declaring it also means a DELETE must be a single statement.
    expect(migration).toMatch(/REFERENCES app_appointments__appointments\(id\) ON DELETE CASCADE/);
    expect(manifest.delete_cascades.appointments).toEqual([
      { table: "visits", foreign_key: "appointment_id" },
    ]);
    expect(indexHtml).toMatch(/await db\("DELETE FROM app_appointments__appointments WHERE id = \?"/);
    expect(indexHtml).not.toMatch(/db\.batch\(\[[^\]]*DELETE FROM app_appointments__appointments/s);
  });

  it("takes a departed member's health rows with them", () => {
    const person = manifest.member_references.appointments.find((r) => r.column === "person_id");
    expect(person.on_removed).toBe("delete");
    // Without the dependent table the parent rows go and the visits are left
    // orphaned: invisible (inherit_visibility fails its EXISTS) and billed.
    expect(person.dependent_tables).toEqual([{ table: "visits", foreign_key: "appointment_id" }]);
    // Attribution survives, so a history entry still says who logged it.
    expect(manifest.member_references.appointments.find((r) => r.column === "created_by").on_removed).toBe("keep");
    expect(manifest.member_references.visits.on_removed).toBe("keep");
  });
});

describe("encryption", () => {
  it("keeps everything a person typed encrypted", () => {
    for (const col of ["title", "provider_name", "provider_phone", "provider_url", "notes"]) {
      expect(isPlaintext(col), `${col} must stay encrypted`).toBe(false);
    }
    for (const col of ["outcome"]) {
      expect(isPlaintext(col), `visits.${col} must stay encrypted`).toBe(false);
    }
  });

  it("declares every column SQL compares or sorts on", () => {
    for (const col of ["kind", "remind_scope", "visibility", "status", "scheduled_time"]) {
      expect(isPlaintext(col), `${col} must be plaintext`).toBe(true);
    }
  });

  it("names only real columns as plaintext", () => {
    const all = new Set([...APPT_COLUMNS, ...VISIT_COLUMNS]);
    for (const col of manifest.db_plaintext_columns) expect(all).toContain(col);
  });

  it("only CHECKs string values on plaintext columns", () => {
    // A `CHECK (col IN ('a','b'))` on an encrypted column rejects every insert:
    // the stored value is ciphertext and matches no listed literal.
    for (const m of migration.matchAll(/^\s*(\w+)\s+TEXT[^\n]*\n?[^\n]*CHECK \((\w+) IN \('/gm)) {
      expect(isPlaintext(m[2]), `CHECK on encrypted column ${m[2]}`).toBe(true);
    }
  });

  it("keeps the schema's enums and the app's vocabulary in step", () => {
    const kinds = /CHECK \(kind IN \(([\s\S]*?)\)\)/.exec(migration)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
    expect(kinds.sort()).toEqual(KINDS.map((k) => k.value).sort());
    expect(kinds.sort()).toEqual([...manifest.automation_actions.add_appointment.params.kind.options].sort());
    const scopes = /CHECK \(remind_scope IN \(([\s\S]*?)\)\)/.exec(migration)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
    expect(scopes.sort()).toEqual(REMIND_SCOPES.map((r) => r.value).sort());
    const vis = /CHECK \(visibility IN \(([\s\S]*?)\)\)/.exec(migration)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
    expect(vis.sort()).toEqual(VISIBILITIES.map((v) => v.value).sort());
    // everyone_values must name a value the column can actually hold.
    for (const v of manifest.row_policies.appointments.everyone_values) expect(vis).toContain(v);
    for (const v of manifest.date_reminders.everyone_values) expect(scopes).toContain(v);
  });
});

describe("date_reminders", () => {
  const dr = manifest.date_reminders;

  it("anchors on the DUE date, not the booked slot", () => {
    // The reminder worth sending is "time to book". The day-of reminder is the
    // calendar's job, and anchoring on both would email the same appointment
    // twice — see the two-dates decision in the migration header.
    expect(dr.date_column).toBe("next_due_date");
    expect(dr.month_column).toBeUndefined();
    expect(dr.day_column).toBeUndefined();
  });

  it("every column the hub compares on is plaintext and exists", () => {
    for (const col of [dr.date_column, dr.enabled_column, dr.visibility_column, dr.kind_column, dr.owner_column, dr.last_reminded_column, dr.lead_days_column]) {
      expect(isPlaintext(col) || INTEGER_COLUMNS.has(col), `${col} must be plaintext`).toBe(true);
      expect(APPT_COLUMNS, `${col} must exist`).toContain(col);
    }
  });

  it("keeps the email audience separate from who can see the row", () => {
    // remind_scope and visibility are different questions: a teen's therapy
    // appointment can be household-visible but emailed only to them.
    expect(dr.visibility_column).toBe("remind_scope");
    expect(dr.visibility_column).not.toBe(manifest.row_policies.appointments.visibility_column);
    expect(dr.owner_column).toBe("person_id");
    expect(dr.everyone_values).toEqual(["household"]);
  });

  it("never widens a private reminder to the adults who may not read the row", () => {
    // `on_no_recipients: "adults"` mails EVERY adult when the scoped audience
    // comes back empty (date-reminders.ts:502). For this app that empty case is
    // a `private` row whose person has no email — a child, typically — so the
    // fallback would put a private health reminder's TITLE in front of the other
    // parent, who `visibility: private` forbids from reading the row at all.
    // The hub's own comment on that branch says the widening "must be the app's
    // explicit choice, never a fallback it inherits". This app's choice is no.
    //
    // The cost is a private reminder to an address-less person reaching nobody.
    // The editor says so out loud rather than letting it vanish (leadNote).
    expect(dr.on_no_recipients).toBe("skip");
  });

  it("defaults lead_days to a value every cadence can honor", () => {
    // The hub applies default_lead_days with no clamp and no knowledge of the
    // cadence, and the column DEFAULT is a constant an omitting INSERT (the
    // add_appointment automation action) lands on. Both must hold for the
    // SHORTEST interval the app offers, or such a row goes permanently silent
    // after one nudge — see maxLeadDays() in logic.js.
    const shortest = Math.min(...KINDS.map((k) => maxLeadDays(k.months)));
    expect(dr.default_lead_days).toBeLessThanOrEqual(shortest);
    // DEFAULT_LEAD_DAYS is the app's TASTE value and may exceed the floor: the
    // app always runs it through clampLeadDays() with the row's own cadence in
    // hand, which the hub and the column DEFAULT cannot do.
    expect(clampLeadDays(DEFAULT_LEAD_DAYS, 1)).toBeLessThanOrEqual(shortest);
    const col = /lead_days\s+INTEGER NOT NULL DEFAULT (\d+)/.exec(migration);
    expect(col).not.toBeNull();
    expect(Number(col[1])).toBeLessThanOrEqual(shortest);
    expect(Number(col[1])).toBe(dr.default_lead_days);
  });
});

describe("surfaces", () => {
  it("filters the agenda and the glance on plaintext columns with :today", () => {
    for (const q of [manifest.agenda.source.query, manifest.glance.source.query]) {
      expect(q).toMatch(/:today/);
      expect(q).not.toMatch(/date\('now'\)|CURRENT_DATE|datetime\('now'\)/);
      expect(q).toMatch(/app_appointments__/);
    }
    // The agenda's day token must actually narrow the scan, not merely be
    // selected: a token that appears only in the SELECT list is rejected at
    // publish.
    expect(manifest.agenda.source.query).toMatch(/WHERE[\s\S]*scheduled_date = :today/);
    expect(manifest.glance.source.query).toMatch(/next_due_date <= date\(:today/);
  });

  it("counts the same rows in the glance badge that the app's own header does", () => {
    // Two copies of one rule. A household seeing "3 to book" on the homepage
    // and "2 to book" inside the app is the defect this pins.
    const q = manifest.glance.source.query;
    expect(q).toMatch(/status = 'active'/);
    expect(q).toMatch(/remind = 1/);
    expect(q).toMatch(/scheduled_date = ''/);
    expect(q).toMatch(/lead_days/);
    expect(manifest.glance.display).toEqual({ template: "badge", count: "due_count", label: "to book", severity: "warn" });
  });

  it("refuses an impossible date at the column, and never counts one in the badge", () => {
    // add_appointment declares next_due_date as a free `text` param and the
    // automation param schema has no pattern, so a rule author can write any
    // string into the column the badge counts on. '2026-02-31' is the shape
    // that hurts: shaped like a date, rejected by the app and by the hub's
    // reminder parser, but lexically <= the badge's cutoff — a phantom "to
    // book" the household cannot clear from inside the app.
    const param = manifest.automation_actions.add_appointment.params.next_due_date;
    expect(param.type, "if this ever stops being free text, say so here").toBe("text");
    for (const col of ["next_due_date", "scheduled_date"]) {
      expect(migration).toMatch(new RegExp(`CHECK \\(${col} IS '' OR ${col} IS date\\(${col}\\)\\)`));
    }
    expect(migration).toMatch(/CHECK \(visit_date IS date\(visit_date\)\)/);
    // `IS`, not `=`: date() yields NULL for unparseable text and `col = NULL`
    // is NULL, which a CHECK accepts — the `=` spelling lets 'later' straight
    // through while looking like it validates.
    expect(migration).not.toMatch(/CHECK \([a-z_]*date = date\(/);
    // Read side agrees even if the constraint were ever relaxed.
    expect(manifest.glance.source.query).toMatch(/next_due_date IS date\(next_due_date\)/);
  });

  it("reports order on plaintext columns and declare no LIMIT", () => {
    for (const view of manifest.reports.views) {
      expect(view.source.query, `${view.id} must not LIMIT`).not.toMatch(/\bLIMIT\b/i);
      const order = /ORDER BY ([\s\S]*)$/.exec(view.source.query)[1];
      for (const col of order.match(/\b\w+\b/g)) {
        if (/^(a|v|DESC|ASC|IS|NULL|AND|OR)$/i.test(col)) continue;
        if (!/^[a-z_]+$/.test(col)) continue;
        expect(isPlaintext(col), `${view.id} orders on encrypted ${col}`).toBe(true);
      }
      for (const c of view.columns) expect(view.source.query).toMatch(new RegExp(`AS ${c.key}\\b`));
    }
  });

  it("keeps the range tokens on plaintext columns", () => {
    const q = manifest.reports.views.find((v) => v.id === "visit_history").source.query;
    expect(q).toMatch(/v\.visit_date >= :range_start/);
    expect(q).toMatch(/v\.visit_date <= :range_end/);
  });
});

/**
 * Everything a `${...}` in the app's markup can actually EMIT.
 *
 * Reduces the expression to its output positions before anything is judged:
 * a ternary emits its two branches, never its condition, so
 * `${a.status === "archived" ? "archived" : ""}` emits two literals and no DB
 * value at all. Without that reduction the check flags every conditional class
 * name in the file — which is how a scanner like this gets deleted instead of
 * fixed. Validated below against the shape that was actually wrong.
 */
function emittedParts(expr) {
  let e = expr;
  // esc(...) is a safe sink: replace the whole call, parens balanced, with a
  // marker so its argument is not judged on its own.
  for (let guard = 0; guard < 50; guard += 1) {
    const at = e.indexOf("esc(");
    if (at === -1) break;
    let depth = 0;
    let i = at + 3;
    for (; i < e.length; i += 1) {
      if (e[i] === "(") depth += 1;
      else if (e[i] === ")") { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) break;
    e = `${e.slice(0, at)}SAFE${e.slice(i + 1)}`;
  }
  // Drop the condition of each top-level ternary, keeping both branches.
  const parts = [];
  const walk = (text) => {
    const q = text.indexOf("?");
    if (q === -1 || text[q + 1] === ".") { parts.push(text); return; }
    let depth = 0;
    for (let i = q + 1; i < text.length; i += 1) {
      const c = text[i];
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      else if (c === "?") depth += 1;
      else if (c === ":" && depth === 0) {
        walk(text.slice(q + 1, i));
        walk(text.slice(i + 1));
        return;
      }
    }
    parts.push(text);
  };
  walk(e);
  return parts.map((x) => x.trim());
}

/** A DB-valued member expression left in an output position. */
const UNESCAPED_DB_VALUE = /\b(?:a|v|row|appt|item|doomed|prev|saved)\.[a-z_]+/;

describe("confidentiality of a private row", () => {
  it("publishes nothing for a private appointment", () => {
    // The only consumer of these events is calendar's `create_event`, which
    // does not set a visibility — so the row lands on calendar's own DEFAULT of
    // 'everyone', inside its everyone_values, i.e. household-wide. Announcing a
    // private referral would publish its title, person, provider and phone to
    // the whole household and defeat the row policy that hid the row.
    expect(indexHtml).toMatch(/announcesBooking\(appt\)/);
    // Both announcement paths route through a predicate that folds in
    // visibility; neither tests scheduled_date on its own any more.
    expect(indexHtml).not.toMatch(/if \(!isIsoDate\(appt\.scheduled_date\)\) return;/);
  });

  it("routes every publish through one gate, retractions excepted", () => {
    // The event bus is a channel row policies cannot see, so a publish is a
    // disclosure decision — and `visit_logged` was the one made wrongly: it
    // carried the title, the person, the kind and the free-text outcome of a
    // private therapy visit into household automation processing. The fix is
    // structural rather than one more `if`: `announceFor(appt, ...)` takes the
    // ROW, gates on it, and is the only way to publish an assertion.
    expect(indexHtml).toMatch(/async function announceFor\(appt, type, payload\) \{\n\s*if \(!isAnnounceable\(appt\)\) return;/);

    // Exactly three mentions of the transport: its definition, announceFor's
    // use of it, and announceCancelled — which is exempt because it retracts an
    // entry that was ALREADY household-visible, and a row turning private is
    // precisely when that entry has to come down. A fourth is a new ungated
    // publish, whoever wrote it and however well-meant.
    const sites = [...indexHtml.matchAll(/publishSafely\(/g)].length;
    expect(sites, "a new publishSafely() call site bypasses the visibility gate").toBe(3);
    expect(indexHtml).toMatch(/await announceFor\(prev, "appointment\.visit_logged"/);
    expect(indexHtml).toMatch(/await announceFor\(appt, "appointment\.due_soon"/);
    expect(indexHtml).toMatch(/await announceFor\(appt, "appointment\.booked"/);
  });

  it("maps a suggested rule only onto the calendar's own visibility default", () => {
    // If calendar ever grows a `visibility` param, this app can announce
    // private rows with it — until then the suggestion must not pretend to.
    for (const s of manifest.suggested_automations) {
      expect(Object.keys(s.param_map)).not.toContain("visibility");
    }
  });
});

describe("writes are checked, not assumed", () => {
  it("treats an accepted-but-zero-row write as a failure", () => {
    // write_visibility_scoped narrows a write instead of refusing it: an UPDATE
    // or DELETE aimed at a row the caller may no longer touch matches zero rows
    // and returns HTTP 200 with changed: 0. Reachable with no attacker — the
    // other parent turns the row private between this browser's load and its
    // write.
    expect(indexHtml).toMatch(/function assertChanged\(/);
    // Every `await db(...)` whose SQL mutates must sit inside assertChanged().
    // Matched by walking the call's own parens rather than by regex, so a
    // multi-line statement (all three of them are) is judged whole.
    const unchecked = [];
    for (let at = indexHtml.indexOf("await db("); at !== -1; at = indexHtml.indexOf("await db(", at + 1)) {
      let depth = 0;
      let i = at + "await db".length;
      for (; i < indexHtml.length; i += 1) {
        if (indexHtml[i] === "(") depth += 1;
        else if (indexHtml[i] === ")") { depth -= 1; if (depth === 0) break; }
      }
      const call = indexHtml.slice(at, i + 1);
      if (!/INSERT INTO app_|UPDATE app_|DELETE FROM app_/.test(call)) continue;
      if (!indexHtml.slice(Math.max(0, at - 20), at).includes("assertChanged(")) {
        unchecked.push(call.slice(0, 70).replace(/\s+/g, " "));
      }
    }
    expect(unchecked, "these writes read HTTP 200 as success").toEqual([]);
    // The batch's roll-forward is checked separately: it can come back
    // changed: 0 while the visit INSERT beside it committed.
    expect(indexHtml).toMatch(/rolledResult\?\.changed/);
  });

  it("leaves demo mode alone", () => {
    // createDbHelper short-circuits to `{ rows: [] }` with no `changed` when
    // __DB_URL is empty, so an unguarded check would turn every save in demo
    // mode into a visible failure — and demo mode exists so the app works with
    // no hub behind it at all.
    expect(indexHtml).toMatch(/function assertChanged\([^)]*\) \{\n\s*if \(!DB\) return;/);
    expect(indexHtml).toMatch(/if \(DB && Number\(rolledResult\?\.changed/);
  });
});

describe("XSS", () => {
  it("has a detector that recognises the shape that was actually wrong", () => {
    // The pre-fix option list, which rendered a stored INTEGER column straight
    // into an attribute. Validating the detector against known-broken code
    // first is the only reason to trust it on the file below.
    expect(emittedParts('a.interval_months').some((x) => UNESCAPED_DB_VALUE.test(x))).toBe(true);
    // ...and does not flag a condition that only chooses between literals.
    expect(emittedParts('a.status === "archived" ? "archived" : ""').some((x) => UNESCAPED_DB_VALUE.test(x))).toBe(false);
    expect(emittedParts('esc(a.title)').some((x) => UNESCAPED_DB_VALUE.test(x))).toBe(false);
  });

  it("escapes every DB value it interpolates into markup", () => {
    // Row ids and even INTEGER-typed columns count as user content: any member
    // can INSERT a row with an attacker-chosen id, or write text into an
    // INTEGER column, through raw /api/db. SQLite affinity is not type
    // enforcement and the codec round-trips whatever was written.
    const offenders = [];
    for (const m of indexHtml.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
      for (const part of emittedParts(m[1])) {
        if (UNESCAPED_DB_VALUE.test(part)) offenders.push(`\${${m[1].trim()}}`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("never renders a stored interval without narrowing it first", () => {
    // The <option> list is the one place a stored INTEGER reaches markup.
    expect(indexHtml).toMatch(/normalizeIntervalMonths\(a\.interval_months\)/);
    expect(indexHtml).not.toMatch(/<option value="\$\{n\}"/);
  });
});

describe("events and automations", () => {
  it("publishes every declared event from app code, adults only", () => {
    for (const type of manifest.publishes) {
      expect(indexHtml, `${type} is declared but never published`).toContain(`"${type}"`);
      // Each of these drives a trusted write in another app (a calendar entry),
      // so a child must not be able to POST a fabricated one.
      expect(manifest.publish_acls[type]).toEqual({ require_role: "adult" });
    }
  });

  it("suggests rules whose params exist on the event that triggers them", () => {
    const payloads = {
      "appointment.due_soon": ["source_ref_id", "title", "person_id", "kind", "due_date", "remind_on", "review_title", "summary"],
      "appointment.booked": ["source_ref_id", "title", "person_id", "scheduled_date", "scheduled_time", "provider_name", "review_title", "summary"],
      "appointment.cancelled": ["source_ref_id", "title", "person_id", "reason"],
    };
    for (const s of manifest.suggested_automations) {
      for (const source of Object.values(s.param_map)) {
        expect(source.kind).toBe("payload_field");
        expect(payloads[s.trigger_event], `${s.trigger_event}.${source.value}`).toContain(source.value);
      }
    }
  });

  it("ships the retraction beside both announcements, on the same reference", () => {
    // The pair is the feature: an announcement rule without its retraction
    // leaves an entry on the calendar for an appointment that was cancelled.
    const [book, slot, retract] = manifest.suggested_automations;
    expect(book.trigger_event).toBe("appointment.due_soon");
    expect(slot.trigger_event).toBe("appointment.booked");
    expect(retract.trigger_event).toBe("appointment.cancelled");
    expect(retract.action_id).toBe("retract_dated_event");
    expect(Object.keys(retract.param_map)).toEqual(["source_ref_id"]);
    for (const s of [book, slot]) {
      // The calendar upserts on source_ref_id, and the param is OPTIONAL there
      // — an unmapped one binds NULL rather than skipping the run, so every
      // edit would land a second entry beside the stale first with nothing able
      // to retract either.
      expect(s.param_map.source_ref_id).toEqual({ kind: "payload_field", value: "source_ref_id" });
    }
  });

  it("gives the two calendar entries distinct, app-namespaced references", () => {
    // One appointment can have both a "time to book" entry and a booked-slot
    // entry live at once. One shared reference would make each upsert overwrite
    // the other; a bare id would collide with every other publisher's.
    expect(indexHtml).toContain("const bookRef = (id) => `appointments:${id}`;");
    expect(indexHtml).toContain("const slotRef = (id) => `appointments:${id}:booked`;");
  });

  it("writes only real columns from the automation action", () => {
    const action = manifest.automation_actions.add_appointment;
    const values = action.steps[0].values;
    for (const col of Object.keys(values)) expect(APPT_COLUMNS, `add_appointment writes ${col}`).toContain(col);
    expect(APPT_COLUMNS).toContain(action.dedupe.column);
    // A member param the caller leaves unmapped resolves to nothing, and the
    // whole run is skipped — so both must be required rather than optional.
    expect(action.params.person_id.required).toBe(true);
    expect(action.params.created_by.required).toBe(true);
    // Without a dedupe column a redelivered event tracks the appointment twice.
    expect(action.dedupe).toEqual({ table: "appointments", column: "source_event_id" });
    expect(values.source_event_id).toBe("$event_id");
    // Every column the dispatcher compares on must be plaintext.
    expect(isPlaintext(action.dedupe.column)).toBe(true);
  });
});
