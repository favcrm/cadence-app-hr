// Staff self-service host calls (0.5.0): which view this session gets, the member's own rows, the owner linking a
// member to an employee and publishing what staff see, the owner's decisions on staff requests and claims, and
// attendance (punches, the device import and corrections). Pure orchestration over `HostActions`, so tests drive it
// with an in-memory host built from the real descriptor.
import { ApiError } from "@cadence/screen-ui";
import {
  CORRECTION_PREFIX, correctionProfile, importProfile, isLinked, latestSnapshot, MEMBER_TABLES, memberClaimProfile, memberLeaveProfile,
  memberPunchProfile, NO_MEMBER, parsePunchCsv, readPunch, SNAPSHOT_PREFIX, snapshotLeave, STAFF, storableMemberId,
  type DirectoryEntry, type Direction, type ImportLine, type Punch, type Snapshot,
} from "../../domain/staff";
import { decisionPatch, FormError, newRecordId, resolveEmployee, type Decision, type Values } from "../../domain/records";
import { approveLeave, listAll, readBalances, rejectLeave } from "./ledger";
import { hostActions, type HostActions, type HostRecord, type HostScope } from "./hostActions";

const UNSURE = [409, 503, 504];
const unsure = (e: unknown) => e instanceof ApiError && UNSURE.includes(e.status);
const p = (r: { profile: unknown }) => ((r.profile && typeof r.profile === "object" ? r.profile : {}) as Record<string, unknown>);
const s = (v: unknown) => (typeof v === "string" ? v : null);

// ---- which view ------------------------------------------------------------------------------------------------
export type Viewer = "owner" | "member";
/** The probe's record id. Both items name it, so the owner's batch is refused whole and nothing is ever written. */
export const PROBE_ID = "viewer-probe";
/**
 * Whether this session is the owner or a member, without a read a member is refused. The host pushes no role, and
 * any 403 closes the frame, so the screen asks with one write that can never land: a `records.batch` of two items
 * under the same record id into a `row_owner` table. An owner's batch reaches the store and the second item meets
 * the first (`record_exists`, 409; the batch is one transaction, so nothing stays). A member may not name a record id
 * on such a table and is refused before anything is read (`record_id_not_allowed`, 400). Any other answer is not a
 * role: it is thrown, and the screen says it could not tell.
 */
