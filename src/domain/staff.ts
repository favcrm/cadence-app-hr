// Staff self-service (0.5.0), pure: the member-owned tables, what the staff view trusts, the time-only punch, the
// owner's punch import from an attendance device, and a week of punches. No host, DOM or React.
//
// Host facts this module is built on (AOS-564, `row_owner`): a member who is not an owner creates rows in a table that
// declares `row_owner` and reads only rows whose owner column is their own id; the host stamps that id from the board
// session and names the record (`mem_` plus 32 hex), and a member never updates. A member chooses every other column,
// so nothing a member wrote is trusted for identity: the owner's screen resolves a row's employee from the owner-only
// employee record, and the staff view trusts only rows whose record id the owner's screen minted (a member cannot name
// a record id).
import {
  buildProfile, checkRequestDates, CLAIM, CLAIM_CATEGORIES, FormError, LEAVE_REQUEST, newRecordId, realDate,
  type TableSpec, type Values,
} from "./records";

export const STAFF = {
  links: "staff_link_requests",
  snapshots: "staff_snapshots",
  leave: "staff_leave_requests",
  claims: "staff_claims",
  withdrawals: "leave_withdrawals",
  punches: "attendance_punches",
} as const;
/** Every table the staff view may call. Each declares `row_owner: member_id`; any other table answers a member 403 and the board closes the frame. */
export const MEMBER_TABLES: readonly string[] = Object.values(STAFF);
/** The `member_id` of a punch the owner imports or corrects for an employee with no linked account: never a member's id. */
export const NO_MEMBER = "-";
/** Record id prefixes only the owner's screen writes. A member's rows are named by the host. */
export const SNAPSHOT_PREFIX = "snap-";
export const IMPORT_PREFIX = "imp-";
export const CORRECTION_PREFIX = "cor-";
/** A member-filed row's `client_ref`: chosen once per form, so a retry after a lost reply finds its own row. */
export const clientRef = (prefix: string, random?: (n: Uint8Array) => void): string => newRecordId(prefix, random);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
const prof = (r: { profile: unknown }) => ((r.profile && typeof r.profile === "object" ? r.profile : {}) as Record<string, unknown>);

// ---- time ---------------------------------------------------------------------------------------------------
// Attendance is kept in Hong Kong time (UTC+8, no daylight saving): the import reads device times in it and both
// views show it, so a punch reads the same on every device. `at` is stored as epoch seconds.
export const HK_OFFSET_S = 8 * 3600;
const pad = (n: number) => String(n).padStart(2, "0");
/** The Hong Kong calendar date and clock time of an epoch second. */
export function hkParts(at: number): { date: string; time: string; weekday: number } {
  const d = new Date((at + HK_OFFSET_S) * 1000);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, weekday: (d.getUTCDay() + 6) % 7 };
}
/** Epoch seconds of a Hong Kong date and time; null when the date or time is not real. */
export function hkEpoch(date: string, time: string): number | null {
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!realDate(date) || !t) return null;
  const [h, m, s] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  if (h > 23 || m > 59 || s > 59) return null;
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m, s) / 1000 - HK_OFFSET_S;
}
/** The first second of the Hong Kong day holding `at`. */
export const hkDayStart = (at: number): number => hkEpoch(hkParts(at).date, "00:00")!;
/** The first second of the Monday of the Hong Kong week holding `at`. */
export const hkWeekStart = (at: number): number => hkDayStart(at) - hkParts(at).weekday * 86400;
export const addDays = (date: string, n: number): string => hkParts(hkEpoch(date, "12:00")! + n * 86400).date;

// ---- the staff view's own facts -----------------------------------------------------------------------------
export interface LeaveTypeName { code: string; name: string }
export interface SnapshotBalance { leaveType: string; halfDays: number }
/** What the owner's screen last published for one member: the employee they are linked to, and their balances. */
export interface Snapshot { id: string; employeeId: string | null; employeeName: string | null; employeeNo: string | null; asOf: number; types: LeaveTypeName[]; balances: SnapshotBalance[]; truncated: boolean }

