// A monthly payroll run, computed in the screen: who is paid, from which salary row and rate row, and every line's
// relevant income, MPF and net pay. Pure: no host, DOM or React. The agent never computes any of this.
// Columns mirror app/storage/004-payroll.json (`salaries`, `payroll_runs`, `payroll_lines`); tests keep them in step.
import { monthEnd, monthStart, parseMonth } from "./leave";
import { mpf, rateFor, validRate, type RateTable } from "./mpf";
import { realDate } from "./people";

/** Changes whenever a line's arithmetic or inputs change; every stored line carries it. */
export const CALC_VERSION = "payroll-1";
export const PAYROLL_CURRENCY = "HKD";
/**
 * The bytes of `records.batch` arguments a run is saved in. The receiver allows 49,152, but a board without the
 * CAD-2263 limit closes the frame above 16,384, so a run is held to that (as Run accrual is). A run is one batch,
 * all or nothing: it is never split.
 */
export const RUN_BATCH_BYTES = 16384;
export const MAX_MINOR = 99999999999;

export interface EmployeeFacts { id: string; name: string; joinDate: string | null; leaveDate: string | null; status: string | null }
export interface SalaryRow { id: string; employeeId: string; effectiveFrom: string; seq: number; monthlyMinor: number; currency: string; mpfExempt: boolean; note: string | null }
export interface Adjustment { additionsMinor: number; deductionsMinor: number }

export interface PayrollLine {
  run_ref: string;
  employee_id: string;
  employee_name: string;
  join_date: string;
  salary_id: string;
  monthly_minor: number;
  additions_minor: number;
  deductions_minor: number;
  mpf_exempt: boolean;
  rate_effective_from: string;
  relevant_income_minor: number;
  employer_mpf_minor: number;
  employee_mpf_minor: number;
  net_pay_minor: number;
  currency: string;
  calc_version: string;
}
export interface RunHeader {
  run_ref: string; period: string; run_no: number; entry_date: string; status: "draft"; line_count: number; calc_version: string;
  decided_on: null; decision_note: null;
}
export type SkipReason = "no_join_date" | "not_started" | "left" | "no_salary" | "salary_currency";
export const SKIP_TEXT: Record<SkipReason, string> = {
  no_join_date: "no join date, so the contribution holiday cannot be worked out",
  not_started: "joins after this month",
  left: "left before this month",
  no_salary: "no salary in effect for this month",
  salary_currency: "the salary is not in HKD",
};
export interface Totals { relevantIncomeMinor: number; employerMinor: number; employeeMinor: number; netPayMinor: number }
export interface RunPlan {
  period: string;
  runNo: number;
  runRef: string;
  entryDate: string;
  rate: RateTable | null;
  lines: PayrollLine[];
  skipped: { employeeId: string; name: string; reason: SkipReason }[];
  /** Employees whose deductions are more than their pay; the run cannot be saved until they are corrected. */
  invalid: { employeeId: string; name: string }[];
  totals: Totals;
}

export const runRef = (period: string, runNo: number): string => `hr-payroll-${period}-${runNo}`;
export const isPeriod = (text: string): boolean => parseMonth(text) !== null && /^\d{4}-\d{2}$/.test(text);

/** The salary in effect for a month: the latest `effective_from` on or before its last day; on one date, the highest `seq`. */
export function salaryFor(rows: readonly SalaryRow[], employeeId: string, period: string): SalaryRow | null {
  const end = monthEnd(period);
  return rows.filter((r) => r.employeeId === employeeId && r.effectiveFrom <= end)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.seq - a.seq)[0] ?? null;
}

/** The next correction number for a salary on a date: one more than the highest stored on that date. */
export function nextSeq(rows: readonly SalaryRow[], employeeId: string, effectiveFrom: string): number {
  return rows.filter((r) => r.employeeId === employeeId && r.effectiveFrom === effectiveFrom).reduce((max, r) => Math.max(max, r.seq), 0) + 1;
}

/** Why an employee is not in the month's run, or null when they are employed in it. */
function absence(e: EmployeeFacts, period: string): SkipReason | null {
  if (e.joinDate === null || !realDate(e.joinDate)) return "no_join_date";
  if (e.joinDate > monthEnd(period)) return "not_started";
  if (e.leaveDate !== null && realDate(e.leaveDate) ? e.leaveDate < monthStart(period) : e.status === "left") return "left";
  return null;
}