export async function probeViewer(scope: HostScope, actions: HostActions = hostActions): Promise<Viewer> {
  const item = { table: STAFF.withdrawals, record_id: PROBE_ID, profile: { member_id: PROBE_ID, request_id: PROBE_ID, withdrawn_at: 946684800 } };
  try {
    await actions.batch(scope, [item, item]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return "owner";
    if (error instanceof ApiError && error.status === 400) return "member";
    throw error;
  }
  throw new ApiError("The workspace accepted a write that should have been refused. Reload the page.", 502);
}

// ---- the member's own rows ---------------------------------------------------------------------------------------
const assertMemberTable = (table: string) => { if (!MEMBER_TABLES.includes(table)) throw new ApiError("The staff view reads only its own tables", 400); };
/** A member's own rows of one table, newest first by the column given. Every table here declares `row_owner`. */
export async function listMine(scope: HostScope, table: string, opts: { orderBy?: string; filters?: { field: string; op: "eq" | "gte" | "in"; value: string | number | string[] }[]; limit?: number } = {}, actions: HostActions = hostActions): Promise<HostRecord[]> {
  assertMemberTable(table);
  const page = await actions.list(scope, { table, limit: opts.limit ?? 50, ...(opts.filters ? { filters: opts.filters } : {}), ...(opts.orderBy ? { order_by: { field: opts.orderBy, direction: "desc" } } : {}) });
  return page.records;
}
export interface MemberHome { snapshot: Snapshot | null; requested: HostRecord | null }
/** What the staff view starts from: the latest snapshot the owner published for this member, and their link request. */
export async function readMemberHome(scope: HostScope, actions: HostActions = hostActions): Promise<MemberHome> {
  const [snaps, links] = await Promise.all([
    listMine(scope, STAFF.snapshots, { orderBy: "as_of", limit: 20 }, actions),
    listMine(scope, STAFF.links, { orderBy: "requested_at", limit: 5 }, actions),
  ]);
  return { snapshot: latestSnapshot(snaps), requested: links[0] ?? null };
}
/**
 * File one row as the member. A lost reply or a refusal that might have landed is resolved by reading the member's
 * own rows for the form's `client_ref`: found means saved; not found re-throws.
 */
async function fileOnce(scope: HostScope, table: string, profile: Record<string, unknown>, ref: { field: string; value: string } | null, actions: HostActions): Promise<HostRecord> {
  assertMemberTable(table);
  try {
    return await actions.file(scope, profile, table);
  } catch (error) {
    if (!unsure(error) || ref === null) throw error;
    const found = await listMine(scope, table, { filters: [{ field: ref.field, op: "eq", value: ref.value }], limit: 2 }, actions);
    if (found.length === 0) throw error;
    return found[0]!;
  }
}
const NOT_LINKED_TEXT = "Your account is not linked to an employee record yet. Ask the owner to link you in People.";
function linked(snapshot: Snapshot | null) {
  if (!isLinked(snapshot)) throw new FormError(null, NOT_LINKED_TEXT);
  return snapshot;
}
export const fileLeave = async (scope: HostScope, snapshot: Snapshot | null, values: Values, ref: string, actions: HostActions = hostActions) =>
  fileOnce(scope, STAFF.leave, memberLeaveProfile(linked(snapshot), values, ref), { field: "client_ref", value: ref }, actions);
export const fileClaim = async (scope: HostScope, snapshot: Snapshot | null, values: Values, ref: string, actions: HostActions = hostActions) =>
  fileOnce(scope, STAFF.claims, memberClaimProfile(linked(snapshot), values, ref), { field: "client_ref", value: ref }, actions);
export const punch = async (scope: HostScope, snapshot: Snapshot | null, direction: Direction, at: number, ref: string, actions: HostActions = hostActions) =>
  fileOnce(scope, STAFF.punches, memberPunchProfile(linked(snapshot), direction, at, ref), { field: "client_ref", value: ref }, actions);
/** Withdraw a pending request: a new row naming it (a member never updates). Withdrawing twice meets the first row. */
export async function withdrawLeave(scope: HostScope, request: HostRecord, now: number, actions: HostActions = hostActions): Promise<HostRecord> {
  if (s(p(request).status) !== "pending") throw new FormError(null, "Only a pending request can be withdrawn.");
  return fileOnce(scope, STAFF.withdrawals, { request_id: request.id, withdrawn_at: now }, { field: "request_id", value: request.id }, actions);
}
/** The only row an unlinked member can file: a request to be linked, carrying the name they give and nothing else. */
export async function requestLink(scope: HostScope, name: string, employeeNo: string, now: number, actions: HostActions = hostActions): Promise<HostRecord> {
  const display = name.trim(), no = employeeNo.trim().toUpperCase();
  if (display === "") throw new FormError("name", "Enter your name as the owner knows it.");
  if (Array.from(display).length > 120) throw new FormError("name", "This is too long.");
  if (no !== "" && !/^[A-Z0-9_-]{1,32}$/.test(no)) throw new FormError("employeeNo", "Use letters, digits, - and _ only in the employee number (up to 32).");
  return fileOnce(scope, STAFF.links, { display_name: display, employee_no: no === "" ? null : no, requested_at: now }, null, actions);
}

// ---- the owner: linking and what staff see -----------------------------------------------------------------------
export interface DirectoryRow { id: string; revision: number; name: string; employeeNo: string; memberId: string | null }
export async function readDirectory(scope: HostScope, actions: HostActions = hostActions): Promise<DirectoryRow[]> {
  return (await listAll(scope, undefined, [], actions)).map((r) => ({ id: r.id, revision: r.revision, name: s(p(r).display_name) ?? "", employeeNo: s(p(r).employee_no) ?? "", memberId: s(p(r).member_id) }));
}
/** The leave type names and one employee's balances, from the same ledger aggregate the Balances tab reads. */
async function leaveFacts(scope: HostScope, employeeIds: string[], actions: HostActions) {
  const [types, balances] = await Promise.all([
    listAll(scope, "leave_types", [], actions),
    employeeIds.length === 0 ? null : readBalances(scope, employeeIds.length === 1 ? [{ field: "employee_id", op: "eq", value: employeeIds[0]! }] : [], actions),
  ]);
  const names = types.flatMap((r) => { const code = s(p(r).code), name = s(p(r).name); return code && name ? [{ code, name }] : []; });
  return { names, balances };
}
function snapshotItem(employee: DirectoryRow | null, memberId: string, facts: Awaited<ReturnType<typeof leaveFacts>>, now: number) {
  const balances = employee === null || facts.balances === null ? [] : facts.balances.groups.filter((g) => g.employeeId === employee.id && g.leaveType !== null).map((g) => ({ leaveType: g.leaveType!, halfDays: g.halfDays }));
  return {
    record_id: newRecordId(SNAPSHOT_PREFIX.slice(0, -1)), table: STAFF.snapshots,
    profile: {
      member_id: memberId, employee_id: employee?.id ?? null, employee_name: employee ? employee.name || null : null, employee_no: employee?.employeeNo || null, as_of: now,
      leave: employee === null ? null : snapshotLeave(facts.names, balances, facts.balances?.truncated === true),
    },
  };
}
/** Publish what one member sees now (an unlinked member sees "not linked"). A new row each time: rows are never edited. */
export async function publishSnapshot(scope: HostScope, memberId: string, employee: DirectoryRow | null, now: number, actions: HostActions = hostActions): Promise<void> {
  const facts = await leaveFacts(scope, employee ? [employee.id] : [], actions);
  const item = snapshotItem(employee, memberId, facts, now);
  try {
    await actions.create(scope, item.record_id, item.profile, STAFF.snapshots);
  } catch (error) {
    if (!unsure(error)) throw error;
    await actions.show(scope, item.record_id, STAFF.snapshots); // landed, or this throws
  }
}
/** Publish every linked employee's balances in batches of up to 200. Returns how many members were updated. */
export async function publishAllSnapshots(scope: HostScope, now: number, actions: HostActions = hostActions): Promise<number> {
  const linkedRows = (await readDirectory(scope, actions)).filter((e) => e.memberId !== null);
  if (linkedRows.length === 0) return 0;
  const facts = await leaveFacts(scope, linkedRows.map((e) => e.id), actions);
  const items = linkedRows.map((e) => snapshotItem(e, e.memberId!, facts, now));
  for (let i = 0; i < items.length; i += 200) await actions.batch(scope, items.slice(i, i + 200));
  return items.length;
}
export interface LinkRequestRow { id: string; memberId: string; name: string; employeeNo: string | null; requestedAt: number; linkedTo: DirectoryRow | null }
/** Every link request, newest first, with the employee each member is linked to now (from the employee records). */
export async function readLinkRequests(scope: HostScope, actions: HostActions = hostActions): Promise<{ requests: LinkRequestRow[]; directory: DirectoryRow[] }> {
  const [rows, directory] = await Promise.all([listAll(scope, STAFF.links, [], actions), readDirectory(scope, actions)]);
  const requests = rows.flatMap((r): LinkRequestRow[] => {
    const memberId = s(p(r).member_id), name = s(p(r).display_name), at = p(r).requested_at;
    if (memberId === null || name === null || !Number.isSafeInteger(at)) return [];
    return [{ id: r.id, memberId, name, employeeNo: s(p(r).employee_no), requestedAt: at as number, linkedTo: directory.find((e) => e.memberId === memberId) ?? null }];
  }).sort((a, b) => b.requestedAt - a.requestedAt);
  return { requests, directory };
}
/**
 * Link a member to an employee: the employee record (owner-only) is the authority, so it is written first; then a
 * snapshot tells the member who they are and their balances. One account per employee and one employee per account.
 */
export async function linkMember(scope: HostScope, memberId: string, employeeNo: string, now: number, actions: HostActions = hostActions): Promise<DirectoryRow> {
  if (!storableMemberId(memberId)) throw new FormError(null, "This account's id cannot be stored on an employee record.");
  const found = await resolveEmployee((args) => actions.list(scope, args), employeeNo);
  const directory = await readDirectory(scope, actions);
  const employee = directory.find((e) => e.id === found.id)!;
  const other = directory.find((e) => e.memberId === memberId && e.id !== employee.id);
  if (other) throw new FormError("employeeNo", "This account is already linked to another employee. Unlink it there first.");
  if (employee.memberId !== null && employee.memberId !== memberId) throw new FormError("employeeNo", "That employee is already linked to another account. Unlink it first.");
  const current = { ...employee };
  if (employee.memberId !== memberId) {
    const saved = await actions.update(scope, employee.id, employee.revision, { member_id: memberId });
    current.revision = saved.revision; current.memberId = memberId;
  }
  await publishSnapshot(scope, memberId, current, now, actions);
  return current;
}
/** Unlink: clear the employee record's account, then tell the member they are no longer linked. */
export async function unlinkEmployee(scope: HostScope, employee: DirectoryRow, now: number, actions: HostActions = hostActions): Promise<void> {
  if (employee.memberId === null) return;
  const fresh = await actions.show(scope, employee.id);
  const memberId = s(p(fresh).member_id);
  if (memberId === null) return;
  await actions.update(scope, fresh.id, fresh.revision, { member_id: null });
  await publishSnapshot(scope, memberId, null, now, actions);
}

// ---- the owner: deciding staff requests and claims ----------------------------------------------------------------
const NOT_FROM_LINKED_TEXT = "This was not filed from the account linked to this employee, so it cannot be approved. Check the link in People → Staff accounts.";
const WITHDRAWN_TEXT = "The employee withdrew this request, so it cannot be approved. Reject it to close it as withdrawn.";
/** The employee a staff row names must be linked, on the owner-only employee record, to the account that filed it. */
async function assertFiledByLinked(scope: HostScope, record: HostRecord, actions: HostActions): Promise<string> {
  const employeeId = s(p(record).employee_id), memberId = s(p(record).member_id);
  if (employeeId === null || memberId === null) throw new FormError(null, NOT_FROM_LINKED_TEXT);
  let employee: HostRecord;
  try { employee = await actions.show(scope, employeeId); } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new FormError(null, NOT_FROM_LINKED_TEXT);
    throw error;
  }
  if (s(p(employee).member_id) !== memberId) throw new FormError(null, NOT_FROM_LINKED_TEXT);
  return employeeId;
}
/** Whether the member who filed a request has withdrawn it. A failed read throws: it is never "not withdrawn". */
export async function isWithdrawn(scope: HostScope, record: HostRecord, actions: HostActions = hostActions): Promise<boolean> {
  const page = await actions.list(scope, { table: STAFF.withdrawals, filters: [{ field: "request_id", op: "eq", value: record.id }], limit: 10 });
  return page.records.some((r) => s(p(r).request_id) === record.id && s(p(r).member_id) === s(p(record).member_id));
}
/**
 * The owner's decision on a staff leave request or claim. Approving checks the filing account is the employee's linked
 * one; a withdrawn request cannot be approved, and rejecting it records it as cancelled. A leave decision goes through
 * the ledger exactly as an owner request does. Afterwards the member's balances are published again; if that fails
 * the decision stands and `published` says so.
 */
