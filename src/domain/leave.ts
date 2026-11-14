// Pure leave-ledger logic: the accrual rule, monthly accrual, the entries an approval or a correction produces, and
// batch chunking. No host, DOM or React. Integer half-days only: one full day is 2. A balance is never stored or
// computed here; it is the host's sum of `leave_entries.half_days` (see `parseAggregate` in hostActions).
// Column names, patterns and bounds mirror app/storage/003-leave-ledger.json; tests keep them in step.
import { realDate } from "./people";

export const LEDGER_KINDS = ["accrual", "taken", "adjustment", "carry_forward", "expiry"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const SOURCE_REF = /^[A-Za-z0-9_-]{1,200}$/;
const EMPLOYEE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LEAVE_CODE = /^[A-Z0-9_-]{1,32}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** One row of `leave_entries` as the screen writes it. `half_days` is signed and never 0. */
export interface LedgerEntry {
  employee_id: string;
  leave_type: string;
  half_days: number;
  kind: LedgerKind;
  effective_date: string;
  source_ref: string;
  note: string | null;
}

// ---- half-days as days ---------------------------------------------------------------------------
/** A signed number of half-days as days, exactly as the screen and the `leave-desk` skill print it: 3 -> "1.5", -1 -> "-0.5", 0 -> "0". */
export function signedDays(halfDays: number): string {
  if (!Number.isSafeInteger(halfDays) || halfDays === 0) return "0";
  const abs = Math.abs(halfDays);
  const text = abs % 2 === 0 ? String(abs / 2) : `${Math.trunc(abs / 2)}.5`;
  return halfDays < 0 ? `-${text}` : text;
}
/** What an owner types for an adjustment: "2", "-1.5", "+0.5". Whole or half days, never 0. */
export function parseSignedHalfDays(text: string): number | null {
  const m = /^([+-]?)(\d{1,4})(?:\.(0|5))?$/.exec(text.trim());
  if (!m) return null;
  const half = Number(m[2]) * 2 + (m[3] === "5" ? 1 : 0);
  if (half < 1 || half > 100000) return null;
  return m[1] === "-" ? -half : half;
}

// ---- dates -------------------------------------------------------------------------------------------
export function parseMonth(text: string): { year: number; month: number } | null {
  const m = MONTH.exec(text.trim());
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}
const pad = (n: number) => String(n).padStart(2, "0");
export const monthStart = (month: string): string => `${month}-01`;
export function monthEnd(month: string): string {
  const { year, month: m } = parseMonth(month)!;
  return `${month}-${pad(new Date(Date.UTC(year, m, 0)).getUTCDate())}`;
}
/** The month of a `YYYY-MM-DD` date, or null. */
export const monthOf = (date: string): string | null => (realDate(date) ? date.slice(0, 7) : null);
/** Whole years of service completed on `onDate` (both real dates); null when either is not a date or `onDate` is earlier. */
export function completedYears(join: string, onDate: string): number | null {
  if (!realDate(join) || !realDate(onDate) || onDate < join) return null;
  const years = Number(onDate.slice(0, 4)) - Number(join.slice(0, 4));
  return onDate.slice(5) < join.slice(5) ? years - 1 : years;
}

// ---- the accrual rule ----------------------------------------------------------------------------
// `leave_types.accrual_rule`: {"v":1,"days_per_year":[{"from_years":0,"days":7},{"from_years":3,"days":8}]}
// A yearly entitlement in days (whole or half) by completed years of service. The first tier starts at 0 and tiers
// ascend. Rules are the customer's own data: no figure is shipped with the app and nothing here is legal advice.
export interface RuleTier { fromYears: number; halfDays: number }
export type RuleResult = { ok: true; tiers: RuleTier[] } | { ok: false; reason: string };
export const RULE_UNREADABLE = "The accrual rule is not in the supported format.";

export function parseAccrualRule(value: unknown): RuleResult {
  const bad: RuleResult = { ok: false, reason: RULE_UNREADABLE };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad;
  const rule = value as Record<string, unknown>;
  const keys = Object.keys(rule);
  if (keys.length !== 2 || rule.v !== 1 || !Array.isArray(rule.days_per_year)) return bad;
  const list = rule.days_per_year as unknown[];
  if (list.length < 1 || list.length > 20) return bad;
  const tiers: RuleTier[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return bad;
    const tier = item as Record<string, unknown>;
    if (Object.keys(tier).length !== 2) return bad;
    const years = tier.from_years, days = tier.days;
    if (!Number.isSafeInteger(years) || (years as number) < 0 || (years as number) > 80) return bad;
    if (typeof days !== "number" || !Number.isFinite(days) || days < 0 || days > 366 || !Number.isInteger(days * 2)) return bad;
    tiers.push({ fromYears: years as number, halfDays: days * 2 });
  }
  if (tiers[0]!.fromYears !== 0) return bad;
  for (let i = 1; i < tiers.length; i += 1) if (tiers[i]!.fromYears <= tiers[i - 1]!.fromYears) return bad;
  return { ok: true, tiers };
}
/** The stored JSON for tiers (days, not half-days). */
export const ruleJson = (tiers: readonly RuleTier[]) => ({ v: 1 as const, days_per_year: tiers.map((t) => ({ from_years: t.fromYears, days: t.halfDays / 2 })) });

// What the owner edits instead of JSON: one "completed years:days" pair per tier, joined by ";" (for example "0:7;3:8").
// Empty text means no accrual. RULE_KEPT stands for a stored rule the screen cannot read: the form keeps it unless replaced.
export const RULE_KEPT = "?";
const dayText = (half: number) => (half % 2 === 0 ? String(half / 2) : `${Math.trunc(half / 2)}.5`);
export function ruleToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const parsed = parseAccrualRule(value);
  return parsed.ok ? parsed.tiers.map((t) => `${t.fromYears}:${dayText(t.halfDays)}`).join(";") : RULE_KEPT;
}
/** The tiers a text names, or null when any pair is malformed, the first does not start at 0, or years do not strictly rise. */
export function textToTiers(text: string): RuleTier[] | null {
  const parts = text.trim().split(";");
  if (parts.length < 1 || parts.length > 20) return null;
  const tiers: RuleTier[] = [];
  for (const part of parts) {
    const m = /^\s*(\d{1,2})\s*:\s*(\d{1,3})(?:\.(0|5))?\s*$/.exec(part);
    if (!m) return null;
    const years = Number(m[1]), half = Number(m[2]) * 2 + (m[3] === "5" ? 1 : 0);
    if (years > 80 || half > 732) return null;
    if (tiers.length === 0 ? years !== 0 : years <= tiers[tiers.length - 1]!.fromYears) return null;
    tiers.push({ fromYears: years, halfDays: half });
  }
  return tiers;
}

