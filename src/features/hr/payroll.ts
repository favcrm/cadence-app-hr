// Payroll's host calls: the MPF rate rows, salaries, saving a run with its lines as one batch, approving or cancelling
// a run, and preparing an Accounting posting. Pure orchestration over `HostActions`, so tests drive it with an
// in-memory host. Every write is safe to repeat: a unique key makes a second row impossible, and a refusal or a lost
// reply counts as "already recorded" only after an exact re-read proves the row is there and is the same one.
// The screen cannot read the Accounting app; whether an entry is in its journal is decided there, by the hr-posting skill.
import { ApiError } from "@cadence/screen-ui";
import { FIRST_MPF_RATE, rateRecordId } from "../../domain/mpf-rates";
import type { RateTable } from "../../domain/mpf";
import {
  nextRunNo, nextSeq, planRun, postingBlock, runBatch, sameLines, sumTotals, unsavable, type Adjustment, type EmployeeFacts, type PayrollLine, type RunFact, type RunPlan, type SalaryRow,
} from "../../domain/payroll";
import {
  claimProposal, payrollProposal, postingProfile, PostingError, type ClaimAccounts, type PayrollAccounts, type Proposal,
} from "../../domain/posting";
import { decisionPatch, FormError, newRecordId, resolveEmployee } from "../../domain/records";
import { realDate } from "../../domain/people";
import { hostActions, type HostActions, type HostRecord, type HostScope } from "./hostActions";
import { listAll } from "./ledger";

export const RATES = "rate_tables";
export const SALARIES = "salaries";
export const RUNS = "payroll_runs";
export const LINES = "payroll_lines";
export const POSTINGS = "postings";
const UNSURE = [409, 503, 504];
const unsure = (e: unknown) => e instanceof ApiError && UNSURE.includes(e.status);
const p = (r: HostRecord) => (r.profile ?? {}) as Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

// ---- reading -------------------------------------------------------------------------------------------------
export function toRate(r: HostRecord): RateTable | null {
  const x = p(r);
  const rate = {
    effectiveFrom: str(x.effective_from) ?? "", employerRateBp: int(x.employer_rate_bp) ?? -1, employeeRateBp: int(x.employee_rate_bp) ?? -1,
    minRelevantIncomeMinor: int(x.min_relevant_income_minor) ?? -1, maxRelevantIncomeMinor: int(x.max_relevant_income_minor) ?? -1,
    holidayDays: int(x.holiday_days) ?? -1, currency: str(x.currency) ?? "",
  };
  return Object.values(rate).some((v) => v === -1 || v === "") ? null : rate;
}
export function toSalary(r: HostRecord): SalaryRow | null {
  const x = p(r);
  const employeeId = str(x.employee_id), effectiveFrom = str(x.effective_from), seq = int(x.seq), monthly = int(x.monthly_minor), currency = str(x.currency);
  if (employeeId === null || effectiveFrom === null || !realDate(effectiveFrom) || seq === null || monthly === null || currency === null) return null;
  return { id: r.id, employeeId, effectiveFrom, seq, monthlyMinor: monthly, currency, mpfExempt: x.mpf_exempt === true, note: str(x.note) };
}
export const toEmployee = (r: HostRecord): EmployeeFacts => {
  const x = p(r);
  return { id: r.id, name: str(x.display_name) ?? r.id, joinDate: str(x.join_date), leaveDate: str(x.leave_date), status: str(x.status) };
};
export const readRates = async (scope: HostScope, actions: HostActions = hostActions) => listAll(scope, RATES, [], actions);
export const readSalaries = async (scope: HostScope, actions: HostActions = hostActions) => listAll(scope, SALARIES, [], actions);

