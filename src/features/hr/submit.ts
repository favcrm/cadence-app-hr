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
  rejected: "The change was refused — check the fields and try again.",
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
