// Pure directory logic and the zh-HK catalog. No host, DOM or React.
// Run: bun test tests/unit/people.test.ts

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildProfile, changedFields, classifyWriteFailure, EMPTY_FORM, findDuplicate, formFromProfile, FormError, newEmployeeId, realDate, viewProfile,
  type EmployeeForm,
} from "../../src/domain/people.ts";
import { zhHK } from "../../src/features/hr/localeCatalog.ts";

const valid: EmployeeForm = { ...EMPTY_FORM, displayName: "  Ada Example ", employeeNo: "E-0001", email: "ada@example.invalid", phone: "+852 5550 0101", jobTitle: "Analyst", department: "Finance", joinDate: "2026-01-31" };
const problem = (patch: Partial<EmployeeForm>) => { try { buildProfile({ ...valid, ...patch }); } catch (e) { return e instanceof FormError ? [e.field, e.message] : e; } return null; };

test("a valid form becomes the profile fields, trimmed, with blank optionals as null", () => {
  expect(buildProfile(valid)).toEqual({
    display_name: "Ada Example", employee_no: "E-0001", email: "ada@example.invalid", phone: "+852 5550 0101", job_title: "Analyst", department: "Finance",
    employment_type: "full_time", join_date: "2026-01-31", leave_date: null, status: "active",
  });
  expect(buildProfile({ ...valid, email: "", phone: "" })).toMatchObject({ email: null, phone: null });
  expect(buildProfile({ ...valid, joinDate: "" })).toMatchObject({ join_date: null });
});

test("employee numbers are stored in capitals", () => {
  expect(buildProfile({ ...valid, employeeNo: " e-0001 " }).employee_no).toBe("E-0001");
  expect(problem({ employeeNo: "é-1" })?.[0]).toBe("employeeNo");
});

test("each bad field is refused under its own field name", () => {
  expect(problem({ displayName: "  " })?.[0]).toBe("displayName");
  expect(problem({ employeeNo: "" })?.[0]).toBe("employeeNo");
  expect(problem({ employeeNo: "E 001" })?.[0]).toBe("employeeNo");
  expect(problem({ employeeNo: "E".repeat(33) })?.[0]).toBe("employeeNo");
  expect(problem({ email: "not-an-address" })?.[0]).toBe("email");
  expect(problem({ phone: "12" })?.[0]).toBe("phone");
  expect(problem({ joinDate: "2026-02-30" })?.[0]).toBe("joinDate");
  expect(problem({ leaveDate: "2025-12-31" })?.[0]).toBe("leaveDate");
  expect(problem({ leaveDate: "soon" })?.[0]).toBe("leaveDate");
  expect(problem({ employmentType: "Zero Hours" })?.[0]).toBe("employmentType");
  expect(problem({ employmentType: "grade_2" })).toBeNull();
  expect(problem({ status: "GONE" })?.[0]).toBe("status");
  expect(problem({ leaveDate: "2026-06-30", status: "left" })).toBeNull();
});

test("dates are real calendar days", () => {
  expect(realDate("2028-02-29")).toBe(true);
  expect(realDate("2026-02-29")).toBe(false);
  expect(realDate("2026-13-01")).toBe(false);
  expect(realDate("26-01-01")).toBe(false);
});

test("a profile reads defensively and round-trips through the form", () => {
  const view = viewProfile({ display_name: "Ben Sample", employee_no: "E-2", email: null, employment_type: "weird", status: "on_leave", join_date: "2026-03-01", leave_date: "" });
  expect(view).toMatchObject({ displayName: "Ben Sample", email: null, employmentType: "weird", status: "on_leave", leaveDate: null, joinDate: "2026-03-01" });
  expect(viewProfile({ join_date: null }).joinDate).toBeNull();
  // A stored value outside the screen's list survives a round trip through the form.
  expect(buildProfile(formFromProfile({ ...buildProfile(valid), employment_type: "zero_hours", status: "seconded" }))).toMatchObject({ employment_type: "zero_hours", status: "seconded" });
  expect(viewProfile(null).displayName).toBe("");
  expect(viewProfile("text").employeeNo).toBe("");
  const profile = buildProfile(valid);
  expect(buildProfile(formFromProfile(profile))).toEqual(profile);
});

test("an update carries only the fields that changed", () => {
  const before = buildProfile(valid);
  expect(changedFields(before, buildProfile(valid))).toEqual({});
  expect(changedFields(before, buildProfile({ ...valid, jobTitle: "Senior analyst", email: "" }))).toEqual({ job_title: "Senior analyst", email: null });
});

