// The owner-decision write rules: a staged create can only be open, and a decided request or claim
// cannot change (which freezes an approved claim's amount). Every case is also run through the host's
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
  expect(cases.length).toBeGreaterThanOrEqual(16);
  for (const c of cases) expect([c.name, run(descriptor.tables[c.table].write_schema, c)]).toEqual([c.name, c.ok]);
});

test("only leave_requests and claims declare a write schema, and they are owner-only", () => {
  expect(Object.entries(descriptor.tables).filter(([, o]) => o.write_schema).map(([n]) => n).sort()).toEqual(["claims", "leave_requests"]);
  for (const o of Object.values(descriptor.tables)) expect(o.read_role).toBe("owner");
  expect(Object.keys(descriptor.tables).sort()).toEqual(["candidates", "claims", "employees", "job_openings", "leave_requests", "leave_types", "policies"]);
});

test("the cases discriminate: removing either rule changes a verdict", () => {
  const schema = structuredClone(descriptor.tables.claims.write_schema);
  const noFreeze = structuredClone(schema); noFreeze.allOf = [noFreeze.allOf[0]];
  const noOpenCreate = structuredClone(schema); noOpenCreate.allOf = [noOpenCreate.allOf[1]];
  const claimCases = cases.filter((c) => c.table === "claims");
  expect(claimCases.some((c) => run(noFreeze, c) !== c.ok)).toBe(true);
  expect(claimCases.some((c) => run(noOpenCreate, c) !== c.ok)).toBe(true);
});
