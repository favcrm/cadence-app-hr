// The ledger flows over an in-memory host: approve-then-entry and its retries, reject, run accrual and its idempotence,
// chunking, entries for earlier approvals, corrections, and balances from the aggregate.
// Run: bun test tests/unit/ledger.test.ts
import { expect, mock, test } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);

const { makeHost, scope, employee, request } = await import("../support/ledger-host.ts");
const G = await import("../../src/features/hr/ledger.ts");
const S = await import("../../src/features/hr/recordsSubmit.ts");
const R = await import("../../src/domain/records.ts");
const L = await import("../../src/domain/leave.ts");
const { parseAggregate } = await import("../../src/features/hr/hostActions.ts");
const B = await import("../../src/bridge/services.ts");

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const entries = (host: ReturnType<typeof makeHost>) => host.of("leave_entries").map((r) => r.profile);
const taken = (host: ReturnType<typeof makeHost>) => entries(host).filter((e) => e.kind === "taken");
const noUpdateOfEntries = (host: ReturnType<typeof makeHost>) =>
  expect(host.calls.filter((c) => c.verb === "records.update" && c.args.table === "leave_entries")).toEqual([]);
const stored = (host: ReturnType<typeof makeHost>, id = "lv-1") => {
  const row = host.of("leave_requests").find((r) => r.id === id)!;
  return { id: row.id, revision: row.revision, digest: "sha256:x", profile: row.profile, history: [] };
};
function withRequest(over: Record<string, unknown> = {}, host = makeHost()) {
  host.add("leave_requests", "lv-1", request(over));
  return host;
}
const approve = (host: ReturnType<typeof makeHost>, record = stored(host)) => S.decide(scope, R.LEAVE_REQUEST, record, "approved", "2026-03-05", "", host.actions);
const reject = (host: ReturnType<typeof makeHost>, record = stored(host)) => S.decide(scope, R.LEAVE_REQUEST, record, "rejected", "2026-03-05", "No cover", host.actions);

// ---- approving ----------------------------------------------------------------------------------------------
test("approving creates the taken entry first, then sets the request approved; the balance drops by its half-days", async () => {
  const host = withRequest();
  host.add("leave_entries", "le-open", { employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: 14, kind: "adjustment", effective_date: "2026-01-01", source_ref: "adjustment-open", note: "Opening" });
  const before = await G.readBalances(scope, G.forEmployee("emp-aaa"), host.actions);
  expect(before.groups).toEqual([{ employeeId: "emp-aaa", leaveType: "ANNUAL", halfDays: 14, entries: 1 }]);
  host.calls.length = 0;
  const done = await approve(host);
  expect(done.profile).toMatchObject({ status: "approved", decided_on: "2026-03-05" });
  // Order: the fresh read, the entry, then the status. Nothing else.
  expect(host.verbs()).toEqual(["records.show", "records.create", "records.update"]);
  expect(host.calls[1]!.args).toMatchObject({ table: "leave_entries", profile: { employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: -4, kind: "taken", effective_date: "2026-03-02", source_ref: "taken-lv-1", note: null } });
  expect(host.calls[2]!.args).toMatchObject({ table: "leave_requests", record_id: "lv-1", profile: { status: "approved" } });
  const after = await G.readBalances(scope, G.forEmployee("emp-aaa"), host.actions);
  expect(after.groups[0]!.halfDays).toBe(10);
  noUpdateOfEntries(host);
});

test("a half-day request deducts one half-day", async () => {
  const host = withRequest({ half_days: 1, end_date: "2026-03-02" });
  await approve(host);
  expect(taken(host).map((e) => e.half_days)).toEqual([-1]);
});

test("rejecting writes no entry and does not read the ledger for anything but the earlier-approval check", async () => {
  const host = withRequest();
  const done = await reject(host);
  expect(done.profile).toMatchObject({ status: "rejected", decision_note: "No cover" });
  expect(host.verbs().filter((v) => v === "records.create" || v === "records.batch")).toEqual([]);
  expect(entries(host)).toEqual([]);
  expect((await G.readBalances(scope, [], host.actions)).groups).toEqual([]);
});