export async function decideStaff(scope: HostScope, table: string, record: HostRecord, decision: Decision, today: string, note: string, now: number, actions: HostActions = hostActions): Promise<{ record: HostRecord; published: boolean }> {
  if (table !== STAFF.leave && table !== STAFF.claims) throw new ApiError("Not a staff table", 400);
  if (table === STAFF.claims) {
    if (decision === "approved") await assertFiledByLinked(scope, record, actions);
    return { record: await actions.update(scope, record.id, record.revision, decisionPatch(decision, today, note), table), published: true };
  }
  const withdrawn = await isWithdrawn(scope, record, actions);
  if (decision === "approved") {
    if (withdrawn) throw new FormError(null, WITHDRAWN_TEXT);
    await assertFiledByLinked(scope, record, actions);
  }
  const next = decision === "approved" ? await approveLeave(scope, record, today, note, actions, table)
    : await rejectLeave(scope, record, today, withdrawn && note.trim() === "" ? "Withdrawn by the employee" : note, actions, table, withdrawn ? "cancelled" : "rejected");
  let published = true;
  try {
    const memberId = s(p(record).member_id), employeeId = s(p(record).employee_id);
    const employee = (await readDirectory(scope, actions)).find((e) => e.id === employeeId && e.memberId === memberId) ?? null;
    if (employee !== null && memberId !== null) await publishSnapshot(scope, memberId, employee, now, actions);
  } catch { published = false; }
  return { record: next, published };
}

