// The leave ledger's host calls: read balances, approve a leave request (entry first, then the status), run accrual,
// record entries for approved requests that have none, and correct a balance. Pure orchestration over `HostActions`,
// so tests drive it with an in-memory host. Entries are only ever created, never updated. Every write is safe to
// repeat: the unique `source_ref` makes a second entry impossible, and a conflict counts as "already recorded" only
// after a re-read proves the entry is there and is the same one.
import { ApiError } from "@cadence/screen-ui";
import {
  adjustmentEntry, balanceFor, chunkBatch, planAccrual, sameEntry, takenEntry, takenRef, type AccrualPlan, type Balances, type EmployeeFacts,
  type LeaveTypeFacts, type LedgerBatchItem, type LedgerEntry,
} from "../../domain/leave";
import {
  assertLeaveTypeExists, buildProfile, decisionPatch, FormError, newRecordId, resolveEmployee, ADJUSTMENT, type Values,
} from "../../domain/records";
import type { RecordFilter } from "../../bridge/services";
import { hostActions, type HostActions, type HostRecord, type HostScope } from "./hostActions";

export const LEDGER = "leave_entries";
/** Pages of 100 read before a list is called too large to read whole. */
export const MAX_PAGES = 50;
const PAGE = 100;
/** A re-read after one of these answers can say whether the write landed: a conflict, a store refusal (the deployed host's answer to a unique key) or a timeout. */
const UNSURE = [409, 503, 504];
const text = (record: HostRecord, key: string): string | null => {
  const v = (record.profile as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : null;
};

/** Every row of a list, page by page. A failed page rejects: a read that did not finish is never "none". */
export async function listAll(scope: HostScope, table: string | undefined, filters: RecordFilter[], actions: HostActions = hostActions): Promise<HostRecord[]> {
  const rows: HostRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await actions.list(scope, { ...(table ? { table } : {}), ...(filters.length ? { filters } : {}), limit: PAGE, ...(cursor ? { cursor } : {}) });
    rows.push(...result.records);
    if (result.nextCursor === null) {
      if (result.truncated) throw new FormError("ledger", "The list was too long to read in full. Nothing was changed.");
      return rows;
    }
    cursor = result.nextCursor;
  }
  throw new FormError("ledger", "The list was too long to read in full. Nothing was changed.");
}

// ---- balances ------------------------------------------------------------------------------------------
/** The balance groups for the filters, from the host's own sum. `asOf` is the moment of this read. */
export async function readBalances(scope: HostScope, filters: RecordFilter[] = [], actions: HostActions = hostActions, now: () => Date = () => new Date()): Promise<Balances> {
  const receipt = await actions.aggregate(scope, { table: LEDGER, group_by: ["employee_id", "leave_type"], sum: ["half_days"], ...(filters.length ? { filters } : {}) });
  const asOf = now().toISOString();
  return {
    asOf, truncated: receipt.truncated,
    groups: receipt.groups.map((g) => {
      const half = g.sums.half_days;
      if (!Number.isSafeInteger(half)) throw new ApiError("The server returned an invalid balance receipt", 502);
      return { employeeId: typeof g.key.employee_id === "string" ? g.key.employee_id : null, leaveType: typeof g.key.leave_type === "string" ? g.key.leave_type : null, halfDays: half as number, entries: g.count };
    }),
  };
}
export const forEmployee = (employeeId: string): RecordFilter[] => [{ field: "employee_id", op: "eq", value: employeeId }];
/** The balance a new request is shown against: the employee by number, then the sum for that employee and leave type. */
export async function readRequestBalance(scope: HostScope, employeeNo: string, leaveType: string, actions: HostActions = hostActions) {
  const employee = await resolveEmployee((args) => actions.list(scope, args), employeeNo);
  const balances = await readBalances(scope, [...forEmployee(employee.id), { field: "leave_type", op: "eq", value: leaveType }], actions);
  return { employeeId: employee.id, balances, halfDays: balanceFor(balances, employee.id, leaveType) };
}

// ---- entries ---------------------------------------------------------------------------------------------
/** The ledger entry with exactly this `source_ref`, or null. A failed read throws. */
export async function findEntry(scope: HostScope, ref: string, actions: HostActions = hostActions): Promise<HostRecord | null> {
  const page = await actions.list(scope, { table: LEDGER, filters: [{ field: "source_ref", op: "eq", value: ref }], limit: 2 });
  return page.records.find((r) => text(r, "source_ref") === ref) ?? null;
}
const DIFFERENT_TEXT = "A leave entry with this reference already exists with different values. Nothing was written. Correct the balance with an adjustment instead.";

/**
 * Create one entry. After a conflict, a store refusal or a timeout it reads the entry back by `source_ref`: the same
 * entry means it is already recorded (a retry, or a lost reply); a different one stops; none re-throws the failure.
 */
