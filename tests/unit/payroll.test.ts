// Payroll runs and their Accounting proposals: who is paid, from which salary and rate row, every line's inputs and
// calc_version, the one-batch save, and a journal entry Accounting's own checks accept.
// Run: bun test tests/unit/payroll.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RateTable } from "../../src/domain/mpf.ts";
import {
  CALC_VERSION, batchBytes, lineRecordId, nextRunNo, nextSeq, planRun, runBatch, salaryFor, sameLines, unsavable, type EmployeeFacts, type SalaryRow,
} from "../../src/domain/payroll.ts";
import {
  accountingBatch, batchProblems, claimProposal, DEFAULT_PAYROLL_ACCOUNTS, defaultClaimAccounts, payrollProposal, postingProfile, PostingError,
} from "../../src/domain/posting.ts";

const json = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8"));
const columns = (table: string): string[] => json("app/storage/004-payroll.json").operations.find((o: { op: string; table: string }) => o.op === "create_table" && o.table === table).columns.map((c: { name: string }) => c.name);

const RATE: RateTable = { effectiveFrom: "2014-06-01", employerRateBp: 500, employeeRateBp: 500, minRelevantIncomeMinor: 710000, maxRelevantIncomeMinor: 3000000, holidayDays: 30, currency: "HKD" };
const emp = (id: string, name: string, joinDate: string | null, extra: Partial<EmployeeFacts> = {}): EmployeeFacts => ({ id, name, joinDate, leaveDate: null, status: "active", ...extra });
const sal = (id: string, employeeId: string, effectiveFrom: string, monthlyMinor: number, extra: Partial<SalaryRow> = {}): SalaryRow => ({ id, employeeId, effectiveFrom, seq: 1, monthlyMinor, currency: "HKD", mpfExempt: false, note: null, ...extra });

const EMPLOYEES = [
  emp("emp-a", "Avery Sample", "2020-03-01"),
  emp("emp-b", "Blair Example", "2026-01-15"),
  emp("emp-c", "Casey Test", "2019-05-01"),
  emp("emp-d", "Devon Nobody", null),
  emp("emp-e", "Emery Gone", "2018-01-01", { leaveDate: "2025-12-31", status: "left" }),
  emp("emp-f", "Finley Later", "2026-02-01"),
  emp("emp-g", "Gale Nosalary", "2021-01-01"),
];
const SALARIES = [
  sal("sal-a1", "emp-a", "2024-01-01", 2000000),
  sal("sal-a2", "emp-a", "2026-01-01", 2200000),
  sal("sal-a3", "emp-a", "2026-01-01", 2100000, { seq: 2, note: "corrected" }),
  sal("sal-a4", "emp-a", "2026-02-01", 2300000),
  sal("sal-b1", "emp-b", "2026-01-15", 1500000),
  sal("sal-c1", "emp-c", "2019-05-01", 4000000, { mpfExempt: true }),
];

test("a run pays everyone employed in the month from the salary in effect, and says why anyone else is left out", () => {
  const plan = planRun({ period: "2026-01", runNo: 1, employees: EMPLOYEES, salaries: SALARIES, rates: [RATE], adjustments: { "emp-a": { additionsMinor: 50000, deductionsMinor: 0 } } });
  expect(plan.runRef).toBe("hr-payroll-2026-01-1");
  expect(plan.entryDate).toBe("2026-01-31");
  expect(plan.lines.map((l) => l.employee_id)).toEqual(["emp-a", "emp-b", "emp-c"]);
  const [a, b, c] = plan.lines;
  // The correction on the same date (seq 2) wins; additions are relevant income.
  expect(a).toMatchObject({ salary_id: "sal-a3", monthly_minor: 2100000, additions_minor: 50000, relevant_income_minor: 2150000, employer_mpf_minor: 107500, employee_mpf_minor: 107500, net_pay_minor: 2042500 });
  // Joined 15 January: the employee is on the contribution holiday; the employer is not.
  expect(b).toMatchObject({ relevant_income_minor: 1500000, employer_mpf_minor: 75000, employee_mpf_minor: 0, net_pay_minor: 1500000 });
  expect(c).toMatchObject({ mpf_exempt: true, employer_mpf_minor: 0, employee_mpf_minor: 0, net_pay_minor: 4000000 });
  expect(plan.skipped.map((s) => [s.employeeId, s.reason])).toEqual([["emp-d", "no_join_date"], ["emp-e", "left"], ["emp-g", "no_salary"]]);
  expect(plan.totals).toEqual({ relevantIncomeMinor: 7650000, employerMinor: 182500, employeeMinor: 107500, netPayMinor: 7542500 });
});

