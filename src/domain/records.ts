// Pure record logic shared by the Policies, Leave, Claims and Recruiting tabs: field specs, the form
// to profile conversion, exact lookups, decisions and failure wording. No host, DOM or React.
// Column names, patterns and bounds mirror app/storage/002-hr-records.json; tests keep them in step.
import { realDate } from "./people";

export { realDate };
export const CODE = /^[a-z0-9_]{1,32}$/;
const UCODE = /^[A-Z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const length = (s: string) => Array.from(s).length;

export type Kind = "text" | "longtext" | "ucode" | "code" | "date" | "days" | "money" | "email" | "phone" | "lookup";
export interface Field {
  /** Form key. */
  key: string;
  /** Profile column; absent for a form-only field that is resolved by a lookup. */
  column?: string;
  label: string;
  kind: Kind;
  required?: boolean;
  max?: number;
  /** Offered values for a `code` field; the screen owns the list, the host stores text. */
  options?: readonly string[];
  hint?: string;
  /** For `money`: the form key of the currency field. */
  currencyKey?: string;
  /** Set once when the record is made: an edit neither shows nor sends it (a join key such as a leave type code). */
  fixed?: boolean;
}
export interface TableSpec { table: string; noun: string; fields: readonly Field[] }
export type Values = Record<string, string>;

/** A validation problem the owner can fix. `message` is the English key the screen translates. */
export class FormError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = "FormError"; }
}

export const POLICY_CATEGORIES = ["benefits", "leave", "claims", "attendance", "general"] as const;
export const POLICY_STATUSES = ["draft", "current", "retired"] as const;
export const CLAIM_CATEGORIES = ["travel", "meals", "supplies", "other"] as const;
export const OPENING_STATUSES = ["draft", "open", "closed"] as const;
export const STAGES = ["new", "screening", "interview", "offer", "hired", "rejected"] as const;
export const LEAVE_OPEN = "pending";
export const CLAIM_OPEN = "submitted";

export const POLICY: TableSpec = { table: "policies", noun: "policy", fields: [
  { key: "title", column: "title", label: "Title", kind: "text", required: true, max: 120 },
  { key: "category", column: "category", label: "Category", kind: "code", options: POLICY_CATEGORIES },
  { key: "language", column: "language", label: "Language", kind: "text", required: true, max: 16, hint: "For example en or zh-HK" },
  { key: "effectiveFrom", column: "effective_from", label: "Effective from", kind: "date", required: true, hint: "YYYY-MM-DD" },
  { key: "status", column: "status", label: "Status", kind: "code", options: POLICY_STATUSES },
  { key: "body", column: "body", label: "Policy text", kind: "longtext", required: true, max: 12000 },
] };
export const LEAVE_TYPE: TableSpec = { table: "leave_types", noun: "leave type", fields: [
  { key: "code", column: "code", label: "Code", kind: "ucode", required: true, max: 32, fixed: true, hint: "Unique, and cannot be changed once saved. Capitals, digits, - and _" },
  { key: "name", column: "name", label: "Name", kind: "text", required: true, max: 80 },
  { key: "paid", column: "paid", label: "Paid leave", kind: "code", options: ["yes", "no"] },
] };
export const LEAVE_REQUEST: TableSpec = { table: "leave_requests", noun: "leave request", fields: [
  { key: "employeeNo", label: "Employee number", kind: "lookup", required: true, max: 32 },
  { key: "leaveType", column: "leave_type", label: "Leave type code", kind: "ucode", required: true, max: 32 },
  { key: "startDate", column: "start_date", label: "First day", kind: "date", required: true, hint: "YYYY-MM-DD" },
  { key: "endDate", column: "end_date", label: "Last day", kind: "date", required: true, hint: "YYYY-MM-DD" },
  { key: "days", column: "half_days", label: "Days of leave", kind: "days", required: true, hint: "Whole or half days, for example 1.5" },
  { key: "reason", column: "reason", label: "Reason (optional)", kind: "longtext", max: 500, hint: "No medical detail" },
] };
export const CLAIM: TableSpec = { table: "claims", noun: "claim", fields: [
  { key: "employeeNo", label: "Employee number", kind: "lookup", required: true, max: 32 },
  { key: "claimDate", column: "claim_date", label: "Receipt date", kind: "date", required: true, hint: "YYYY-MM-DD" },
  { key: "category", column: "category", label: "Category", kind: "code", options: CLAIM_CATEGORIES },
  { key: "merchant", column: "merchant", label: "Merchant", kind: "text", max: 120 },
  { key: "amount", column: "amount_minor", label: "Amount", kind: "money", required: true, currencyKey: "currency", hint: "For example 12.50" },
  { key: "currency", column: "currency", label: "Currency", kind: "text", required: true, max: 3, hint: "Three capitals, for example HKD" },
  { key: "description", column: "description", label: "Description (optional)", kind: "longtext", max: 500, hint: "No medical detail" },
  { key: "receiptRef", column: "receipt_ref", label: "Receipt file name (optional)", kind: "text", max: 200 },
] };
export const OPENING: TableSpec = { table: "job_openings", noun: "opening", fields: [
  { key: "title", column: "title", label: "Title", kind: "text", required: true, max: 120 },
  { key: "department", column: "department", label: "Department", kind: "text", max: 80 },
  { key: "status", column: "status", label: "Status", kind: "code", options: OPENING_STATUSES },
  { key: "description", column: "description", label: "Description", kind: "longtext", max: 8000 },
] };
export const CANDIDATE: TableSpec = { table: "candidates", noun: "candidate", fields: [
  { key: "displayName", column: "display_name", label: "Name", kind: "text", required: true, max: 120 },
  { key: "email", column: "email", label: "Email (optional)", kind: "email", max: 254 },
  { key: "phone", column: "phone", label: "Phone (optional)", kind: "phone", max: 24 },
  { key: "source", column: "source", label: "Source", kind: "text", max: 80 },
  { key: "cvText", column: "cv_text", label: "CV text", kind: "longtext", max: 12000, hint: "Paste the text of the CV" },
] };

