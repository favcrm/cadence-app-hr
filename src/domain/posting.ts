// The Accounting journal entry for an approved payroll run or an approved expense claim, computed in the screen and
// stored on a `postings` row so the `hr-posting` skill copies it and never works a figure out. The shape is the
// Accounting app's own (0.3.0, `hr-posting-intake` and `bookkeeping-entry/references/entry.md`): one `journal_entries`
// row and two or more `journal_lines` rows in one `records.batch`, signed HKD minor units (a debit positive), lines
// summing to 0. Payroll is posted as totals by account: no employee's name or pay goes to the books.
// The account codes are generic defaults from Accounting's starter chart, not accounting advice; the owner can change
// them for each posting. Pure: no host, DOM or React.
import { realDate } from "./people";
import type { Totals } from "./payroll";

export const POSTING_VERSION = "posting-1";
export const ACCOUNT_CODE = /^[0-9A-Z-]{1,12}$/;
const REF = /^[A-Za-z0-9_-]{1,160}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_JOURNAL_LINES = 199;

export interface PayrollAccounts { salaries: string; mpfExpense: string; netPay: string; mpfPayable: string }
export interface ClaimAccounts { expense: string; payable: string }
/** Salaries and wages, retirement scheme contributions, the operating bank account, and contributions payable. */
export const DEFAULT_PAYROLL_ACCOUNTS: PayrollAccounts = { salaries: "6010", mpfExpense: "6020", netPay: "1020", mpfPayable: "2110" };
/** A claim is an expense by its category, owed to the employee until it is paid (accrued expenses). */
export const DEFAULT_CLAIM_EXPENSE: Record<string, string> = { travel: "6210", meals: "6220", supplies: "6120", other: "6900" };
export const DEFAULT_CLAIM_PAYABLE = "2020";
export const defaultClaimAccounts = (category: string): ClaimAccounts => ({ expense: DEFAULT_CLAIM_EXPENSE[category] ?? DEFAULT_CLAIM_EXPENSE.other!, payable: DEFAULT_CLAIM_PAYABLE });

export interface ProposedLine { account_code: string; amount_minor: number; memo: string | null }
export interface Proposal { source: "payroll" | "claim"; sourceId: string; entryRef: string; entryDate: string; period: string; description: string; lines: ProposedLine[] }

export interface JournalEntryProfile { entry_ref: string; entry_date: string; period: string; description: string; source: "payroll" | "claim"; reverses: null }
export interface JournalLineProfile { entry_ref: string; entry_date: string; period: string; account_code: string; amount_minor: number; currency: "HKD"; base_minor: number; contact_id: null; memo: string | null }
export type AccountingItem =
  | { table: "journal_entries"; record_id: string; profile: JournalEntryProfile }
  | { table: "journal_lines"; record_id: string; profile: JournalLineProfile };
export interface AccountingBatch { items: AccountingItem[] }

/** A problem the owner can fix, as the English text the screen translates. */
export class PostingError extends Error { constructor(message: string) { super(message); this.name = "PostingError"; } }

export const claimEntryRef = (claimId: string): string => `hr-claim-${claimId}`;
const clip = (text: string, max: number) => (Array.from(text).length > max ? Array.from(text).slice(0, max).join("") : text);

/** Merge lines by account (an owner may give two roles one account), keep the first memo, drop what nets to 0. */
function merged(lines: readonly ProposedLine[]): ProposedLine[] {
  const out: ProposedLine[] = [];
  for (const line of lines) {
    const same = out.find((l) => l.account_code === line.account_code);
    if (same) same.amount_minor += line.amount_minor; else out.push({ ...line });
  }
  return out.filter((l) => l.amount_minor !== 0);
}

function checkCodes(codes: readonly string[]): void {
  if (!codes.every((c) => ACCOUNT_CODE.test(c))) throw new PostingError("An account code is 1 to 12 capitals, digits or hyphens, as in the Accounting chart.");
}

/**
 * A payroll run as one entry: debit salaries with the run's relevant income and the MPF expense with the employer's
 * contributions; credit the bank with net pay and contributions payable with both sides' contributions. It is the
 * worked example in Accounting's `hr-posting-intake`. Dated the period's last day (the run's `entry_date`).
 */
export function payrollProposal(run: { runRef: string; period: string; entryDate: string; runNo: number }, totals: Totals, accounts: PayrollAccounts): Proposal {
  checkCodes(Object.values(accounts));
  const lines = merged([
    { account_code: accounts.salaries, amount_minor: totals.relevantIncomeMinor, memo: "Salaries and wages" },
    { account_code: accounts.mpfExpense, amount_minor: totals.employerMinor, memo: "Employer MPF contributions" },
    { account_code: accounts.netPay, amount_minor: -totals.netPayMinor, memo: "Net pay" },
    { account_code: accounts.mpfPayable, amount_minor: -(totals.employerMinor + totals.employeeMinor), memo: "MPF contributions payable (employer and employee)" },
  ]);
  if (lines.length < 2) throw new PostingError("This run has nothing to post.");
  return { source: "payroll", sourceId: run.runRef, entryRef: run.runRef, entryDate: run.entryDate, period: run.period, description: `Payroll ${run.period}, run ${run.runNo}`, lines };
}

/**
 * An approved claim as one entry: debit the expense, credit the amount owed. Dated the day it was approved (the
 * company accepted the cost then), or the receipt date if no approval date is stored. HKD only: Accounting keeps HKD.
 */
