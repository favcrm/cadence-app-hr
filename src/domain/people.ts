// Pure employee-directory logic: no host, DOM or React. Column names, enums
// and bounds mirror app/storage/001-initial.json; tests keep the two in step.

// The screen owns these lists. The host stores both as plain text (a closed host enum can never gain a
// value), so a stored value outside the list is shown as it is and kept on edit.
export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern"] as const;
export const EMPLOYEE_STATUSES = ["active", "on_leave", "left"] as const;
export type EmploymentType = string;
export type EmployeeStatus = string;
const CODE = /^[a-z0-9_]{1,32}$/;

export const LIMITS = { displayName: 120, employeeNo: 32, email: 254, phone: 24, jobTitle: 80, department: 80 } as const;
const EMPLOYEE_NO = /^[A-Z0-9_-]{1,32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What the owner types: every field is text so a half-typed form never throws. */
export interface EmployeeForm {
  displayName: string; employeeNo: string; email: string; phone: string; jobTitle: string; department: string;
  employmentType: EmploymentType; joinDate: string; leaveDate: string; status: EmployeeStatus;
}
export const EMPTY_FORM: EmployeeForm = {
  displayName: "", employeeNo: "", email: "", phone: "", jobTitle: "", department: "",
  employmentType: "full_time", joinDate: "", leaveDate: "", status: "active",
};

/** The profile as the host returns it, read defensively: a malformed field shows as empty, never as a crash. */
export interface EmployeeView {
  displayName: string; employeeNo: string; email: string | null; phone: string | null; jobTitle: string; department: string;
  employmentType: EmploymentType | null; joinDate: string | null; leaveDate: string | null; managerId: string | null;
  status: EmployeeStatus | null; memberId: string | null;
}
const text = (v: unknown) => (typeof v === "string" ? v : "");
const optional = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
export function viewProfile(profile: unknown): EmployeeView {
  const p = (profile && typeof profile === "object" ? profile : {}) as Record<string, unknown>;
  return {
    displayName: text(p.display_name), employeeNo: text(p.employee_no), email: optional(p.email), phone: optional(p.phone),
    jobTitle: text(p.job_title), department: text(p.department), employmentType: code(p.employment_type),
    joinDate: optional(p.join_date), leaveDate: optional(p.leave_date), managerId: optional(p.manager_id),
    status: code(p.status), memberId: optional(p.member_id),
  };
}
export function formFromProfile(profile: unknown): EmployeeForm {
  const v = viewProfile(profile);
  return {
    displayName: v.displayName, employeeNo: v.employeeNo, email: v.email ?? "", phone: v.phone ?? "", jobTitle: v.jobTitle,
    department: v.department, employmentType: v.employmentType ?? "full_time", joinDate: v.joinDate ?? "", leaveDate: v.leaveDate ?? "",
    status: v.status ?? "active",
  };
}

/** A validation problem the owner can fix. `message` is the English key the screen translates. */
export class FormError extends Error {
  constructor(readonly field: keyof EmployeeForm, message: string) { super(message); this.name = "FormError"; }
}
export function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
const length = (s: string) => Array.from(s).length;

/** Trim and check the form, and return the profile fields to send. Blank optional fields become explicit null. */
export function buildProfile(form: EmployeeForm): Record<string, string | null> {
  const f = { ...form };
  // Employee numbers are stored in capitals, so the unique index ignores case.
  f.employeeNo = form.employeeNo.trim().toUpperCase();
  for (const k of ["displayName", "email", "phone", "jobTitle", "department", "joinDate", "leaveDate"] as const) f[k] = form[k].trim();
  if (f.displayName === "") throw new FormError("displayName", "Enter the employee's name.");
  if (length(f.displayName) > LIMITS.displayName) throw new FormError("displayName", "The name is too long.");
  if (f.employeeNo === "") throw new FormError("employeeNo", "Enter an employee number.");
  if (!EMPLOYEE_NO.test(f.employeeNo)) throw new FormError("employeeNo", "Use letters, digits, - and _ only in the employee number (up to 32).");
  if (f.email !== "" && (length(f.email) > LIMITS.email || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(f.email))) throw new FormError("email", "Enter a valid email address or leave it blank.");
  if (f.phone !== "" && (length(f.phone) > LIMITS.phone || length(f.phone) < 7 || !/^[0-9 +().-]+$/.test(f.phone) || (f.phone.match(/[0-9]/g) ?? []).length < 7)) throw new FormError("phone", "Enter a valid phone number or leave it blank.");
  if (length(f.jobTitle) > LIMITS.jobTitle) throw new FormError("jobTitle", "The job title is too long.");
  if (length(f.department) > LIMITS.department) throw new FormError("department", "The department name is too long.");
  if (f.joinDate !== "" && !realDate(f.joinDate)) throw new FormError("joinDate", "Enter the join date as YYYY-MM-DD or leave it blank.");
  if (f.leaveDate !== "" && !realDate(f.leaveDate)) throw new FormError("leaveDate", "Enter the leave date as YYYY-MM-DD or leave it blank.");
  if (f.leaveDate !== "" && f.joinDate !== "" && f.leaveDate < f.joinDate) throw new FormError("leaveDate", "The leave date cannot be before the join date.");
  if (!CODE.test(f.employmentType)) throw new FormError("employmentType", "Choose an employment type.");
  if (!CODE.test(f.status)) throw new FormError("status", "Choose a status.");
  return {
    display_name: f.displayName, employee_no: f.employeeNo, email: f.email || null, phone: f.phone || null, job_title: f.jobTitle,
    department: f.department, employment_type: f.employmentType, join_date: f.joinDate || null, leave_date: f.leaveDate || null, status: f.status,
  };
}
/** An update carries only the fields that changed; the host keeps the rest. */
export function changedFields(before: unknown, next: Record<string, string | null>): Record<string, string | null> {
  const old = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => (old[k] ?? null) !== v));
}