/** The yearly half-days that apply after `years` completed years of service: the last tier that has started. */
export function annualHalfDays(tiers: readonly RuleTier[], years: number): number {
  let current = tiers[0]!.halfDays;
  for (const tier of tiers) if (tier.fromYears <= years) current = tier.halfDays;
  return current;
}
/**
 * The half-days one calendar month (1 to 12) adds when the year's entitlement is `annual` half-days. The running total
 * after month m is floor(annual * m / 12), so the twelve months of a year at one tier sum to exactly `annual`: no
 * rounding drift, and the rounding falls on whole half-days only. A month can add 0 when `annual` is under 12.
 */
export const monthlyHalfDays = (annual: number, month: number): number =>
  Math.floor((annual * month) / 12) - Math.floor((annual * (month - 1)) / 12);

// ---- who accrues -------------------------------------------------------------------------------------
export interface EmployeeFacts { id: string; name: string; joinDate: string | null; leaveDate: string | null; status: string | null }
export interface LeaveTypeFacts { code: string; accrualRule: unknown }
export type SkipReason = "no_join_date" | "not_yet_joined" | "left";
export const SKIP_TEXT: Record<SkipReason, string> = {
  no_join_date: "No join date",
  not_yet_joined: "Not yet joined",
  left: "Has left",
};

/**
 * Why an employee does not accrue for a month, or null when they do. Months are whole: someone who joins mid-month
 * accrues for the month they join, and someone who leaves mid-month for the month they leave.
 * - no real join date: skipped (never guessed);
 * - the join month is after the month: not yet joined;
 * - a real leave date before the month starts, or (no real leave date) status `left`: has left.
 */