export async function ensureEntry(scope: HostScope, entry: LedgerEntry, actions: HostActions = hostActions): Promise<"created" | "exists"> {
  try {
    await actions.create(scope, newRecordId("le"), entry, LEDGER);
    return "created";
  } catch (error) {
    if (!(error instanceof ApiError) || !UNSURE.includes(error.status)) throw error;
    const found = await findEntry(scope, entry.source_ref, actions);
    if (found === null) throw error;
    if (!sameEntry(found.profile, entry)) throw new FormError("ledger", DIFFERENT_TEXT);
    return "exists";
  }
}

// ---- approving and rejecting a leave request ----------------------------------------------------------
const REQUEST = "leave_requests";
/**
 * Approve: re-read the request (it must still be open and at the revision the owner saw), write its `taken` entry
 * (minus its half-days), and only then set the request approved. A failure after the entry leaves it recorded, and the
 * next try recognises it and goes on to the status, so one approval is one entry.
 */
export async function approveLeave(scope: HostScope, record: HostRecord, today: string, note: string, actions: HostActions = hostActions): Promise<HostRecord> {
  const patch = decisionPatch("approved", today, note);
  const fresh = await actions.show(scope, record.id, REQUEST);
  if (text(fresh, "status") !== "pending") throw new FormError("ledger", "This request is no longer pending. Reload it to see what happened.");
  if (fresh.revision !== record.revision) throw new FormError("ledger", "This request changed after you opened it. Reload it, then decide again.");
  const built = takenEntry(fresh);
  if (!built.ok) throw new FormError("ledger", built.reason);
  await ensureEntry(scope, built.entry, actions);
  return actions.update(scope, fresh.id, fresh.revision, patch, REQUEST);
}
/**
 * Reject writes no entry. If an earlier approval already recorded the request's entry (it stopped before the status),
 * rejecting would leave that deduction standing, so it is refused: finish the approval instead.
 */
export async function rejectLeave(scope: HostScope, record: HostRecord, today: string, note: string, actions: HostActions = hostActions): Promise<HostRecord> {
  const patch = decisionPatch("rejected", today, note);
  if ((await findEntry(scope, takenRef(record.id), actions)) !== null) {
    throw new FormError("ledger", "An earlier approval of this request already recorded its leave entry. Approve it to finish, instead of rejecting it.");
  }
  return actions.update(scope, record.id, record.revision, patch, REQUEST);
}

// ---- batches -----------------------------------------------------------------------------------------------
export interface PostResult { posted: number; alreadyThere: number }
/** A batch run that stopped part-way: what was recorded before the stop, and the failure. Running it again continues. */
export class PostStopped extends Error {
  constructor(readonly done: PostResult, readonly total: number, override readonly cause: unknown) { super("The batch stopped part-way"); this.name = "PostStopped"; }
}
const items = (entries: readonly LedgerEntry[]): LedgerBatchItem[] => entries.map((profile) => ({ record_id: newRecordId("le"), table: LEDGER, profile }));

/** Which of these refs are in the ledger, asked 50 at a time (the `in` filter's limit). A failed read throws. */
export async function refsPresent(scope: HostScope, refs: readonly string[], actions: HostActions = hostActions): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < refs.length; i += 50) {
    const page = await actions.list(scope, { table: LEDGER, filters: [{ field: "source_ref", op: "in", value: refs.slice(i, i + 50) }], limit: PAGE });
    for (const row of page.records) { const ref = text(row, "source_ref"); if (ref !== null) present.add(ref); }
  }
  return present;
}

/**
 * Post entries with `records.batch`, chunked within 200 items and the chunk byte limit. A chunk is all-or-nothing. If
 * a chunk is refused for a duplicate key (or its reply is lost), the refs are read back: those already there count as
 * recorded and the rest are posted once more. Any other failure stops the run with what was done (`PostStopped`).
 */
export async function postEntries(scope: HostScope, entries: readonly LedgerEntry[], onProgress?: (done: number, total: number) => void, actions: HostActions = hostActions): Promise<PostResult> {
  const result: PostResult = { posted: 0, alreadyThere: 0 };
  const total = entries.length;
  const tick = () => onProgress?.(result.posted + result.alreadyThere, total);
  for (const chunk of chunkBatch(items(entries))) {
    try {
      try {
        await actions.batch(scope, chunk);
        result.posted += chunk.length;
      } catch (error) {
        if (!(error instanceof ApiError) || !UNSURE.includes(error.status)) throw error;
        const present = await refsPresent(scope, chunk.map((i) => i.profile.source_ref), actions);
        const missing = chunk.filter((i) => !present.has(i.profile.source_ref));
        // None of the chunk is there: the refusal had another cause (or a timeout that did not land). Say so, do not guess.
        if (missing.length === chunk.length) throw error;
        result.alreadyThere += chunk.length - missing.length;
        if (missing.length > 0) {
          await actions.batch(scope, missing.map((i) => ({ ...i, record_id: newRecordId("le") })));
          result.posted += missing.length;
        }
      }
    } catch (error) {
      throw new PostStopped({ ...result }, total, error);
    }
    tick();
  }
  return result;
}