// ---- the first rate row ------------------------------------------------------------------------------------------
/** Write the first MPF rate row under its fixed record id. A second load, or a retry after a lost reply, meets it. */
export async function addFirstRate(scope: HostScope, actions: HostActions = hostActions): Promise<"created" | "exists"> {
  const find = async () => (await actions.list(scope, { table: RATES, filters: [{ field: "effective_from", op: "eq", value: FIRST_MPF_RATE.effective_from }], limit: 2 })).records;
  if ((await find()).length > 0) return "exists";
  try {
    await actions.create(scope, rateRecordId(FIRST_MPF_RATE.effective_from), FIRST_MPF_RATE, RATES);
    return "created";
  } catch (error) {
    if (unsure(error) && (await find()).length > 0) return "exists";
    throw error;
  }
}

// ---- salaries ------------------------------------------------------------------------------------------------------
export interface SalaryInput { employeeNo: string; effectiveFrom: string; monthlyMinor: number; mpfExempt: boolean; note: string }
const DIFFERENT_SALARY_TEXT = "A different salary was saved for this employee and date at the same moment. Reload and check the salaries.";
/**
 * Add a salary row. A correction on the same date takes the next `seq` (the highest counts). The record id is chosen
 * once per open form, so a retry after a lost reply meets its own row instead of adding a second.
 */
export async function addSalary(scope: HostScope, input: SalaryInput, recordId: string, actions: HostActions = hostActions): Promise<HostRecord> {
  const employee = await resolveEmployee((args) => actions.list(scope, args), input.employeeNo);
  const mine = async () => (await listAll(scope, SALARIES, [{ field: "employee_id", op: "eq", value: employee.id }], actions));
  const before = await mine();
  const own = before.find((r) => r.id === recordId);
  if (own) return own;
  const existing = before.map(toSalary).filter((s): s is SalaryRow => s !== null);
  const note = input.note.trim();
  const profile = { employee_id: employee.id, effective_from: input.effectiveFrom, seq: nextSeq(existing, employee.id, input.effectiveFrom), monthly_minor: input.monthlyMinor, currency: "HKD", mpf_exempt: input.mpfExempt, note: note === "" ? null : note };
  try {
    return await actions.create(scope, recordId, profile, SALARIES);
  } catch (error) {
    if (!unsure(error)) throw error;
    const rows = await mine();
    const found = rows.find((r) => r.id === recordId);
    if (found) return found;
    if (rows.some((r) => p(r).effective_from === profile.effective_from && p(r).seq === profile.seq)) throw new FormError(null, DIFFERENT_SALARY_TEXT);
    throw error;
  }
}

// ---- runs ---------------------------------------------------------------------------------------------------------
export interface RunInputs { period: string; runNo: number; employees: EmployeeFacts[]; salaries: SalaryRow[]; rates: RateTable[]; earlier: HostRecord[] }
/** Everything a month's run depends on, read once. Writes nothing. A read that fails or does not finish rejects. */
export async function readRunInputs(scope: HostScope, period: string, actions: HostActions = hostActions): Promise<RunInputs> {
  const [employees, salaries, rates, earlier] = await Promise.all([
    listAll(scope, undefined, [], actions), readSalaries(scope, actions), readRates(scope, actions),
    listAll(scope, RUNS, [{ field: "period", op: "eq", value: period }], actions),
  ]);
  return {
    period, runNo: nextRunNo(earlier.map((r) => int(p(r).run_no) ?? 0)), employees: employees.map(toEmployee),
    salaries: salaries.map(toSalary).filter((s): s is SalaryRow => s !== null), rates: rates.map(toRate).filter((r): r is RateTable => r !== null), earlier,
  };
}
export const computeRun = (inputs: RunInputs, adjustments: Record<string, Adjustment>): RunPlan => planRun({ ...inputs, adjustments });

const OTHER_RUN_TEXT = "Another run was saved under this number at the same moment. Nothing was written. Reload the runs and start again.";
/**
 * Save the run and its lines as one `records.batch`: all of them or none. After a refusal or a lost reply the run is
 * looked up by its reference: the same run with the same lines means it is saved; another one stops.
 */