/** The `leave` value of a snapshot row: leave type names and balances from the ledger aggregate. */
export function snapshotLeave(types: LeaveTypeName[], balances: SnapshotBalance[], truncated: boolean) {
  return { v: 1, types: types.map((t) => ({ code: t.code, name: t.name })), balances: balances.map((b) => ({ leave_type: b.leaveType, half_days: b.halfDays })), truncated };
}
/** One snapshot row read strictly; null when its shape is not one the owner's screen writes. */
export function readSnapshot(record: { id: string; profile: unknown }): Snapshot | null {
  if (!record.id.startsWith(SNAPSHOT_PREFIX)) return null;
  const p = prof(record);
  const asOf = int(p.as_of);
  if (asOf === null) return null;
  const leave = p.leave as { v?: unknown; types?: unknown; balances?: unknown; truncated?: unknown } | null;
  const types: LeaveTypeName[] = [];
  const balances: SnapshotBalance[] = [];
  if (leave !== null && leave !== undefined) {
    if (typeof leave !== "object" || leave.v !== 1 || !Array.isArray(leave.types) || !Array.isArray(leave.balances)) return null;
    for (const t of leave.types as { code?: unknown; name?: unknown }[]) { const code = str(t?.code), name = str(t?.name); if (code === null || name === null) return null; types.push({ code, name }); }
    for (const b of leave.balances as { leave_type?: unknown; half_days?: unknown }[]) { const type = str(b?.leave_type), half = int(b?.half_days); if (type === null || half === null) return null; balances.push({ leaveType: type, halfDays: half }); }
  }
  return { id: record.id, employeeId: str(p.employee_id), employeeName: str(p.employee_name), employeeNo: str(p.employee_no), asOf, types, balances, truncated: leave?.truncated === true };
}
/**
 * The newest snapshot the owner's screen wrote, from rows in the host's own creation order, newest first
 * (`order_by: created_at desc`). The owner device's `as_of` clock does not decide which is newest. A row a member
 * filed (a host-named id) is never read as one.
 */
export function latestSnapshot(newestFirst: readonly { id: string; profile: unknown }[]): Snapshot | null {
  for (const r of newestFirst) { const s = readSnapshot(r); if (s !== null) return s; }
  return null;
}
export const isLinked = (s: Snapshot | null): s is Snapshot & { employeeId: string } => s !== null && s.employeeId !== null;

// ---- a member's own rows ---------------------------------------------------------------------------------------
/** The member's leave form: the owner's leave request fields without the employee lookup. */
export const MEMBER_LEAVE: TableSpec = { table: STAFF.leave, noun: "leave request", fields: LEAVE_REQUEST.fields.filter((f) => f.kind !== "lookup") };
/** The member's claim form: no employee lookup, no receipt file name (no upload in this release), always HKD. */
export const MEMBER_CLAIM: TableSpec = { table: STAFF.claims, noun: "claim", fields: CLAIM.fields.filter((f) => f.kind !== "lookup" && f.key !== "receiptRef") };
export { CLAIM_CATEGORIES };

type Linked = Snapshot & { employeeId: string };
const employeeOf = (s: Linked) => ({ employee_id: s.employeeId, employee_name: s.employeeName ?? s.employeeNo ?? s.employeeId });
/** A leave request a member files: pending, undecided, for the employee the owner linked them to. No `member_id`: the host stamps it. */
export function memberLeaveProfile(s: Linked, values: Values, ref: string) {
  const profile = buildProfile(MEMBER_LEAVE, values);
  checkRequestDates(values);
  if (!s.types.some((t) => t.code === profile.leave_type)) throw new FormError("leaveType", "Choose a leave type from the list.");
  return { ...profile, ...employeeOf(s), status: "pending", decided_on: null, decision_note: null, client_ref: ref };
}
/** A claim a member files: submitted, undecided, in HKD, with no receipt reference. */
export function memberClaimProfile(s: Linked, values: Values, ref: string) {
  const profile = buildProfile(MEMBER_CLAIM, { ...values, currency: "HKD" });
  return { ...profile, currency: "HKD", ...employeeOf(s), receipt_ref: null, status: "submitted", decided_on: null, decision_note: null, client_ref: ref };
}
export type Direction = "in" | "out";
/** A time-only punch: the device's clock now, no location (CAD-2334), method `app`. */
export function memberPunchProfile(s: Linked, direction: Direction, at: number, ref: string) {
  return { employee_id: s.employeeId, at, direction, method: "app", lat_e7: null, lng_e7: null, accuracy_m: null, note: null, client_ref: ref };
}

