import { ApiError } from "@cadence/screen-ui";
import { classifyWriteFailure, findDuplicate, FormError, type WriteFailure } from "../../domain/people";
import { hostActions, type HostActions, type HostScope } from "./hostActions";
import { SESSION_EXPIRED_TEXT } from "./hostErrors";
import type { FieldProblem } from "./EmployeeForm";

export const DUPLICATE_TEXT = "That employee number is already used by another employee. Pick a different number or open the existing employee.";
const TEXT: Record<Exclude<WriteFailure, "session">, string> = {
  stale: "Someone else changed this employee after you opened it, so your change was not saved. Reload to see the latest version, then reapply your change.",
  changed: "This employee could not be saved because the record changed or the store is out of step. Reload to see the latest version, then try again.",
  store_unavailable: "The employee store could not save this change. If the employee number may already exist, search for it first; otherwise try again.",
  timeout: "The workspace did not answer. Check the list before saving again, so the same person is not added twice.",
  maybe_saved: "This employee may already be saved. Check the list before trying again.",
  rejected: "The change could not be saved. Check the fields, then try again. If it keeps happening, reload the page.",
  neutral: "The change could not be saved. Try again; if it keeps happening, reload the page.",
};

/**
 * The host answers a duplicate unique index with a store error, not a typed refusal, so look first:
 * an exact `eq` filter on the employee number, two rows at most. `ownId` is the row being edited, or
 * the id of a create that may already have landed, so a row never counts as its own duplicate.
 */
export async function assertEmployeeNoFree(scope: HostScope, employeeNo: string, ownId: string | null, actions: HostActions = hostActions): Promise<void> {
  const page = await actions.list(scope, { filters: [{ field: "employee_no", op: "eq", value: employeeNo }], limit: 2 });
  if (findDuplicate(page.records, employeeNo, ownId)) throw new FormError("employeeNo", DUPLICATE_TEXT);
}

/** One plain-words message for a failed write, plus whether a reload should be offered. */
export function writeProblem(error: unknown, operation: "create" | "update", t: (s: string) => string): { problem: FieldProblem; kind: WriteFailure | "form"; reload: boolean } {
  if (error instanceof FormError) return { problem: { field: error.field, message: t(error.message) }, kind: "form", reload: false };
  const kind = classifyWriteFailure(error instanceof ApiError ? error : null, operation);
  const message = kind === "session" ? SESSION_EXPIRED_TEXT : TEXT[kind];
  return { problem: { field: null, message: t(message) }, kind, reload: kind === "stale" || kind === "changed" };
}

/** Create: the pre-check ignores this form's own id, so a retry after a landed write is not called a duplicate. */
export async function createEmployee(scope: HostScope, recordId: string, profile: Record<string, string | null>, actions: HostActions = hostActions) {
  await assertEmployeeNoFree(scope, profile.employee_no!, recordId, actions);
  return actions.create(scope, recordId, profile);
}

/** Update: the number is looked up only when it changes, and never against the row being edited. */
export async function updateEmployee(scope: HostScope, record: { id: string; revision: number }, patch: Record<string, string | null>, actions: HostActions = hostActions) {
  if ("employee_no" in patch) await assertEmployeeNoFree(scope, patch.employee_no!, record.id, actions);
  return actions.update(scope, record.id, record.revision, patch);
}

/** What the drawer shows after a failed save, and whether it offers the reload button. */
export function updateFailure(error: unknown, t: (s: string) => string): { problem: FieldProblem; stale: boolean } {
  const r = writeProblem(error, "update", t);
  return { problem: r.problem, stale: r.reload };
}