test("each line stores its inputs and calc_version, exactly the payroll_lines columns", () => {
  const plan = planRun({ period: "2026-02", runNo: 1, employees: EMPLOYEES, salaries: SALARIES, rates: [RATE] });
  for (const line of plan.lines) {
    expect(Object.keys(line)).toEqual(columns("payroll_lines"));
    expect(line.calc_version).toBe(CALC_VERSION);
    expect(line.rate_effective_from).toBe("2014-06-01");
  }
  expect(plan.lines.find((l) => l.employee_id === "emp-a")!.salary_id).toBe("sal-a4");
  // Finley joins 1 February: in the February run, on holiday.
  expect(plan.lines.find((l) => l.employee_id === "emp-f")).toBeUndefined(); // no salary row, so skipped
  expect(plan.skipped.find((s) => s.employeeId === "emp-f")!.reason).toBe("no_salary");
});

test("salaries are effective-dated and corrected by a higher seq on the same date", () => {
  expect(salaryFor(SALARIES, "emp-a", "2025-12")!.id).toBe("sal-a1");
  expect(salaryFor(SALARIES, "emp-a", "2026-01")!.id).toBe("sal-a3");
  expect(salaryFor(SALARIES, "emp-a", "2023-12")).toBeNull();
  expect(nextSeq(SALARIES, "emp-a", "2026-01-01")).toBe(3);
  expect(nextSeq(SALARIES, "emp-a", "2026-03-01")).toBe(1);
  expect(nextRunNo([])).toBe(1);
  expect(nextRunNo([1, 3, 2])).toBe(4);
});

test("a run cannot be saved without a rate, with deductions above pay, with nobody, or above the batch budget", () => {
  expect(unsavable(planRun({ period: "2026-01", runNo: 1, employees: EMPLOYEES, salaries: SALARIES, rates: [] }))).toMatch(/No MPF rate/);
  const over = planRun({ period: "2026-01", runNo: 1, employees: EMPLOYEES, salaries: SALARIES, rates: [RATE], adjustments: { "emp-b": { additionsMinor: 0, deductionsMinor: 1500001 } } });
  expect(over.invalid.map((i) => i.employeeId)).toEqual(["emp-b"]);
  expect(unsavable(over)).toMatch(/deductions/);
  expect(unsavable(planRun({ period: "2026-01", runNo: 1, employees: [], salaries: [], rates: [RATE] }))).toMatch(/Nobody/);
  const many = Array.from({ length: 60 }, (_, i) => emp(`emp-${String(i).padStart(3, "0")}`, `Person ${i}`, "2020-01-01"));
  const big = planRun({ period: "2026-01", runNo: 1, employees: many, salaries: many.map((e) => sal(`sal-${e.id}`, e.id, "2020-01-01", 2000000)), rates: [RATE] });
  expect(unsavable(big)).toMatch(/too large/);
  const ok = planRun({ period: "2026-01", runNo: 1, employees: EMPLOYEES, salaries: SALARIES, rates: [RATE] });
  expect(unsavable(ok)).toBeNull();
});

test("a run and its lines are one batch: the run's record id is its reference and each line names its table", () => {
  const plan = planRun({ period: "2026-01", runNo: 2, employees: EMPLOYEES, salaries: SALARIES, rates: [RATE] });
  const items = runBatch(plan);
  expect(items[0]).toEqual({ record_id: "hr-payroll-2026-01-2", table: "payroll_runs", profile: { run_ref: "hr-payroll-2026-01-2", period: "2026-01", run_no: 2, entry_date: "2026-01-31", status: "draft", line_count: 3, calc_version: CALC_VERSION, decided_on: null, decision_note: null } });
  expect(Object.keys(items[0]!.profile)).toEqual(columns("payroll_runs"));
  expect(items.slice(1).map((i) => [i.record_id, i.table])).toEqual([0, 1, 2].map((n) => [lineRecordId("hr-payroll-2026-01-2", n), "payroll_lines"]));
  expect(batchBytes(items)).toBeLessThan(16384);
  // A retry that meets its own run is recognised; a different run under the same reference is not.
  expect(sameLines(plan.lines, plan.lines)).toBe(true);
  expect(sameLines(plan.lines.map((l) => ({ ...l, additions_minor: 1 })), plan.lines)).toBe(false);
  expect(sameLines(plan.lines.slice(1), plan.lines)).toBe(false);
});