// ---- amounts and days -------------------------------------------------------------------------
// Minor-unit exponents (ISO 4217) that differ from the usual two decimals.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "ISK", "CLP"]);
const THREE_DECIMAL = new Set(["KWD", "BHD", "OMR", "JOD", "TND", "IQD", "LYD"]);
const exponent = (currency: string) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);
export const MAX_MINOR = 99999999999;

/** "12.50" in a two-decimal currency is 1250; "1.234" KWD is 1234. Refuses anything that is not an exact amount. */
export function toMinor(text: string, currency: string): number | null {
  const digits = exponent(currency);
  const m = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${Math.max(digits, 1)}}))?$`).exec(text.trim());
  if (!m || (digits === 0 && m[2] !== undefined)) return null;
  const minor = Number(m[1]) * 10 ** digits + Number((m[2] ?? "").padEnd(digits, "0") || 0);
  return Number.isSafeInteger(minor) && minor >= 1 && minor <= MAX_MINOR ? minor : null;
}
export function fromMinor(minor: number, currency: string): string {
  const digits = exponent(currency);
  if (digits === 0) return String(minor);
  const unit = 10 ** digits;
  return `${Math.trunc(minor / unit)}.${String(minor % unit).padStart(digits, "0")}`;
}
/** "1.5" days is 3 half days. Only whole and half days are accepted. */
export function toHalfDays(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(0|5))?$/.exec(text.trim());
  if (!m) return null;
  const half = Number(m[1]) * 2 + (m[2] === "5" ? 1 : 0);
  return half >= 1 && half <= 1000 ? half : null;
}
export const fromHalfDays = (half: number): string => (half % 2 === 0 ? String(half / 2) : `${Math.trunc(half / 2)}.5`);
/** Calendar days between two real dates, inclusive; null when either date is not real or the end is earlier. */
export function inclusiveDays(start: string, end: string): number | null {
  if (!realDate(start) || !realDate(end) || end < start) return null;
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
}

// ---- form <-> profile -------------------------------------------------------------------------
/** The fields an edit shows and sends: a form-only lookup (the employee) and a `fixed` field are set once at creation. */
export const editable = (spec: TableSpec): TableSpec => ({ ...spec, fields: spec.fields.filter((f) => f.kind !== "lookup" && !f.fixed) });
export const emptyValues = (spec: TableSpec): Values => Object.fromEntries(spec.fields.map((f) => [f.key, f.kind === "code" ? f.options![0]! : f.key === "currency" ? "HKD" : f.key === "language" ? "en" : ""]));

const SHAPE: Record<string, RegExp> = { email: /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/ };
function validPhone(v: string) { return length(v) >= 7 && /^[0-9 +().-]+$/.test(v) && (v.match(/[0-9]/g) ?? []).length >= 7; }

/** Trim and check the form, and return the profile fields to send. Form-only fields are skipped. Blank optional fields become explicit null where the column is nullable. */
export function buildProfile(spec: TableSpec, values: Values): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of spec.fields) {
    const raw = (values[f.key] ?? "").trim();
    const v = f.kind === "ucode" ? raw.toUpperCase() : raw;
    if (v === "" && f.required) throw new FormError(f.key, "Fill in this field.");
    if (f.max !== undefined && length(v) > f.max) throw new FormError(f.key, "This is too long.");
    switch (f.kind) {
      case "lookup": continue;
      case "ucode": if (!UCODE.test(v)) throw new FormError(f.key, "Use capitals, digits, - and _ only (up to 32)."); break;
      case "code": if (!(f.options!.includes(v) || CODE.test(v)) || v === "") throw new FormError(f.key, "Choose a value from the list."); break;
      case "date": if (v !== "" && !realDate(v)) throw new FormError(f.key, "Enter the date as YYYY-MM-DD."); break;
      case "email": if (v !== "" && !SHAPE.email.test(v)) throw new FormError(f.key, "Enter a valid email address or leave it blank."); break;
      case "phone": if (v !== "" && !validPhone(v)) throw new FormError(f.key, "Enter a valid phone number or leave it blank."); break;
      default: break;
    }
    if (!f.column) continue;
    if (f.kind === "days") { const n = toHalfDays(v); if (n === null) throw new FormError(f.key, "Enter whole or half days, for example 1.5."); out[f.column] = n; continue; }
    if (f.kind === "money") {
      const currency = (values[f.currencyKey!] ?? "").trim();
      const n = /^[A-Z]{3}$/.test(currency) ? toMinor(v, currency) : null;
      if (n === null) throw new FormError(f.key, "Enter an exact amount in the currency's own units, for example 12.50.");
      out[f.column] = n; continue;
    }
    if (f.key === "currency" && !/^[A-Z]{3}$/.test(v)) throw new FormError(f.key, "Use three capital letters, for example HKD.");
    if (f.column === "paid") { out[f.column] = v === "yes"; continue; }
    out[f.column] = v === "" && (f.kind === "email" || f.kind === "phone" || f.column === "receipt_ref") ? null : v;
  }
  return out;
}
/** Cross-field rules a single field cannot see: the span runs forwards, and its days fit inside it (two half days per calendar day). */
export function checkRequestDates(values: Values): void {
  const start = values.startDate!.trim(), end = values.endDate!.trim();
  if (end < start) throw new FormError("endDate", "The last day cannot be before the first day.");
  const span = inclusiveDays(start, end), half = toHalfDays(values.days ?? "");
  if (span !== null && half !== null && half > span * 2) throw new FormError("days", "The days of leave cannot be more than the calendar days from the first to the last day.");
}

export function viewValues(spec: TableSpec, profile: unknown): Values {
  const p = (profile && typeof profile === "object" ? profile : {}) as Record<string, unknown>;
  const out: Values = {};
  const currency = typeof p.currency === "string" ? p.currency : "";
  for (const f of spec.fields) {
    const v = f.column ? p[f.column] : undefined;
    out[f.key] = f.kind === "days" && Number.isSafeInteger(v) ? fromHalfDays(v as number)
      : f.kind === "money" && Number.isSafeInteger(v) ? fromMinor(v as number, currency)
      : f.column === "paid" ? (v === true ? "yes" : v === false ? "no" : "")
      : typeof v === "string" ? v : "";
  }
  return out;
}
/** An update carries only the fields that changed; the host keeps the rest. */
export function changedFields(before: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const old = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => (old[k] ?? null) !== v));
}
export function newRecordId(prefix: string, random: (n: Uint8Array) => void = (n) => crypto.getRandomValues(n)): string {
  const bytes = new Uint8Array(9);
  random(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12)}`;
}