// ---- run accrual ---------------------------------------------------------------------------------------------
const facts = (rows: HostRecord[]): EmployeeFacts[] => rows.map((r) => ({
  id: r.id, name: text(r, "display_name") ?? r.id, joinDate: text(r, "join_date"), leaveDate: text(r, "leave_date"), status: text(r, "status"),
}));
const typeFacts = (rows: HostRecord[]): LeaveTypeFacts[] => rows.flatMap((r) => {
  const code = text(r, "code");
  return code === null ? [] : [{ code, accrualRule: (r.profile as Record<string, unknown> | null)?.accrual_rule ?? null }];
});
/** The accrual refs already in the ledger for a month, read with a prefix and a month filter and paged to the end. */
export async function existingAccrualRefs(scope: HostScope, month: string, actions: HostActions = hostActions): Promise<Set<string>> {
  const rows = await listAll(scope, LEDGER, [{ field: "source_ref", op: "prefix", value: "accrual-" }, { field: "source_ref", op: "contains", value: `-${month}` }], actions);
  return new Set(rows.flatMap((r) => { const ref = text(r, "source_ref"); return ref === null ? [] : [ref]; }));
}
/** Read everything a month's accrual depends on, and compute it. Writes nothing. */
export async function planMonth(scope: HostScope, month: string, actions: HostActions = hostActions): Promise<AccrualPlan> {
  const [employees, leaveTypes, existingRefs] = await Promise.all([
    listAll(scope, undefined, [], actions), listAll(scope, "leave_types", [], actions), existingAccrualRefs(scope, month, actions),
  ]);
  return planAccrual({ month, employees: facts(employees), leaveTypes: typeFacts(leaveTypes), existingRefs });
}
/** Post a plan's missing entries. Running it again plans again from a fresh read, so it posts only what is still missing. */
export const runAccrual = (scope: HostScope, plan: AccrualPlan, onProgress?: (done: number, total: number) => void, actions: HostActions = hostActions) =>
  postEntries(scope, plan.entries, onProgress, actions);

// ---- approved requests with no entry -----------------------------------------------------------------------
export interface ReconcilePlan { entries: LedgerEntry[]; alreadyThere: number; unusable: { id: string; reason: string }[] }
/** Every approved request, whenever it was approved and by whatever path, that has no `taken` entry yet. */
export async function planReconcile(scope: HostScope, actions: HostActions = hostActions): Promise<ReconcilePlan> {
  const [approved, taken] = await Promise.all([
    listAll(scope, REQUEST, [{ field: "status", op: "eq", value: "approved" }], actions),
    listAll(scope, LEDGER, [{ field: "kind", op: "eq", value: "taken" }], actions),
  ]);
  const refs = new Set(taken.flatMap((r) => { const ref = text(r, "source_ref"); return ref === null ? [] : [ref]; }));
  const plan: ReconcilePlan = { entries: [], alreadyThere: 0, unusable: [] };
  for (const request of approved) {
    const built = takenEntry(request);
    if (!built.ok) plan.unusable.push({ id: request.id, reason: built.reason });
    else if (refs.has(built.entry.source_ref)) plan.alreadyThere += 1;
    else plan.entries.push(built.entry);
  }
  return plan;
}

// ---- corrections ---------------------------------------------------------------------------------------------
/** The `adjustment` source_ref of an open form: chosen once, so a retry after a lost reply meets its own entry. */
export const adjustmentRef = (formId: string): string => `adjustment-${formId}`;
/** Validate the form, look the employee and the leave type up, and write one `adjustment` entry. Never edits an entry. */
export async function adjustBalance(scope: HostScope, values: Values, ref: string, actions: HostActions = hostActions): Promise<LedgerEntry> {
  const profile = buildProfile(ADJUSTMENT, values) as { leave_type: string; half_days: number; effective_date: string; note: string };
  const list = (args: Parameters<Parameters<typeof resolveEmployee>[0]>[0]) => actions.list(scope, args);
  const employee = await resolveEmployee(list, values.employeeNo!);
  await assertLeaveTypeExists(list, profile.leave_type);
  const entry = adjustmentEntry({ employeeId: employee.id, leaveType: profile.leave_type, halfDays: profile.half_days, effectiveDate: profile.effective_date, note: profile.note, ref });
  await ensureEntry(scope, entry, actions);
  return entry;
}
