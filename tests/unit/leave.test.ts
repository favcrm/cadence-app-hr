// The leave ledger's pure logic: the accrual rule, monthly accrual, the entries a decision produces, batch chunking.
// Run: bun test tests/unit/leave.test.ts
import { expect, test } from "bun:test";
import * as L from "../../src/domain/leave.ts";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const emp = (over: Partial<L.EmployeeFacts> = {}): L.EmployeeFacts => ({ id: "emp-aaa", name: "Avery Sample", joinDate: "2020-01-01", leaveDate: null, status: "active", ...over });
const RULE = { v: 1, days_per_year: [{ from_years: 0, days: 7 }, { from_years: 3, days: 8 }] };
const ANNUAL: L.LeaveTypeFacts = { code: "ANNUAL", accrualRule: RULE };
const plan = (month: string, employees: L.EmployeeFacts[], leaveTypes = [ANNUAL], existingRefs = new Set<string>()) => L.planAccrual({ month, employees, leaveTypes, existingRefs });
const halfOf = (month: string, employee: L.EmployeeFacts, types = [ANNUAL]) => plan(month, [employee], types).entries[0]?.half_days ?? 0;

test("the accrual rule format: versioned, tiers by completed years, whole or half days", () => {
  expect(L.parseAccrualRule(RULE)).toEqual({ ok: true, tiers: [{ fromYears: 0, halfDays: 14 }, { fromYears: 3, halfDays: 16 }] });
  expect(L.parseAccrualRule({ v: 1, days_per_year: [{ from_years: 0, days: 7.5 }] })).toEqual({ ok: true, tiers: [{ fromYears: 0, halfDays: 15 }] });
  const bad: unknown[] = [
    null, [], "x", {}, { v: 2, days_per_year: [{ from_years: 0, days: 7 }] }, { v: 1 }, { v: 1, days_per_year: [] }, { v: 1, days_per_year: [{ from_years: 0, days: 7 }], extra: 1 },
    { v: 1, days_per_year: [{ from_years: 1, days: 7 }] }, // must start at 0
    { v: 1, days_per_year: [{ from_years: 0, days: 7 }, { from_years: 0, days: 8 }] }, // years must rise
    { v: 1, days_per_year: [{ from_years: 0, days: 7 }, { from_years: 3, days: 2 }, { from_years: 2, days: 9 }] },
    { v: 1, days_per_year: [{ from_years: 0, days: 7.3 }] }, { v: 1, days_per_year: [{ from_years: 0, days: -1 }] }, { v: 1, days_per_year: [{ from_years: 0, days: 367 }] },
    { v: 1, days_per_year: [{ from_years: 0.5, days: 7 }] }, { v: 1, days_per_year: [{ from_years: 0, days: "7" }] }, { v: 1, days_per_year: [{ from_years: 0, days: 7, x: 1 }] },
  ];
  for (const value of bad) expect([JSON.stringify(value), L.parseAccrualRule(value).ok]).toEqual([JSON.stringify(value), false]);
  expect(L.ruleJson((L.parseAccrualRule(RULE) as { tiers: L.RuleTier[] }).tiers)).toEqual(RULE);
});

test("the owner edits tiers as text, not JSON, and a rule the screen cannot read is kept", () => {
  expect(L.ruleToText(null)).toBe("");
  expect(L.ruleToText(RULE)).toBe("0:7;3:8");
  expect(L.ruleToText({ v: 1, days_per_year: [{ from_years: 0, days: 7.5 }] })).toBe("0:7.5");
  expect(L.ruleToText({ v: 9 })).toBe(L.RULE_KEPT);
  expect(L.textToTiers("0:7;3:8")).toEqual([{ fromYears: 0, halfDays: 14 }, { fromYears: 3, halfDays: 16 }]);
  expect(L.textToTiers(" 0 : 7.5 ; 5 : 10 ")).toEqual([{ fromYears: 0, halfDays: 15 }, { fromYears: 5, halfDays: 20 }]);
  for (const text of ["", ";", "7", "0:", ":7", "1:7", "0:7;0:8", "0:7;3:8;2:9", "0:7.3", "0:-1", "0:7;3", "0:7:1", "81:1", "0:7;100:8"]) expect([text, L.textToTiers(text)]).toEqual([text, null]);
});