// ---- the owner: attendance ------------------------------------------------------------------------------------------
export async function readPunches(scope: HostScope, from: number, actions: HostActions = hostActions): Promise<Punch[]> {
  const page = await actions.list(scope, { table: STAFF.punches, filters: [{ field: "at", op: "gte", value: from }], order_by: { field: "at", direction: "desc" }, limit: 100 });
  return page.records.flatMap((r) => { const x = readPunch(r); return x ? [x] : []; });
}
const directoryMap = (rows: DirectoryRow[]) => new Map<string, DirectoryEntry>(rows.filter((e) => e.employeeNo !== "").map((e) => [e.employeeNo, { id: e.id, memberId: e.memberId }]));
/** Which of these punch ids are stored, 50 at a time (the `in` filter's limit). A failed read throws. */
async function storedPunches(scope: HostScope, ids: string[], actions: HostActions): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const page = await actions.list(scope, { table: STAFF.punches, filters: [{ field: "client_ref", op: "in", value: ids.slice(i, i + 50) }], limit: 100 });
    if (page.nextCursor !== null || page.truncated) throw new FormError(null, "The list was too long to read in full. Nothing was changed.");
    for (const r of page.records) { const ref = s(p(r).client_ref); if (ref !== null && ref === r.id) present.add(ref); }
  }
  return present;
}
/** Read the file against People and the punches already imported. Nothing is written. */
export async function previewImport(scope: HostScope, text: string, actions: HostActions = hostActions): Promise<ImportLine[]> {
  const directory = directoryMap(await readDirectory(scope, actions));
  const first = parsePunchCsv(text, directory);
  const ids = first.flatMap((l) => (l.status === "new" && l.recordId ? [l.recordId] : []));
  return parsePunchCsv(text, directory, await storedPunches(scope, ids, actions));
}
export interface ImportResult { imported: number; alreadyThere: number }
/**
 * Import the preview's new lines in batches of up to 200 under their fixed ids. A batch refused for an id that is
 * already stored (an earlier run, or a lost reply) is read back: the stored ones count as already there, the rest are
 * sent once more. Running the import again adds nothing twice.
 */