export async function saveRun(scope: HostScope, plan: RunPlan, actions: HostActions = hostActions): Promise<"created" | "exists"> {
  const problem = unsavable(plan);
  if (problem !== null) throw new FormError(null, problem);
  try {
    await actions.batch(scope, runBatch(plan));
    return "created";
  } catch (error) {
    if (!unsure(error)) throw error;
    const found = await findRun(scope, plan.runRef, actions);
    if (found === null) throw error;
    const lines = await readLines(scope, plan.runRef, actions);
    if (int(p(found).line_count) !== plan.lines.length || !sameLines(lines.map((l) => l.profile), plan.lines)) throw new FormError(null, OTHER_RUN_TEXT);
    return "exists";
  }
}
export async function findRun(scope: HostScope, ref: string, actions: HostActions = hostActions): Promise<HostRecord | null> {
  const page = await actions.list(scope, { table: RUNS, filters: [{ field: "run_ref", op: "eq", value: ref }], limit: 2 });
  return page.records.find((r) => p(r).run_ref === ref) ?? null;
}
export const readLines = (scope: HostScope, ref: string, actions: HostActions = hostActions) => listAll(scope, LINES, [{ field: "run_ref", op: "eq", value: ref }], actions);
export const readRuns = (scope: HostScope, actions: HostActions = hostActions) => listAll(scope, RUNS, [], actions);

const RUN_NOT_DRAFT_TEXT = "This run is no longer a draft. Reload it to see what happened.";
const RUN_CHANGED_TEXT = "This run changed after you opened it. Reload it, then decide again.";
const RUN_INCOMPLETE_TEXT = "This run's lines do not match it, so it cannot be approved. Cancel it and save a new run.";
/** A run's lines, read whole and checked against the run: every line present and made for it. */
export async function runLines(scope: HostScope, run: HostRecord, actions: HostActions = hostActions): Promise<PayrollLine[]> {
  const ref = str(p(run).run_ref);
  if (ref === null) throw new FormError(null, RUN_INCOMPLETE_TEXT);
  const lines = (await readLines(scope, ref, actions)).map((l) => l.profile as PayrollLine);
  if (lines.length !== int(p(run).line_count) || lines.some((l) => l.run_ref !== ref || l.currency !== "HKD")) throw new FormError(null, RUN_INCOMPLETE_TEXT);
  return lines;
}
/**
 * Approve or cancel a draft run: re-read it (still a draft, at the revision the owner saw), check its lines are whole
 * before an approval, then set the status. Once approved or cancelled the run's write rule refuses any further change.
 */
export async function decideRun(scope: HostScope, run: HostRecord, decision: "approved" | "cancelled", today: string, note: string, actions: HostActions = hostActions): Promise<HostRecord> {
  const patch = { ...decisionPatch("approved", today, note), status: decision };
  const fresh = await actions.show(scope, run.id, RUNS);
  if (p(fresh).status !== "draft") throw new FormError(null, RUN_NOT_DRAFT_TEXT);
  if (fresh.revision !== run.revision) throw new FormError(null, RUN_CHANGED_TEXT);
  if (decision === "approved") await runLines(scope, fresh, actions);
  return actions.update(scope, fresh.id, fresh.revision, patch, RUNS);
}

// ---- postings --------------------------------------------------------------------------------------------------------
const NOT_APPROVED_TEXT = "Only an approved run or claim can be posted.";
const POSTED_TEXT = "HR already has a record that this was posted to Accounting, so it cannot be prepared again.";
export async function findPosting(scope: HostScope, source: "payroll" | "claim", sourceId: string, actions: HostActions = hostActions): Promise<HostRecord | null> {
  const page = await actions.list(scope, { table: POSTINGS, filters: [{ field: "source", op: "eq", value: source }, { field: "source_id", op: "eq", value: sourceId }], limit: 2 });
  return page.records.find((r) => p(r).source === source && p(r).source_id === sourceId) ?? null;
}
export const readPostings = (scope: HostScope, actions: HostActions = hostActions) => listAll(scope, POSTINGS, [], actions);