test("approving the same request twice produces one entry: the second attempt is refused as no longer pending", async () => {
  const host = withRequest();
  const first = stored(host);
  await approve(host, first);
  await expect(approve(host, first)).rejects.toMatchObject({ field: "ledger", message: "This request is no longer pending. Reload it to see what happened." });
  expect(taken(host).length).toBe(1);
});

test("a retry after the status update failed finds the entry and finishes: one entry, request approved", async () => {
  for (const uniqueStatus of [503, 409]) {
    const host = withRequest({}, makeHost({ uniqueStatus }));
    host.fault("records.update", new ApiError("lost", 504), { table: "leave_requests" });
    await expect(approve(host)).rejects.toMatchObject({ status: 504 });
    expect(taken(host).length).toBe(1);
    expect(host.of("leave_requests")[0]!.profile.status).toBe("pending");
    // Retry: the create meets the unique key (503 on the deployed host, 409 on the next), a re-read proves the entry, the status is set.
    const done = await approve(host);
    expect(done.profile.status).toBe("approved");
    expect(taken(host).length).toBe(1);
    noUpdateOfEntries(host);
  }
});

test("a lost reply on the entry itself is recognised by a re-read, never by the status code alone", async () => {
  const host = withRequest();
  host.fault("records.create", new ApiError("lost", 504), { after: true, table: "leave_entries" }); // written, reply lost
  const done = await approve(host);
  expect(done.profile.status).toBe("approved");
  expect(taken(host).length).toBe(1);
  // A 409 with no entry behind it is not "already recorded": the failure surfaces and the request stays open.
  const other = withRequest({}, makeHost());
  other.fault("records.create", new ApiError("conflict", 409, { code: "conflict" }), { table: "leave_entries" });
  await expect(approve(other)).rejects.toMatchObject({ status: 409 });
  expect(other.of("leave_requests")[0]!.profile.status).toBe("pending");
  expect(entries(other)).toEqual([]);
});

test("an entry under the same source_ref with other values stops the approval instead of being reused", async () => {
  const host = withRequest();
  host.add("leave_entries", "le-x", { employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: -2, kind: "taken", effective_date: "2026-03-02", source_ref: "taken-lv-1", note: null });
  await expect(approve(host)).rejects.toMatchObject({ field: "ledger" });
  expect(host.of("leave_requests")[0]!.profile.status).toBe("pending");
  expect(taken(host).length).toBe(1);
});

test("a stale or already-decided request writes no entry", async () => {
  const host = withRequest();
  const seen = stored(host);
  host.of("leave_requests")[0]!.revision = 2; // someone edited it after the owner opened it
  await expect(approve(host, seen)).rejects.toMatchObject({ field: "ledger", message: "This request changed after you opened it. Reload it, then decide again." });
  expect(entries(host)).toEqual([]);
  const decided = withRequest({ status: "rejected" });
  await expect(approve(decided)).rejects.toMatchObject({ field: "ledger" });
  expect(entries(decided)).toEqual([]);
});

test("a request that cannot make a valid entry is refused before anything is written", async () => {
  const host = withRequest({ employee_id: "" });
  await expect(approve(host)).rejects.toMatchObject({ message: "This request has no valid employee." });
  expect(host.verbs()).toEqual(["records.show"]);
});

test("rejecting after an approval that stopped part-way is refused: the deduction would stand for a rejected request", async () => {
  const host = withRequest();
  host.fault("records.update", new ApiError("lost", 504), { table: "leave_requests" });
  await expect(approve(host)).rejects.toMatchObject({ status: 504 });
  await expect(reject(host)).rejects.toMatchObject({ field: "ledger" });
  expect(host.of("leave_requests")[0]!.profile.status).toBe("pending");
  await approve(host); // finishing is the way out
  expect(host.of("leave_requests")[0]!.profile.status).toBe("approved");
  expect(taken(host).length).toBe(1);
});

