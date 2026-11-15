// Pure staff self-service logic: Hong Kong time, the device CSV, the week view, what the staff view trusts, and the
// member's own rows. Run: bun test tests/unit/staff.test.ts
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);
const D = await import("../../src/domain/staff.ts");
const { FormError } = await import("../../src/domain/records.ts");
const { zhHK } = await import("../../src/features/hr/localeCatalog.ts");

const at = (date: string, time: string) => D.hkEpoch(date, time)!;
const directory = new Map([["E001", { id: "emp-amy", memberId: "usr_amy" }], ["E002", { id: "emp-ben", memberId: null }]]);

test("Hong Kong time: a punch reads the same on every device, and days and weeks start in Hong Kong", () => {
  expect(at("2026-11-16", "09:02")).toBe(Date.UTC(2026, 10, 16, 1, 2) / 1000);
  expect(D.hkParts(at("2026-11-16", "00:30"))).toEqual({ date: "2026-11-16", time: "00:30", weekday: 0 });
  expect(D.hkParts(at("2026-11-15", "23:59"))).toMatchObject({ date: "2026-11-15", weekday: 6 });
  expect(D.hkDayStart(at("2026-11-16", "18:00"))).toBe(at("2026-11-16", "00:00"));
  expect(D.hkWeekStart(at("2026-11-19", "10:00"))).toBe(at("2026-11-16", "00:00"));
  expect(D.hkEpoch("2026-02-30", "09:00")).toBeNull();
  expect(D.hkEpoch("2026-11-16", "24:00")).toBeNull();
  expect(D.addDays("2026-12-31", 1)).toBe("2027-01-01");
});

test("the device CSV: header skipped, each line a status, times in Hong Kong, the same punch the same id", () => {
  const lines = D.parsePunchCsv([
    "﻿employee_no,timestamp,direction",
    "e001, 2026-11-16 09:02 , In",
    "\"E001\",\"2026-11-16 18:10:30\",\"OUT\"",
    "E002;2026-11-16T08:55;i",
    "",
    "E003,2026-11-16 09:00,in",
    "E001,16/11/2026 09:00,in",
    "E001,2026-11-16 09:00,break",
    "E001,2026-11-16 09:02,in",
    "E!,2026-11-16 09:00,in",
    "E001,2026-11-16",
  ].join("\r\n"), directory, new Set([D.importId("E002", at("2026-11-16", "08:55"), "in")]));
  expect(lines.map((l) => [l.line, l.status])).toEqual([[2, "new"], [3, "new"], [4, "already"], [6, "unknown_employee"], [7, "invalid"], [8, "invalid"], [9, "duplicate"], [10, "invalid"], [11, "invalid"]]);
  expect(lines[0]).toMatchObject({ employeeNo: "E001", at: at("2026-11-16", "09:02"), direction: "in", employeeId: "emp-amy", memberId: "usr_amy" });
  expect(lines[1]!.at).toBe(at("2026-11-16", "18:10") + 30);
  expect(lines[2]).toMatchObject({ employeeId: "emp-ben", memberId: D.NO_MEMBER });
  expect(lines[0]!.recordId).toBe(D.importId("E001", at("2026-11-16", "09:02"), "in"));
  expect(lines[0]!.recordId).toMatch(/^imp-[0-9a-f]{16}$/);
  expect(D.importId("E001", 1, "in")).not.toBe(D.importId("E001", 1, "out"));
  // An imported punch for an unlinked employee carries no member: nobody's staff view shows it.
  expect(D.importProfile({ ...lines[2]!, status: "new" })).toMatchObject({ member_id: "-", method: "import", client_ref: lines[2]!.recordId, lat_e7: null });
  expect(() => D.importProfile(lines[3]!)).toThrow();
  expect(() => D.parsePunchCsv(Array.from({ length: 5001 }, () => "E001,2026-11-16 09:00,in").join("\n"), directory)).toThrow(FormError);
  // Every reason the preview shows has its zh-HK text.
  for (const l of lines) if (l.reason) expect(zhHK[l.reason]).toBeTruthy();
});

