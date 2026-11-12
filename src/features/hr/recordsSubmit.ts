import { ApiError } from "@cadence/screen-ui";
import {
  assertLeaveCodeFree, assertLeaveTypeExists, buildProfile, changedFields, checkRequestDates, classify, decisionPatch, editable, FormError, resolveEmployee,
  type Decision, type Failure, type ListFn, type TableSpec, type Values,
} from "../../domain/records";
import { hostActions, type HostActions, type HostRecord, type HostScope } from "./hostActions";
import { SESSION_EXPIRED_TEXT } from "./hostErrors";

const listFor = (scope: HostScope, actions: HostActions): ListFn => (args) => actions.list(scope, args);

/** Everything a create needs besides the form: lookups run first, and a failed lookup blocks the write. */
export async function prepareCreate(scope: HostScope, spec: TableSpec, values: Values, extra: Record<string, string> = {}, actions: HostActions = hostActions) {
  const profile: Record<string, unknown> = buildProfile(spec, values);
  const list = listFor(scope, actions);
  if (spec.table === "leave_requests") checkRequestDates(values);
  if (spec.table === "leave_requests" || spec.table === "claims") {
    const employee = await resolveEmployee(list, values.employeeNo!);
    profile.employee_id = employee.id; profile.employee_name = employee.name;
  }
  if (spec.table === "leave_requests") await assertLeaveTypeExists(list, String(profile.leave_type));
  if (spec.table === "leave_types") await assertLeaveCodeFree(list, String(profile.code), null);
  return { ...profile, ...extra };
}
/** `recordId` is the form's own id: a retry after a lost reply reuses it, so the host refuses a second row. */
export async function createRecord(scope: HostScope, spec: TableSpec, recordId: string, values: Values, extra: Record<string, string> = {}, actions: HostActions = hostActions) {
  return actions.create(scope, recordId, await prepareCreate(scope, spec, values, extra, actions), spec.table);
}
/** An update names the revision it was read at and carries only what changed; a changed code or leave type is looked up first. */
export async function updateRecord(scope: HostScope, spec: TableSpec, record: HostRecord, values: Values, actions: HostActions = hostActions) {
  const next = buildProfile(editable(spec), values);
  if (spec.table === "leave_requests") checkRequestDates(values);
  const patch = changedFields(record.profile, next);
  if (Object.keys(patch).length === 0) return null;
  const list = listFor(scope, actions);
  if ("code" in patch && spec.table === "leave_types") await assertLeaveCodeFree(list, String(patch.code), record.id);
  if ("leave_type" in patch) await assertLeaveTypeExists(list, String(patch.leave_type));
  return actions.update(scope, record.id, record.revision, patch, spec.table);
}
/** An owner decision writes status, the decision date and the note, nothing else. */
export function decide(scope: HostScope, spec: TableSpec, record: HostRecord, decision: Decision, today: string, note: string, actions: HostActions = hostActions) {
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
  stale: "Someone else changed this record after you opened it, so your change was not saved. Reload to see the latest version, then reapply your change.",
  changed: "This record could not be saved because it changed or the store is out of step. Reload to see the latest version, then try again.",
  store_unavailable: "The store could not save this change. If a code may already exist, search for it first; otherwise try again.",
  timeout: "The workspace did not answer. Check the list before saving again, so the same record is not added twice.",
  maybe_saved: "This record may already be saved. Check the list before trying again.",
  forbidden: "This session cannot read or change these records. They are for the workspace owner.",
  rejected: "The change was not saved. Check the fields, or the record may already be decided or changed. Reload and look, then try again.",
  neutral: "The change could not be saved. Try again; if it keeps happening, reload the page.",
};
export interface Problem { field: string | null; message: string; kind: Failure | "form"; reload: boolean }
export function problemFor(error: unknown, operation: "create" | "update", t: (s: string) => string): Problem {
  if (error instanceof FormError) return { field: error.field, message: t(error.message), kind: "form", reload: false };
  const kind = classify(error instanceof ApiError ? error : null, operation);
  return { field: null, message: t(kind === "session" ? SESSION_EXPIRED_TEXT : TEXT[kind]), kind, reload: kind === "stale" || kind === "changed" || kind === "rejected" };
}
