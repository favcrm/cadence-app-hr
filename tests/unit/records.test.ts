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

test("three-decimal currencies keep their third decimal, and a stored amount reads back unchanged", () => {
  for (const cur of ["KWD", "BHD", "OMR", "JOD", "TND", "IQD", "LYD"]) expect([cur, R.toMinor("1.234", cur)]).toEqual([cur, 1234]);
  expect(R.toMinor("1.5", "KWD")).toBe(1500);
  expect(R.toMinor("12.50", "KWD")).toBe(12500);
  expect(R.toMinor("1.2345", "KWD")).toBeNull();
  expect(R.fromMinor(1234, "KWD")).toBe("1.234");
  expect(R.fromMinor(5, "BHD")).toBe("0.005");
  const stored = { claim_date: "2026-03-02", category: "meals", merchant: "Sample Cafe", amount_minor: 12345, currency: "KWD", description: "", receipt_ref: null };
  const values = R.viewValues(R.CLAIM, stored);
  expect(values.amount).toBe("12.345");
  expect(R.changedFields(stored, R.buildProfile(R.editable(R.CLAIM), values))).toEqual({});
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

test("the days of leave fit inside the span: at most two half days per calendar day, inclusive", () => {
  const span = (startDate: string, endDate: string, days: string) => () => R.checkRequestDates({ ...leaveForm, startDate, endDate, days });
  expect(span("2026-03-02", "2026-03-03", "2")).not.toThrow();
  expect(span("2026-03-02", "2026-03-03", "1.5")).not.toThrow();
  expect(span("2026-03-02", "2026-03-02", "1")).not.toThrow();
  expect(span("2026-03-02", "2026-03-02", "0.5")).not.toThrow();
  expect(span("2026-02-27", "2026-03-02", "4")).not.toThrow();
  let error: unknown = null;
  try { span("2026-03-02", "2026-03-03", "2.5")(); } catch (e) { error = e; }
  expect(error).toMatchObject({ field: "days", message: "The days of leave cannot be more than the calendar days from the first to the last day." });
  expect(span("2026-03-02", "2026-03-02", "1.5")).toThrow(R.FormError);
  expect(span("2026-02-27", "2026-03-02", "4.5")).toThrow(R.FormError);
});

test("a leave request whose days exceed its span is refused before any call, on create and on edit", async () => {
  const create = fake([]);
  await expect(S.createRecord(scope, R.LEAVE_REQUEST, "lv-abc", { ...leaveForm, days: "3" }, {}, create.actions)).rejects.toMatchObject({ field: "days" });
  expect(create.calls).toEqual([]);
  const record = row("lv-1", { leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, reason: "", status: "pending" }, 2);
  const edit = fake([]);
  await expect(S.updateRecord(scope, R.LEAVE_REQUEST, record, { ...R.viewValues(R.LEAVE_REQUEST, record.profile), days: "2.5" }, edit.actions)).rejects.toMatchObject({ field: "days" });
  expect(edit.calls).toEqual([]);
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

test("a new leave type code is checked for a duplicate, except against the form's own row on a retry", async () => {
  const form = { code: "annual", name: "Annual leave", paid: "yes" };
  const dup = fake([page(annual)]);
  await expect(S.createRecord(scope, R.LEAVE_TYPE, "lt-new", form, {}, dup.actions)).rejects.toMatchObject({ field: "code", message: R.DUPLICATE_CODE_TEXT });
  expect(dup.calls.map((c) => c.verb)).toEqual(["records.list"]);
  expect(dup.calls[0]!.args).toEqual({ table: "leave_types", filters: [{ field: "code", op: "eq", value: "ANNUAL" }], limit: 2 });
  const ok = fake([page(), rec("lt-new", {})]);
  await S.createRecord(scope, R.LEAVE_TYPE, "lt-new", form, {}, ok.actions);
  expect(ok.calls[1]!.args).toMatchObject({ table: "leave_types", record_id: "lt-new", profile: { code: "ANNUAL", name: "Annual leave", paid: true } });
  // A retry after a lost reply finds its own row under the form's id: not a duplicate; the host refuses the second create itself.
  const retry = fake([page(row("lt-new", { code: "ANNUAL" })), rec("lt-new", {})]);
  await S.createRecord(scope, R.LEAVE_TYPE, "lt-new", form, {}, retry.actions);
  expect(retry.calls.map((c) => c.verb)).toEqual(["records.list", "records.create"]);
});

test("a leave type's code is read-only after creation: an edit neither shows nor sends it", async () => {
  expect(R.editable(R.LEAVE_TYPE).fields.map((f) => f.key)).toEqual(["name", "paid"]);
  expect(R.LEAVE_TYPE.fields.find((f) => f.key === "code")).toMatchObject({ fixed: true, required: true });
  const record = row("lt-1", { code: "OLD", name: "Old name", paid: true });
  const renamed = fake([rec("lt-1", {}, 2)]);
  await S.updateRecord(scope, R.LEAVE_TYPE, record, { code: "NEW", name: "New name", paid: "yes" }, renamed.actions);
  expect(renamed.calls).toEqual([{ verb: "records.update", args: { table: "leave_types", record_id: "lt-1", expected_revision: 1, profile: { name: "New name" } } }]);
  const codeOnly = fake([]);
  expect(await S.updateRecord(scope, R.LEAVE_TYPE, record, { code: "NEW", name: "Old name", paid: "yes" }, codeOnly.actions)).toBeNull();
  expect(codeOnly.calls).toEqual([]);
});

test("a failed leave-type lookup blocks the write and surfaces as the failure, never as 'free' or 'missing'", async () => {
  const down = () => new ApiError("unavailable", 503, { code: "unavailable" });
  // The duplicate check on a new leave type.
  const dupCheck = fake([down()]);
  const e1 = await S.createRecord(scope, R.LEAVE_TYPE, "lt-new", { code: "annual", name: "Annual leave", paid: "yes" }, {}, dupCheck.actions).catch((e: unknown) => e);
  expect(e1).toBeInstanceOf(ApiError); expect(e1).not.toBeInstanceOf(R.FormError); expect(e1).toMatchObject({ status: 503 });
  expect(dupCheck.calls.map((c) => c.verb)).toEqual(["records.list"]);
  // The existence check on a new leave request (the employee lookup succeeds first).
  const typeCheck = fake([page(ada), down()]);
  const e2 = await S.createRecord(scope, R.LEAVE_REQUEST, "lv-abc", leaveForm, {}, typeCheck.actions).catch((e: unknown) => e);
  expect(e2).toBeInstanceOf(ApiError); expect(e2).not.toBeInstanceOf(R.FormError); expect(e2).toMatchObject({ status: 503 });
  expect(typeCheck.calls.map((c) => [c.verb, c.args.table])).toEqual([["records.list", undefined], ["records.list", "leave_types"]]);
  // The existence check when an edit changes the leave type.
  const record = row("lv-1", { leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, reason: "", status: "pending" }, 2);
  const editCheck = fake([down()]);
  const e3 = await S.updateRecord(scope, R.LEAVE_REQUEST, record, { ...R.viewValues(R.LEAVE_REQUEST, record.profile), leaveType: "unpaid" }, editCheck.actions).catch((e: unknown) => e);
  expect(e3).toBeInstanceOf(ApiError); expect(e3).not.toBeInstanceOf(R.FormError); expect(e3).toMatchObject({ status: 503 });
  expect(editCheck.calls.map((c) => [c.verb, c.args.table])).toEqual([["records.list", "leave_types"]]);
  // The pure checks rethrow the failed call as it is.
  const failing: Parameters<typeof R.assertLeaveTypeExists>[0] = async () => { throw down(); };
  await expect(R.assertLeaveTypeExists(failing, "ANNUAL")).rejects.toMatchObject({ status: 503 });
  await expect(R.assertLeaveCodeFree(failing, "ANNUAL", "lt-new")).rejects.toMatchObject({ status: 503 });
});

test("every record tab's list and show calls name its own table, through the bridge's field allowlist", async () => {
  const Q = await import("../../src/features/hr/recordQueries.ts");
  const V = await import("../../src/features/hr/views.tsx");
  const { cleanArgs } = await import("../../src/bridge/services.ts");
  const views = [V.policiesView, V.leaveRequestsView, V.leaveTypesView, V.claimsView, V.openingsView, V.candidatesView(null, {}), V.candidatesView("job-1", {})];
  expect(views.map((v) => v.spec.table)).toEqual(["policies", "leave_requests", "leave_types", "claims", "job_openings", "candidates", "candidates"]);
  for (const view of views) {
    const list = cleanArgs("records.list", Q.listArgs(view, { status: view.filter?.initial ?? "all", query: "", limit: 25 }));
    expect([view.id, list.table]).toEqual([view.id, view.spec.table]);
    expect(cleanArgs("records.show", Q.showArgs(view, "rec-1"))).toEqual({ table: view.spec.table, record_id: "rec-1" });
  }
  expect(Q.listArgs(V.candidatesView("job-1", {}), { status: "interview", query: "sam", cursor: "c-2", limit: 25 })).toEqual({
    table: "candidates", query: "sam", limit: 25, cursor: "c-2", order_by: { field: "created_at", direction: "desc" },
    filters: [{ field: "opening_id", op: "eq", value: "job-1" }, { field: "stage", op: "eq", value: "interview" }],
  });
  expect(Q.listArgs(V.claimsView, { status: "all", query: "", limit: 25 }).filters).toBeUndefined();
  // The pane builds its reads with these functions, not with its own literals.
  const { readFileSync } = await import("node:fs");
  const pane = readFileSync(new URL("../../src/features/hr/RecordsPane.tsx", import.meta.url), "utf8");
  expect(pane).toMatch(/useHrQuery\(scope, "records\.list", listArgs\(view, /);
  expect(pane).toMatch(/useHrQuery\(scope, "records\.show", showArgs\(view, recordId\)/);
  expect(pane).not.toMatch(/table: view\.spec\.table/);
});

test("approve is confirmed like reject, and a claim filter offers no paid status", async () => {
  const { readFileSync } = await import("node:fs");
  const pane = readFileSync(new URL("../../src/features/hr/RecordsPane.tsx", import.meta.url), "utf8");
  expect(pane).toMatch(/primary=\{[^\n]*onClick=\{\(\) => confirm\("approved"\)\}/);
  expect(pane).not.toMatch(/decideNow\("approved"/);
  expect(pane).toContain("cannot be changed afterwards in this release");
  const V = await import("../../src/features/hr/views.tsx");
  expect(V.claimsView.filter!.values).toEqual(["submitted", "approved", "rejected"]);
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

test("failure wording claims only what the frame can know", async () => {
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
  // A 403 also means withdrawn access or an undeclared operation: the text names every cause, not only "owner-only".
  const { FORBIDDEN_TEXT, hostErrorText } = await import("../../src/features/hr/hostErrors.ts");
  const forbidden = S.problemFor(new ApiError("x", 403, { code: "forbidden" }), "update", t).message;
  expect(forbidden).toBe(FORBIDDEN_TEXT);
  expect(hostErrorText(new ApiError("x", 403, { code: "forbidden" }), "fallback")).toBe(FORBIDDEN_TEXT);
  expect(FORBIDDEN_TEXT).toMatch(/no longer available here, or these records are for the workspace owner\. Reload the page\./);
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
  const { FORBIDDEN_TEXT } = await import("../../src/features/hr/hostErrors.ts");
  strings.add(FORBIDDEN_TEXT);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/domain/records.ts", import.meta.url), "utf8");
  for (const m of src.matchAll(/FormError\([^,]+, "([^"]+)"/g)) strings.add(m[1]!);
  for (const file of ["RecordsPane.tsx", "Sections.tsx", "HrScreen.tsx", "views.tsx"]) {
    const text = readFileSync(new URL(`../../src/features/hr/${file}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/\bt\("([^"]+)"\)/g)) strings.add(m[1]!);
    for (const m of text.matchAll(/(?:title|newLabel|searchHint|blockedNew|body|confirm): "([^"]+)"/g)) strings.add(m[1]!);
    for (const m of text.matchAll(/^const TAB_LABEL.*$/gm)) for (const w of m[0].matchAll(/: "([^"]+)"/g)) strings.add(w[1]!);
  }
  strings.add("Reject…"); strings.add("All");
  const missing = [...strings].filter((s) => s !== "—" && !(s in zhHK));
  expect(missing).toEqual([]);
});

// ---- argument budgets ---------------------------------------------------------------------------
// The board shell closes a records frame whose `records.create` / `records.update` arguments pass 49,152 bytes of
// JSON, and any other operation's past 16,384. The screen refuses first, before anything is sent.
const B = await import("../../src/bridge/services.ts");
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
/** The host call the screen makes: `serviceCall` checks the arguments with `cleanArgs` before it sends them. */
function budgeted() {
  const sent: Call[] = [];
  const actions = createHostActions(async (_s, verb, args) => {
    sent.push({ verb, args: B.cleanArgs(verb, args as Record<string, unknown>) });
    return rec("pol-1", {});
  });
  return { actions, sent };
}
/** Written Chinese with punctuation and line breaks, `n` characters long (3 bytes each in UTF-8, a line break 2 in JSON). */
const chinese = (n: number) => Array.from("本公司員工每年可享有十四日有薪年假，並須於兩星期前向主管提出申請。\n".repeat(Math.ceil(n / 30))).slice(0, n).join("");
const longPolicy = (body: string) => ({ title: chinese(120), category: "leave", language: "zh-HK", effectiveFrom: "2026-01-01", status: "current", body });

test("a record write may carry 49,152 bytes of arguments, and every other operation 16,384", () => {
  const padField = (verb: string) => (verb === "records.list" ? "query" : "record_id");
  const base: Record<string, Record<string, unknown>> = {
    "records.create": { table: "policies", record_id: "", profile: {} },
    "records.update": { table: "policies", record_id: "", expected_revision: 1, profile: {} },
    "records.list": { table: "policies", query: "" },
    "records.show": { table: "policies", record_id: "" },
    "screen.route.patch": { section: "policies", record_id: "" },
  };
  const sized = (verb: string, size: number) => {
    const args = { ...base[verb] };
    args[padField(verb)] = "x".repeat(size - json(args));
    expect(json(args)).toBe(size);
    return args;
  };
  expect(Object.keys(base).sort()).toEqual([...B.OPERATIONS].sort());
  for (const verb of B.OPERATIONS) {
    const budget = verb === "records.create" || verb === "records.update" ? 49152 : 16384;
    expect(B.requestBudget(verb)).toBe(budget);
    expect(() => B.cleanArgs(verb, sized(verb, budget))).not.toThrow();
    let refused: unknown = null;
    try { B.cleanArgs(verb, sized(verb, budget + 1)); } catch (e) { refused = e; }
    expect(refused).toMatchObject({ status: 413, code: "too_large" });
  }
});

test("a 12,000-character Chinese policy body or CV fits a record write, though it is larger than 16 KiB", async () => {
  const policy = budgeted();
  await S.createRecord(scope, R.POLICY, "pol-0123456789ab", longPolicy(chinese(12000)), {}, policy.actions);
  expect(policy.sent.map((c) => c.verb)).toEqual(["records.create"]);
  expect((policy.sent[0]!.args.profile as Record<string, unknown>).body).toBe(chinese(12000));
  expect(json(policy.sent[0]!.args)).toBeGreaterThan(16384);
  expect(json(policy.sent[0]!.args)).toBeLessThanOrEqual(49152);
  // An edit that replaces the whole body is sent too.
  const stored = row("pol-1", policy.sent[0]!.args.profile as Record<string, unknown>, 3);
  const edit = budgeted();
  await S.updateRecord(scope, R.POLICY, stored, { ...R.viewValues(R.POLICY, stored.profile), body: chinese(11999) + "。" }, edit.actions);
  expect(edit.sent.map((c) => c.verb)).toEqual(["records.update"]);
  expect(json(edit.sent[0]!.args)).toBeGreaterThan(16384);
  const cv = budgeted();
  const candidate = { displayName: chinese(120), email: "applicant@example.invalid", phone: "+852 5555 0100", source: chinese(80), cvText: chinese(12000) };
  await S.createRecord(scope, R.CANDIDATE, "cand-0123456789ab", candidate, { opening_id: "job-0123456789ab" }, cv.actions);
  expect(cv.sent.map((c) => c.verb)).toEqual(["records.create"]);
  expect(json(cv.sent[0]!.args)).toBeGreaterThan(16384);
  expect(json(cv.sent[0]!.args)).toBeLessThanOrEqual(49152);
});

test("a write over 49,152 bytes is refused in the screen with a plain 'too long' message, and nothing is sent", async () => {
  const { zhHK } = await import("../../src/features/hr/localeCatalog.ts");
  // Pasted text keeps Word's manual line breaks (U+000B), which JSON writes as six bytes each: 12,000 characters
  // pass the form's own length check but not the write budget.
  const pasted = Array.from(chinese(6000)).map((c) => c + "\u000b").join("");
  expect(Array.from(pasted).length).toBe(12000);
  const create = budgeted();
  const error = await S.createRecord(scope, R.POLICY, "pol-0123456789ab", longPolicy(pasted), {}, create.actions).catch((e: unknown) => e);
  expect(create.sent).toEqual([]);
  const identity = (s: string) => s;
  expect(S.problemFor(error, "create", identity)).toEqual({ field: null, message: S.TEXT.too_long, kind: "too_long", reload: false });
  expect(S.TEXT.too_long).toMatch(/too long/);
  expect(S.problemFor(error, "create", (m) => zhHK[m] ?? m).message).toBe("文字太長，無法在此畫面儲存。請先縮短，然後再儲存。");
  // The same on an edit.
  const stored = row("pol-1", R.buildProfile(R.POLICY, longPolicy(chinese(100))), 2);
  const edit = budgeted();
  const editError = await S.updateRecord(scope, R.POLICY, stored, { ...R.viewValues(R.POLICY, stored.profile), body: pasted }, edit.actions).catch((e: unknown) => e);
  expect(edit.sent).toEqual([]);
  expect(S.problemFor(editError, "update", identity)).toMatchObject({ kind: "too_long", message: S.TEXT.too_long, reload: false });
  // Only the screen's own refusal reads as "too long": the board shows a host 413 as 400 `failed`.
  expect(R.classify({ status: 413 }, "create")).toBe("neutral");
  expect(R.classify({ status: 400, code: "failed" }, "create")).toBe("rejected");
});

test("only the screen's own 413 is 'too long'; the board's relayed too_large means the write may have landed", () => {
  // The screen's refusal: status 413, code `too_large`, nothing sent.
  expect(R.classify({ status: 413, code: "too_large" }, "create")).toBe("too_long");
  expect(R.classify({ status: 413, code: "too_large" }, "update")).toBe("too_long");
  // The board sends `too_large` when a reply is too big to show, after the write ran. app-kit gives an unnamed
  // refusal code status 400. Saying "too long" or "not saved" would be false; the record may be saved.
  for (const operation of ["create", "update"] as const) {
    expect(R.classify({ status: 400, code: "too_large" }, operation)).toBe("maybe_saved");
    expect(S.problemFor(new ApiError("That is too large to show.", 400, { code: "too_large" }), operation, (s) => s))
      .toEqual({ field: null, message: S.TEXT.maybe_saved, kind: "maybe_saved", reload: false });
  }
});

test("the bridge's busy refusal (429, code conflict) is neither a revision conflict nor a duplicate: nothing was sent", () => {
  expect(R.classify({ status: 429, code: "conflict" }, "update")).toBe("neutral");
  expect(R.classify({ status: 429, code: "conflict" }, "create")).toBe("neutral");
  // A real conflict still reads as one.
  expect(R.classify({ status: 409, code: "conflict" }, "update")).toBe("changed");
  expect(R.classify({ status: 409, code: "conflict" }, "create")).toBe("maybe_saved");
});