test("a correction is a new punch that says why, never an edit", () => {
  const amy = { id: "emp-amy", memberId: "usr_amy" };
  expect(D.correctionProfile(amy, { date: "2026-11-16", time: "08:58", direction: "in", note: " Forgot " }, "cor-1")).toEqual({
    employee_id: "emp-amy", member_id: "usr_amy", at: at("2026-11-16", "08:58"), direction: "in", method: "correction", lat_e7: null, lng_e7: null, accuracy_m: null, note: "Forgot", client_ref: "cor-1",
  });
  expect(() => D.correctionProfile(amy, { date: "2026-11-16", time: "08:58", direction: "in", note: "" }, "cor-1")).toThrow(/why/);
  expect(() => D.correctionProfile(amy, { date: "2026-13-01", time: "08:58", direction: "in", note: "x" }, "cor-1")).toThrow(/YYYY-MM-DD/);
  expect(() => D.correctionProfile(amy, { date: "2026-11-16", time: "8am", direction: "in", note: "x" }, "cor-1")).toThrow(/HH:MM/);
  expect(D.correctionProfile({ id: "emp-ben", memberId: null }, { date: "2026-11-16", time: "08:58", direction: "out", note: "x" }, "cor-2").member_id).toBe("-");
});

test("who wrote a punch comes from its record id, not from its method column", () => {
  expect(D.punchKind("imp-0123456789abcdef")).toBe("import");
  expect(D.punchKind("cor-0123456789ab")).toBe("correction");
  expect(D.punchKind("mem_" + "0".repeat(32))).toBe("app");
  expect(D.readPunch({ id: "mem_1", profile: { employee_id: "emp-amy", member_id: "usr_amy", at: 1794790920, direction: "in", method: "import" } })).toMatchObject({ kind: "app" });
  expect(D.readPunch({ id: "mem_1", profile: { employee_id: "emp-amy", member_id: "usr_amy", at: 1794790920, direction: "sideways" } })).toBeNull();
});

test("the clock button and the week: out after an in today; missing clock-outs and leave days are shown", () => {
  const p = (date: string, time: string, direction: "in" | "out") => ({ id: `mem_${date}${time}`, employeeId: "emp-amy", memberId: "usr_amy", at: at(date, time), direction, kind: "app" as const, note: null });
  const now = at("2026-11-18", "12:00");
  expect(D.nextDirection([], now)).toBe("in");
  expect(D.nextDirection([p("2026-11-18", "09:02", "in")], now)).toBe("out");
  expect(D.nextDirection([p("2026-11-18", "09:02", "in"), p("2026-11-18", "11:00", "out")], now)).toBe("in");
  expect(D.nextDirection([p("2026-11-17", "09:02", "in")], now)).toBe("in"); // yesterday's open punch does not carry over
  const week = D.daySummary(
    [p("2026-11-16", "09:05", "in"), p("2026-11-16", "18:12", "out"), p("2026-11-18", "08:58", "in"), p("2026-11-19", "08:58", "in")],
    [{ start: "2026-11-17", end: "2026-11-17", leaveType: "SICK" }], "2026-11-16", "2026-11-19", "2026-11-19",
  );
  expect(week.map((d) => [d.date, d.firstIn !== null, d.lastOut !== null, d.missingOut, d.leaveType])).toEqual([
    ["2026-11-16", true, true, false, null], ["2026-11-17", false, false, false, "SICK"], ["2026-11-18", true, false, true, null], ["2026-11-19", true, false, false, null],
  ]);
});

test("the staff view trusts only snapshots the owner's screen named, newest first", () => {
  const snap = (id: string, asOf: number, over: Record<string, unknown> = {}) => ({ id, profile: { member_id: "usr_amy", employee_id: "emp-amy", employee_name: "Amy Chan", employee_no: "E001", as_of: asOf, leave: D.snapshotLeave([{ code: "ANNUAL", name: "Annual leave" }], [{ leaveType: "ANNUAL", halfDays: 17 }], false), ...over } });
  expect(D.latestSnapshot([snap("snap-a", 10), snap("snap-b", 20)])!.id).toBe("snap-b");
  expect(D.latestSnapshot([snap("snap-a", 10), snap("mem_" + "f".repeat(32), 99)])!.id).toBe("snap-a");
  expect(D.latestSnapshot([snap("mem_x", 99)])).toBeNull();
  expect(D.latestSnapshot([snap("snap-a", 10, { leave: { v: 2 } })])).toBeNull(); // a shape the screen never writes
  const s = D.latestSnapshot([snap("snap-a", 10)])!;
  expect(s).toMatchObject({ employeeId: "emp-amy", balances: [{ leaveType: "ANNUAL", halfDays: 17 }], types: [{ code: "ANNUAL", name: "Annual leave" }] });
  expect(D.isLinked(s)).toBe(true);
  expect(D.isLinked(D.latestSnapshot([snap("snap-c", 30, { employee_id: null, leave: null })]))).toBe(false);
});