export function skipReason(employee: EmployeeFacts, month: string): SkipReason | null {
  if (employee.joinDate === null || !realDate(employee.joinDate)) return "no_join_date";
  if (employee.joinDate.slice(0, 7) > month) return "not_yet_joined";
  if (employee.leaveDate !== null && realDate(employee.leaveDate)) return employee.leaveDate < monthStart(month) ? "left" : null;
  return employee.status === "left" ? "left" : null;
}

export const accrualRef = (employeeId: string, leaveType: string, month: string): string => `accrual-${employeeId}-${leaveType}-${month}`;
export const takenRef = (requestId: string): string => `taken-${requestId}`;

/** The half-days a (readable) rule gives an eligible employee for the month: tier by years completed at the month's end. */
export function accrualHalfDays(tiers: readonly RuleTier[], joinDate: string, month: string): number {
  const years = completedYears(joinDate, monthEnd(month)) ?? 0;
  return monthlyHalfDays(annualHalfDays(tiers, years), parseMonth(month)!.month);
}

export interface SkippedEmployee { employeeId: string; name: string; reason: SkipReason }
export interface AccrualPlan {
  month: string;
  /** Entries still to post: eligible, due more than 0, and not already recorded. */
  entries: LedgerEntry[];
  /** Entries the rule gives that are already in the ledger (same `source_ref`). */
  alreadyRecorded: number;
  /** Employee and leave type pairs where the month adds 0 half-days (a small yearly figure). Nothing is written for them. */
  nothingDue: number;
  skipped: SkippedEmployee[];
  /** Leave type codes that have a rule the screen cannot read; they accrue nothing. */
  unreadableRules: string[];
  /** Leave types that accrue: those with a readable rule. */
  accruingTypes: string[];
}

/** Compute one month's accrual. Pure: the caller supplies the employees, leave types and the refs already in the ledger. */
export function planAccrual(input: { month: string; employees: readonly EmployeeFacts[]; leaveTypes: readonly LeaveTypeFacts[]; existingRefs: ReadonlySet<string> }): AccrualPlan {
  const { month, employees, leaveTypes, existingRefs } = input;
  if (parseMonth(month) === null) throw new RangeError("month must be YYYY-MM");
  const rules: { code: string; tiers: RuleTier[] }[] = [];
  const unreadable: string[] = [];
  for (const type of leaveTypes) {
    if (type.accrualRule === null || type.accrualRule === undefined) continue;
    const parsed = parseAccrualRule(type.accrualRule);
    if (parsed.ok) rules.push({ code: type.code, tiers: parsed.tiers }); else unreadable.push(type.code);
  }
  const plan: AccrualPlan = { month, entries: [], alreadyRecorded: 0, nothingDue: 0, skipped: [], unreadableRules: unreadable, accruingTypes: rules.map((r) => r.code) };
  if (rules.length === 0) return plan;
  for (const employee of employees) {
    const reason = skipReason(employee, month);
    if (reason !== null) { plan.skipped.push({ employeeId: employee.id, name: employee.name, reason }); continue; }
    for (const rule of rules) {
      const half = accrualHalfDays(rule.tiers, employee.joinDate!, month);
      if (half === 0) { plan.nothingDue += 1; continue; }
      const ref = accrualRef(employee.id, rule.code, month);
      if (existingRefs.has(ref)) { plan.alreadyRecorded += 1; continue; }
      plan.entries.push({ employee_id: employee.id, leave_type: rule.code, half_days: half, kind: "accrual", effective_date: monthEnd(month), source_ref: ref, note: null });
    }
  }
  return plan;
}

// ---- entries from decisions and corrections ------------------------------------------------------------
export type EntryResult = { ok: true; entry: LedgerEntry } | { ok: false; reason: string };
const col = (profile: unknown, key: string) => (profile && typeof profile === "object" ? (profile as Record<string, unknown>)[key] : undefined);

/**
 * The `taken` entry an approved leave request produces: minus its half-days, dated its first day, one entry for the
 * whole request (a request across a month boundary is not split), `source_ref` derived from the request id so a retry
 * meets the same unique key. A request that cannot produce a valid entry is refused with a reason, never guessed.
 */