export const sumTotals = (lines: readonly Pick<PayrollLine, "relevant_income_minor" | "employer_mpf_minor" | "employee_mpf_minor" | "net_pay_minor">[]): Totals => lines.reduce<Totals>((t, l) => ({
  relevantIncomeMinor: t.relevantIncomeMinor + l.relevant_income_minor, employerMinor: t.employerMinor + l.employer_mpf_minor,
  employeeMinor: t.employeeMinor + l.employee_mpf_minor, netPayMinor: t.netPayMinor + l.net_pay_minor,
}), { relevantIncomeMinor: 0, employerMinor: 0, employeeMinor: 0, netPayMinor: 0 });

const amount = (n: number | undefined) => (Number.isSafeInteger(n) && n! >= 0 && n! <= MAX_MINOR ? n! : 0);

/**
 * Compute a month's run. `runNo` is the next number for the period (a cancelled or corrected run keeps its number).
 * Relevant income is the monthly salary plus additions (allowances, commission, bonus) less deductions (unpaid leave,
 * a part month); the owner types the last two per line. Net pay is relevant income less the employee's contribution.
 */
export function planRun(input: {
  period: string; runNo: number; employees: readonly EmployeeFacts[]; salaries: readonly SalaryRow[]; rates: readonly RateTable[];
  adjustments?: Readonly<Record<string, Adjustment>>;
}): RunPlan {
  const { period, runNo } = input;
  if (!isPeriod(period) || !Number.isInteger(runNo) || runNo < 1) throw new RangeError("period or run number is invalid");
  const ref = runRef(period, runNo);
  const rate = rateFor(input.rates.filter(validRate), period);
  const plan: RunPlan = { period, runNo, runRef: ref, entryDate: monthEnd(period), rate, lines: [], skipped: [], invalid: [], totals: sumTotals([]) };
  if (rate === null) return plan;
  const employees = [...input.employees].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const e of employees) {
    const away = absence(e, period);
    if (away !== null) { if (away !== "not_started") plan.skipped.push({ employeeId: e.id, name: e.name, reason: away }); continue; }
    const salary = salaryFor(input.salaries, e.id, period);
    if (salary === null) { plan.skipped.push({ employeeId: e.id, name: e.name, reason: "no_salary" }); continue; }
    if (salary.currency !== PAYROLL_CURRENCY) { plan.skipped.push({ employeeId: e.id, name: e.name, reason: "salary_currency" }); continue; }
    const adj = input.adjustments?.[e.id];
    const additions = amount(adj?.additionsMinor), deductions = amount(adj?.deductionsMinor);
    const relevant = salary.monthlyMinor + additions - deductions;
    if (relevant < 0 || relevant > MAX_MINOR) { plan.invalid.push({ employeeId: e.id, name: e.name }); continue; }
    const { employerMinor, employeeMinor } = mpf(relevant, e.joinDate!, period, rate, salary.mpfExempt);
    plan.lines.push({
      run_ref: ref, employee_id: e.id, employee_name: e.name, join_date: e.joinDate!, salary_id: salary.id, monthly_minor: salary.monthlyMinor,
      additions_minor: additions, deductions_minor: deductions, mpf_exempt: salary.mpfExempt, rate_effective_from: rate.effectiveFrom,
      relevant_income_minor: relevant, employer_mpf_minor: employerMinor, employee_mpf_minor: employeeMinor, net_pay_minor: relevant - employeeMinor,
      currency: PAYROLL_CURRENCY, calc_version: CALC_VERSION,
    });
  }
  plan.totals = sumTotals(plan.lines);
  return plan;
}

export interface RunBatchItem { record_id: string; table: "payroll_runs" | "payroll_lines"; profile: RunHeader | PayrollLine }
export const lineRecordId = (ref: string, index: number): string => `${ref}-${String(index + 1).padStart(3, "0")}`;