/** The label of a stored value; an unknown value is shown as it is. */
export const optionLabel = (value: string) => (value === "" ? "—" : value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " "));

// ---- status text the host stores as plain text --------------------------------------------------
const word = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : null);
export const statusOf = (profile: unknown): string | null => word((profile as { status?: unknown } | null)?.status);
export const stageOf = (profile: unknown): string | null => word((profile as { stage?: unknown } | null)?.stage);
export const isOpenLeave = (profile: unknown) => statusOf(profile) === LEAVE_OPEN;
export const isOpenClaim = (profile: unknown) => statusOf(profile) === CLAIM_OPEN;

/** A screening result as the host returns it, read defensively; null when it is absent or malformed. */
export function viewScreening(value: unknown): { summary: string; reasons: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { summary?: unknown; reasons?: unknown };
  if (typeof v.summary !== "string" || !Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === "string")) return null;
  return { summary: v.summary, reasons: v.reasons as string[] };
}

// ---- decisions ----------------------------------------------------------------------------------
export type Decision = "approved" | "rejected";
/** The only fields an owner decision writes. `today` is the device's date, as YYYY-MM-DD. */
export function decisionPatch(decision: Decision, today: string, note: string): Record<string, string | null> {
  const trimmed = note.trim();
  if (length(trimmed) > 500) throw new FormError("note", "This is too long.");
  return { status: decision, decided_on: today, decision_note: trimmed === "" ? null : trimmed };
}
export const todayLocal = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

