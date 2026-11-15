// Payroll against an in-memory host that enforces the app's own storage declaration (unique keys, append-only tables,
// write rules): saving a run as one batch and retrying it, approving it and then failing to change it, salaries,
// the first rate row, preparing a posting, and posting a run twice into a stand-in Accounting journal.
// Run: bun test tests/unit/payroll_host.test.ts
import { expect, mock, test } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);
const { makeJournal, makePayrollHost, person, scope } = await import("../support/payroll-host.ts");
const { FIRST_MPF_RATE } = await import("../../src/domain/mpf-rates.ts");
const { DEFAULT_PAYROLL_ACCOUNTS } = await import("../../src/domain/posting.ts");
const { FormError } = await import("../../src/domain/records.ts");
const { addFirstRate, addSalary, computeRun, decideRun, findPosting, preparePosting, readRunInputs, runProposal, saveRun } = await import("../../src/features/hr/payroll.ts");

async function seeded() {
  const host = makePayrollHost();
  host.add("employees", "emp-a", person("A1"));
  host.add("employees", "emp-b", person("B2", { join_date: "2026-01-15" }));
  expect(await addFirstRate(scope, host.actions)).toBe("created");
  await addSalary(scope, { employeeNo: "A1", effectiveFrom: "2020-01-01", monthlyMinor: 2000000, mpfExempt: false, note: "" }, "sal-000000000001", host.actions);
  await addSalary(scope, { employeeNo: "b2", effectiveFrom: "2026-01-15", monthlyMinor: 1500000, mpfExempt: false, note: "" }, "sal-000000000002", host.actions);
  return host;
}
async function savedRun(host: ReturnType<typeof makePayrollHost>, period = "2026-01") {
  const plan = computeRun(await readRunInputs(scope, period, host.actions), {});
  expect(await saveRun(scope, plan, host.actions)).toBe("created");
  return plan;
}

test("the first rate row is written once under its fixed id; a second load and a lost reply meet it", async () => {
  const host = makePayrollHost();
  expect(await addFirstRate(scope, host.actions)).toBe("created");
  expect(await addFirstRate(scope, host.actions)).toBe("exists");
  expect(host.of("rate_tables").map((r) => [r.id, r.profile])).toEqual([["rt-2014-06-01", FIRST_MPF_RATE]]);
  const lost = makePayrollHost();
  lost.fault("records.create", new ApiError("timeout", 504), { after: true, table: "rate_tables" });
  expect(await addFirstRate(scope, lost.actions)).toBe("exists");
  expect(lost.of("rate_tables").length).toBe(1);
  // The table is append-only: the row cannot be edited.
  await expect(host.actions.update(scope, "rt-2014-06-01", 1, { employer_rate_bp: 600 }, "rate_tables")).rejects.toThrow();
});

test("a salary correction on the same date takes the next seq; a retry of the same form adds nothing", async () => {
  const host = await seeded();
  const row = await addSalary(scope, { employeeNo: "A1", effectiveFrom: "2020-01-01", monthlyMinor: 2100000, mpfExempt: false, note: "typo" }, "sal-000000000003", host.actions);
  expect(row.profile).toMatchObject({ seq: 2, monthly_minor: 2100000, currency: "HKD", note: "typo" });
  await addSalary(scope, { employeeNo: "A1", effectiveFrom: "2020-01-01", monthlyMinor: 2100000, mpfExempt: false, note: "typo" }, "sal-000000000003", host.actions);
  expect(host.of("salaries").length).toBe(3);
  await expect(addSalary(scope, { employeeNo: "ZZ9", effectiveFrom: "2020-01-01", monthlyMinor: 1, mpfExempt: false, note: "" }, "sal-000000000004", host.actions)).rejects.toBeInstanceOf(FormError);
});

test("a run and its lines are saved as one batch with every line's inputs, and a retry after a lost reply saves nothing twice", async () => {
  const host = await seeded();
  host.fault("records.batch", new ApiError("timeout", 504), { after: true });
  const plan = computeRun(await readRunInputs(scope, "2026-01", host.actions), {});
  expect(await saveRun(scope, plan, host.actions)).toBe("exists");
  expect(host.verbs().filter((v) => v === "records.batch").length).toBe(1);
  expect(host.of("payroll_runs").map((r) => r.id)).toEqual(["hr-payroll-2026-01-1"]);
  expect(host.of("payroll_lines").map((r) => [r.profile.employee_id, r.profile.employer_mpf_minor, r.profile.employee_mpf_minor, r.profile.calc_version])).toEqual([
    ["emp-a", 100000, 100000, "payroll-1"], ["emp-b", 75000, 0, "payroll-1"],
  ]);
  expect(await saveRun(scope, plan, host.actions)).toBe("exists");
  expect(host.of("payroll_lines").length).toBe(2);
});

test("two screens saving run 1 at once: the second is stopped, not merged", async () => {
  const host = await seeded();
  const inputs = await readRunInputs(scope, "2026-01", host.actions);
  await saveRun(scope, computeRun(inputs, {}), host.actions);
  const other = computeRun(inputs, { "emp-a": { additionsMinor: 100, deductionsMinor: 0 } });
  await expect(saveRun(scope, other, host.actions)).rejects.toThrow(/Another run was saved under this number/);
  expect(host.of("payroll_lines").length).toBe(2);
  // The next read numbers the following run 2.
  expect((await readRunInputs(scope, "2026-01", host.actions)).runNo).toBe(2);
});

