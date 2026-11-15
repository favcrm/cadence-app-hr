// An in-memory host for the leave ledger tests: employees, leave types, leave requests and the append-only
// `leave_entries` table with its unique `source_ref`, atomic `records.batch` and `records.aggregate`. It enforces the
// rules the descriptor declares and keeps a call log, so a test can assert on order, counts and bytes.
import { ApiError } from "../support/sdk-mock.mjs";
import { createHostActions } from "../../src/features/hr/hostActions.ts";
import { cleanArgs } from "../../src/bridge/services.ts";

export interface Row { id: string; revision: number; profile: Record<string, any> }
export type Call = { verb: string; args: Record<string, any> };
export const scope = { installId: "install-test", digest: "sha256:" + "a".repeat(64) };
const TABLES = ["employees", "leave_types", "leave_requests", "leave_entries"] as const;

export function makeHost(opts: { uniqueStatus?: number; pageSize?: number } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]]));
  const calls: Call[] = [];
  /** Throw this for the nth (1-based) matching call, once, and still apply the write first when `after` is set (a lost reply). */
  const faults: { verb: string; nth: number; error: ApiError; after: boolean; seen: number; table?: string }[] = [];
  const fault = (verb: string, error: ApiError, { nth = 1, after = false, table }: { nth?: number; after?: boolean; table?: string } = {}) => { faults.push({ verb, nth, error, after, seen: 0, table }); };
  const rows = (name: string) => tables[name] ?? (() => { throw new ApiError("not declared", 403); })();
  const matches = (row: Row, f: { field: string; op: string; value: unknown }) => {
    const v = row.profile[f.field];
    if (f.op === "in") return (f.value as unknown[]).includes(v);
    if (f.op === "prefix") return typeof v === "string" && v.startsWith(f.value as string);
    if (f.op === "contains") return typeof v === "string" && v.includes(f.value as string);
    return v === f.value;
  };
  const receipt = (r: Row) => ({ id: r.id, revision: r.revision, digest: "sha256:" + r.id, profile: r.profile, history: [] });
  const ledgerRule = (p: Record<string, any>) => {
    const ok = Number.isInteger(p.half_days) && p.half_days !== 0
      && ["accrual", "taken", "adjustment", "carry_forward", "expiry"].includes(p.kind)
      && (!["accrual", "carry_forward"].includes(p.kind) || p.half_days > 0) && (!["taken", "expiry"].includes(p.kind) || p.half_days < 0)
      && (p.kind !== "adjustment" || (typeof p.note === "string" && p.note !== ""));
    if (!ok) throw new ApiError("refused", 400, { code: "failed" });
  };
  const unique = (p: Record<string, any>) => rows("leave_entries").some((r) => r.profile.source_ref === p.source_ref);
  const uniqueError = () => new ApiError("refused", opts.uniqueStatus ?? 503, { code: opts.uniqueStatus === 409 ? "conflict" : "unavailable" });

  const actions = createHostActions(async (_s, verb, rawArgs) => {
    const args = cleanArgs(verb, rawArgs as Record<string, unknown>) as Record<string, any>; // the screen's own budgets apply
    const call: Call = { verb, args };
    calls.push(call);
    const table: string = args.table ?? "employees";
    const hit = faults.find((f) => f.verb === verb && (f.table === undefined || f.table === table) && ++f.seen === f.nth);
    const run = (): unknown => {
      switch (verb) {
        case "records.list": {
          const filters = (args.filters ?? []) as { field: string; op: string; value: unknown }[];
          const all = rows(table).filter((r) => filters.every((f) => matches(r, f)));
          const limit = Math.min(args.limit ?? 25, opts.pageSize ?? 100);
          const start = args.cursor ? all.findIndex((r) => r.id === args.cursor) + 1 : 0;
          const page = all.slice(start, start + limit);
          const more = start + limit < all.length;
          return { records: page.map(receipt), total: all.length, truncated: more, next_cursor: more ? page.at(-1)!.id : null };
        }
        case "records.show": {
          const row = rows(table).find((r) => r.id === args.record_id);
          if (!row) throw new ApiError("gone", 404, { code: "not_found" });
          return { record: receipt(row) };
        }
        case "records.create": {
          if (rows(table).some((r) => r.id === args.record_id)) throw new ApiError("conflict", 409, { code: "conflict" });
          if (table === "leave_entries") { ledgerRule(args.profile); if (unique(args.profile)) throw uniqueError(); }
          const row = { id: args.record_id, revision: 1, profile: { ...args.profile } };
          rows(table).push(row);
          return { record: receipt(row) };
        }
        case "records.update": {
          if (table === "leave_entries") throw new ApiError("append_only", 400, { code: "failed" });
          const row = rows(table).find((r) => r.id === args.record_id);
          if (!row) throw new ApiError("gone", 404, { code: "not_found" });
          if (row.revision !== args.expected_revision) throw new ApiError("stale", 409, { code: "conflict" });
          if (table === "leave_requests" && row.profile.status !== "pending") throw new ApiError("refused", 400, { code: "failed" });
          row.profile = { ...row.profile, ...args.profile }; row.revision += 1;
          return { record: receipt(row) };
        }
        case "records.batch": {
          const items = args.items as { record_id: string; table: string; profile: Record<string, any> }[];
          if (items.length < 1 || items.length > 200) throw new ApiError("refused", 400, { code: "failed" });
          const staged: Row[] = [];
          for (const item of items) {
            if (item.table !== "leave_entries") throw new ApiError("refused", 400, { code: "failed" });
            ledgerRule(item.profile);
            if (unique(item.profile) || staged.some((r) => r.profile.source_ref === item.profile.source_ref)) throw new ApiError("unique_violation", 409, { code: "conflict" });
            if (rows(item.table).some((r) => r.id === item.record_id) || staged.some((r) => r.id === item.record_id)) throw new ApiError("conflict", 409, { code: "conflict" });
            staged.push({ id: item.record_id, revision: 1, profile: { ...item.profile } });
          }
          rows("leave_entries").push(...staged); // all or nothing
          return { rows: staged.length };
        }
        case "records.aggregate": {
          const filters = (args.filters ?? []) as { field: string; op: string; value: unknown }[];
          const groups = new Map<string, { key: Record<string, unknown>; count: number; sums: Record<string, number> }>();
          for (const r of rows(table).filter((row) => filters.every((f) => matches(row, f)))) {
            const key = Object.fromEntries((args.group_by ?? []).map((c: string) => [c, r.profile[c]]));
            const id = JSON.stringify(key);
            const g = groups.get(id) ?? { key, count: 0, sums: Object.fromEntries((args.sum ?? []).map((c: string) => [c, 0])) };
            g.count += 1; for (const c of args.sum ?? []) g.sums[c]! += r.profile[c];
            groups.set(id, g);
          }
          return { groups: [...groups.values()], group_limit: 1000, truncated: false };
        }
        default: throw new Error(`unexpected ${verb}`);
      }
    };
    if (hit && !hit.after) throw hit.error;
    const result = run();
    if (hit?.after) throw hit.error;
    return result;
  });
  const add = (name: string, id: string, profile: Record<string, any>) => { rows(name).push({ id, revision: 1, profile }); };
  return { actions, tables, calls, fault, add, of: (name: string) => rows(name), verbs: () => calls.map((c) => c.verb) };
}

export const employee = (id: string, over: Record<string, any> = {}) => ({ display_name: `Person ${id}`, employee_no: id.toUpperCase(), join_date: "2024-01-15", leave_date: null, status: "active", ...over });
export const request = (over: Record<string, any> = {}) => ({ employee_id: "emp-aaa", employee_name: "Person emp-aaa", leave_type: "ANNUAL", start_date: "2026-03-02", end_date: "2026-03-03", half_days: 4, reason: "", status: "pending", decided_on: null, decision_note: null, ...over });