/** What a member sees for one of their requests. A pending request they withdrew reads as withdrawn. */
export type MemberStatus = "pending" | "withdrawn" | "approved" | "rejected" | "cancelled" | "submitted" | "unknown";
export function memberStatus(profile: unknown, withdrawn: boolean): MemberStatus {
  const s = str((profile as { status?: unknown } | null)?.status);
  if (s === "pending" && withdrawn) return "withdrawn";
  return s === "pending" || s === "approved" || s === "rejected" || s === "cancelled" || s === "submitted" ? s : "unknown";
}

// ---- punches -------------------------------------------------------------------------------------------------
/** Who wrote a punch, from its record id: the owner's import and correction ids, or else a member's own app punch. */
export type PunchKind = "app" | "import" | "correction";
export const punchKind = (id: string): PunchKind => (id.startsWith(IMPORT_PREFIX) ? "import" : id.startsWith(CORRECTION_PREFIX) ? "correction" : "app");
export interface Punch { id: string; employeeId: string; memberId: string; at: number; direction: Direction; kind: PunchKind; note: string | null }
export function readPunch(record: { id: string; profile: unknown }): Punch | null {
  const p = prof(record);
  const at = int(p.at), employeeId = str(p.employee_id), memberId = typeof p.member_id === "string" ? p.member_id : null;
  if (at === null || employeeId === null || memberId === null || (p.direction !== "in" && p.direction !== "out")) return null;
  return { id: record.id, employeeId, memberId, at, direction: p.direction, kind: punchKind(record.id), note: str(p.note) };
}
/** The next punch button: out after an `in` today, otherwise in. */
export function nextDirection(punches: readonly Punch[], now: number): Direction {
  const today = hkDayStart(now);
  const last = punches.filter((p) => p.at >= today && p.at <= now + 300).sort((a, b) => a.at - b.at).at(-1);
  return last?.direction === "in" ? "out" : "in";
}
export interface DayRow { date: string; weekday: number; firstIn: number | null; lastOut: number | null; missingOut: boolean; missingIn: boolean; leaveType: string | null }
/** One row per day from `from` to `to` (inclusive, YYYY-MM-DD): first in, last out, what is missing, and approved leave. */
export function daySummary(punches: readonly Punch[], leave: readonly { start: string; end: string; leaveType: string }[], from: string, to: string, today: string): DayRow[] {
  const rows: DayRow[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const own = punches.filter((p) => hkParts(p.at).date === date).sort((a, b) => a.at - b.at);
    const ins = own.filter((p) => p.direction === "in"), outs = own.filter((p) => p.direction === "out");
    const firstIn = ins[0]?.at ?? null, lastOut = outs.at(-1)?.at ?? null;
    rows.push({
      date, weekday: hkParts(hkEpoch(date, "12:00")!).weekday, firstIn, lastOut,
      missingOut: firstIn !== null && (lastOut === null || lastOut < firstIn) && date < today,
      missingIn: lastOut !== null && firstIn === null,
      leaveType: leave.find((l) => l.start <= date && date <= l.end)?.leaveType ?? null,
    });
  }
  return rows;
}

// ---- the owner's import from an attendance device -------------------------------------------------------------
/** A 64-bit FNV-1a of the line's identity, as 16 hex: the same punch always gets the same record id. */
function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) { h ^= BigInt(byte); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, "0");
}
/** The record id (and `client_ref`) of an imported punch: an import run twice meets its own rows. */
export const importId = (employeeNo: string, at: number, direction: Direction): string => `${IMPORT_PREFIX}${fnv64(`${employeeNo}|${at}|${direction}`)}`;
export const MAX_IMPORT_LINES = 5000;
export type ImportStatus = "new" | "already" | "unknown_employee" | "invalid" | "duplicate";
export interface ImportLine { line: number; raw: string; employeeNo: string; at: number | null; direction: Direction | null; status: ImportStatus; reason: string | null; recordId: string | null; employeeId: string | null; memberId: string | null }
export interface DirectoryEntry { id: string; memberId: string | null }
const DIRECTION: Record<string, Direction> = { in: "in", i: "in", out: "out", o: "out" };

