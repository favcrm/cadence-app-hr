import {
  CANDIDATE, CLAIM, CLAIM_OPEN, fromHalfDays, fromMinor, LEAVE_OPEN, LEAVE_REQUEST, LEAVE_TYPE, OPENING, OPENING_STATUSES, POLICY, POLICY_STATUSES, STAGES,
} from "../../domain/records";
import { chip, type View } from "./RecordsPane";

const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : "—");
const n = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);
const decided = (p: Record<string, unknown>, t: (x: string) => string) => [
  { key: "decided_on", term: t("Decided on"), value: <span className="num">{s(p.decided_on)}</span> },
  { key: "decision_note", term: t("Decision note"), value: s(p.decision_note) },
];

export const policiesView: View = {
  id: "policies", title: "Policies", spec: POLICY, newLabel: "Add policy", searchHint: "Search policies…", kind: "plain", newId: "pol",
  filter: { field: "status", values: POLICY_STATUSES, initial: "all" },
  columns: (p, t) => [
    { key: "title", header: t("Title"), cell: s(p.title), className: "text-ink-100" },
    { key: "category", header: t("Category"), cell: chip(p.category, t) },
    { key: "effective", header: t("Effective from"), cell: <span className="num">{s(p.effective_from)}</span>, className: "hr-nowrap" },
    { key: "language", header: t("Language"), cell: s(p.language), className: "hr-nowrap" },
    { key: "status", header: t("Status"), cell: chip(p.status, t) },
  ],
};
export const leaveRequestsView: View = {
  id: "leave", title: "Leave requests", spec: LEAVE_REQUEST, newLabel: "Add leave request", searchHint: "Search leave requests…", kind: "decision", open: LEAVE_OPEN, newId: "lv",
  filter: { field: "status", values: ["pending", "approved", "rejected", "cancelled"], initial: LEAVE_OPEN },
  columns: (p, t) => [
    { key: "employee", header: t("Employee"), cell: s(p.employee_name), className: "text-ink-100" },
    { key: "type", header: t("Leave type"), cell: s(p.leave_type), className: "hr-nowrap" },
    { key: "dates", header: t("Dates"), cell: <span className="num">{s(p.start_date)} → {s(p.end_date)}</span>, className: "hr-nowrap" },
    { key: "days", header: t("Days"), cell: <span className="num">{n(p.half_days) === null ? "—" : fromHalfDays(n(p.half_days)!)}</span> },
    { key: "status", header: t("Status"), cell: chip(p.status, t) },
  ],
  extra: (p, t) => [{ key: "employee", term: t("Employee"), value: s(p.employee_name) }, { key: "status", term: t("Status"), value: chip(p.status, t) }, ...decided(p, t)],
};
export const leaveTypesView: View = {
  id: "leave-types", title: "Leave types", spec: LEAVE_TYPE, newLabel: "Add leave type", searchHint: "Search leave types…", kind: "plain", newId: "lt",
  columns: (p, t) => [
    { key: "code", header: t("Code"), cell: s(p.code), className: "text-ink-100 hr-nowrap" },
    { key: "name", header: t("Name"), cell: s(p.name) },
    { key: "paid", header: t("Paid leave"), cell: p.paid === true ? t("Yes") : p.paid === false ? t("No") : "—" },
  ],
};
export const claimsView: View = {
  id: "claims", title: "Claims", spec: CLAIM, newLabel: "Add claim", searchHint: "Search claims…", kind: "decision", open: CLAIM_OPEN, newId: "cl",
  filter: { field: "status", values: ["submitted", "approved", "rejected", "paid"], initial: CLAIM_OPEN },
  columns: (p, t) => {
    const minor = n(p.amount_minor);
    return [
      { key: "employee", header: t("Employee"), cell: s(p.employee_name), className: "text-ink-100" },
      { key: "date", header: t("Receipt date"), cell: <span className="num">{s(p.claim_date)}</span>, className: "hr-nowrap" },
      { key: "merchant", header: t("Merchant"), cell: s(p.merchant) },
      { key: "amount", header: t("Amount"), cell: <span className="num">{minor === null || typeof p.currency !== "string" ? "—" : `${p.currency} ${fromMinor(minor, p.currency)}`}</span>, className: "hr-nowrap" },
      { key: "status", header: t("Status"), cell: chip(p.status, t) },
    ];
  },
  extra: (p, t) => [{ key: "employee", term: t("Employee"), value: s(p.employee_name) }, { key: "status", term: t("Status"), value: chip(p.status, t) }, ...decided(p, t)],
};
export const openingsView: View = {
  id: "openings", title: "Openings", spec: OPENING, newLabel: "Add opening", searchHint: "Search openings…", kind: "plain", newId: "job",
  filter: { field: "status", values: OPENING_STATUSES, initial: "all" },
  columns: (p, t) => [
    { key: "title", header: t("Title"), cell: s(p.title), className: "text-ink-100" },
    { key: "department", header: t("Department"), cell: s(p.department) },
    { key: "status", header: t("Status"), cell: chip(p.status, t) },
  ],
};
/** Candidates for one opening (or all openings when `openingId` is null). */
export function candidatesView(openingId: string | null, titles: Record<string, string>): View {
  return {
    id: "candidates", title: "Candidates", spec: CANDIDATE, newLabel: "Add candidate", searchHint: "Search candidates…", kind: "candidate", newId: "cand",
    filter: { field: "stage", values: STAGES, initial: "all" },
    filters: openingId ? [{ field: "opening_id", op: "eq", value: openingId }] : undefined,
    createExtra: openingId ? { opening_id: openingId } : undefined,
    blockedNew: openingId ? undefined : "Choose one opening to add a candidate to it.",
    columns: (p, t) => [
      { key: "name", header: t("Name"), cell: s(p.display_name), className: "text-ink-100" },
      { key: "opening", header: t("Opening"), cell: typeof p.opening_id === "string" ? titles[p.opening_id] ?? "—" : "—" },
      { key: "source", header: t("Source"), cell: s(p.source) },
      { key: "stage", header: t("Stage"), cell: chip(p.stage, t) },
      { key: "screened", header: t("Screening"), cell: p.screening ? t("Has note") : t("None") },
    ],
    extra: (p, t) => [{ key: "stage", term: t("Stage"), value: chip(p.stage, t) }, { key: "opening", term: t("Opening"), value: typeof p.opening_id === "string" ? titles[p.opening_id] ?? "—" : "—" }],
  };
}
