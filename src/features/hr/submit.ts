import { ApiError } from "@cadence/screen-ui";
import { classifyWriteFailure, findDuplicate, FormError, type WriteFailure } from "../../domain/people";
import { hostActions, type HostScope } from "./hostActions";
import { SESSION_EXPIRED_TEXT } from "./hostErrors";
import type { FieldProblem } from "./EmployeeForm";

export const DUPLICATE_TEXT = "That employee number is already used by another employee. Pick a different number or open the existing employee.";
const TEXT: Record<Exclude<WriteFailure, "refused" | "session" | "duplicate">, string> = {
  stale: "Someone else changed this employee after you opened it, so your change was not saved. Reload to see the latest version, then reapply your change.",
  store_unavailable: "The employee store could not save this change. If the employee number may already exist, search for it first; otherwise try again.",
  timeout: "The workspace did not answer. Check the list before saving again, so the same person is not added twice.",
};

/** The host answers a duplicate unique index with a store error, not a typed refusal, so look first. */
export async function assertEmployeeNoFree(scope: HostScope, employeeNo: string, ownId: string | null): Promise<void> {
  const page = await hostActions.list(scope, { query: employeeNo, limit: 100 });
  if (findDuplicate(page.records, employeeNo, ownId)) throw new FormError("employeeNo", DUPLICATE_TEXT);
}

/** One plain-words message for a failed write, plus whether a reload should be offered. */
export function writeProblem(error: unknown, operation: "create" | "update", t: (s: string) => string): { problem: FieldProblem; kind: WriteFailure | "form" } {
  if (error instanceof FormError) return { problem: { field: error.field, message: t(error.message) }, kind: "form" };
  const kind = classifyWriteFailure(error instanceof ApiError ? error : null, operation);
  if (kind === "duplicate") return { problem: { field: "employeeNo", message: t(DUPLICATE_TEXT) }, kind };
  if (kind === "session") return { problem: { field: null, message: t(SESSION_EXPIRED_TEXT) }, kind };
  // The board's own refusal text is generic ("Inspect fresh status..."), so say what the owner can do.
  if (kind === "refused") return { problem: { field: null, message: t("The change was refused — check the fields and try again.") }, kind };
  return { problem: { field: null, message: t(TEXT[kind]) }, kind };
}