test("a member's rows: pending or submitted, undecided, for their linked employee, with no owner column", () => {
  const s = D.latestSnapshot([{ id: "snap-a", profile: { member_id: "usr_amy", employee_id: "emp-amy", employee_name: "Amy Chan", employee_no: "E001", as_of: 1, leave: D.snapshotLeave([{ code: "ANNUAL", name: "Annual" }], [], false) } }])! as Parameters<typeof D.memberLeaveProfile>[0];
  const leave = D.memberLeaveProfile(s, { leaveType: "annual", startDate: "2026-12-22", endDate: "2026-12-23", days: "1.5", reason: "" }, "slv-1");
  expect(leave).toEqual({ leave_type: "ANNUAL", start_date: "2026-12-22", end_date: "2026-12-23", half_days: 3, reason: "", employee_id: "emp-amy", employee_name: "Amy Chan", status: "pending", decided_on: null, decision_note: null, client_ref: "slv-1" });
  expect(() => D.memberLeaveProfile(s, { leaveType: "SICK", startDate: "2026-12-22", endDate: "2026-12-22", days: "1", reason: "" }, "slv-1")).toThrow(/from the list/);
  expect(() => D.memberLeaveProfile(s, { leaveType: "ANNUAL", startDate: "2026-12-22", endDate: "2026-12-22", days: "2", reason: "" }, "slv-1")).toThrow(FormError);
  const claim = D.memberClaimProfile(s, { category: "meals", claimDate: "2026-11-03", amount: "420", merchant: "Harbour Cafe", description: "" }, "scl-1");
  expect(claim).toMatchObject({ amount_minor: 42000, currency: "HKD", receipt_ref: null, status: "submitted", employee_id: "emp-amy", client_ref: "scl-1" });
  for (const row of [leave, claim, D.memberPunchProfile(s, "in", 1794790920, "app-1")]) expect("member_id" in row).toBe(false);
  expect(D.memberStatus({ status: "pending" }, true)).toBe("withdrawn");
  expect(D.memberStatus({ status: "rejected" }, true)).toBe("rejected");
  expect(D.memberStatus({ status: "odd" }, false)).toBe("unknown");
  expect(D.memberCode("usr_1fa8e0cd-80d1-4ee2-a643-616f25cb0a0f")).toBe("25CB0A0F");
  expect(D.storableMemberId("usr_1fa8e0cd-80d1-4ee2-a643-616f25cb0a0f")).toBe(true);
  expect(D.storableMemberId("user@example.invalid")).toBe(false);
});

test("the staff view's bar names the package version, and every staff string has its zh-HK text", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
  const screen = readFileSync(fileURLToPath(new URL("../../src/features/hr/StaffScreen.tsx", import.meta.url)), "utf8");
  expect(screen).toContain(`export const APP_VERSION = "${pkg.version}";`);
  const domain = readFileSync(fileURLToPath(new URL("../../src/domain/staff.ts", import.meta.url)), "utf8");
  const found = [...domain.matchAll(/FormError\([^,]+, "([^"]+)"/g), ...domain.matchAll(/bad\("([^"]+)"\)/g), ...domain.matchAll(/reason: "([^"]+)"/g)].map((m) => m[1]!);
  for (const file of ["StaffScreen.tsx", "AttendancePane.tsx", "StaffAccounts.tsx", "staff.ts"]) {
    const text = readFileSync(fileURLToPath(new URL(`../../src/features/hr/${file}`, import.meta.url)), "utf8");
    for (const m of text.matchAll(/\bt\("([^"]+)"/g)) found.push(m[1]!);
    for (const m of text.matchAll(/\? "([^"]+)" : "([^"]+)"/g)) found.push(m[1]!, m[2]!);
    for (const m of text.matchAll(/_TEXT = "([^"]+)"/g)) found.push(m[1]!);
    for (const b of text.matchAll(/_LABEL[^=]*=\s*\{([^}]*)\}/g)) for (const m of b[1]!.matchAll(/:\s*"([^"]+)"/g)) found.push(m[1]!);
  }
  expect(found.length).toBeGreaterThan(80);
  const missing = found.filter((s) => !(s in zhHK) && !/^[a-z_]+$|^(hr-|HH:MM|YYYY|Withdrawn by)/.test(s));
  if (missing.length) console.log(JSON.stringify(missing));
  expect(missing).toEqual([]);
});