// ---- the Accounting entry --------------------------------------------------------------------------------
const plan = planRun({ period: "2026-01", runNo: 1, employees: EMPLOYEES, salaries: SALARIES, rates: [RATE] });
const proposal = payrollProposal({ runRef: plan.runRef, period: plan.period, entryDate: plan.entryDate, runNo: plan.runNo }, plan.totals, DEFAULT_PAYROLL_ACCOUNTS);

test("a payroll run posts as Accounting's worked example: salaries and employer MPF against bank and MPF payable, balanced", () => {
  // Totals: relevant 7,600,000; employer 180,000; employee 105,000; net 7,495,000.
  expect(proposal.lines).toEqual([
    { account_code: "6010", amount_minor: 7600000, memo: "Salaries and wages" },
    { account_code: "6020", amount_minor: 180000, memo: "Employer MPF contributions" },
    { account_code: "1020", amount_minor: -7495000, memo: "Net pay" },
    { account_code: "2110", amount_minor: -285000, memo: "MPF contributions payable (employer and employee)" },
  ]);
  const batch = accountingBatch(proposal);
  expect(batchProblems(batch)).toEqual([]);
  expect(batch.items[0]).toEqual({ table: "journal_entries", record_id: "hr-payroll-2026-01-1", profile: { entry_ref: "hr-payroll-2026-01-1", entry_date: "2026-01-31", period: "2026-01", description: "Payroll 2026-01, run 1", source: "payroll", reverses: null } });
  expect(batch.items[1]).toEqual({ table: "journal_lines", record_id: "hr-payroll-2026-01-1-001", profile: { entry_ref: "hr-payroll-2026-01-1", entry_date: "2026-01-31", period: "2026-01", account_code: "6010", amount_minor: 7600000, currency: "HKD", base_minor: 7600000, contact_id: null, memo: "Salaries and wages" } });
  // No personal data goes to the books.
  const text = JSON.stringify(batch);
  for (const line of plan.lines) { expect(text).not.toContain(line.employee_name); expect(text).not.toContain(line.employee_id); }
  // The same run always proposes the same entry: posting it twice meets Accounting's unique entry_ref.
  expect(accountingBatch(payrollProposal({ runRef: plan.runRef, period: plan.period, entryDate: plan.entryDate, runNo: 1 }, plan.totals, DEFAULT_PAYROLL_ACCOUNTS))).toEqual(batch);
});

test("zero lines are dropped, accounts the owner merges net together, and a run with nothing to post is refused", () => {
  const exempt = planRun({ period: "2026-01", runNo: 1, employees: [EMPLOYEES[2]!], salaries: SALARIES, rates: [RATE] });
  const p = payrollProposal({ runRef: exempt.runRef, period: "2026-01", entryDate: "2026-01-31", runNo: 1 }, exempt.totals, DEFAULT_PAYROLL_ACCOUNTS);
  expect(p.lines.map((l) => l.account_code)).toEqual(["6010", "1020"]);
  const same = payrollProposal({ runRef: plan.runRef, period: "2026-01", entryDate: "2026-01-31", runNo: 1 }, plan.totals, { ...DEFAULT_PAYROLL_ACCOUNTS, mpfPayable: "1020" });
  expect(same.lines.map((l) => [l.account_code, l.amount_minor])).toEqual([["6010", 7600000], ["6020", 180000], ["1020", -7780000]]);
  expect(() => payrollProposal({ runRef: "hr-payroll-2026-01-1", period: "2026-01", entryDate: "2026-01-31", runNo: 1 }, { relevantIncomeMinor: 0, employerMinor: 0, employeeMinor: 0, netPayMinor: 0 }, DEFAULT_PAYROLL_ACCOUNTS)).toThrow(PostingError);
  expect(() => payrollProposal({ runRef: plan.runRef, period: "2026-01", entryDate: "2026-01-31", runNo: 1 }, plan.totals, { ...DEFAULT_PAYROLL_ACCOUNTS, salaries: "salaries" })).toThrow(PostingError);
});

