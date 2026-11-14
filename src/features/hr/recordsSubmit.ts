import { ApiError } from "@cadence/screen-ui";
import {
  assertLeaveCodeFree, assertLeaveTypeExists, buildProfile, changedFields, checkRequestDates, classify, decisionPatch, editable, FormError, resolveEmployee,
  type Decision, type Failure, type ListFn, type TableSpec, type Values,
} from "../../domain/records";
import { loadStarterLeaveTypes, STARTER_LEAVE_TYPES, type StarterPort } from "../../domain/leave-starter";
import { approveLeave, rejectLeave } from "./ledger";
import { hostActions, type HostActions, type HostRecord, type HostScope } from "./hostActions";
import { FORBIDDEN_TEXT, SESSION_EXPIRED_TEXT } from "./hostErrors";

const listFor = (scope: HostScope, actions: HostActions): ListFn => (args) => actions.list(scope, args);

/** Everything a create needs besides the form: lookups run first, and a failed lookup blocks the write. */
export async function prepareCreate(scope: HostScope, spec: TableSpec, recordId: string, values: Values, extra: Record<string, string> = {}, actions: HostActions = hostActions) {
  const profile: Record<string, unknown> = buildProfile(spec, values);
  const list = listFor(scope, actions);
  if (spec.table === "leave_requests") checkRequestDates(values);
  if (spec.table === "leave_requests" || spec.table === "claims") {
    const employee = await resolveEmployee(list, values.employeeNo!);
    profile.employee_id = employee.id; profile.employee_name = employee.name;
  }
  if (spec.table === "leave_requests") await assertLeaveTypeExists(list, String(profile.leave_type));
  if (spec.table === "leave_types") await assertLeaveCodeFree(list, String(profile.code), recordId);
  return { ...profile, ...extra };
}
/** `recordId` is the form's own id: a retry after a lost reply reuses it, so the host refuses a second row. */
export async function createRecord(scope: HostScope, spec: TableSpec, recordId: string, values: Values, extra: Record<string, string> = {}, actions: HostActions = hostActions) {
  return actions.create(scope, recordId, await prepareCreate(scope, spec, recordId, values, extra, actions), spec.table);
}
/**
 * An update names the revision it was read at and carries only what changed. A changed leave type is looked up
 * first; a leave type's own code is fixed at creation, so an edit never sends it.
 */
export async function updateRecord(scope: HostScope, spec: TableSpec, record: HostRecord, values: Values, actions: HostActions = hostActions) {
  const next = buildProfile(editable(spec), values);
  if (spec.table === "leave_requests") checkRequestDates(values);
  const patch = changedFields(record.profile, next);
  if (Object.keys(patch).length === 0) return null;
  if ("leave_type" in patch) await assertLeaveTypeExists(listFor(scope, actions), String(patch.leave_type));
  return actions.update(scope, record.id, record.revision, patch, spec.table);
}
/**
 * An owner decision writes status, the decision date and the note, nothing else. A leave request first writes (approve)
 * or checks for (reject) its `taken` ledger entry; see `approveLeave` and `rejectLeave`.
 */
export function decide(scope: HostScope, spec: TableSpec, record: HostRecord, decision: Decision, today: string, note: string, actions: HostActions = hostActions) {
  if (spec.table === "leave_requests") return (decision === "approved" ? approveLeave : rejectLeave)(scope, record, today, note, actions);
  return actions.update(scope, record.id, record.revision, decisionPatch(decision, today, note), spec.table);
}
/** A one-field change the owner makes from a drawer (a candidate's stage, an opening's status). */
export function setField(scope: HostScope, spec: TableSpec, record: HostRecord, field: string, value: string, actions: HostActions = hostActions) {
  return actions.update(scope, record.id, record.revision, { [field]: value }, spec.table);
}

/**
 * Wording true for every cause the frame cannot tell apart. A 400 reaches the frame as `failed` whatever its cause
 * (a refused field, or a write rule such as "a decided request cannot change"), so it is never called a duplicate
 * or "already decided"; only a re-read can say that.
 */
export const TEXT: Record<Exclude<Failure, "session">, string> = {
  too_long: "This text is too long to save from this screen. Shorten it, then save again.",
  stale: "Someone else changed this record after you opened it, so your change was not saved. Reload to see the latest version, then reapply your change.",
  changed: "This record could not be saved because it changed or the store is out of step. Reload to see the latest version, then try again.",
  store_unavailable: "The store could not save this change. If a code may already exist, search for it first; otherwise try again.",
  timeout: "The workspace did not answer. Check the list before saving again, so the same record is not added twice.",
  maybe_saved: "This record may already be saved. Check the list before trying again.",
  forbidden: FORBIDDEN_TEXT,
  rejected: "The change was not saved. Check the fields, or the record may already be decided or changed. Reload and look, then try again.",
  neutral: "The change could not be saved. Try again; if it keeps happening, reload the page.",
};
export interface Problem { field: string | null; message: string; kind: Failure | "form"; reload: boolean }
export function problemFor(error: unknown, operation: "create" | "update", t: (s: string) => string): Problem {
  if (error instanceof FormError) return { field: error.field, message: t(error.message), kind: "form", reload: false };
  const kind = classify(error instanceof ApiError ? error : null, operation);
  return { field: null, message: t(kind === "session" ? SESSION_EXPIRED_TEXT : TEXT[kind]), kind, reload: kind === "stale" || kind === "changed" || kind === "rejected" };
}

/** The leave type with exactly this code, under whatever record id, or null. A failed read throws: it is never "none". */
const storedCodes = async (scope: HostScope, codes: readonly string[], actions: HostActions): Promise<Set<string>> => {
  const page = await actions.list(scope, { table: "leave_types", filters: [{ field: "code", op: "in", value: [...codes] }], limit: 100 });
  return new Set(page.records.map((r) => (r.profile as { code?: unknown } | null)?.code).filter((c): c is string => typeof c === "string"));
};
const ALL_CODES = STARTER_LEAVE_TYPES.map((row) => row.code);

/**
 * The starter set, one create at a time under fixed record ids. Only a code that a re-read proves is stored counts as
 * "exists": under the same id the host answers a conflict, under another id its unique index answers a store failure
 * (503 today, 409 later), and neither is called a duplicate without that read.
 */
export function starterPort(scope: HostScope, actions: HostActions = hostActions): StarterPort {
  return {
    existingCodes: () => storedCodes(scope, ALL_CODES, actions),
    async create(item) {
      try {
        await actions.create(scope, item.record_id, item.profile, "leave_types");
        return "created";
      } catch (error) {
        if (error instanceof ApiError && [409, 503].includes(error.status) && (await storedCodes(scope, [item.profile.code], actions)).has(item.profile.code)) return "exists";
        throw error;
      }
    },
  };
}
export const addStarterLeaveTypes = (scope: HostScope, locale: "en" | "zh-TW", onProgress?: (done: number, total: number) => void, actions: HostActions = hostActions) =>
  loadStarterLeaveTypes(starterPort(scope, actions), locale, onProgress);

/** The cause of a stopped load, when the owner can act on it; any other failure is not named. */
export function starterReason(error: unknown): string | null {
  const kind = classify(error instanceof ApiError ? error : null, "create");
  return kind === "session" ? SESSION_EXPIRED_TEXT : kind === "forbidden" ? FORBIDDEN_TEXT : null;
}