test("a year's twelve months sum to exactly the yearly half-days, for every yearly figure", () => {
  for (let annual = 0; annual <= 740; annual += 1) {
    let sum = 0;
    for (let month = 1; month <= 12; month += 1) {
      const added = L.monthlyHalfDays(annual, month);
      expect(added).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(added)).toBe(true);
      sum += added;
    }
    expect([annual, sum]).toEqual([annual, annual]);
  }
  // 7 days is 14 half-days: two in some months and one in the rest, nothing lost.
  expect(Array.from({ length: 12 }, (_, i) => L.monthlyHalfDays(14, i + 1))).toEqual([1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2]);
  // Fewer than twelve half-days: some months add nothing.
  expect(Array.from({ length: 12 }, (_, i) => L.monthlyHalfDays(5, i + 1)).filter((n) => n === 0).length).toBe(7);
});

test("accrual by service length: the tier follows completed years at the month's end", () => {
  expect(L.completedYears("2023-06-15", "2026-06-14")).toBe(2);
  expect(L.completedYears("2023-06-15", "2026-06-15")).toBe(3);
  expect(L.completedYears("2024-02-29", "2025-02-28")).toBe(0);
  expect(L.completedYears("2024-02-29", "2025-03-01")).toBe(1);
  expect(L.completedYears("2026-06-15", "2026-06-14")).toBeNull();
  expect(L.completedYears("nope", "2026-06-14")).toBeNull();
  const who = emp({ joinDate: "2023-06-15" });
  // Jan to May 2026: two completed years, 7 days a year (14 half-days): one half-day a month.
  expect(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"].map((m) => halfOf(m, who))).toEqual([1, 1, 1, 1, 1]);
  // June 2026: the third anniversary falls in the month, so the 8-day tier (16 half-days) applies: floor(16*6/12) - floor(16*5/12) = 8 - 6.
  expect(halfOf("2026-06", who)).toBe(2);
  // A tier change mid-year is not drift: each month is exact for the tier it falls in.
  const year = Array.from({ length: 12 }, (_, i) => halfOf(`2026-${String(i + 1).padStart(2, "0")}`, who));
  expect(year.reduce((a, b) => a + b, 0)).toBe(L.monthlyHalfDays(14, 1) + L.monthlyHalfDays(14, 2) + L.monthlyHalfDays(14, 3) + L.monthlyHalfDays(14, 4) + L.monthlyHalfDays(14, 5) + [6, 7, 8, 9, 10, 11, 12].reduce((a, m) => a + L.monthlyHalfDays(16, m), 0));
  // One tier for the whole year: exactly the yearly entitlement.
  const steady = emp({ joinDate: "2020-01-01" });
  expect(Array.from({ length: 12 }, (_, i) => halfOf(`2026-${String(i + 1).padStart(2, "0")}`, steady)).reduce((a, b) => a + b, 0)).toBe(16);
  const newer = emp({ joinDate: "2025-12-31" });
  expect(Array.from({ length: 12 }, (_, i) => halfOf(`2026-${String(i + 1).padStart(2, "0")}`, newer)).reduce((a, b) => a + b, 0)).toBe(14);
});

test("the entry an accrual posts: month-end date, deterministic source_ref, a positive integer", () => {
  const p = plan("2026-02", [emp()]);
  expect(p.entries).toEqual([{ employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: 1, kind: "accrual", effective_date: "2026-02-28", source_ref: "accrual-emp-aaa-ANNUAL-2026-02", note: null }]);
  expect(L.monthEnd("2024-02")).toBe("2024-02-29");
  expect(L.monthEnd("2026-12")).toBe("2026-12-31");
  // The longest ids still fit the column.
  expect(L.accrualRef("e".repeat(128), "T".repeat(32), "2026-02").length).toBeLessThanOrEqual(200);
  expect(L.SOURCE_REF.test(L.accrualRef("e".repeat(128), "T".repeat(32), "2026-02"))).toBe(true);
});

test("employees without a join date, not yet joined, or who left are skipped with a reason", () => {
  const p = plan("2026-03", [
    emp({ id: "a", name: "No Date", joinDate: null }),
    emp({ id: "b", name: "Bad Date", joinDate: "2026-02-30" }),
    emp({ id: "c", name: "Later", joinDate: "2026-04-01" }),
    emp({ id: "d", name: "Joins This Month", joinDate: "2026-03-20" }),
    emp({ id: "e", name: "Left Before", leaveDate: "2026-02-28", status: "left" }),
    emp({ id: "f", name: "Leaves This Month", leaveDate: "2026-03-01" }),
    emp({ id: "g", name: "Left No Date", status: "left" }),
    emp({ id: "h", name: "On Leave", status: "on_leave" }),
    emp({ id: "i", name: "Bad Leave Date", leaveDate: "2026-13-01", status: "active" }),
  ]);
  expect(p.skipped.map((s) => [s.employeeId, s.reason])).toEqual([["a", "no_join_date"], ["b", "no_join_date"], ["c", "not_yet_joined"], ["e", "left"], ["g", "left"]]);
  expect(p.entries.map((e) => e.employee_id)).toEqual(["d", "f", "h", "i"]);
  expect(L.SKIP_TEXT.left).toBe("Has left");
});

test("entries already in the ledger are counted, not planned again; a second run plans nothing", () => {
  const people = [emp({ id: "a" }), emp({ id: "b" })];
  const first = plan("2026-03", people);
  expect(first.entries.length).toBe(2);
  const second = plan("2026-03", people, [ANNUAL], new Set(first.entries.map((e) => e.source_ref)));
  expect(second.entries).toEqual([]);
  expect(second.alreadyRecorded).toBe(2);
  // One of two already there: only the other is planned.
  const half = plan("2026-03", people, [ANNUAL], new Set([first.entries[0]!.source_ref]));
  expect(half.entries.map((e) => e.employee_id)).toEqual(["b"]);
});

test("a leave type with no rule does not accrue, an unreadable rule is reported, and a month that adds nothing writes nothing", () => {
  const p = plan("2026-03", [emp()], [{ code: "SICK", accrualRule: null }, { code: "ODD", accrualRule: { v: 3 } }, { code: "COMP", accrualRule: { v: 1, days_per_year: [{ from_years: 0, days: 0.5 }] } }]);
  expect(p.entries).toEqual([]);
  expect(p.unreadableRules).toEqual(["ODD"]);
  expect(p.accruingTypes).toEqual(["COMP"]);
  expect(p.nothingDue).toBe(1);
  expect(plan("2026-03", [emp()], [{ code: "SICK", accrualRule: null }]).skipped).toEqual([]);
  expect(() => plan("2026-3", [emp()])).toThrow(RangeError);
});

test("the taken entry of an approved request: minus its half-days, dated its first day, source_ref from the request id", () => {
  const request = (over: Record<string, unknown> = {}) => ({ id: "lv-0123456789ab", profile: { employee_id: "emp-aaa", leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, status: "pending", ...over } });
  expect(L.takenEntry(request())).toEqual({ ok: true, entry: { employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: -4, kind: "taken", effective_date: "2026-03-02", source_ref: "taken-lv-0123456789ab", note: null } });
  // A half day is one half-day.
  expect(L.takenEntry(request({ half_days: 1, end_date: "2026-03-02" }))).toMatchObject({ ok: true, entry: { half_days: -1 } });
  // A request across a month boundary is one entry, in the month it starts; it is not split.
  const across = L.takenEntry(request({ start_date: "2026-03-30", end_date: "2026-04-02", half_days: 8 }));
  expect(across).toMatchObject({ ok: true, entry: { half_days: -8, effective_date: "2026-03-30" } });
  expect(L.takenRef("lv-1")).toBe("taken-lv-1");
  for (const over of [{ employee_id: "" }, { employee_id: 5 }, { leave_type: "annual" }, { half_days: 0 }, { half_days: 1.5 }, { half_days: 1001 }, { start_date: "2026-02-30" }, { start_date: null }]) {
    expect([JSON.stringify(over), L.takenEntry(request(over)).ok]).toEqual([JSON.stringify(over), false]);
  }
  expect(L.takenEntry({ id: "lv-1", profile: null }).ok).toBe(false);
});

test("an adjustment is a new signed entry with its note, and a stored entry is the same one only if it matches", () => {
  const entry = L.adjustmentEntry({ employeeId: "emp-aaa", leaveType: "ANNUAL", halfDays: -3, effectiveDate: "2026-03-05", note: "Carried a day too many", ref: "adjustment-adj-0123" });
  expect(entry).toEqual({ employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: -3, kind: "adjustment", effective_date: "2026-03-05", source_ref: "adjustment-adj-0123", note: "Carried a day too many" });
  expect(L.sameEntry({ ...entry }, entry)).toBe(true);
  expect(L.sameEntry({ ...entry, half_days: -2 }, entry)).toBe(false);
  expect(L.sameEntry({ ...entry, kind: "taken" }, entry)).toBe(false);
  expect(L.sameEntry(null, entry)).toBe(false);
});

test("signed days print exactly: -1 half-day is -0.5, and typing days gives half-days", () => {
  expect([0, 1, 2, 3, -1, -2, -3, 15].map(L.signedDays)).toEqual(["0", "0.5", "1", "1.5", "-0.5", "-1", "-1.5", "7.5"]);
  expect(["2", "-1.5", "+0.5", " 3 ", "0.5"].map(L.parseSignedHalfDays)).toEqual([4, -3, 1, 6, 1]);
  for (const bad of ["0", "-0", "0.0", "1.3", "", "abc", "1,5", "--1", "1.25", "99999"]) expect([bad, L.parseSignedHalfDays(bad)]).toEqual([bad, null]);
});

test("a request balance: a missing group is 0 only when the aggregate was complete", () => {
  const balances: L.Balances = { asOf: "2026-03-01T00:00:00.000Z", truncated: false, groups: [{ employeeId: "a", leaveType: "ANNUAL", halfDays: 6, entries: 3 }] };
  expect(L.balanceFor(balances, "a", "ANNUAL")).toBe(6);
  expect(L.balanceFor(balances, "a", "SICK")).toBeNull();
  expect(L.balanceAfter(balances, "a", "ANNUAL", 8)).toBe(-2);
  expect(L.balanceAfter(balances, "a", "SICK", 2)).toBe(-2);
  expect(L.balanceAfter({ ...balances, truncated: true }, "a", "SICK", 2)).toBeNull();
  expect(L.balanceAfter(balances, "a", "ANNUAL", null)).toBeNull();
});

test("batches are chunked within 200 items and the byte limit, in order, with nothing lost", () => {
  const entries = Array.from({ length: 450 }, (_, i): L.LedgerBatchItem => ({ record_id: `le-${String(i).padStart(12, "0")}`, table: "leave_entries", profile: { employee_id: `emp-${String(i).padStart(12, "0")}`, leave_type: "ANNUAL", half_days: 1, kind: "accrual", effective_date: "2026-03-31", source_ref: `accrual-emp-${String(i).padStart(12, "0")}-ANNUAL-2026-03`, note: null } }));
  const chunks = L.chunkBatch(entries);
  expect(chunks.flat()).toEqual(entries);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(200);
    expect(bytes({ items: chunk })).toBeLessThanOrEqual(L.BATCH_CHUNK_BYTES);
  }
  expect(chunks.length).toBeGreaterThan(450 / 200);
  // With the 49,152-byte limit these roughly 250-byte items are bound by bytes (under 200 per chunk); short items would be bound by the 200 cap.
  const wide = L.chunkBatch(entries, 200, 49152);
  expect(wide.flat().length).toBe(450);
  for (const chunk of wide) expect(bytes({ items: chunk })).toBeLessThanOrEqual(49152);
  const tiny = Array.from({ length: 450 }, (_, i): L.LedgerBatchItem => ({ record_id: `r${i}`, table: "t", profile: {} as L.LedgerEntry }));
  expect(L.chunkBatch(tiny, 200, 49152).map((c) => c.length)).toEqual([200, 200, 50]);
  // The tightest possible chunk: exactly at the limit is allowed, one byte under is not.
  const one = entries.slice(0, 1);
  expect(L.chunkBatch(one, 200, bytes({ items: one })).length).toBe(1);
  expect(() => L.chunkBatch(one, 200, bytes({ items: one }) - 1)).toThrow(RangeError);
  expect(L.chunkBatch([])).toEqual([]);
});