/**
 * Read a device's CSV export: one punch per line as `employee number, date and time, direction` (in/out). A header line
 * is skipped; times are Hong Kong time, `YYYY-MM-DD HH:MM` with optional seconds (a `T` may separate date and time).
 * Every line gets a status; nothing is guessed. `existing` holds the record ids already stored, so a second import of
 * the same file marks those lines `already`.
 */
export function parsePunchCsv(text: string, directory: ReadonlyMap<string, DirectoryEntry>, existing: ReadonlySet<string> = new Set()): ImportLine[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.filter((l) => l.trim() !== "").length > MAX_IMPORT_LINES) throw new FormError("csv", "This file has more than 5,000 lines. Split it and import each part.");
  const out: ImportLine[] = [];
  const seen = new Set<string>();
  lines.forEach((raw, index) => {
    if (raw.trim() === "") return;
    const cells = raw.split(/[,\t;]/).map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    const base = { line: index + 1, raw: raw.slice(0, 200), employeeNo: (cells[0] ?? "").toUpperCase(), at: null, direction: null, recordId: null, employeeId: null, memberId: null };
    if (out.length === 0 && index === lines.findIndex((l) => l.trim() !== "") && !/\d/.test(cells[1] ?? "")) return; // a header line
    const bad = (reason: string): void => { out.push({ ...base, status: "invalid", reason }); };
    if (cells.length < 3) return bad("Three columns are needed: employee number, date and time, direction.");
    if (!/^[A-Z0-9_-]{1,32}$/.test(base.employeeNo)) return bad("The employee number is not valid.");
    const when = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(cells[1]!);
    const at = when ? hkEpoch(when[1]!, when[2]!) : null;
    if (at === null) return bad("The date and time is not YYYY-MM-DD HH:MM.");
    const direction = DIRECTION[cells[2]!.toLowerCase()] ?? null;
    if (direction === null) return bad("The direction is not in or out.");
    const recordId = importId(base.employeeNo, at, direction);
    const employee = directory.get(base.employeeNo);
    const row = { ...base, at, direction, recordId, employeeId: employee?.id ?? null, memberId: employee ? employee.memberId ?? NO_MEMBER : null };
    if (seen.has(recordId)) return void out.push({ ...row, status: "duplicate", reason: "The same punch appears earlier in this file." });
    seen.add(recordId);
    if (!employee) return void out.push({ ...row, status: "unknown_employee", reason: "No employee has this number in People." });
    out.push({ ...row, status: existing.has(recordId) ? "already" : "new", reason: null });
  });
  return out;
}
/** The row an imported line becomes. */
export function importProfile(line: ImportLine) {
  if (line.status !== "new" || line.at === null || line.direction === null || line.employeeId === null || line.recordId === null) throw new Error("not an importable line");
  return { employee_id: line.employeeId, member_id: line.memberId ?? NO_MEMBER, at: line.at, direction: line.direction, method: "import", lat_e7: null, lng_e7: null, accuracy_m: null, note: null, client_ref: line.recordId };
}
/** An owner's correction: a new punch, never an edit. It needs a note saying why. */
export function correctionProfile(employee: DirectoryEntry, values: Values, recordId: string) {
  const at = hkEpoch((values.date ?? "").trim(), (values.time ?? "").trim());
  if (!realDate((values.date ?? "").trim())) throw new FormError("date", "Enter the date as YYYY-MM-DD.");
  if (at === null) throw new FormError("time", "Enter the time as HH:MM.");
  const direction = values.direction === "in" || values.direction === "out" ? values.direction : null;
  if (direction === null) throw new FormError("direction", "Choose in or out.");
  const note = (values.note ?? "").trim();
  if (note === "") throw new FormError("note", "Say why this correction is needed.");
  if (Array.from(note).length > 500) throw new FormError("note", "This is too long.");
  return { employee_id: employee.id, member_id: employee.memberId ?? NO_MEMBER, at, direction, method: "correction", lat_e7: null, lng_e7: null, accuracy_m: null, note, client_ref: recordId };
}
/** A member id the employee record can hold (its own column's pattern). */
export const storableMemberId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id) && id !== NO_MEMBER;
/** The short code both screens show so the owner can match a link request to the person in front of them. */
export const memberCode = (id: string) => id.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase();
