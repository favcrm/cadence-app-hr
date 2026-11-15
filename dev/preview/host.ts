// A local stand-in for the Cadence host: it speaks the screen bridge to the real app
// frame and answers the records verbs from synthetic fixtures held in this tab.
// It is a presentation harness, not an authority: nothing here is a signed-in session.
//
// Scenarios (?scenario=): loaded (default), empty, loading, refused, lost, stale, unreachable.
// Language (?locale=): en or zh-TW, the two values the real host pushes.
// Viewer (?viewer=): owner (default), member (linked to E-001) or unlinked: a member gets the AOS-564 gates (only
// `row_owner` tables, only their own rows, host-named ids, no update); any other table answers `forbidden`.
// Refusals use the codes the hosted board hands a frame: it narrows a host error by HTTP status
// to unauthorized, forbidden, not_found, conflict, unavailable or failed. A unique-index
// violation is a store error on the host, so it reaches the frame as `unavailable`.
import { seedRows, seedStaff, seedTables, type SeedRow } from "./fixtures";
import type { Route } from "../../src/bridge/scope";

const SCENARIOS = ["loaded", "empty", "loading", "refused", "lost", "stale", "unreachable"] as const;
type Scenario = (typeof SCENARIOS)[number];
const LOCALES = ["en", "zh-TW"] as const;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEARCH: Record<string, string[]> = {
  employees: ["display_name", "employee_no", "email", "department"], policies: ["title", "body"], leave_types: ["code", "name"], leave_requests: ["employee_name", "leave_type", "reason"],
  claims: ["employee_name", "merchant", "description"], job_openings: ["title"], candidates: ["display_name", "email", "cv_text"], leave_entries: ["source_ref", "note"],
};
const OPEN: Record<string, string> = { leave_requests: "pending", claims: "submitted" };
const SECTIONS = ["people", "policies", "leave", "claims", "payroll", "recruiting", "attendance"];
const VIEWERS = ["owner", "member", "unlinked"] as const;
const ROW_OWNER = ["attendance_punches", "staff_link_requests", "staff_snapshots", "staff_leave_requests", "staff_claims", "leave_withdrawals"];
const ACTIONS = ["records.list", "records.show", "records.create", "records.update", "records.batch", "records.aggregate", "screen.route.patch"];
const INSTALL = "install-preview";
const DIGEST = `sha256:${"c".repeat(64)}`;

const query = new URLSearchParams(location.search);
const scenario: Scenario = SCENARIOS.includes(query.get("scenario") as Scenario) ? (query.get("scenario") as Scenario) : "loaded";
const viewer = VIEWERS.includes(query.get("viewer") as (typeof VIEWERS)[number]) ? (query.get("viewer") as (typeof VIEWERS)[number]) : "owner";
const MEMBER = viewer === "member" ? "usr_preview-amy-0001" : viewer === "unlinked" ? "usr_preview-new-0002" : null;
const locale = LOCALES.includes(query.get("locale") as (typeof LOCALES)[number]) ? (query.get("locale") as "en" | "zh-TW") : "en";
const frame = document.querySelector<HTMLIFrameElement>("#hr-frame")!;
const status = document.querySelector<HTMLElement>("#status")!;

for (const [id, values, current, key] of [["scenarios", SCENARIOS, scenario, "scenario"], ["locales", LOCALES, locale, "locale"], ["viewers", VIEWERS, viewer, "viewer"]] as const) {
  const nav = document.getElementById(id)!;
  for (const value of values) {
    const url = new URL(location.href);
    url.searchParams.set(key, value);
    const link = Object.assign(document.createElement("a"), { href: url.pathname + url.search, textContent: value });
    link.setAttribute("aria-current", String(value === current));
    nav.append(link);
  }
}

const data: Record<string, SeedRow[]> = scenario === "empty" ? {} : { employees: seedRows(), ...seedTables(), ...seedStaff("usr_preview-amy-0001", Math.floor(Date.now() / 1000)) };
const table = (args: Record<string, unknown>) => (typeof args.table === "string" ? args.table : "employees");
const rowsOf = (name: string) => (data[name] ??= []);
let route: Route = readRoute();
let port: MessagePort | null = null;
let staleOnce = scenario === "stale";
const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

function readRoute(): Route {
  const record = query.get("record");
  const section = query.get("section");
  return { section: (SECTIONS.includes(section ?? "") ? section : "people") as Route["section"], view: query.get("view") === "new" ? "new" : "list", record_id: record && ID.test(record) ? record : null, segment_id: null };
}
const refusal = (code: string, text: string) => ({ code, text });
class Refused extends Error { constructor(readonly refusal: { code: string; text: string }) { super(refusal.text); } }
const receipt = (row: SeedRow) => ({
  id: row.id, install_id: INSTALL, context_id: "", kind: "employee", revision: row.revision, profile: row.profile, history: [], history_truncated: false, consent_history: [],
  digest: `sha256:${(row.id + row.revision).split("").map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64)}`,
});