export function claimProposal(claim: { id: string; amountMinor: number; currency: string; category: string; merchant: string; claimDate: string; decidedOn: string | null }, accounts: ClaimAccounts): Proposal {
  checkCodes([accounts.expense, accounts.payable]);
  if (claim.currency !== "HKD") throw new PostingError("Accounting keeps HKD only, so a claim in another currency cannot be posted from here.");
  if (accounts.expense === accounts.payable) throw new PostingError("The expense and the amount owed need two different accounts.");
  if (!Number.isSafeInteger(claim.amountMinor) || claim.amountMinor < 1) throw new PostingError("This claim has no amount to post.");
  const entryRef = claimEntryRef(claim.id);
  // Accounting's line record ids are the reference and -001, -002: they must stay within a record id.
  if (!RECORD_ID.test(`${entryRef}-002`)) throw new PostingError("This claim's record id is too long to post as an Accounting reference.");
  const entryDate = claim.decidedOn !== null && realDate(claim.decidedOn) ? claim.decidedOn : claim.claimDate;
  if (!realDate(entryDate)) throw new PostingError("This claim has no real date to post it on.");
  const what = claim.merchant.trim() !== "" ? claim.merchant.trim() : claim.category;
  const memo = clip(`${what} (${claim.claimDate})`, 100);
  return {
    source: "claim", sourceId: claim.id, entryRef, entryDate, period: entryDate.slice(0, 7), description: clip(`Expense claim: ${memo}`, 200),
    lines: [{ account_code: accounts.expense, amount_minor: claim.amountMinor, memo }, { account_code: accounts.payable, amount_minor: -claim.amountMinor, memo: "Owed to the employee" }],
  };
}

/** The `records.batch` arguments the `hr-posting` skill sends to Accounting, item for item. */
export function accountingBatch(p: Proposal): AccountingBatch {
  const head = { entry_ref: p.entryRef, entry_date: p.entryDate, period: p.period };
  const items: AccountingItem[] = [
    { table: "journal_entries", record_id: p.entryRef, profile: { ...head, description: clip(p.description, 200), source: p.source, reverses: null } },
    ...p.lines.map((l, i): AccountingItem => ({
      table: "journal_lines", record_id: `${p.entryRef}-${String(i + 1).padStart(3, "0")}`,
      profile: { ...head, account_code: l.account_code, amount_minor: l.amount_minor, currency: "HKD", base_minor: l.amount_minor, contact_id: null, memo: l.memo === null ? null : clip(l.memo, 100) },
    })),
  ];
  const problems = batchProblems({ items });
  if (problems.length > 0) throw new PostingError(problems[0]!);
  return { items };
}

/**
 * Accounting's checks for an HR batch (`hr-posting-intake/references/checks.md`) that need no read: the reference,
 * the entry row, lines agreeing with it, currency, no empty line, balance and size. The chart, "already posted" and
 * the opening balances need Accounting's own reads; the skill makes those.
 */
export function batchProblems(batch: { items: readonly { table?: string; record_id?: string; profile?: unknown }[] }): string[] {
  const out: string[] = [];
  const items = batch.items;
  if (items.some((i) => i.table !== "journal_entries" && i.table !== "journal_lines")) out.push("Every item must name its table.");
  const entries = items.filter((i) => i.table === "journal_entries");
  const lines = items.filter((i) => i.table === "journal_lines").map((i) => i.profile as JournalLineProfile);
  if (entries.length !== 1) return [...out, "A batch holds exactly one journal entry."];
  const e = entries[0]!.profile as JournalEntryProfile;
  const kind = e.source === "payroll" ? /^hr-payroll-\d{4}-(0[1-9]|1[0-2])-[1-9]\d*$/ : e.source === "claim" ? /^hr-claim-[A-Za-z0-9_-]+$/ : null;
  if (kind === null) out.push("The entry's source must be payroll or claim.");
  else if (!kind.test(e.entry_ref) || !REF.test(e.entry_ref)) out.push("The entry reference is not an HR payroll or claim reference.");
  if (entries[0]!.record_id !== e.entry_ref) out.push("The entry's record id must be its reference.");
  if (e.reverses !== null) out.push("An HR entry reverses nothing.");
  if (!realDate(e.entry_date) || e.period !== e.entry_date.slice(0, 7)) out.push("The date must be a real day and the period its month.");
  if (e.source === "payroll" && e.entry_ref.slice(11, 18) !== e.period) out.push("A payroll reference names the entry's month.");
  if (typeof e.description !== "string" || e.description.length < 1 || Array.from(e.description).length > 200) out.push("The description must be 1 to 200 characters.");
  if (lines.length < 2) out.push("An entry needs at least two lines.");
  if (lines.length > MAX_JOURNAL_LINES) out.push("An entry holds at most 199 lines.");
  for (const l of lines) {
    if (l.entry_ref !== e.entry_ref || l.entry_date !== e.entry_date || l.period !== e.period) { out.push("Every line must repeat the entry's reference, date and period."); break; }
  }
  if (lines.some((l) => l.currency !== "HKD" || l.base_minor !== l.amount_minor)) out.push("Every line is in HKD with base_minor equal to amount_minor.");
  if (lines.some((l) => !Number.isSafeInteger(l.amount_minor) || l.amount_minor === 0)) out.push("No line may be zero.");
  if (lines.some((l) => !ACCOUNT_CODE.test(l.account_code))) out.push("Every line names an account code.");
  if (lines.reduce((sum, l) => sum + (Number.isSafeInteger(l.base_minor) ? l.base_minor : NaN), 0) !== 0) out.push("The lines must add up to exactly zero.");
  return out;
}

/** The `postings` row for a proposal. A new row is `prepared`; the `hr-posting` skill records `posting_ref` later. */
export function postingProfile(p: Proposal) {
  return { source: p.source, source_id: p.sourceId, entry_ref: p.entryRef, entry_date: p.entryDate, period: p.period, batch: accountingBatch(p), stage: "prepared" as const, posting_ref: null, posted_on: null, calc_version: POSTING_VERSION };
}
