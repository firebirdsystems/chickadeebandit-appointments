-- Appointments & Check-ups — the household's recurring human-health cadence.
--
-- An `appointments` row is a standing cadence ("dental, every six months, for
-- Sam"); a `visits` row is one attendance of it. Logging a visit rolls the
-- parent's `next_due_date` forward, which is the whole loop. README.md carries
-- the design rationale; this file carries the constraints.
--
-- TWO DATES, deliberately not one. `next_due_date` is when the cadence says a
-- visit is DUE; `scheduled_date`/`scheduled_time` is the slot once it is
-- BOOKED. date_reminders anchors on `next_due_date` alone, so the email it
-- sends is the one worth sending — "time to book". The day-of reminder belongs
-- to the calendar. Anchoring on both would email the same appointment twice.
--
-- ENCRYPTION. This is health data, so everything a person typed stays
-- encrypted: `title`, `provider_*`, `notes`, and a visit's `outcome`/`notes`.
-- Plaintext is only what SQL must compare or sort on — `kind`, `remind_scope`,
-- `visibility`, `status` and the three integers are declared in manifest
-- db_plaintext_columns; `*_date`/`*_time`/`*_at`/`*_id`/`*_by` are plaintext by
-- suffix. A string CHECK is therefore safe on the enum columns below (a CHECK
-- against an encrypted column rejects every insert) but NOT on `title`/`notes`.
-- The same is why the date columns can carry a `date()` round-trip CHECK.
CREATE TABLE IF NOT EXISTS app_appointments__appointments (
  id               TEXT PRIMARY KEY,
  -- The member the appointment is FOR. Deliberately NOT the row policy's owner
  -- column: `owner_or_visibility` forces its owner column to the caller on
  -- INSERT, which would silently rewrite "Sam's dentist" into the parent's own.
  person_id        TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('physical','dental','vision','wellchild','therapy',
                                     'specialist','screening','vaccine','other')),
  title            TEXT NOT NULL,                    -- "Dentist" (encrypted)
  provider_name    TEXT NOT NULL DEFAULT '',         -- encrypted
  provider_phone   TEXT NOT NULL DEFAULT '',         -- encrypted
  provider_url     TEXT NOT NULL DEFAULT '',         -- encrypted
  -- NULL = a one-off with no cadence: logging its visit clears the due date
  -- instead of rolling it forward. Recurring rows carry a positive count.
  interval_months  INTEGER CHECK (interval_months IS NULL OR interval_months > 0),
  -- '' rather than NULL, so "unset" has exactly one spelling: an automation
  -- writing a default, an empty <input type="date">, and a roll-forward
  -- clearing a booking all agree, and every read filters `<> ''`.
  -- A REAL date check, not a shape check, because these columns have a writer
  -- the app cannot validate: add_appointment declares next_due_date as a free
  -- `text` param and the automation schema carries no pattern, so any rule
  -- author can write any string. '2026-02-31' would otherwise store happily and
  -- read three ways — "no date set" in the app, refused by the reminder parser,
  -- counted as due by the glance's lexical compare. `IS` not `=`: date() is
  -- NULL for junk and `d = NULL` is NULL, which a CHECK accepts. The round trip
  -- also pins the canonical spelling (2026-2-3 is out).
  next_due_date    TEXT NOT NULL DEFAULT ''
                     CHECK (next_due_date IS '' OR next_due_date IS date(next_due_date)),
  scheduled_date   TEXT NOT NULL DEFAULT ''
                     CHECK (scheduled_date IS '' OR scheduled_date IS date(scheduled_date)),
  scheduled_time   TEXT NOT NULL DEFAULT '',         -- HH:MM floating local, never UTC
  -- The DEFAULT is the FLOOR (26), not the app's taste value (30). A DEFAULT is
  -- a constant and the safe lead time is not: the shortest cadence offered is
  -- monthly, and a 30-day lead makes the hub's `lead_days + 1` suppression
  -- window wider than the 28-day gap between occurrences — last cycle's stamp
  -- lands inside this one's window and the row nudges exactly once, ever. Any
  -- INSERT that omits the column (the add_appointment automation action, which
  -- learns the cadence only as a runtime param) therefore lands on a value
  -- every cadence can honor. The app raises it per row; see maxLeadDays().
  lead_days        INTEGER NOT NULL DEFAULT 26 CHECK (lead_days >= 1),
  remind           INTEGER NOT NULL DEFAULT 1 CHECK (remind IN (0, 1)),
  -- Who the reminder EMAIL reaches. Not an access control — `visibility` is.
  -- Separate on purpose: a teen's therapy appointment can be household-visible
  -- while only they are emailed. date_reminders reads this, not `visibility`.
  remind_scope     TEXT NOT NULL DEFAULT 'household'
                     CHECK (remind_scope IN ('household', 'private')),
  visibility       TEXT NOT NULL DEFAULT 'household'
                     CHECK (visibility IN ('household', 'private')),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived')),
  notes            TEXT NOT NULL DEFAULT '',         -- encrypted
  -- Dedupe stamp written by the date_reminders cron. The durable authority is
  -- the hub's per-recipient send log; this exists so a served row drops out of
  -- evaluation. The app clears it whenever `next_due_date` moves — a stamp from
  -- the previous occurrence sitting inside this one's `lead_days + 1` window
  -- silences the new date forever, with nothing on screen to say so.
  last_reminded_at TEXT,
  created_by       TEXT NOT NULL,                    -- row policy owner column
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- Automation dedupe. Nullable: hand-entered rows have no source event, and
  -- the dispatcher's guard only ever looks for a specific id.
  source_event_id  TEXT
);

-- Serves the preload's `status = 'active' ORDER BY next_due_date` and the
-- glance's due-soon count.
CREATE INDEX IF NOT EXISTS app_appointments__appointments_due_idx
  ON app_appointments__appointments (status, next_due_date);

-- The agenda asks "what is booked today", which the due-date index cannot serve.
CREATE INDEX IF NOT EXISTS app_appointments__appointments_scheduled_idx
  ON app_appointments__appointments (status, scheduled_date);

CREATE INDEX IF NOT EXISTS app_appointments__appointments_source_event_idx
  ON app_appointments__appointments (source_event_id);

-- One attendance. `visit_date` is the day it happened on the HOUSEHOLD's
-- calendar (hubToday()), never a UTC instant.
--
-- The real FK cascade is the primary cleanup path; manifest `delete_cascades`
-- declares the same edge so the hub's reclaim graph knows about it. Because
-- that key is declared, a DELETE of an appointment must be sent as a SINGLE
-- statement — the batch form is refused outright.
CREATE TABLE IF NOT EXISTS app_appointments__visits (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL
                   REFERENCES app_appointments__appointments(id) ON DELETE CASCADE,
  visit_date     TEXT NOT NULL                       -- YYYY-MM-DD household-local
                   CHECK (visit_date IS date(visit_date)),
  logged_by      TEXT NOT NULL,                      -- inherit_visibility writer column
  outcome        TEXT NOT NULL DEFAULT '',           -- encrypted
  notes          TEXT NOT NULL DEFAULT '',           -- encrypted
  created_at     TEXT NOT NULL
);

-- Per-appointment history, newest first (the visit-history drawer).
CREATE INDEX IF NOT EXISTS app_appointments__visits_appointment_idx
  ON app_appointments__visits (appointment_id, visit_date);

-- The preload reads the recent tail across all appointments to show each row's
-- last visit. Without this index that ORDER BY sorts the whole table.
CREATE INDEX IF NOT EXISTS app_appointments__visits_recent_idx
  ON app_appointments__visits (visit_date DESC, id DESC);