function sendProjection() {
  port?.postMessage({
    v: 2, op: "screen", tag: "hr", install_id: INSTALL, digest: DIGEST,
    installation: { install_id: INSTALL, name: "hr", title: "HR", version: "development", digest: DIGEST, summary: "Local synthetic fixtures" },
    actions: ACTIONS, route, presentation_locale: locale,
  });
}

const hit = (f: { field: string; op: string; value: unknown }, r: SeedRow) => {
  const v = r.profile[f.field];
  switch (f.op) {
    case "in": return Array.isArray(f.value) && f.value.includes(v);
    case "prefix": return typeof v === "string" && typeof f.value === "string" && v.startsWith(f.value);
    case "contains": return typeof v === "string" && typeof f.value === "string" && v.includes(f.value);
    case "gte": return (v as number) >= (f.value as number);
    case "lte": return (v as number) <= (f.value as number);
    default: return v === f.value;
  }
};
let memberSeq = 0;
/** The AOS-564 member gates, before the owner's fixture logic runs. */
function asMember(verb: string, args: Record<string, unknown>): Record<string, unknown> {
  const names = verb === "records.batch" ? (Array.isArray(args.items) ? args.items.map((i: { table?: unknown }) => (typeof i.table === "string" ? i.table : "employees")) : []) : [table(args)];
  // A member never updates: the host refuses it `owner_required`, which the board keeps non-fatal for a write.
  if (verb === "records.update" && names.every((n) => ROW_OWNER.includes(n))) throw new Refused(refusal("owner_required", "Only a workspace owner can perform this action."));
  if (names.some((n) => !ROW_OWNER.includes(n))) throw new Refused(refusal("forbidden", "This app's access is no longer available."));
  if (verb === "records.create") {
    if (args.record_id !== undefined) throw failed();
    const profile = args.profile as Record<string, unknown>;
    if ("member_id" in profile && profile.member_id !== MEMBER) throw new Refused(refusal("forbidden", "This app's access is no longer available."));
    return { ...args, record_id: `mem_${(++memberSeq).toString(16).padStart(32, "0")}`, profile: { ...profile, member_id: MEMBER } };
  }
  if (verb === "records.batch") throw failed(); // a member's batch here only ever names record ids (the screen's probe)
  return args;
}
const mine = (r: SeedRow, name: string) => MEMBER === null || !ROW_OWNER.includes(name) || r.profile.member_id === MEMBER;
const failed = () => new Refused(refusal("failed", "Cadence refused this request. Inspect fresh status before retrying an effect."));
const KINDS = ["accrual", "taken", "adjustment", "carry_forward", "expiry"];
/** The ledger's declared rules: only creates, a closed kind, a signed non-zero count with the right sign, and an adjustment needs a note. */
function ledgerRule(profile: SeedRow["profile"]) {
  const half = profile.half_days, kind = profile.kind;
  if (!KINDS.includes(String(kind)) || !Number.isInteger(half) || half === 0) throw failed();
  if (["accrual", "carry_forward"].includes(String(kind)) && (half as number) < 1) throw failed();
  if (["taken", "expiry"].includes(String(kind)) && (half as number) > -1) throw failed();
  if (kind === "adjustment" && (typeof profile.note !== "string" || profile.note === "")) throw failed();
  for (const key of ["employee_id", "leave_type", "effective_date", "source_ref"]) if (typeof profile[key] !== "string" || profile[key] === "") throw failed();
}
const duplicateRef = (rows: SeedRow[], profile: SeedRow["profile"]) => rows.some((r) => r.profile.source_ref === profile.source_ref);