test("an approved claim posts as expense against the amount owed, dated its approval, HKD only", () => {
  const claim = { id: "cl-0a1b2c3d4e5f", amountMinor: 45050, currency: "HKD", category: "travel", merchant: "Example Taxi", claimDate: "2026-02-27", decidedOn: "2026-03-02" };
  const p = claimProposal(claim, defaultClaimAccounts("travel"));
  expect(p).toMatchObject({ source: "claim", entryRef: "hr-claim-cl-0a1b2c3d4e5f", entryDate: "2026-03-02", period: "2026-03" });
  expect(p.lines).toEqual([{ account_code: "6210", amount_minor: 45050, memo: "Example Taxi (2026-02-27)" }, { account_code: "2020", amount_minor: -45050, memo: "Owed to the employee" }]);
  expect(batchProblems(accountingBatch(p))).toEqual([]);
  expect(claimProposal({ ...claim, decidedOn: null }, defaultClaimAccounts("travel")).entryDate).toBe("2026-02-27");
  expect(defaultClaimAccounts("unknown").expense).toBe("6900");
  expect(() => claimProposal({ ...claim, currency: "USD" }, defaultClaimAccounts("travel"))).toThrow(/HKD only/);
  expect(() => claimProposal(claim, { expense: "2020", payable: "2020" })).toThrow(PostingError);
  expect(() => claimProposal({ ...claim, id: "x".repeat(116) }, defaultClaimAccounts("travel"))).toThrow(/too long/);
});

test("the batch checks are Accounting's: each broken rule is reported", () => {
  const good = accountingBatch(proposal);
  const broken = (edit: (b: typeof good) => void) => { const b = structuredClone(good); edit(b); return batchProblems(b); };
  expect(broken((b) => { (b.items[1]!.profile as { amount_minor: number; base_minor: number }).base_minor += 1; })).not.toEqual([]);
  expect(broken((b) => { (b.items[2]!.profile as { period: string }).period = "2026-02"; })).not.toEqual([]);
  expect(broken((b) => { (b.items[0]!.profile as { reverses: string | null }).reverses = "x"; })).not.toEqual([]);
  expect(broken((b) => { delete (b.items[1] as { table?: string }).table; })).not.toEqual([]);
  expect(broken((b) => { b.items.splice(2); })).not.toEqual([]);
  expect(broken((b) => { (b.items[0]!.profile as { entry_ref: string }).entry_ref = "hr-payroll-2026-01"; })).not.toEqual([]);
  expect(broken((b) => { for (const i of b.items) { (i.profile as { entry_date: string }).entry_date = "2026-02-30"; (i.profile as { period: string }).period = "2026-02"; } })).not.toEqual([]);
});

test("a postings row is the prepared proposal with the exact batch, in the postings columns", () => {
  const row = postingProfile(proposal);
  expect(Object.keys(row)).toEqual(columns("postings"));
  expect(row).toMatchObject({ source: "payroll", source_id: "hr-payroll-2026-01-1", entry_ref: "hr-payroll-2026-01-1", stage: "prepared", posting_ref: null, posted_on: null });
  expect(row.batch).toEqual(accountingBatch(proposal));
});

test("every payroll and posting message the screen shows has a zh-HK entry", async () => {
  const { zhHK } = await import("../../src/features/hr/localeCatalog.ts");
  const { SKIP_TEXT } = await import("../../src/domain/payroll.ts");
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
  const found = new Set<string>(Object.values(SKIP_TEXT));
  for (const m of read("src/domain/posting.ts").matchAll(/PostingError\("([^"]+)"\)/g)) found.add(m[1]!);
  for (const m of read("src/domain/payroll.ts").matchAll(/return "([^"]* [^"]*)";/g)) found.add(m[1]!);
  for (const m of read("src/features/hr/PayrollPanes.tsx").matchAll(/hostErrorText\([^,]+, "([^"]+)"\)/g)) found.add(m[1]!);
  for (const m of read("src/features/hr/PayrollPanes.tsx").matchAll(/(?:salaries|mpfExpense|netPay|mpfPayable|expense|payable): "([^"]+)"/g)) found.add(m[1]!);
  for (const s of ["Payroll", "Payroll runs", "Salaries", "MPF rates", "Postings", "Prepared", "Posted", "Draft", "Approved", "Cancelled"]) found.add(s);
  expect(found.size).toBeGreaterThan(20);
  expect([...found].filter((s) => !(s in zhHK))).toEqual([]);
});