// ---- exact lookups ------------------------------------------------------------------------------
/** The one call shape a lookup needs; tests pass a fake. */
export type ListFn = (args: { table?: string; filters: { field: string; op: "eq"; value: string }[]; limit: number }) => Promise<{ records: { id: string; profile: unknown }[] }>;
const col = (row: { profile: unknown }, key: string) => ((row.profile as Record<string, unknown> | null)?.[key]);

/** Every row whose column equals the value, exactly (two rows at most). A failed call throws: it is never read as "none". */
export async function findExact(list: ListFn, table: string | undefined, field: string, value: string) {
  const page = await list({ ...(table ? { table } : {}), filters: [{ field, op: "eq", value }], limit: 2 });
  return page.records.filter((r) => col(r, field) === value);
}
export async function resolveEmployee(list: ListFn, employeeNo: string): Promise<{ id: string; name: string }> {
  const no = employeeNo.trim().toUpperCase();
  const rows = await findExact(list, undefined, "employee_no", no);
  if (rows.length === 0) throw new FormError("employeeNo", "No employee has that number. Check the number in People.");
  if (rows.length > 1) throw new FormError("employeeNo", "More than one employee has that number. Fix the directory first.");
  const name = col(rows[0]!, "display_name");
  return { id: rows[0]!.id, name: typeof name === "string" && name !== "" ? name : no };
}
export async function assertLeaveTypeExists(list: ListFn, code: string): Promise<void> {
  if ((await findExact(list, "leave_types", "code", code.trim().toUpperCase())).length === 0)
    throw new FormError("leaveType", "No leave type has that code. Add it under Leave types first.");
}
export const DUPLICATE_CODE_TEXT = "That code is already used by another leave type. Pick a different code or open the existing one.";
/** `ownId` is the new form's own record id: after a lost reply, a retry must not call its own row a duplicate. */
export async function assertLeaveCodeFree(list: ListFn, code: string, ownId: string): Promise<void> {
  const rows = await findExact(list, "leave_types", "code", code.trim().toUpperCase());
  if (rows.some((r) => r.id !== ownId)) throw new FormError("code", DUPLICATE_CODE_TEXT);
}

// ---- failure wording ----------------------------------------------------------------------------
/**
 * What a refused write can honestly be called. The frame sees only 401, 403, 404, 409, 503 as named codes and shows every
 * other status as 400/failed. `too_long` is the screen's own refusal (code `too_large`): the write was never sent.
 */
export type Failure = "too_long" | "stale" | "changed" | "maybe_saved" | "store_unavailable" | "timeout" | "session" | "forbidden" | "rejected" | "neutral";
export function classify(error: { status?: number; code?: string } | null | undefined, operation: "create" | "update"): Failure {
  const code = error?.code, status = error?.status;
  if (code === "too_large") return "too_long";
  if (code === "stale_revision" || code === "revision_conflict") return operation === "update" ? "stale" : "maybe_saved";
  if (status === 409 || code === "conflict") return operation === "update" ? "changed" : "maybe_saved";
  if (status === 401) return "session";
  if (status === 403) return "forbidden";
  if (status === 504) return "timeout";
  if (code === "unavailable" || code === "storage_unavailable" || status === 503) return "store_unavailable";
  if (status === 400 || code === "failed" || code === "invalid") return "rejected";
  return "neutral";
}
export const isId = (v: string) => ID.test(v);