// ---- run accrual ----------------------------------------------------------------------------------------------
const RULE = { v: 1, days_per_year: [{ from_years: 0, days: 7 }, { from_years: 3, days: 8 }] };
function company(count: number) {
  const host = makeHost();
  host.add("leave_types", "lt-1", { code: "ANNUAL", name: "Annual leave", paid: true, accrual_rule: RULE });
  host.add("leave_types", "lt-2", { code: "UNPAID", name: "Unpaid leave", paid: false, accrual_rule: null });
  for (let i = 0; i < count; i += 1) host.add("employees", `emp-${String(i).padStart(12, "0")}`, employee(`emp-${i}`, { join_date: "2020-01-01" }));
  return host;
}
const posted = (host: ReturnType<typeof makeHost>) => host.calls.filter((c) => c.verb === "records.batch");

test("running accrual posts one entry per eligible employee and accruing leave type; a second run posts nothing", async () => {
  const host = company(3);
  host.add("employees", "emp-nojoin", employee("nojoin", { join_date: null }));
  host.add("employees", "emp-left", employee("left", { status: "left", leave_date: "2026-01-31" }));
  const plan = await G.planMonth(scope, "2026-03", host.actions);
  expect(plan.entries.length).toBe(3);
  expect(plan.skipped.map((s) => [s.employeeId, s.reason])).toEqual([["emp-nojoin", "no_join_date"], ["emp-left", "left"]]);
  const result = await G.runAccrual(scope, plan, undefined, host.actions);
  expect(result).toEqual({ posted: 3, alreadyThere: 0 });
  expect(posted(host).length).toBe(1);
  expect(entries(host).every((e) => e.kind === "accrual" && e.half_days === 2 && e.source_ref.startsWith("accrual-emp-") && e.source_ref.endsWith("-ANNUAL-2026-03"))).toBe(true);
  host.calls.length = 0;
  // Second run: the plan sees the refs, so there is nothing to post and no batch is sent.
  const again = await G.planMonth(scope, "2026-03", host.actions);
  expect(again.entries).toEqual([]);
  expect(again.alreadyRecorded).toBe(3);
  expect(await G.runAccrual(scope, again, undefined, host.actions)).toEqual({ posted: 0, alreadyThere: 0 });
  expect(posted(host)).toEqual([]);
  expect(entries(host).length).toBe(3);
  // Even a stale plan, run again, cannot add a second entry: the batch is refused for the duplicate keys, and the re-read finds them all.
  const stale = await G.runAccrual(scope, plan, undefined, host.actions);
  expect(stale).toEqual({ posted: 0, alreadyThere: 3 });
  expect(entries(host).length).toBe(3);
});

test("another month is a separate set of entries, and the month filter does not mix months", async () => {
  const host = company(2);
  await G.runAccrual(scope, await G.planMonth(scope, "2026-03", host.actions), undefined, host.actions);
  const april = await G.planMonth(scope, "2026-04", host.actions);
  expect(april.entries.length).toBe(2);
  expect(april.alreadyRecorded).toBe(0);
  await G.runAccrual(scope, april, undefined, host.actions);
  expect(entries(host).length).toBe(4);
  expect(new Set(entries(host).map((e) => e.source_ref)).size).toBe(4);
});

test("part of a chunk already in the ledger: those count as recorded and only the rest is posted", async () => {
  const host = company(3);
  const plan = await G.planMonth(scope, "2026-03", host.actions);
  // Another session posts one of them after this plan was made.
  const other = plan.entries[1]!;
  host.add("leave_entries", "le-other", { ...other });
  const result = await G.postEntries(scope, plan.entries, undefined, host.actions);
  expect(result).toEqual({ posted: 2, alreadyThere: 1 });
  expect(entries(host).length).toBe(3);
});