export const toRunFact = (r: HostRecord): RunFact => ({ runRef: str(p(r).run_ref) ?? r.id, period: str(p(r).period) ?? "", runNo: int(p(r).run_no) ?? 0, status: str(p(r).status) ?? "" });
/** Every run of a month and the references HR records as posted: what the one-payroll-a-month rule reads. */
export async function monthPostingFacts(scope: HostScope, period: string, actions: HostActions = hostActions) {
  const [runs, postings] = await Promise.all([
    listAll(scope, RUNS, [{ field: "period", op: "eq", value: period }], actions),
    listAll(scope, POSTINGS, [{ field: "source", op: "eq", value: "payroll" }, { field: "period", op: "eq", value: period }], actions),
  ]);
  return { runs: runs.map(toRunFact), posted: new Set(postings.filter((r) => p(r).stage === "posted").map((r) => String(p(r).source_id))) };
}
/**
 * The proposal for an approved run, from a fresh read of the run and its whole set of lines. One payroll a month goes
 * to the books: a superseded run is refused, and so is a run while an earlier run of the month is recorded as posted,
 * unless the owner confirms (`reversed`) they reversed that one in Accounting.
 */
export async function runProposal(scope: HostScope, runId: string, accounts: PayrollAccounts, actions: HostActions = hostActions, reversed: ReadonlySet<string> = new Set()): Promise<Proposal> {
  const run = await actions.show(scope, runId, RUNS);
  const x = p(run);
  if (x.status !== "approved") throw new FormError(null, NOT_APPROVED_TEXT);
  const facts = await monthPostingFacts(scope, String(x.period), actions);
  const block = postingBlock(toRunFact(run), facts.runs, facts.posted, reversed);
  if (block !== null) throw new FormError(null, block);
  const lines = await runLines(scope, run, actions);
  return payrollProposal({ runRef: String(x.run_ref), period: String(x.period), entryDate: String(x.entry_date), runNo: int(x.run_no) ?? 0 }, sumTotals(lines), accounts);
}
/** The proposal for an approved claim, from a fresh read of the claim. */
export async function claimProposalFor(scope: HostScope, claimId: string, accounts: ClaimAccounts, actions: HostActions = hostActions): Promise<Proposal> {
  const claim = await actions.show(scope, claimId, "claims");
  const x = p(claim);
  if (x.status !== "approved") throw new FormError(null, NOT_APPROVED_TEXT);
  return claimProposal({ id: claim.id, amountMinor: int(x.amount_minor) ?? 0, currency: str(x.currency) ?? "", category: str(x.category) ?? "other", merchant: str(x.merchant) ?? "", claimDate: str(x.claim_date) ?? "", decidedOn: str(x.decided_on) }, accounts);
}

/**
 * Store the proposal on its `postings` row: a new row, or the prepared row rewritten with the owner's accounts. A row
 * HR has recorded as posted is final. After a refusal or a lost reply the row is re-read by its source.
 */
export async function preparePosting(scope: HostScope, proposal: Proposal, actions: HostActions = hostActions): Promise<HostRecord> {
  let profile;
  try { profile = postingProfile(proposal); } catch (e) { if (e instanceof PostingError) throw new FormError(null, e.message); throw e; }
  const existing = await findPosting(scope, proposal.source, proposal.sourceId, actions);
  if (existing !== null) {
    if (p(existing).stage !== "prepared") throw new FormError(null, POSTED_TEXT);
    return actions.update(scope, existing.id, existing.revision, { batch: profile.batch, entry_date: profile.entry_date, period: profile.period, calc_version: profile.calc_version }, POSTINGS);
  }
  try {
    return await actions.create(scope, newRecordId("post"), profile, POSTINGS);
  } catch (error) {
    if (!unsure(error)) throw error;
    const found = await findPosting(scope, proposal.source, proposal.sourceId, actions);
    if (found === null) throw error;
    if (JSON.stringify(p(found).batch) !== JSON.stringify(profile.batch)) throw new FormError(null, "A different posting was prepared at the same moment. Reload the postings and check it.");
    return found;
  }
}
