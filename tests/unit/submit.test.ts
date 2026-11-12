// The duplicate pre-check, the write argument shapes and the owner-facing refusal text, against a fake call function.
// Run: bun test tests/unit/submit.test.ts

import { expect, mock, test } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);

const { createHostActions } = await import("../../src/features/hr/hostActions.ts");
const { assertEmployeeNoFree, writeProblem, createEmployee, updateEmployee, updateFailure, DUPLICATE_TEXT } = await import("../../src/features/hr/submit.ts");
const { FormError, buildProfile, changedFields, EMPTY_FORM } = await import("../../src/domain/people.ts");
const { zhHK } = await import("../../src/features/hr/localeCatalog.ts");

const scope = { installId: "install-test", digest: "sha256:" + "a".repeat(64) };
const receipt = (id: string, profile: Record<string, unknown>, revision = 1) => ({ id, revision, digest: "sha256:x", profile, history: [] });
type Call = { verb: string; args: Record<string, unknown> };

/** A fake host: records every call and answers each with the next canned reply. */
function fake(replies: unknown[]) {
  const calls: Call[] = [];
  const actions = createHostActions(async (_scope, verb, args) => {
    calls.push({ verb, args: args as Record<string, unknown> });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { actions, calls };
}
const page = (...rows: ReturnType<typeof receipt>[]) => ({ records: rows, total: rows.length, truncated: false, next_cursor: null });
const identity = (s: string) => s;

test("the pre-check sends one exact eq filter and two rows at most", async () => {
  const { actions, calls } = fake([page()]);
  await assertEmployeeNoFree(scope, "E-0001", null, actions);
  expect(calls).toEqual([{ verb: "records.list", args: { filters: [{ field: "employee_no", op: "eq", value: "E-0001" }], limit: 2 } }]);
});

test("the pre-check refuses when another row holds the number", async () => {
  const { actions } = fake([page(receipt("emp-1", { employee_no: "E-0001" }))]);
  const error = await assertEmployeeNoFree(scope, "E-0001", null, actions).catch((e) => e);
  expect(error).toBeInstanceOf(FormError);
  expect(error).toMatchObject({ field: "employeeNo", message: DUPLICATE_TEXT });
});

test("the pre-check ignores the row being edited and a create retry's own earlier write", async () => {
  const own = page(receipt("emp-1", { employee_no: "E-0001" }));
  await expect(assertEmployeeNoFree(scope, "E-0001", "emp-1", fake([own]).actions)).resolves.toBeUndefined();
  // A retry after a lost reply: the form's id is the ownId, so its own landed row is not a duplicate.
  await expect(assertEmployeeNoFree(scope, "E-0001", "emp-new1", fake([page(receipt("emp-new1", { employee_no: "E-0001" }))]).actions)).resolves.toBeUndefined();
  // But a second row under that number still is one.
  const both = page(receipt("emp-new1", { employee_no: "E-0001" }), receipt("emp-9", { employee_no: "E-0001" }));
  await expect(assertEmployeeNoFree(scope, "E-0001", "emp-new1", fake([both]).actions)).rejects.toBeInstanceOf(FormError);
});

test("a failed lookup is not read as 'free'", async () => {
  const { actions } = fake([new ApiError("unavailable", 503, { code: "unavailable" })]);
  await expect(assertEmployeeNoFree(scope, "E-0001", null, actions)).rejects.toMatchObject({ status: 503 });
});

test("create sends record_id and profile only; update sends the revision and only changed fields", async () => {
  const profile = buildProfile({ ...EMPTY_FORM, displayName: "Ada Example", employeeNo: "e-1", joinDate: "2026-01-31" });
  const { actions, calls } = fake([{ record: receipt("emp-abc", profile) }, { record: receipt("emp-abc", { ...profile, job_title: "Lead" }, 2) }]);
  await actions.create(scope, "emp-abc", profile);
  const patch = changedFields(profile, buildProfile({ ...EMPTY_FORM, displayName: "Ada Example", employeeNo: "E-1", joinDate: "2026-01-31", jobTitle: "Lead" }));
  expect(patch).toEqual({ job_title: "Lead" });
  await actions.update(scope, "emp-abc", 1, patch);
  expect(calls[0]).toEqual({ verb: "records.create", args: { record_id: "emp-abc", profile } });
  expect(Object.keys(calls[0]!.args).sort()).toEqual(["profile", "record_id"]);
  expect(calls[0]!.args.profile).toMatchObject({ employee_no: "E-1" });
  expect(calls[1]).toEqual({ verb: "records.update", args: { record_id: "emp-abc", expected_revision: 1, profile: { job_title: "Lead" } } });
});

test("bad ids and revisions never reach the host", async () => {
  const { actions, calls } = fake([]);
  await expect(actions.create(scope, "bad id", {})).rejects.toMatchObject({ status: 400 });
  await expect(actions.update(scope, "emp-1", 0, {})).rejects.toMatchObject({ status: 400 });
  expect(calls).toEqual([]);
});

test("refusal text: duplicate only from the pre-check, reload only where the frame can justify it", () => {
  const text = (e: unknown, op: "create" | "update") => writeProblem(e, op, identity);
  const pre = text(new FormError("employeeNo", DUPLICATE_TEXT), "create");
  expect(pre).toMatchObject({ kind: "form", reload: false, problem: { field: "employeeNo" } });
  // A 409 on create after a clean pre-check is most likely a retry of a create that already landed.
  const create409 = text(new ApiError("x", 409, { code: "conflict" }), "create");
  expect(create409).toMatchObject({ kind: "maybe_saved", reload: false, problem: { field: null, message: "This employee may already be saved. Check the list before trying again." } });
  expect(create409.problem.message).not.toMatch(/already used|could not be saved/);
  // On update a bare conflict gets the neutral text with a reload; a stale code gets the stale text with a reload.
  expect(text(new ApiError("x", 409, { code: "conflict" }), "update")).toMatchObject({ kind: "changed", reload: true });
  expect(text(new ApiError("x", 409, { code: "stale_revision" }), "update")).toMatchObject({ kind: "stale", reload: true });
  expect(text(new ApiError("x", 401, { code: "unauthorized" }), "update").problem.message).toMatch(/session expired/);
  expect(text(new TypeError("boom"), "update").kind).toBe("neutral");
});

test("the real 400 + failed arrival reads true for a field refusal and a server failure alike", () => {
  // The board sends any status it does not name (400, 413, 500...) as code `failed`, which app-kit makes status 400.
  const real = writeProblem(new ApiError("Cadence refused this request.", 400, { code: "failed" }), "create", identity);
  expect(real.kind).toBe("rejected");
  expect(real.problem.message).toBe("The change could not be saved. Check the fields, then try again. If it keeps happening, reload the page.");
  expect(real.reload).toBe(false);
  // Written in the zh-HK catalogue terms too.
  const zh = writeProblem(new ApiError("x", 400, { code: "failed" }), "update", (m) => zhHK[m] ?? m);
  expect(zh.problem.message).toBe("未能儲存這項修改。請檢查各欄位，然後再試一次；如問題持續，請重新載入頁面。");
  expect(writeProblem(new ApiError("x", 409, { code: "conflict" }), "create", (m) => zhHK[m] ?? m).problem.message).toBe("此員工可能已經儲存。再試之前請先查看名冊。");
  // Statuses the board names are not "check the fields".
  for (const [status, code] of [[403, "forbidden"], [404, "not_found"], [503, "unavailable"], [504, "timeout"]] as const) {
    expect(writeProblem(new ApiError("x", status, { code }), "create", identity).problem.message).not.toMatch(/Check the fields/);
  }
});

test("a create retry after a landed write: own row passes the pre-check, the 409 reads as maybe saved", async () => {
  const profile = buildProfile({ ...EMPTY_FORM, displayName: "Ada Example", employeeNo: "E-1" });
  const landed = page(receipt("emp-new1", { employee_no: "E-1" }));
  const { actions, calls } = fake([landed, new ApiError("x", 409, { code: "conflict" })]);
  const error = await createEmployee(scope, "emp-new1", profile, actions).catch((e) => e);
  // The pre-check was sent first and the form's own record id was ignored, so the create went out.
  expect(calls.map((c) => c.verb)).toEqual(["records.list", "records.create"]);
  expect(writeProblem(error, "create", identity)).toMatchObject({ kind: "maybe_saved" });
});

test("create looks up the number against its own record id; another row blocks it before any write", async () => {
  const profile = buildProfile({ ...EMPTY_FORM, displayName: "Ada Example", employeeNo: "E-1" });
  const other = fake([page(receipt("emp-9", { employee_no: "E-1" }))]);
  await expect(createEmployee(scope, "emp-new1", profile, other.actions)).rejects.toBeInstanceOf(FormError);
  expect(other.calls.map((c) => c.verb)).toEqual(["records.list"]);
});

test("update looks the number up only when it changes, and never against the edited row", async () => {
  const { actions, calls } = fake([{ record: receipt("emp-1", { job_title: "Lead" }, 3) }]);
  await updateEmployee(scope, { id: "emp-1", revision: 2 }, { job_title: "Lead" }, actions);
  expect(calls).toEqual([{ verb: "records.update", args: { record_id: "emp-1", expected_revision: 2, profile: { job_title: "Lead" } } }]);
  const renumber = fake([page(receipt("emp-1", { employee_no: "E-7" })), { record: receipt("emp-1", { employee_no: "E-7" }, 3) }]);
  await updateEmployee(scope, { id: "emp-1", revision: 2 }, { employee_no: "E-7" }, renumber.actions);
  expect(renumber.calls.map((c) => c.verb)).toEqual(["records.list", "records.update"]);
  const clash = fake([page(receipt("emp-2", { employee_no: "E-7" }))]);
  await expect(updateEmployee(scope, { id: "emp-1", revision: 2 }, { employee_no: "E-7" }, clash.actions)).rejects.toBeInstanceOf(FormError);
});

test("the drawer shows the reload button exactly for a stale or changed record", () => {
  expect(updateFailure(new ApiError("x", 409, { code: "stale_revision" }), identity).stale).toBe(true);
  expect(updateFailure(new ApiError("x", 409, { code: "conflict" }), identity).stale).toBe(true);
  expect(updateFailure(new ApiError("x", 503, { code: "unavailable" }), identity).stale).toBe(false);
  expect(updateFailure(new ApiError("x", 400, { code: "failed" }), identity).stale).toBe(false);
  expect(updateFailure(new FormError("employeeNo", DUPLICATE_TEXT), identity).stale).toBe(false);
});