test("a large month is posted in chunks within 200 items and the byte limit; nothing is posted twice", async () => {
  const host = company(450);
  const plan = await G.planMonth(scope, "2026-03", host.actions);
  expect(plan.entries.length).toBe(450);
  const progress: number[] = [];
  const result = await G.runAccrual(scope, plan, (done) => progress.push(done), host.actions);
  expect(result).toEqual({ posted: 450, alreadyThere: 0 });
  const batches = posted(host);
  expect(batches.length).toBeGreaterThan(2);
  for (const call of batches) {
    expect(call.args.items.length).toBeLessThanOrEqual(200);
    expect(bytes(call.args)).toBeLessThanOrEqual(L.BATCH_CHUNK_BYTES);
    expect(() => B.cleanArgs("records.batch", call.args)).not.toThrow();
  }
  expect(batches.reduce((n, c) => n + c.args.items.length, 0)).toBe(450);
  expect(new Set(entries(host).map((e) => e.source_ref)).size).toBe(450);
  expect(progress.at(-1)).toBe(450);
  // Employees are read page by page (100 a page), never as one list.
  expect(host.calls.filter((c) => c.verb === "records.list" && c.args.table === undefined).length).toBe(5);
});

test("a run that stops part-way reports what was posted, and running it again posts only what is missing", async () => {
  const host = company(450);
  const plan = await G.planMonth(scope, "2026-03", host.actions);
  host.fault("records.batch", new ApiError("down", 503), { nth: 2 });
  // The second chunk is refused with a store failure; the re-read finds none of it there, so the run stops with what it did.
  const error = await G.runAccrual(scope, plan, undefined, host.actions).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(G.PostStopped);
  const stopped = error as InstanceType<typeof G.PostStopped>;
  expect(stopped.done.posted).toBe(entries(host).length);
  expect(stopped.done.posted).toBeGreaterThan(0);
  expect(stopped.done.posted).toBeLessThan(450);
  expect(S.problemFor(stopped.cause, "create", (s: string) => s).kind).toBe("store_unavailable");
  // Again: a fresh read, then only the missing ones.
  const again = await G.planMonth(scope, "2026-03", host.actions);
  expect(again.entries.length).toBe(450 - stopped.done.posted);
  await G.runAccrual(scope, again, undefined, host.actions);
  expect(entries(host).length).toBe(450);
  expect(new Set(entries(host).map((e) => e.source_ref)).size).toBe(450);
});

test("a timeout where the batch landed is recognised by the re-read", async () => {
  const host = company(3);
  const plan = await G.planMonth(scope, "2026-03", host.actions);
  host.fault("records.batch", new ApiError("timeout", 504), { after: true });
  expect(await G.runAccrual(scope, plan, undefined, host.actions)).toEqual({ posted: 0, alreadyThere: 3 });
  expect(entries(host).length).toBe(3);
});

test("a read that does not finish is an error, never an empty list", async () => {
  const host = company(2);
  host.fault("records.list", new ApiError("down", 503), { nth: 2 });
  await expect(G.planMonth(scope, "2026-03", host.actions)).rejects.toMatchObject({ status: 503 });
  expect(entries(host)).toEqual([]);
  const paged = company(3);
  const flaky = makeHost({ pageSize: 1 });
  for (const row of paged.of("employees")) flaky.add("employees", row.id, row.profile);
  expect((await G.listAll(scope, undefined, [], flaky.actions)).length).toBe(3);
});