export function takenEntry(request: { id: string; profile: unknown }): EntryResult {
  const employee = col(request.profile, "employee_id"), type = col(request.profile, "leave_type"), half = col(request.profile, "half_days"), start = col(request.profile, "start_date");
  const ref = takenRef(request.id);
  if (typeof employee !== "string" || !EMPLOYEE_ID.test(employee)) return { ok: false, reason: "This request has no valid employee." };
  if (typeof type !== "string" || !LEAVE_CODE.test(type)) return { ok: false, reason: "This request has no valid leave type." };
  if (!Number.isSafeInteger(half) || (half as number) < 1 || (half as number) > 1000) return { ok: false, reason: "This request has no valid number of days." };
  if (typeof start !== "string" || !realDate(start)) return { ok: false, reason: "This request has no valid first day." };
  if (!SOURCE_REF.test(ref)) return { ok: false, reason: "This request has no valid record id." };
  return { ok: true, entry: { employee_id: employee, leave_type: type, half_days: -(half as number), kind: "taken", effective_date: start, source_ref: ref, note: null } };
}
/** An owner's correction: a new `adjustment` entry with a required note. `ref` is chosen once per open form, so a retry meets its own entry. */
export function adjustmentEntry(input: { employeeId: string; leaveType: string; halfDays: number; effectiveDate: string; note: string; ref: string }): LedgerEntry {
  return { employee_id: input.employeeId, leave_type: input.leaveType, half_days: input.halfDays, kind: "adjustment", effective_date: input.effectiveDate, source_ref: input.ref, note: input.note };
}
/** True when a stored entry is the one this request would write, so a lost reply is not read as a different entry. */
export function sameEntry(stored: unknown, entry: LedgerEntry): boolean {
  return col(stored, "employee_id") === entry.employee_id && col(stored, "leave_type") === entry.leave_type && col(stored, "half_days") === entry.half_days
    && col(stored, "kind") === entry.kind && col(stored, "source_ref") === entry.source_ref;
}

// ---- balances ------------------------------------------------------------------------------------------
export interface BalanceGroup { employeeId: string | null; leaveType: string | null; halfDays: number; entries: number }
export interface Balances { groups: BalanceGroup[]; truncated: boolean; asOf: string }
/** The balance for one employee and leave type from an aggregate; null when the aggregate has no group for them (not "0": see `truncated`). */
export function balanceFor(balances: Balances, employeeId: string, leaveType: string): number | null {
  const group = balances.groups.find((g) => g.employeeId === employeeId && g.leaveType === leaveType);
  return group ? group.halfDays : null;
}
/** What a new request would leave: null when the request's days are unknown. A missing group reads as 0 only when the aggregate was complete. */
export function balanceAfter(balances: Balances, employeeId: string, leaveType: string, requestHalfDays: number | null): number | null {
  if (requestHalfDays === null) return null;
  const have = balanceFor(balances, employeeId, leaveType);
  if (have === null && balances.truncated) return null;
  return (have ?? 0) - requestHalfDays;
}

// ---- batches -------------------------------------------------------------------------------------------
export const BATCH_MAX_ITEMS = 200;
/**
 * The most JSON bytes of `records.batch` arguments one chunk sends. The receiver and the screen's write budget allow
 * 49,152, but a board without the CAD-2263 limit closes the frame above 16,384, so a chunk stays within that. Raise
 * it once the deployed board is known to carry the larger limit.
 */
export const BATCH_CHUNK_BYTES = 16384;
export interface LedgerBatchItem { record_id: string; table: string; profile: LedgerEntry }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** Split items into chunks of at most `maxItems` items and `maxBytes` bytes of serialized `{items}` arguments. One item over the limit alone is an error. */
export function chunkBatch(items: readonly LedgerBatchItem[], maxItems = BATCH_MAX_ITEMS, maxBytes = BATCH_CHUNK_BYTES): LedgerBatchItem[][] {
  const chunks: LedgerBatchItem[][] = [];
  let current: LedgerBatchItem[] = [];
  const base = bytes({ items: [] });
  let size = base;
  for (const item of items) {
    const own = bytes(item) + (current.length > 0 ? 1 : 0);
    if (base + bytes(item) > maxBytes) throw new RangeError("One item is larger than a batch can carry.");
    if (current.length > 0 && (current.length >= maxItems || size + own > maxBytes)) { chunks.push(current); current = []; size = base; }
    size += bytes(item) + (current.length > 0 ? 1 : 0);
    current.push(item);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
