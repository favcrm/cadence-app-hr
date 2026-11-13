// A local stand-in for the Cadence host: it speaks the screen bridge to the real app
// frame and answers the records verbs from synthetic fixtures held in this tab.
// It is a presentation harness, not an authority: nothing here is a signed-in session.
//
// Scenarios (?scenario=): loaded (default), empty, loading, refused, lost, stale, unreachable.
// Language (?locale=): en or zh-TW, the two values the real host pushes.
// Refusals use the codes the hosted board hands a frame: it narrows a host error by HTTP status
// to unauthorized, forbidden, not_found, conflict, unavailable or failed. A unique-index
// violation is a store error on the host, so it reaches the frame as `unavailable`.
import { seedRows, seedTables, type SeedRow } from "./fixtures";
import type { Route } from "../../src/bridge/scope";

const SCENARIOS = ["loaded", "empty", "loading", "refused", "lost", "stale", "unreachable"] as const;
type Scenario = (typeof SCENARIOS)[number];
const LOCALES = ["en", "zh-TW"] as const;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEARCH: Record<string, string[]> = {
  employees: ["display_name", "employee_no", "email", "department"], policies: ["title", "body"], leave_types: ["code", "name"], leave_requests: ["employee_name", "leave_type", "reason"],
  claims: ["employee_name", "merchant", "description"], job_openings: ["title"], candidates: ["display_name", "email", "cv_text"],
};
const OPEN: Record<string, string> = { leave_requests: "pending", claims: "submitted" };
const SECTIONS = ["people", "policies", "leave", "claims", "recruiting"];
const ACTIONS = ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"];
const INSTALL = "install-preview";
const DIGEST = `sha256:${"c".repeat(64)}`;

const query = new URLSearchParams(location.search);
const scenario: Scenario = SCENARIOS.includes(query.get("scenario") as Scenario) ? (query.get("scenario") as Scenario) : "loaded";
const locale = LOCALES.includes(query.get("locale") as (typeof LOCALES)[number]) ? (query.get("locale") as "en" | "zh-TW") : "en";
const frame = document.querySelector<HTMLIFrameElement>("#hr-frame")!;
const status = document.querySelector<HTMLElement>("#status")!;

for (const [id, values, current, key] of [["scenarios", SCENARIOS, scenario, "scenario"], ["locales", LOCALES, locale, "locale"]] as const) {
  const nav = document.getElementById(id)!;
  for (const value of values) {
    const url = new URL(location.href);
    url.searchParams.set(key, value);
    const link = Object.assign(document.createElement("a"), { href: url.pathname + url.search, textContent: value });
    link.setAttribute("aria-current", String(value === current));
    nav.append(link);
  }
}

const data: Record<string, SeedRow[]> = scenario === "empty" ? {} : { employees: seedRows(), ...seedTables() };
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

function call(verb: string, args: Record<string, unknown>): unknown {
  if (scenario === "refused" && verb !== "screen.route.patch") throw new Refused(refusal("failed", "Cadence refused this request. Inspect fresh status before retrying an effect."));
  if (scenario === "lost" && verb !== "screen.route.patch") throw new Refused(refusal("unauthorized", "This app's access is no longer available."));
  switch (verb) {
    case "records.list": {
      const q = typeof args.query === "string" ? args.query.toLowerCase() : null;
      const filters = Array.isArray(args.filters) ? (args.filters as { field: string; op: string; value: unknown }[]) : [];
      const name = table(args);
      const columns = SEARCH[name] ?? [];
      const hit = (f: { field: string; op: string; value: unknown }, r: SeedRow) => (f.op === "in" ? Array.isArray(f.value) && f.value.includes(r.profile[f.field]) : r.profile[f.field] === f.value);
      const matched = rowsOf(name).filter((r) => (!q || columns.some((c) => String(r.profile[c] ?? "").toLowerCase().includes(q))) && filters.every((f) => hit(f, r))).sort((a, b) => (a.id < b.id ? -1 : 1));
      const after = typeof args.cursor === "string" ? matched.findIndex((r) => r.id === args.cursor) + 1 : 0;
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const page = matched.slice(after, after + limit);
      const more = after + limit < matched.length;
      return { records: page.map(receipt), total: matched.length, truncated: more, next_cursor: more ? page.at(-1)!.id : null };
    }
    case "records.show": {
      const row = rowsOf(table(args)).find((r) => r.id === args.record_id);
      if (!row) throw new Refused(refusal("not_found", "That record is not available."));
      return { record: receipt(row) };
    }
    case "records.create": {
      const id = String(args.record_id);
      const rows = rowsOf(table(args));
      if (rows.some((r) => r.id === id)) throw new Refused(refusal("conflict", "That changed. Refresh before trying again."));
      const profile = { ...(table(args) === "employees" ? { member_id: null, manager_id: null } : {}), ...(args.profile as Record<string, SeedRow["profile"][string]>) } as SeedRow["profile"];
      // The write rule the descriptor declares: a staged create can only be open.
      if (OPEN[table(args)] && profile.status !== undefined && profile.status !== OPEN[table(args)]) throw new Refused(refusal("failed", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      if (OPEN[table(args)]) profile.status = OPEN[table(args)]!;
      if (table(args) === "employees" && rows.some((r) => r.profile.employee_no === profile.employee_no)) throw new Refused(refusal("unavailable", "Cadence refused this request. Inspect fresh status before retrying an effect."));
      const row: SeedRow = { id, revision: 1, profile };
      rows.push(row);
      return { record: receipt(row) };
    }
    case "records.update": {
      const rows = rowsOf(table(args));
      const row = rows.find((r) => r.id === args.record_id);
      if (!row) throw new Refused(refusal("not_found", "That record is not available."));
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
    status.textContent = `${scenario} · synthetic data held in this tab`;
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