// ---- earlier approvals ----------------------------------------------------------------------------------------
test("approved requests with no entry get one, once; those that have one are left alone", async () => {
  const host = makeHost();
  host.add("leave_requests", "lv-old", request({ status: "approved", decided_on: "2026-01-20" }));
  host.add("leave_requests", "lv-done", request({ status: "approved", half_days: 2, start_date: "2026-02-02" }));
  host.add("leave_requests", "lv-pending", request());
  host.add("leave_requests", "lv-rejected", request({ status: "rejected" }));
  host.add("leave_requests", "lv-bad", request({ status: "approved", employee_id: "" }));
  host.add("leave_entries", "le-done", { employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: -2, kind: "taken", effective_date: "2026-02-02", source_ref: "taken-lv-done", note: null });
  const plan = await G.planReconcile(scope, host.actions);
  expect(plan.entries.map((e) => e.source_ref)).toEqual(["taken-lv-old"]);
  expect(plan.alreadyThere).toBe(1);
  expect(plan.unusable.map((u) => u.id)).toEqual(["lv-bad"]);
  expect(await G.postEntries(scope, plan.entries, undefined, host.actions)).toEqual({ posted: 1, alreadyThere: 0 });
  expect(taken(host).map((e) => e.source_ref).sort()).toEqual(["taken-lv-done", "taken-lv-old"]);
  // Idempotent: nothing is left to record, and a repeat changes nothing.
  const again = await G.planReconcile(scope, host.actions);
  expect(again.entries).toEqual([]);
  expect(taken(host).length).toBe(2);
});

// ---- corrections ---------------------------------------------------------------------------------------------
test("an adjustment is a new signed entry with a required note; a retry with the same reference adds no second entry", async () => {
  const host = makeHost();
  host.add("employees", "emp-aaa", employee("aaa", { employee_no: "E-001" }));
  host.add("leave_types", "lt-1", { code: "ANNUAL", name: "Annual leave", paid: true, accrual_rule: null });
  const form = { employeeNo: "e-001", leaveType: "annual", days: "-1.5", effectiveDate: "2026-03-05", note: "Counted a day twice" };
  const ref = G.adjustmentRef("adj-0123456789ab");
  const entry = await G.adjustBalance(scope, form, ref, host.actions);
  expect(entry).toEqual({ employee_id: "emp-aaa", leave_type: "ANNUAL", half_days: -3, kind: "adjustment", effective_date: "2026-03-05", source_ref: "adjustment-adj-0123456789ab", note: "Counted a day twice" });
  expect(entries(host)).toEqual([entry]);
  // A lost reply, then the same form again: the same reference, one entry.
  await G.adjustBalance(scope, form, ref, host.actions);
  expect(entries(host).length).toBe(1);
  // A different adjustment is a different entry; the first is never edited.
  await G.adjustBalance(scope, { ...form, days: "2" }, G.adjustmentRef("adj-ffffffffffff"), host.actions);
  expect(entries(host).map((e) => e.half_days)).toEqual([-3, 4]);
  noUpdateOfEntries(host);
  expect((await G.readBalances(scope, G.forEmployee("emp-aaa"), host.actions)).groups[0]!.halfDays).toBe(1);
});

test("an adjustment without a note, with 0 days, or for an unknown employee or leave type writes nothing", async () => {
  const host = makeHost();
  host.add("employees", "emp-aaa", employee("aaa", { employee_no: "E-001" }));
  host.add("leave_types", "lt-1", { code: "ANNUAL", name: "Annual leave", paid: true, accrual_rule: null });
  const form = { employeeNo: "E-001", leaveType: "ANNUAL", days: "1", effectiveDate: "2026-03-05", note: "Why" };
  const ref = G.adjustmentRef("adj-1");
  for (const bad of [{ note: "" }, { note: "   " }, { days: "0" }, { days: "1.3" }, { effectiveDate: "2026-02-30" }, { employeeNo: "E-404" }, { leaveType: "NOPE" }]) {
    await expect(G.adjustBalance(scope, { ...form, ...bad }, ref, host.actions)).rejects.toBeInstanceOf(R.FormError);
  }
  expect(entries(host)).toEqual([]);
});