test("an approved run cannot be changed: not by the screen, not by a staged update, and its lines are append-only", async () => {
  const host = await seeded();
  await savedRun(host);
  const run = await host.actions.show(scope, "hr-payroll-2026-01-1", "payroll_runs");
  const approved = await decideRun(scope, run, "approved", "2026-02-01", "", host.actions);
  expect(approved.profile).toMatchObject({ status: "approved", decided_on: "2026-02-01" });
  await expect(decideRun(scope, approved, "cancelled", "2026-02-02", "", host.actions)).rejects.toThrow(/no longer a draft/);
  for (const patch of [{ status: "approved", decision_note: "edited" }, { status: "draft" }, { status: "cancelled", decided_on: "2026-02-02" }, { period: "2026-02" }]) {
    await expect(host.actions.update(scope, approved.id, approved.revision, patch, "payroll_runs")).rejects.toMatchObject({ status: 400 });
  }
  const line = host.of("payroll_lines")[0]!;
  await expect(host.actions.update(scope, line.id, 1, { additions_minor: 1 }, "payroll_lines")).rejects.toMatchObject({ status: 400 });
  expect(host.of("payroll_runs")[0]!.profile.status).toBe("approved");
});

test("approving checks the revision the owner saw and that the run's lines are whole", async () => {
  const host = await seeded();
  await savedRun(host);
  const run = await host.actions.show(scope, "hr-payroll-2026-01-1", "payroll_runs");
  await host.actions.update(scope, run.id, run.revision, { decision_note: null }, "payroll_runs");
  await expect(decideRun(scope, run, "approved", "2026-02-01", "", host.actions)).rejects.toThrow(/changed after you opened it/);
  host.tables.payroll_lines!.pop();
  const fresh = await host.actions.show(scope, run.id, "payroll_runs");
  await expect(decideRun(scope, fresh, "approved", "2026-02-01", "", host.actions)).rejects.toThrow(/do not match/);
  // A draft can still be cancelled, and a new run takes the next number.
  await decideRun(scope, fresh, "cancelled", "2026-02-01", "lines missing", host.actions);
  expect((await readRunInputs(scope, "2026-01", host.actions)).runNo).toBe(2);
});

test("posting the same run twice produces one Accounting entry", async () => {
  const host = await seeded();
  await savedRun(host);
  const run = await host.actions.show(scope, "hr-payroll-2026-01-1", "payroll_runs");
  await expect(runProposal(scope, run.id, DEFAULT_PAYROLL_ACCOUNTS, host.actions)).rejects.toThrow(/Only an approved/);
  await decideRun(scope, run, "approved", "2026-02-01", "", host.actions);
  // Preparing twice (or after changing an account) keeps one postings row; its unique source and entry_ref hold it.
  await preparePosting(scope, await runProposal(scope, run.id, { ...DEFAULT_PAYROLL_ACCOUNTS, netPay: "2100" }, host.actions), host.actions);
  const posting = await preparePosting(scope, await runProposal(scope, run.id, DEFAULT_PAYROLL_ACCOUNTS, host.actions), host.actions);
  expect(host.of("postings").length).toBe(1);
  expect(posting.profile).toMatchObject({ entry_ref: "hr-payroll-2026-01-1", stage: "prepared", posting_ref: null });
  const batch = posting.profile.batch as { items: { table: string; record_id: string; profile: Record<string, any> }[] };
  expect(batch.items.filter((i) => i.table === "journal_lines").map((i) => [i.profile.account_code, i.profile.amount_minor])).toEqual([["6010", 3500000], ["6020", 175000], ["1020", -3400000], ["2110", -275000]]);

  // The hr-posting skill's procedure: an exact lookup decides; a batch is staged only when the entry is absent.
  const journal = makeJournal();
  const post = () => { if (journal.find(posting.profile.entry_ref).length > 0) return "already in the journal"; journal.batch(batch.items); return "posted"; };
  expect(post()).toBe("posted");
  expect(post()).toBe("already in the journal");
  // Even without the lookup, Accounting's unique entry_ref refuses a second batch whole.
  expect(() => journal.batch(batch.items)).toThrow();
  expect(journal.find("hr-payroll-2026-01-1").length).toBe(1);
  expect(journal.lines.length).toBe(4);

  // The posting_ref update is the last step, and it is final.
  const posted = await host.actions.update(scope, posting.id, posting.revision, { stage: "posted", posting_ref: "hr-payroll-2026-01-1", posted_on: "2026-02-03" }, "postings");
  await expect(host.actions.update(scope, posted.id, posted.revision, { stage: "prepared", posting_ref: null, posted_on: null }, "postings")).rejects.toMatchObject({ status: 400 });
  await expect(preparePosting(scope, await runProposal(scope, run.id, DEFAULT_PAYROLL_ACCOUNTS, host.actions), host.actions)).rejects.toThrow(/already has a record/);
  expect((await findPosting(scope, "payroll", "hr-payroll-2026-01-1", host.actions))!.profile.stage).toBe("posted");
});

test("a posting that lands but loses its reply is found again, not written twice", async () => {
  const host = await seeded();
  await savedRun(host);
  const run = await host.actions.show(scope, "hr-payroll-2026-01-1", "payroll_runs");
  await decideRun(scope, run, "approved", "2026-02-01", "", host.actions);
  host.fault("records.create", new ApiError("timeout", 504), { after: true, table: "postings" });
  const proposal = await runProposal(scope, run.id, DEFAULT_PAYROLL_ACCOUNTS, host.actions);
  const row = await preparePosting(scope, proposal, host.actions);
  expect(row.profile.stage).toBe("prepared");
  expect(host.of("postings").length).toBe(1);
});