test("record ids satisfy the host's grammar and differ between forms", () => {
  const a = newEmployeeId(), b = newEmployeeId();
  expect(a).toMatch(/^emp-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
  expect(newEmployeeId((bytes) => bytes.fill(0xab))).toBe("emp-abababababab");
});

test("a duplicate employee number is an exact match on another row", () => {
  const rows = [{ id: "emp-1", profile: { employee_no: "E-0001" } }, { id: "emp-2", profile: { employee_no: "E-00010" } }];
  expect(findDuplicate(rows, "E-0001", null)?.id).toBe("emp-1");
  expect(findDuplicate(rows, " E-0001 ", null)?.id).toBe("emp-1");
  expect(findDuplicate(rows, "E-0001", "emp-1")).toBeNull();
  expect(findDuplicate(rows, "E-000", null)).toBeNull();
  expect(findDuplicate(rows, "e-0001", null)).toBeNull();
});

test("write refusals are classified by what the frame can tell", () => {
  // The board narrows a host error to unauthorized/forbidden/not_found/conflict/unavailable/failed by HTTP status.
  expect(classifyWriteFailure({ status: 409, code: "stale_revision" }, "update")).toBe("stale");
  expect(classifyWriteFailure({ status: 409, code: "conflict" }, "update")).toBe("changed");
  // A 409 on create follows a clean pre-check: most often a retry of a create that landed, never a "duplicate".
  expect(classifyWriteFailure({ status: 409, code: "conflict" }, "create")).toBe("maybe_saved");
  expect(classifyWriteFailure({ status: 503, code: "unavailable" }, "create")).toBe("store_unavailable");
  expect(classifyWriteFailure({ status: 504 }, "update")).toBe("timeout");
  expect(classifyWriteFailure({ status: 401, code: "unauthorized" }, "update")).toBe("session");
  expect(classifyWriteFailure({ status: 400, code: "failed" }, "create")).toBe("rejected");
  expect(classifyWriteFailure({ status: 403, code: "forbidden" }, "update")).toBe("neutral");
  expect(classifyWriteFailure({ status: 500 }, "update")).toBe("neutral");
  expect(classifyWriteFailure(null, "create")).toBe("neutral");
});

test("every English string the screen translates has a zh-HK entry", () => {
  const dir = fileURLToPath(new URL("../../src/", import.meta.url));
  const files = [...readdirSync(dir + "features/hr").filter((f) => /\.tsx?$/.test(f) && f !== "localeCatalog.ts").map((f) => dir + "features/hr/" + f), dir + "domain/people.ts"];
  const found = new Set<string>();
  const literal = '"((?:[^"\\\\]|\\\\.)*)"';
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(new RegExp(`\\bt\\(${literal}\\)`, "g"))) found.add(m[1]!);
    for (const m of source.matchAll(new RegExp(`FormError\\([^,]+,\\s*${literal}`, "g"))) found.add(m[1]!);
    for (const m of source.matchAll(new RegExp(`\\b[A-Z_]+_TEXT\\s*=\\s*${literal}`, "g"))) found.add(m[1]!);
    for (const m of source.matchAll(new RegExp(`(?:hint|title|label|placeholder): "([^"]+)"`, "g"))) found.add(m[1]!);
    for (const block of source.matchAll(/(?:TYPE_LABEL|STATUS_LABEL|TEXT)[^=]*=\s*\{([^}]*)\}/g)) for (const m of block[1]!.matchAll(new RegExp(`:\\s*${literal}`, "g"))) found.add(m[1]!);
    for (const m of source.matchAll(new RegExp(`t\\([a-z]+ \\? ${literal} : ${literal}`, "g"))) { found.add(m[1]!); found.add(m[2]!); }
    for (const m of source.matchAll(new RegExp(`t\\(committed === "" \\? ${literal} : ${literal}`, "g"))) { found.add(m[1]!); found.add(m[2]!); }
    for (const m of source.matchAll(new RegExp(`t\\(canWrite \\? ${literal} : ${literal}`, "g"))) { found.add(m[1]!); found.add(m[2]!); }
    for (const m of source.matchAll(new RegExp(`t\\(records.length === 1 \\? ${literal} : ${literal}`, "g"))) { found.add(m[1]!); found.add(m[2]!); }
  }
  // Values a person types or a format, not words: they are shown as they are.
  const exempt = new Set(["name@example.com", "YYYY-MM-DD", "2026-01-31", "—"]);
  const missing = [...found].filter((s) => !exempt.has(s) && !(s in zhHK));
  expect(missing).toEqual([]);
  expect(found.size).toBeGreaterThan(40);
  // Placeholders survive translation and no entry is an empty or untranslated copy.
  for (const [english, chinese] of Object.entries(zhHK)) {
    expect(chinese.length).toBeGreaterThan(0);
    for (const slot of english.match(/\{[a-z]+\}/g) ?? []) expect(chinese).toContain(slot);
  }
});
