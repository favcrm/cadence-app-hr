// The owner-decision write rules: a staged create can only be open and carries no decision, a decided
// request or claim cannot change (which freezes an approved claim's amount), and 0.2.0 never writes a
// paid claim. `after` is the host's merged row, so a create case lists the decided columns as null.
// Every case is also run through the host's
// real validator by scripts/host-schema-check.mjs. Run: bun test tests/unit/write_schema.test.mjs
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { valid } from "../support/mini-schema.mjs";

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8"));
const descriptor = read("app/app-storage.json");
const cases = read("tests/fixtures/write-schema-cases.json");
const run = (schema, c) => valid(schema, { operation: c.operation, before: c.before, after: c.after, provenance: null });

test("every case gets the expected verdict from the declared write schema", () => {
  expect(cases.length).toBeGreaterThanOrEqual(23);
  for (const c of cases) expect([c.name, run(descriptor.tables[c.table].write_schema, c)]).toEqual([c.name, c.ok]);
});

test("the tables that declare a write schema are the decision tables, the ledgers, leave types, payroll and punches; every table is owner-only", () => {
  expect(Object.entries(descriptor.tables).filter(([, o]) => o.write_schema).map(([n]) => n).sort()).toEqual(["attendance_punches", "claims", "leave_entries", "leave_requests", "leave_types", "payroll_lines", "payroll_runs", "postings", "salaries", "staff_claims", "staff_leave_requests"]);
  for (const o of Object.values(descriptor.tables)) expect(o.read_role).toBe("owner");
  expect(Object.keys(descriptor.tables).sort()).toEqual(["attendance_punches", "candidates", "claims", "employees", "job_openings", "leave_entries", "leave_requests", "leave_types", "leave_withdrawals", "payroll_lines", "payroll_runs", "policies", "postings", "rate_tables", "salaries", "staff_claims", "staff_leave_requests", "staff_link_requests", "staff_snapshots"]);
});

test("the ledger rules discriminate: each removed rule flips a verdict", () => {
  const schema = descriptor.tables.leave_entries.write_schema;
  const ledger = cases.filter((c) => c.table === "leave_entries");
  expect(ledger.length).toBeGreaterThanOrEqual(15);
  const without = (edit) => { const copy = structuredClone(schema); edit(copy); return copy; };
  const flips = (copy) => ledger.some((c) => run(copy, c) !== c.ok);
  expect(flips(without((x) => { delete x.properties.after.properties.half_days.not; }))).toBe(true); // never 0
  expect(flips(without((x) => { x.allOf = x.allOf.filter((r) => !JSON.stringify(r).includes('"minimum":1')); }))).toBe(true); // accruals add
  expect(flips(without((x) => { x.allOf = x.allOf.filter((r) => !JSON.stringify(r).includes('"maximum":-1')); }))).toBe(true); // taken and expiry remove
  expect(flips(without((x) => { x.allOf = x.allOf.filter((r) => !JSON.stringify(r).includes('"minLength":1')); }))).toBe(true); // an adjustment needs a note
  expect(flips(without((x) => { x.properties.operation = {}; }))).toBe(true); // create only
  expect(flips(without((x) => { delete x.properties.after.properties.kind.enum; }))).toBe(true); // closed kinds
});

test("the accrual rule format is checked on every write: dropping the shape rule flips cases", () => {
  const schema = descriptor.tables.leave_types.write_schema;
  const rules = cases.filter((c) => c.table === "leave_types");
  expect(rules.length).toBeGreaterThanOrEqual(8);
  const loose = structuredClone(schema);
  loose.properties.after.properties.accrual_rule = {};
  expect(rules.some((c) => run(loose, c) !== c.ok)).toBe(true);
});

test("the cases discriminate: removing either rule changes a verdict", () => {
  const schema = structuredClone(descriptor.tables.claims.write_schema);
  const noFreeze = structuredClone(schema); noFreeze.allOf = [noFreeze.allOf[0]];
  const noOpenCreate = structuredClone(schema); noOpenCreate.allOf = [noOpenCreate.allOf[1]];
  const claimCases = cases.filter((c) => c.table === "claims");
  expect(claimCases.some((c) => run(noFreeze, c) !== c.ok)).toBe(true);
  expect(claimCases.some((c) => run(noOpenCreate, c) !== c.ok)).toBe(true);
});

test("0.2.0 cannot write a paid claim: putting paid back in the status list flips submitted to paid", () => {
  const schema = descriptor.tables.claims.write_schema;
  expect(schema.properties.after.properties.status.enum).toEqual(["submitted", "approved", "rejected"]);
  const withPaid = structuredClone(schema); withPaid.properties.after.properties.status.enum.push("paid");
  const toPaid = cases.find((c) => c.name === "claims: a submitted claim cannot be marked paid in 0.2.0");
  expect(run(schema, toPaid)).toBe(false);
  expect(run(withPaid, toPaid)).toBe(true);
});

test("a create cannot carry decided metadata: dropping the null rule flips those cases", () => {
  for (const table of ["leave_requests", "claims"]) {
    const schema = descriptor.tables[table].write_schema;
    const loose = structuredClone(schema);
    const afterRule = loose.allOf[0].then.properties.after.properties;
    delete afterRule.decided_on; delete afterRule.decision_note;
    const decided = cases.filter((c) => c.table === table && c.operation === "create" && (c.after.decided_on !== null || c.after.decision_note !== null));
    expect(decided.length).toBe(2);
    for (const c of decided) { expect(run(schema, c)).toBe(false); expect(run(loose, c)).toBe(true); }
  }
});

test("an approved payroll run is frozen and a posted posting is final: each removed rule flips a verdict", () => {
  for (const table of ["payroll_runs", "postings"]) {
    const schema = descriptor.tables[table].write_schema;
    const mine = cases.filter((c) => c.table === table);
    expect(mine.length).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < schema.allOf.length; i += 1) {
      const without = structuredClone(schema); without.allOf.splice(i, 1);
      expect([table, i, mine.some((c) => run(without, c) !== c.ok)]).toEqual([table, i, true]);
    }
  }
  // The literal acceptance item: no update of an approved run passes, whatever it changes.
  const runs = descriptor.tables.payroll_runs.write_schema;
  for (const after of [{ status: "approved", decided_on: "2026-02-01" }, { status: "approved", decided_on: "2026-02-01", period: "2026-02" }, { status: "draft" }, { status: "cancelled", decided_on: "2026-02-02" }]) {
    expect(run(runs, { operation: "update", before: { status: "approved", decided_on: "2026-02-01" }, after })).toBe(false);
  }
});