export function newEmployeeId(random: (n: Uint8Array) => void = (n) => crypto.getRandomValues(n)): string {
  const bytes = new Uint8Array(9);
  random(bytes);
  return `emp-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12)}`;
}

/** Another row already holds this employee number (exact match; the host search is a substring match). */
export function findDuplicate(rows: readonly { id: string; profile: unknown }[], employeeNo: string, ownId: string | null) {
  const wanted = employeeNo.trim();
  return rows.find((r) => r.id !== ownId && viewProfile(r.profile).employeeNo === wanted) ?? null;
}

/**
 * How a refused write reads to the owner. Only what the frame can tell is claimed:
 * - stale: the board kept the stale-revision code;
 * - changed: an update met a 409 (a revision conflict, or the store out of step) and the frame cannot tell which;
 * - store_unavailable: a 503. The deployed host also answers a unique-index violation this way; the next host
 *   answers 409 `unique_violation`, which the board shows as a plain conflict (see maybe_saved and changed);
 * - maybe_saved: a 409 on create after a clean pre-check, most often a retry of a create that already landed;
 * - rejected: status 400 with code `failed`. The board sends every status it does not name (400, 413, 500...) this
 *   way, so the frame cannot tell a field refusal from a server failure and the text must be true for both;
 * - neutral: anything else, including the screen's own busy refusal (429, eight requests in flight), which sent nothing.
 * A duplicate is claimed only when the pre-check found the row.
 */
export type WriteFailure = "stale" | "changed" | "maybe_saved" | "store_unavailable" | "timeout" | "session" | "rejected" | "neutral";
/** The hosted board narrows a host error by HTTP status to unauthorized, forbidden, not_found, conflict, unavailable or failed. */
export function classifyWriteFailure(error: { status?: number; code?: string } | null | undefined, operation: "create" | "update"): WriteFailure {
  const code = error?.code, status = error?.status;
  // The bridge's busy refusal carries code `conflict`; it is not a revision conflict.
  if (status === 429) return "neutral";
  if (code === "stale_revision" || code === "revision_conflict") return operation === "update" ? "stale" : "maybe_saved";
  if (status === 409 || code === "conflict") return operation === "update" ? "changed" : "maybe_saved";
  if (status === 401) return "session";
  if (status === 504) return "timeout";
  if (code === "unavailable" || code === "storage_unavailable" || status === 503) return "store_unavailable";
  if (status === 400 || code === "failed" || code === "invalid") return "rejected";
  return "neutral";
}
