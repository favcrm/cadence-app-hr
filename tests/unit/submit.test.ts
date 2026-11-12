// The duplicate pre-check, the write argument shapes and the owner-facing refusal text, against a fake call function.
// Run: bun test tests/unit/submit.test.ts

import { expect, mock, test } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);

const { createHostActions } = await import("../../src/features/hr/hostActions.ts");
const { assertEmployeeNoFree, writeProblem, DUPLICATE_TEXT } = await import("../../src/features/hr/submit.ts");
const { FormError, buildProfile, changedFields, EMPTY_FORM } = await import("../../src/domain/people.ts");

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
  // A 409 on create never says "duplicate".
  const create409 = text(new ApiError("x", 409, { code: "conflict" }), "create");
  expect(create409.problem.message).not.toMatch(/already used/);
  expect(create409).toMatchObject({ kind: "neutral", reload: false, problem: { field: null } });
  // On update a bare conflict gets the neutral text with a reload; a stale code gets the stale text with a reload.
  expect(text(new ApiError("x", 409, { code: "conflict" }), "update")).toMatchObject({ kind: "changed", reload: true });
  expect(text(new ApiError("x", 409, { code: "stale_revision" }), "update")).toMatchObject({ kind: "stale", reload: true });
  // "Check the fields" only for a 400-class refusal.
  expect(text(new ApiError("x", 400, { code: "failed" }), "create").problem.message).toMatch(/check the fields/);
  for (const [status, code] of [[500, "failed2"], [403, "forbidden"], [409, "conflict"], [503, "unavailable"], [504, "timeout"]] as const) {
    expect(text(new ApiError("x", status, { code }), "create").problem.message).not.toMatch(/check the fields/);
  }
  expect(text(new ApiError("x", 401, { code: "unauthorized" }), "update").problem.message).toMatch(/session expired/);
  expect(text(new TypeError("boom"), "update").kind).toBe("neutral");
});