function call(verb: string, args: Record<string, unknown>): unknown {
  if (scenario === "refused" && verb !== "screen.route.patch") throw new Refused(refusal("failed", "Cadence refused this request. Inspect fresh status before retrying an effect."));
  if (scenario === "lost" && verb !== "screen.route.patch") throw new Refused(refusal("unauthorized", "This app's access is no longer available."));
  if (MEMBER !== null) args = asMember(verb, args);
  switch (verb) {
    case "records.list": {
      const q = typeof args.query === "string" ? args.query.toLowerCase() : null;
      const filters = Array.isArray(args.filters) ? (args.filters as { field: string; op: string; value: unknown }[]) : [];
      const name = table(args);
      const columns = SEARCH[name] ?? [];
      const order = args.order_by as { field: string; direction?: string } | undefined;
      const key = (r: SeedRow) => (order?.field === "created_at" ? rowsOf(name).indexOf(r) : order ? (r.profile[order.field] as string | number) ?? "" : r.id);
      const matched = rowsOf(name).filter((r) => mine(r, name) && (!q || columns.some((c) => String(r.profile[c] ?? "").toLowerCase().includes(q))) && filters.every((f) => hit(f, r)))
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (order?.direction === "desc" ? -1 : 1));
      const after = typeof args.cursor === "string" ? matched.findIndex((r) => r.id === args.cursor) + 1 : 0;
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const page = matched.slice(after, after + limit);
      const more = after + limit < matched.length;
      return { records: page.map(receipt), total: matched.length, truncated: more, next_cursor: more ? page.at(-1)!.id : null };
    }
    case "records.show": {
      const row = rowsOf(table(args)).find((r) => r.id === args.record_id && mine(r, table(args)));
      if (!row) throw new Refused(refusal("not_found", "That record is not available."));
      return { record: receipt(row) };
    }
    case "records.create": {
      const id = String(args.record_id);
      const rows = rowsOf(table(args));
      if (rows.some((r) => r.id === id)) throw new Refused(refusal("conflict", "That changed. Refresh before trying again."));
      const profile = { ...(table(args) === "employees" ? { member_id: null, confirmed_member_id: null, manager_id: null } : {}), ...(args.profile as Record<string, SeedRow["profile"][string]>) } as SeedRow["profile"];
      // The write rule the descriptor declares: a staged create can only be open.
      if (OPEN[table(args)] && profile.status !== undefined && profile.status !== OPEN[table(args)]) throw new Refused(refusal("failed", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      if (OPEN[table(args)]) profile.status = OPEN[table(args)]!;
      if (table(args) === "employees" && rows.some((r) => r.profile.employee_no === profile.employee_no)) throw new Refused(refusal("unavailable", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      if (table(args) === "leave_entries") {
        ledgerRule(profile);
        // The deployed host answers a unique-index violation as a store failure (503, `unavailable`); a later board answers 409.
        if (duplicateRef(rows, profile)) throw new Refused(refusal(query.get("unique") === "409" ? "conflict" : "unavailable", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      }
      const row: SeedRow = { id, revision: 1, profile };
      rows.push(row);
      return { record: receipt(row) };
    }
    case "records.update": {
      // The append-only staff tables refuse every update before a row is read (the screen's owner-or-member probe).
      if (["attendance_punches", "staff_link_requests", "staff_snapshots", "leave_withdrawals"].includes(table(args))) throw new Refused(refusal("conflict", "That changed. Refresh before trying again."));
      const rows = rowsOf(table(args));
      const row = rows.find((r) => r.id === args.record_id);
      if (!row) throw new Refused(refusal("not_found", "That record is not available."));
      if (table(args) === "leave_entries") throw failed(); // append_only: no update, ever
      // The write rule the descriptor declares: only an open request or claim can change.
      if (OPEN[table(args)] && row.profile.status !== OPEN[table(args)]) throw new Refused(refusal("failed", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      // The stale scenario: someone else saves first, so the first update meets a newer revision.
      if (staleOnce) { staleOnce = false; row.revision += 1; row.profile = { ...row.profile, job_title: "Changed by someone else" }; }
      if (row.revision !== args.expected_revision) throw new Refused(refusal("conflict", "That changed. Refresh before trying again."));
      const profile = { ...row.profile, ...(args.profile as Record<string, SeedRow["profile"][string]>) } as SeedRow["profile"];
      if (table(args) === "employees" && rows.some((r) => r.id !== row.id && r.profile.employee_no === profile.employee_no)) throw new Refused(refusal("unavailable", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      row.profile = profile; row.revision += 1;
      return { record: receipt(row) };
    }
    case "records.batch": {
      const batch = Array.isArray(args.items) ? (args.items as { record_id?: unknown; table?: unknown; profile?: SeedRow["profile"] }[]) : [];
      if (batch.length < 1 || batch.length > 200) throw failed();
      const staged: Record<string, SeedRow[]> = {};
      const seenIds = new Set<string>();
      for (const item of batch) {
        const name = typeof item.table === "string" ? item.table : "employees";
        if (!["leave_entries", "payroll_runs", "payroll_lines", ...ROW_OWNER].includes(name) || typeof item.record_id !== "string" || !item.profile) throw failed();
        if (name === "leave_entries") ledgerRule(item.profile);
        const all = [...rowsOf(name), ...(staged[name] ??= [])];
        if (seenIds.has(item.record_id) || all.some((r) => r.id === item.record_id)) throw new Refused(refusal("conflict", "That changed. Refresh before trying again."));
        // One duplicate key refuses the whole batch: 409 unique_violation, which the board shows as `conflict`.
        if (name === "leave_entries" && duplicateRef(all, item.profile)) throw new Refused(refusal("conflict", "That changed. Refresh before trying again."));
        seenIds.add(item.record_id);
        staged[name]!.push({ id: item.record_id, revision: 1, profile: item.profile });
      }
      for (const [name, added] of Object.entries(staged)) rowsOf(name).push(...added);
      return { rows: batch.length };
    }
    case "records.aggregate": {
      const filters = Array.isArray(args.filters) ? (args.filters as { field: string; op: string; value: unknown }[]) : [];
      const by = Array.isArray(args.group_by) ? (args.group_by as string[]) : [];
      const sums = Array.isArray(args.sum) ? (args.sum as string[]) : [];
      const groups = new Map<string, { key: Record<string, unknown>; count: number; sums: Record<string, number> }>();
      for (const r of rowsOf(table(args)).filter((row) => mine(row, table(args)) && filters.every((f) => hit(f, row)))) {
        const key = Object.fromEntries(by.map((c) => [c, r.profile[c] ?? null]));
        const id = JSON.stringify(key);
        const g = groups.get(id) ?? { key, count: 0, sums: Object.fromEntries(sums.map((c) => [c, 0])) };
        g.count += 1;
        for (const c of sums) g.sums[c]! += Number(r.profile[c] ?? 0);
        groups.set(id, g);
      }
      const all = [...groups.values()];
      // ?aggregate=truncated shows the screen a cut answer: the host reports groups beyond its limit as `truncated`.
      return query.get("aggregate") === "truncated" ? { groups: all.slice(0, 2), group_limit: 1000, truncated: true } : { groups: all, group_limit: 1000, truncated: false };
    }
    default: throw new Refused(refusal("forbidden", "This operation is unavailable."));
  }
}

function navigate(patch: Record<string, unknown>) {
  route = {
    ...route,
    ...(typeof patch.section === "string" && SECTIONS.includes(patch.section) ? { section: patch.section as Route["section"] } : {}),
    ...(patch.view === "list" || patch.view === "new" ? { view: patch.view } : {}),
    ...(patch.record_id !== undefined ? { record_id: patch.record_id as string | null } : {}),
  };
  const url = new URL(location.href);
  if (route.section !== "people") url.searchParams.set("section", route.section); else url.searchParams.delete("section");
  if (route.view === "new") url.searchParams.set("view", "new"); else url.searchParams.delete("view");
  if (route.record_id) url.searchParams.set("record", route.record_id); else url.searchParams.delete("record");
  history.replaceState(null, "", url);
  sendProjection();
}

function handle(request: Record<string, unknown>) {
  if (request.v === 1 && request.op === "ready") {
    if (scenario !== "unreachable") sendProjection();
    status.textContent = `${scenario} · ${viewer} · synthetic data held in this tab`;
    return;
  }
  // The leave hint: the real board asks before navigating away while it is true.
  if (request.v === 2 && request.op === "leave" && typeof request.unsaved === "boolean") {
    status.textContent = `${scenario} · synthetic data held in this tab${request.unsaved ? " · unsaved edits" : ""}`;
    return;
  }
  if (request.v !== 2 || request.op !== "call" || typeof request.id !== "string") return;
  const id = request.id, verb = String(request.verb), args = (request.args ?? {}) as Record<string, unknown>;
  const answer = (data: unknown) => port?.postMessage({ v: 2, op: "reply", id, ok: true, data });
  const refuse = (r: { code: string; text: string }) => port?.postMessage({ v: 2, op: "reply", id, ok: false, refusal: r });
  if (!ACTIONS.includes(verb)) return refuse(refusal("forbidden", "This operation is unavailable."));
  if (verb === "screen.route.patch") { navigate(args); return answer({}); }
  const run = () => { try { answer(call(verb, args)); } catch (e) { if (e instanceof Refused) refuse(e.refusal); else refuse(refusal("failed", "Local fixture refused.")); } };
  if (scenario === "loading" && verb === "records.list") setTimeout(run, 60_000); else run();
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  if (!message || message.v !== 1 || message.op !== "init" || message.tag !== "hr" || message.bridge_nonce !== nonce || message.generation !== 1 || event.ports.length !== 1) return;
  port?.close();
  port = event.ports[0]!;
  port.onmessage = (e) => { try { handle(e.data); } catch { port?.close(); port = null; } };
  port.start();
});
window.addEventListener("pagehide", () => port?.close());
frame.src = `./frame.html?nonce=${nonce}`;