/** Why a plan cannot be saved, as the English text the screen translates, or null when it can. */
export function unsavable(plan: RunPlan): string | null {
  if (plan.rate === null) return "No MPF rate is in effect for this month. Add the MPF rates first.";
  if (plan.invalid.length > 0) return "Some deductions are more than the pay. Correct them before saving.";
  if (plan.lines.length === 0) return "Nobody is paid in this month, so there is no run to save.";
  if (batchBytes(runBatch(plan)) > RUN_BATCH_BYTES) return "This run is too large to save in one step from this screen.";
  return null;
}

/** The run and its lines as one `records.batch`: the run's record id is its reference, each line's is the reference and its number. */
export function runBatch(plan: RunPlan): RunBatchItem[] {
  const header: RunHeader = {
    run_ref: plan.runRef, period: plan.period, run_no: plan.runNo, entry_date: plan.entryDate, status: "draft", line_count: plan.lines.length,
    calc_version: CALC_VERSION, decided_on: null, decision_note: null,
  };
  return [{ record_id: plan.runRef, table: "payroll_runs", profile: header }, ...plan.lines.map((profile, i) => ({ record_id: lineRecordId(plan.runRef, i), table: "payroll_lines" as const, profile }))];
}
export const batchBytes = (items: readonly unknown[]): number => new TextEncoder().encode(JSON.stringify({ items })).length;

/** The figures that make two stored lines the same line (a retry that met its own run, not another one). */
const LINE_KEYS = ["run_ref", "employee_id", "salary_id", "monthly_minor", "additions_minor", "deductions_minor", "mpf_exempt", "rate_effective_from", "relevant_income_minor", "employer_mpf_minor", "employee_mpf_minor", "net_pay_minor", "calc_version"] as const;
export function sameLines(stored: readonly unknown[], planned: readonly PayrollLine[]): boolean {
  if (stored.length !== planned.length) return false;
  const byEmployee = new Map(stored.map((p) => [(p as Record<string, unknown> | null)?.employee_id, p as Record<string, unknown>]));
  return planned.every((line) => { const s = byEmployee.get(line.employee_id); return s !== undefined && LINE_KEYS.every((k) => s[k] === line[k]); });
}

// ---- one payroll per month in the books ---------------------------------------------------------------------------
/** What the one-payroll-a-month rule needs of a stored run. */
export interface RunFact { runRef: string; period: string; runNo: number; status: string }
/**
 * The run that supersedes this one, or null. An approved run cannot change, so a correction is a later run of the
 * same month; once a later-numbered run of that month is approved, this one is superseded. Derived, never stored.
 */
export function supersededBy(run: RunFact, runs: readonly RunFact[]): RunFact | null {
  return runs.filter((r) => r.period === run.period && r.status === "approved" && r.runNo > run.runNo).sort((a, b) => b.runNo - a.runNo)[0] ?? null;
}
/** Earlier approved runs of the same month that HR records as posted: they stand in the books until reversed there. */
export function postedEarlier(run: RunFact, runs: readonly RunFact[], posted: ReadonlySet<string>): RunFact[] {
  return runs.filter((r) => r.period === run.period && r.status === "approved" && r.runNo < run.runNo && posted.has(r.runRef)).sort((a, b) => a.runNo - b.runNo);
}
export const SUPERSEDED_TEXT = "This run is superseded: a later run for the same month is approved. Only the latest approved run of a month is posted.";
export const POSTED_EARLIER_TEXT = "An earlier run for this month is recorded as posted. Reverse it in the Accounting app's Journal first, then confirm that here and ask the assistant to post this run; it checks the journal before it stages anything.";
/**
 * Why a run cannot be prepared for posting, or null. `reversed` lists the earlier references the owner confirms they
 * reversed in Accounting: the screen cannot read Accounting, so the `hr-posting` skill checks the journal itself.
 */
export function postingBlock(run: RunFact, runs: readonly RunFact[], posted: ReadonlySet<string>, reversed: ReadonlySet<string> = new Set()): string | null {
  if (supersededBy(run, runs) !== null) return SUPERSEDED_TEXT;
  if (postedEarlier(run, runs, posted).some((r) => !reversed.has(r.runRef))) return POSTED_EARLIER_TEXT;
  return null;
}

/** The next run number for a period: one more than any stored, whatever its status. */
export const nextRunNo = (runNos: readonly number[]): number => runNos.reduce((max, n) => Math.max(max, n), 0) + 1;