// ---- balances ---------------------------------------------------------------------------------------------------
test("balances come from the aggregate grouped by employee and leave type, with the moment of the read", async () => {
  const host = makeHost();
  for (const [ref, emp, type, half, kind] of [["a", "emp-a", "ANNUAL", 14, "carry_forward"], ["b", "emp-a", "ANNUAL", -3, "taken"], ["c", "emp-a", "SICK", 4, "accrual"], ["d", "emp-b", "ANNUAL", 1, "accrual"]] as const) {
    host.add("leave_entries", `le-${ref}`, { employee_id: emp, leave_type: type, half_days: half, kind, effective_date: "2026-03-01", source_ref: `r-${ref}`, note: null });
  }
  host.calls.length = 0;
  const balances = await G.readBalances(scope, [], host.actions, () => new Date("2026-03-09T01:02:03Z"));
  expect(host.calls).toEqual([{ verb: "records.aggregate", args: { table: "leave_entries", group_by: ["employee_id", "leave_type"], sum: ["half_days"] } }]);
  expect(balances.asOf).toBe("2026-03-09T01:02:03.000Z");
  expect(balances.truncated).toBe(false);
  expect(balances.groups.map((g) => [g.employeeId, g.leaveType, g.halfDays, g.entries])).toEqual([["emp-a", "ANNUAL", 11, 2], ["emp-a", "SICK", 4, 1], ["emp-b", "ANNUAL", 1, 1]]);
  expect(L.balanceFor(balances, "emp-a", "ANNUAL")).toBe(11);
  expect(L.signedDays(11)).toBe("5.5");
  // The request hint reads the employee by number, then one filtered aggregate.
  host.add("employees", "emp-a", employee("a", { employee_no: "E-A" }));
  host.calls.length = 0;
  const hint = await G.readRequestBalance(scope, "e-a", "ANNUAL", host.actions);
  expect(hint.halfDays).toBe(11);
  expect(host.calls.at(-1)!.args.filters).toEqual([{ field: "employee_id", op: "eq", value: "emp-a" }, { field: "leave_type", op: "eq", value: "ANNUAL" }]);
});

test("a truncated aggregate is reported, and a malformed one is an invalid receipt, never a zero", async () => {
  expect(parseAggregate({ groups: [], group_limit: 1000, truncated: true })).toEqual({ groups: [], truncated: true, groupLimit: 1000 });
  const bad: unknown[] = [null, {}, { groups: [] }, { groups: [], truncated: "no" }, { groups: [{ key: {}, count: 1 }], truncated: false }, { groups: [{ key: {}, count: 1, sums: { half_days: 1.5 } }], truncated: false },
    { groups: [{ key: {}, count: -1, sums: {} }], truncated: false }, { groups: [{ key: [], count: 1, sums: {} }], truncated: false }, { groups: [{ key: { a: {} }, count: 1, sums: {} }], truncated: false }];
  for (const value of bad) expect(() => parseAggregate(value)).toThrow(ApiError);
  const host = makeHost();
  const truncated = { ...host.actions, aggregate: async () => ({ groups: [{ key: { employee_id: "emp-a", leave_type: "ANNUAL" }, count: 1, sums: { half_days: 4 } }], truncated: true, groupLimit: 1000 }) };
  const result = await G.readBalances(scope, [], truncated as never);
  expect(result.truncated).toBe(true);
  // A group with no half_days sum is invalid.
  const noSum = { ...host.actions, aggregate: async () => ({ groups: [{ key: { employee_id: "e", leave_type: "T" }, count: 1, sums: {} }], truncated: false, groupLimit: 1000 }) };
  await expect(G.readBalances(scope, [], noSum as never)).rejects.toMatchObject({ status: 502 });
});

test("the screen never updates a ledger entry anywhere in its source", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../src/features/hr/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    if (/LEDGER|leave_entries/.test(source)) expect([file, /actions\.update\([^)]*(LEDGER|leave_entries)/.test(source)]).toEqual([file, false]);
  }
});
