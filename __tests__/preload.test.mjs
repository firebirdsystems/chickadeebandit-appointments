import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const norm = (s) => s.replace(/\s+/g, " ").trim();

// The hub runs `manifest.preload` while rendering the document and answers the
// app's matching api/db request from the embedded rows — matching on the
// statement text with whitespace collapsed. A drifted copy is not an error
// anywhere: it is a preload that silently never answers. So the manifest is
// checked against the source here.
describe("manifest.preload mirrors the app's first-render reads", () => {
  const body = norm(html);
  const prefix = `app_${manifest.id.replace(/-/g, "_")}__`;

  it("declares statements the app posts, byte-for-byte after whitespace collapse", () => {
    for (const [name, { sql }] of Object.entries(manifest.preload)) {
      expect(body.includes(norm(sql)), `preload.${name} is not the text src/index.html posts`).toBe(true);
    }
  });

  it("stays within the hub's caps and reads only this app's tables", () => {
    expect(Object.keys(manifest.preload).length).toBeLessThanOrEqual(6);
    for (const [name, { sql, params = [] }] of Object.entries(manifest.preload)) {
      expect(sql, name).toMatch(/^(SELECT|WITH) /);
      expect(sql, name).not.toMatch(/;|--/);
      for (const table of sql.match(/(?:FROM|JOIN)\s+(\w+)/g) ?? []) expect(table, name).toMatch(new RegExp(`\\s${prefix}`));
      expect((sql.match(/\?/g) ?? []).length, `${name}: placeholders vs params`).toBe(params.length);
    }
  });

  it("bounds every preloaded read", () => {
    // These run server-side on EVERY launch for every household, and D1 bills
    // rows read. `appointments` is capped below the table's own max_rows;
    // `recent_visits` reads a tail, which is all the list needs to show each
    // row's last visit. Both order deterministically so the page cannot
    // reshuffle between loads.
    for (const [name, { sql }] of Object.entries(manifest.preload)) {
      const limit = /\bLIMIT (\d+)$/.exec(sql.trim());
      expect(limit, `preload.${name} has no LIMIT`).not.toBeNull();
      expect(Number(limit[1]), `preload.${name} LIMIT`).toBeLessThanOrEqual(500);
      expect(sql, `preload.${name} needs a deterministic order`).toMatch(/ORDER BY /);
    }
    expect(manifest.preload.appointments.sql).toMatch(/LIMIT 500$/);
    expect(Number(/LIMIT (\d+)$/.exec(manifest.preload.appointments.sql)[1]))
      .toBeLessThanOrEqual(manifest.row_policies.appointments.max_rows);
  });

  it("never folds the last visit per appointment in SQL", () => {
    // `visits` is a governed table, and the row-policy rewriter fails closed on
    // a governed table reachable only from inside a subquery or a derived
    // table — which is exactly the shape a `MAX(visit_date) … GROUP BY` join
    // takes. The fold lives in logic.js `lastVisitByAppointment` instead.
    expect(manifest.preload.recent_visits.sql).not.toMatch(/GROUP BY|MAX\(/i);
    expect(manifest.preload.recent_visits.sql).not.toMatch(/JOIN \(/i);
  });
});
