// Pure record logic and the write paths of the four new tabs, against a fake call function.
// Each test fails if the behaviour it names is reverted. Run: bun test tests/unit/records.test.ts
import { expect, mock, test } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);

const R = await import("../../src/domain/records.ts");
const { createHostActions } = await import("../../src/features/hr/hostActions.ts");
const S = await import("../../src/features/hr/recordsSubmit.ts");

const scope = { installId: "install-test", digest: "sha256:" + "a".repeat(64) };
const row = (id: string, profile: Record<string, unknown>, revision = 1) => ({ id, revision, digest: "sha256:x", profile, history: [] });
const page = (...rows: ReturnType<typeof row>[]) => ({ records: rows, total: rows.length, truncated: false, next_cursor: null });
type Call = { verb: string; args: Record<string, unknown> };
function fake(replies: unknown[]) {
  const calls: Call[] = [];
  const actions = createHostActions(async (_s, verb, args) => {
    calls.push({ verb, args: args as Record<string, unknown> });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { actions, calls };
}
const rec = (id: string, profile: Record<string, unknown>, revision = 1) => ({ record: row(id, profile, revision) });
const ada = row("emp-1", { employee_no: "E-001", display_name: "Ada Sample" });
const annual = row("lt-1", { code: "ANNUAL" });
const leaveForm = { employeeNo: "e-001", leaveType: "annual", startDate: "2026-03-02", endDate: "2026-03-03", days: "2", reason: "" };
const claimForm = { employeeNo: "E-001", claimDate: "2026-03-02", category: "meals", merchant: "Sample Cafe", amount: "12.50", currency: "HKD", description: "", receiptRef: "" };

test("money is exact integer minor units and refuses anything inexact", () => {
  expect(R.toMinor("12.50", "HKD")).toBe(1250);
  expect(R.toMinor("12.5", "HKD")).toBe(1250);
  expect(R.toMinor("0.07", "HKD")).toBe(7);
  expect(R.toMinor("12.505", "HKD")).toBeNull();
  expect(R.toMinor("0", "HKD")).toBeNull();
  expect(R.toMinor("-1", "HKD")).toBeNull();
  expect(R.toMinor("1e3", "HKD")).toBeNull();
  expect(R.toMinor("1200", "JPY")).toBe(1200);
  expect(R.toMinor("12.5", "JPY")).toBeNull();
  expect(R.fromMinor(1205, "HKD")).toBe("12.05");
});

test("leave is whole or half days stored as half days", () => {
  expect(R.toHalfDays("1")).toBe(2);
  expect(R.toHalfDays("1.5")).toBe(3);
  expect(R.toHalfDays("0.5")).toBe(1);
  expect(R.toHalfDays("0")).toBeNull();
  expect(R.toHalfDays("1.3")).toBeNull();
  expect(R.toHalfDays("2.50")).toBeNull();
  expect(R.fromHalfDays(3)).toBe("1.5");
  expect(R.inclusiveDays("2026-03-02", "2026-03-04")).toBe(3);
  expect(R.inclusiveDays("2026-03-04", "2026-03-02")).toBeNull();
  expect(R.inclusiveDays("2026-02-30", "2026-03-02")).toBeNull();
});

test("a leave request profile carries half days, a capitalised type code and no employee yet", () => {
  const profile = R.buildProfile(R.LEAVE_REQUEST, leaveForm);
  expect(profile).toEqual({ leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, reason: "" });
  expect(() => R.buildProfile(R.LEAVE_REQUEST, { ...leaveForm, startDate: "2026-02-30" })).toThrow(R.FormError);
  expect(() => R.buildProfile(R.LEAVE_REQUEST, { ...leaveForm, days: "1.2" })).toThrow(R.FormError);
  expect(() => R.checkRequestDates({ ...leaveForm, endDate: "2026-03-01" })).toThrow(R.FormError);
  expect(() => R.buildProfile(R.LEAVE_REQUEST, { ...leaveForm, leaveType: "an nual" })).toThrow(R.FormError);
});

test("a claim profile stores an integer amount with its currency and null for a blank receipt", () => {
  const profile = R.buildProfile(R.CLAIM, claimForm);
  expect(profile.amount_minor).toBe(1250);
  expect(profile.currency).toBe("HKD");
  expect(profile.receipt_ref).toBeNull();
  expect(Number.isInteger(profile.amount_minor)).toBe(true);
  expect(() => R.buildProfile(R.CLAIM, { ...claimForm, amount: "12.505" })).toThrow(R.FormError);
  expect(() => R.buildProfile(R.CLAIM, { ...claimForm, currency: "hkd" })).toThrow(R.FormError);
  expect(() => R.buildProfile(R.CLAIM, { ...claimForm, claimDate: "" })).toThrow(R.FormError);
});

test("a policy needs a real effective date and a bounded body; a candidate email and phone are checked", () => {
  const policy = { title: "Annual leave", category: "leave", language: "en", effectiveFrom: "2026-01-01", status: "current", body: "Sample text." };
  expect(R.buildProfile(R.POLICY, policy).effective_from).toBe("2026-01-01");
  expect(() => R.buildProfile(R.POLICY, { ...policy, effectiveFrom: "2026-13-01" })).toThrow(R.FormError);
  expect(() => R.buildProfile(R.POLICY, { ...policy, body: "x".repeat(12001) })).toThrow(R.FormError);
  const cand = { displayName: "Sam Sample", email: "", phone: "", source: "", cvText: "" };
  expect(R.buildProfile(R.CANDIDATE, cand)).toMatchObject({ email: null, phone: null });
  expect(() => R.buildProfile(R.CANDIDATE, { ...cand, email: "nope" })).toThrow(R.FormError);
  expect(() => R.buildProfile(R.CANDIDATE, { ...cand, phone: "123" })).toThrow(R.FormError);
});

test("the form shows what is stored, so an edit sends only real changes", () => {
  const profile = { leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 3, reason: "" };
  const values = R.viewValues(R.LEAVE_REQUEST, profile);
  expect(values.days).toBe("1.5");
  expect(R.changedFields(profile, R.buildProfile(R.editable(R.LEAVE_REQUEST), values))).toEqual({});
  expect(R.changedFields(profile, R.buildProfile(R.editable(R.LEAVE_REQUEST), { ...values, days: "2" }))).toEqual({ half_days: 4 });
});

test("the employee lookup is one exact eq filter, two rows at most, and a failed lookup is never 'not found'", async () => {
  const { actions, calls } = fake([page(ada)]);
  const found = await R.resolveEmployee((a) => actions.list(scope, a), "e-001");
  expect(found).toEqual({ id: "emp-1", name: "Ada Sample" });
  expect(calls).toEqual([{ verb: "records.list", args: { filters: [{ field: "employee_no", op: "eq", value: "E-001" }], limit: 2 } }]);
  await expect(R.resolveEmployee((a) => fake([page()]).actions.list(scope, a), "E-404")).rejects.toBeInstanceOf(R.FormError);
  await expect(R.resolveEmployee((a) => fake([page(ada, row("emp-2", { employee_no: "E-001" }))]).actions.list(scope, a), "E-001")).rejects.toBeInstanceOf(R.FormError);
  // A substring hit is not an exact match.
  await expect(R.resolveEmployee((a) => fake([page(row("emp-9", { employee_no: "E-0010" }))]).actions.list(scope, a), "E-001")).rejects.toBeInstanceOf(R.FormError);
  const failing = fake([new ApiError("unavailable", 503, { code: "unavailable" })]);
  await expect(R.resolveEmployee((a) => failing.actions.list(scope, a), "E-001")).rejects.toMatchObject({ status: 503 });
});

test("creating a leave request looks up the employee and the type first, then writes one create with the table", async () => {
  const { actions, calls } = fake([page(ada), page(annual), rec("lv-1", { status: "pending" })]);
  await S.createRecord(scope, R.LEAVE_REQUEST, "lv-abc", leaveForm, {}, actions);
  expect(calls.map((c) => [c.verb, c.args.table])).toEqual([["records.list", undefined], ["records.list", "leave_types"], ["records.create", "leave_requests"]]);
  expect(calls[1]!.args.filters).toEqual([{ field: "code", op: "eq", value: "ANNUAL" }]);
  expect(calls[2]!.args).toEqual({ table: "leave_requests", record_id: "lv-abc", profile: { leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, reason: "", employee_id: "emp-1", employee_name: "Ada Sample" } });
  expect("status" in (calls[2]!.args.profile as object)).toBe(false);
});

test("no write happens when a lookup fails or finds nothing", async () => {
  const unknownType = fake([page(ada), page()]);
  await expect(S.createRecord(scope, R.LEAVE_REQUEST, "lv-abc", leaveForm, {}, unknownType.actions)).rejects.toBeInstanceOf(R.FormError);
  expect(unknownType.calls.some((c) => c.verb === "records.create")).toBe(false);
  const down = fake([new ApiError("unavailable", 503, { code: "unavailable" })]);
  await expect(S.createRecord(scope, R.CLAIM, "cl-abc", claimForm, {}, down.actions)).rejects.toMatchObject({ status: 503 });
  expect(down.calls.some((c) => c.verb === "records.create")).toBe(false);
});

test("a leave type code is checked for a duplicate except against its own row", async () => {
  const form = { code: "annual", name: "Annual leave", paid: "yes" };
  const dup = fake([page(annual)]);
  await expect(S.createRecord(scope, R.LEAVE_TYPE, "lt-new", form, {}, dup.actions)).rejects.toMatchObject({ field: "code", message: R.DUPLICATE_CODE_TEXT });
  const ok = fake([page(), rec("lt-new", {})]);
  await S.createRecord(scope, R.LEAVE_TYPE, "lt-new", form, {}, ok.actions);
  expect(ok.calls[1]!.args).toMatchObject({ table: "leave_types", profile: { code: "ANNUAL", name: "Annual leave", paid: true } });
  const own = fake([page(annual), rec("lt-1", {})]);
  const record = { ...row("lt-1", { code: "OLD", name: "x", paid: true }), history: [] };
  await S.updateRecord(scope, R.LEAVE_TYPE, record, { code: "annual", name: "x", paid: "yes" }, own.actions);
  expect(own.calls[1]!.args).toEqual({ table: "leave_types", record_id: "lt-1", expected_revision: 1, profile: { code: "ANNUAL" } });
});

test("a candidate create carries the chosen opening", async () => {
  const { actions, calls } = fake([rec("cand-1", {})]);
  await S.createRecord(scope, R.CANDIDATE, "cand-abc", { displayName: "Sam Sample", email: "", phone: "", source: "", cvText: "" }, { opening_id: "job-1" }, actions);
  expect((calls[0]!.args.profile as Record<string, unknown>).opening_id).toBe("job-1");
  expect(calls[0]!.args.table).toBe("candidates");
});

test("an update names the revision and sends only changed fields; no change sends nothing", async () => {
  const record = row("cl-1", { claim_date: "2026-03-02", category: "meals", merchant: "Sample Cafe", amount_minor: 1250, currency: "HKD", description: "", receipt_ref: null }, 4);
  const values = R.viewValues(R.CLAIM, record.profile);
  const same = fake([]);
  expect(await S.updateRecord(scope, R.CLAIM, record, values, same.actions)).toBeNull();
  expect(same.calls).toEqual([]);
  const changed = fake([rec("cl-1", {}, 5)]);
  await S.updateRecord(scope, R.CLAIM, record, { ...values, amount: "13.00" }, changed.actions);
  expect(changed.calls).toEqual([{ verb: "records.update", args: { table: "claims", record_id: "cl-1", expected_revision: 4, profile: { amount_minor: 1300 } } }]);
});

test("an owner decision writes status, date and note only, and a stage move writes the stage only", async () => {
  const record = row("lv-1", { status: "pending" }, 2);
  const a = fake([rec("lv-1", {}, 3)]);
  await S.decide(scope, R.LEAVE_REQUEST, record, "approved", "2026-03-05", "", a.actions);
  expect(a.calls[0]!.args).toEqual({ table: "leave_requests", record_id: "lv-1", expected_revision: 2, profile: { status: "approved", decided_on: "2026-03-05", decision_note: null } });
  const b = fake([rec("lv-1", {}, 3)]);
  await S.decide(scope, R.LEAVE_REQUEST, record, "rejected", "2026-03-05", "  Not covered  ", b.actions);
  expect((b.calls[0]!.args.profile as Record<string, unknown>).decision_note).toBe("Not covered");
  expect(() => R.decisionPatch("rejected", "2026-03-05", "x".repeat(501))).toThrow(R.FormError);
  const c = fake([rec("cand-1", {}, 2)]);
  await S.setField(scope, R.CANDIDATE, row("cand-1", { stage: "new" }), "stage", "interview", c.actions);
  expect(c.calls[0]!.args).toEqual({ table: "candidates", record_id: "cand-1", expected_revision: 1, profile: { stage: "interview" } });
});

test("failure wording claims only what the frame can know", () => {
  const t = (s: string) => s;
  const kind = (status: number, code: string | undefined, op: "create" | "update") => S.problemFor(new ApiError("x", status, code ? { code } : undefined), op, t).kind;
  expect(kind(409, "conflict", "create")).toBe("maybe_saved");
  expect(kind(409, "conflict", "update")).toBe("changed");
  expect(kind(400, "failed", "update")).toBe("rejected");
  expect(kind(403, "forbidden", "update")).toBe("forbidden");
  expect(kind(503, "unavailable", "create")).toBe("store_unavailable");
  expect(kind(504, undefined, "update")).toBe("timeout");
  // A 400 reaches the frame from a field refusal and from a write rule alike: it never says "duplicate" or "already decided" as fact.
  const text = S.problemFor(new ApiError("x", 400, { code: "failed" }), "update", t).message;
  expect(text).not.toMatch(/duplicate/i);
  expect(text).toMatch(/may already be decided/);
  expect(S.problemFor(new R.FormError("amount", "Fill in this field."), "create", t)).toMatchObject({ field: "amount", kind: "form" });
});

test("the zh-HK catalogue covers every label, hint, option, message and refusal text", async () => {
  const { zhHK } = await import("../../src/features/hr/localeCatalog.ts");
  const { optionLabel } = R;
  const strings = new Set<string>();
  for (const spec of [R.POLICY, R.LEAVE_TYPE, R.LEAVE_REQUEST, R.CLAIM, R.OPENING, R.CANDIDATE]) {
    strings.add(optionLabel(spec.noun));
    for (const f of spec.fields) { strings.add(f.label.replace(" (optional)", "")); strings.add(f.label); if (f.hint) strings.add(f.hint); for (const o of f.options ?? []) strings.add(optionLabel(o)); }
  }
  for (const v of [...R.STAGES, "pending", "approved", "rejected", "cancelled", "submitted", "paid"]) strings.add(optionLabel(v));
  for (const m of Object.values(S.TEXT)) strings.add(m);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/domain/records.ts", import.meta.url), "utf8");
  for (const m of src.matchAll(/FormError\([^,]+, "([^"]+)"/g)) strings.add(m[1]!);
  for (const file of ["RecordsPane.tsx", "Sections.tsx", "HrScreen.tsx", "views.tsx"]) {
    const text = readFileSync(new URL(`../../src/features/hr/${file}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/\bt\("([^"]+)"\)/g)) strings.add(m[1]!);
    for (const m of text.matchAll(/(?:title|newLabel|searchHint|blockedNew): "([^"]+)"/g)) strings.add(m[1]!);
    for (const m of text.matchAll(/^const TAB_LABEL.*$/gm)) for (const w of m[0].matchAll(/: "([^"]+)"/g)) strings.add(w[1]!);
  }
  strings.add("Reject…"); strings.add("All");
  const missing = [...strings].filter((s) => s !== "—" && !(s in zhHK));
  expect(missing).toEqual([]);
});