export async function importPunches(scope: HostScope, lines: readonly ImportLine[], onProgress?: (done: number, total: number) => void, actions: HostActions = hostActions): Promise<ImportResult> {
  const wanted = lines.filter((l) => l.status === "new");
  const result: ImportResult = { imported: 0, alreadyThere: 0 };
  for (let i = 0; i < wanted.length; i += 200) {
    let chunk = wanted.slice(i, i + 200);
    try {
      await actions.batch(scope, chunk.map((l) => ({ record_id: l.recordId!, table: STAFF.punches, profile: importProfile(l) })));
      result.imported += chunk.length;
    } catch (error) {
      if (!unsure(error)) throw error;
      const present = await storedPunches(scope, chunk.map((l) => l.recordId!), actions);
      if (present.size === 0) throw error;
      result.alreadyThere += present.size;
      chunk = chunk.filter((l) => !present.has(l.recordId!));
      if (chunk.length > 0) {
        await actions.batch(scope, chunk.map((l) => ({ record_id: l.recordId!, table: STAFF.punches, profile: importProfile(l) })));
        result.imported += chunk.length;
      }
    }
    onProgress?.(result.imported + result.alreadyThere, wanted.length);
  }
  return result;
}
/** The owner's correction: a new punch under the form's own id, so a retry meets its own row. Never an edit. */
export async function addCorrection(scope: HostScope, values: Values, recordId: string, actions: HostActions = hostActions): Promise<HostRecord> {
  if (!recordId.startsWith(CORRECTION_PREFIX)) throw new ApiError("A correction id must carry its prefix", 400);
  const found = await resolveEmployee((args) => actions.list(scope, args), values.employeeNo ?? "");
  const employee = (await readDirectory(scope, actions)).find((e) => e.id === found.id)!;
  const profile = correctionProfile({ id: employee.id, memberId: employee.memberId }, values, recordId);
  try {
    return await actions.create(scope, recordId, profile, STAFF.punches);
  } catch (error) {
    if (!unsure(error)) throw error;
    return actions.show(scope, recordId, STAFF.punches);
  }
}
export { NO_MEMBER };
