// An in-memory host for the staff self-service tests, built from the app's own storage declaration like
// `payroll-host.ts`, plus the AOS-564 member gates the real host applies to a verified member who is not an owner:
//
// - a table that declares `read_role: "owner"` and no `row_owner` refuses a member every verb (403 `owner_required`);
// - a `row_owner` table shows a member only rows whose owner column is their id (another member's row reads as missing);
// - a member's create names no `record_id` (400 `record_id_not_allowed`) and the host names it `mem_` + 32 hex; the owner
//   column is filled from the session, and a different value is refused (403 `row_owner_mismatch`);
// - a member never updates (403 `owner_required`, before any read);
// - a member's batch must target only `row_owner` tables, or it takes the owner-only path and is refused whole.
//
// Every store is shared, so one test can act as the owner and as two members on the same rows. `closed` records the
// first 403 a viewer met: the board closes a screen's frame on it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError } from "./sdk-mock.mjs";
import { valid } from "./mini-schema.mjs";
import { createHostActions, type HostActions } from "../../src/features/hr/hostActions.ts";
import { cleanArgs } from "../../src/bridge/services.ts";

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8"));
export const descriptor = read("app/app-storage.json");
const operations = descriptor.migrations.flatMap((m: { path: string }) => read(`app/${m.path}`).operations);
const TABLES: string[] = operations.filter((o: { op: string }) => o.op === "create_table").map((o: { table: string }) => o.table);
const UNIQUES: Record<string, string[][]> = {};
for (const o of operations) if (o.op === "create_index" && o.unique) (UNIQUES[o.table] ??= []).push(o.columns);
const options = (table: string): { read_role?: string; row_owner?: string; append_only?: boolean; write_schema?: unknown } => descriptor.tables[table] ?? {};

export interface Row { id: string; revision: number; profile: Record<string, any> }
export type Viewer = { role: "owner" } | { role: "member"; id: string };
export interface Call { viewer: string; verb: string; table: string; args: Record<string, any>; status: number }
export const scope = { installId: "install-test", digest: "sha256:" + "a".repeat(64) };
export const OWNER: Viewer = { role: "owner" };
export const member = (id: string): Viewer => ({ role: "member", id });

export function makeStaffHost() {
  const tables: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]]));
  const calls: Call[] = [];
  const closed = new Map<string, string>();
  let seq = 0;
  const faults: { verb: string; table?: string; viewer?: string; error: ApiError; after: boolean; done: boolean }[] = [];
  const fault = (verb: string, error: ApiError, opts: { table?: string; viewer?: string; after?: boolean } = {}) => { faults.push({ verb, error, table: opts.table, viewer: opts.viewer, after: opts.after ?? false, done: false }); };
  const fail = (status: number, code: string) => new ApiError(code, status, { code });
  const rows = (name: string) => { const t = tables[name]; if (!t) throw fail(400, "validation_failed"); return t; };
  const rule = (table: string, operation: string, before: Record<string, any> | null, after: Record<string, any>) => {
    const o = options(table);
    if (operation === "update" && o.append_only) throw fail(409, "append_only");
    if (o.write_schema && !valid(o.write_schema, { operation, before, after, provenance: null })) throw fail(400, "validation_failed");
  };
  const clash = (table: string, profile: Record<string, any>, others: Row[]) => (UNIQUES[table] ?? []).some((cols) => others.some((r) => cols.every((c) => r.profile[c] === profile[c])));
  const receipt = (r: Row) => ({ id: r.id, revision: r.revision, digest: "sha256:" + r.id, profile: r.profile, history: [] });
  const matches = (row: Row, f: { field: string; op: string; value: any }) => {
    const v = row.profile[f.field];
    return f.op === "in" ? f.value.includes(v) : f.op === "gte" ? v >= f.value : f.op === "lte" ? v <= f.value : v === f.value;
  };
  // A profile as the host stores it: every declared column, defaults filled.
  const columns = (table: string) => operations.find((o: any) => o.op === "create_table" && o.table === table).columns as { name: string; nullable: boolean; default?: unknown }[];
  const stored = (table: string, profile: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const c of columns(table)) {
      if (c.name in profile) out[c.name] = profile[c.name];
      else if ("default" in c) out[c.name] = c.default;
      else if (c.nullable) out[c.name] = null;
      else throw fail(400, "missing_value");
    }
    for (const k of Object.keys(profile)) if (!columns(table).some((c) => c.name === k)) throw fail(400, "unknown_column");
    return out;
  };

  function actionsFor(viewer: Viewer): HostActions { return createHostActions(callFor(viewer)); }
  /** The wire call itself, for a request the screen's own client never sends (a crafted one). */
  function callFor(viewer: Viewer) {
    const who = viewer.role === "owner" ? "owner" : viewer.id;
    const isMember = viewer.role === "member";
    const owned = (table: string) => options(table).row_owner;
    /** The read_role gate every verb passes; a member passes it only on a `row_owner` table. */
    const gate = (table: string) => { if (isMember && options(table).read_role === "owner" && !owned(table)) throw fail(403, "owner_required"); };
    const mine = (table: string, r: Row) => !isMember || !owned(table) || r.profile[owned(table)!] === (viewer as { id: string }).id;
    const stamp = (table: string, profile: Record<string, any>) => {
      const col = owned(table)!;
      if (col in profile && profile[col] !== (viewer as { id: string }).id) throw fail(403, "row_owner_mismatch");
      return { ...profile, [col]: (viewer as { id: string }).id };
    };
    const hostId = () => `mem_${(++seq).toString(16).padStart(32, "0")}`;
    return async (_s: unknown, verb: string, rawArgs: unknown): Promise<unknown> => {
      const args = cleanArgs(verb, rawArgs as Record<string, unknown>) as Record<string, any>;
      const table: string = args.table ?? (verb === "records.batch" ? args.items?.[0]?.table ?? "employees" : "employees");
      const call: Call = { viewer: who, verb, table, args, status: 200 };
      calls.push(call);
      const hit = faults.find((f) => !f.done && f.verb === verb && (f.table === undefined || f.table === table) && (f.viewer === undefined || f.viewer === who));
      if (hit) hit.done = true;
      const run = (): unknown => {
        switch (verb) {
          case "records.list": {
            gate(table);
            let all = rows(table).filter((r) => mine(table, r) && (args.filters ?? []).every((f: any) => matches(r, f)));
            if (args.order_by) { const { field, direction } = args.order_by; all = [...all].sort((a, b) => (a.profile[field] < b.profile[field] ? -1 : a.profile[field] > b.profile[field] ? 1 : 0) * (direction === "desc" ? -1 : 1)); }
            const limit = args.limit ?? 25;
            const start = args.cursor ? all.findIndex((r) => r.id === args.cursor) + 1 : 0;
            const page = all.slice(start, start + limit);
            const more = start + limit < all.length;
            return { records: page.map(receipt), total: all.length, truncated: more, next_cursor: more ? page.at(-1)!.id : null };
          }
          case "records.show": {
            gate(table);
            const row = rows(table).find((r) => r.id === args.record_id && mine(table, r));
            if (!row) throw fail(404, "record_not_found");
            return { record: receipt(row) };
          }
          case "records.aggregate": {
            gate(table);
            const groups = new Map<string, { key: Record<string, any>; count: number; sums: Record<string, number> }>();
            for (const r of rows(table).filter((x) => mine(table, x) && (args.filters ?? []).every((f: any) => matches(x, f)))) {
              const key = Object.fromEntries((args.group_by ?? []).map((c: string) => [c, r.profile[c] ?? null]));
              const k = JSON.stringify(key);
              const g = groups.get(k) ?? { key, count: 0, sums: Object.fromEntries((args.sum ?? []).map((c: string) => [c, 0])) };
              g.count += 1; for (const c of args.sum ?? []) g.sums[c]! += r.profile[c];
              groups.set(k, g);
            }
            return { groups: [...groups.values()], truncated: false, group_limit: 1000 };
          }
          case "records.create": {
            const memberWrite = isMember && owned(table);
            if (memberWrite && args.record_id !== undefined) throw fail(400, "record_id_not_allowed");
            if (!memberWrite && typeof args.record_id !== "string") throw fail(400, "validation_failed");
            const profile = stored(table, memberWrite ? stamp(table, args.profile) : args.profile);
            gate(table);
            const id = memberWrite ? hostId() : args.record_id;
            if (rows(table).some((r) => r.id === id)) throw fail(409, "record_exists");
            rule(table, "create", null, profile);
            if (clash(table, profile, rows(table))) throw fail(409, "unique_violation");
            const row = { id, revision: 1, profile };
            rows(table).push(row);
            return { record: receipt(row) };
          }
          case "records.update": {
            if (isMember && owned(table)) throw fail(403, "owner_required");
            gate(table);
            const row = rows(table).find((r) => r.id === args.record_id);
            if (!row) throw fail(404, "record_not_found");
            if (options(table).append_only) throw fail(409, "append_only");
            if (row.revision !== args.expected_revision) throw fail(409, "revision_conflict");
            const after = { ...row.profile, ...args.profile };
            rule(table, "update", row.profile, after);
            row.profile = after; row.revision += 1;
            return { record: receipt(row) };
          }
          case "records.batch": {
            const items = args.items as { record_id?: string; table?: string; profile: Record<string, any> }[];
            const memberBatch = isMember && items.every((i) => owned(i.table ?? "employees"));
            if (memberBatch && items.some((i) => i.record_id !== undefined)) throw fail(400, "record_id_not_allowed");
            for (const t of new Set(items.map((i) => i.table ?? "employees"))) { rows(t); if (isMember && !memberBatch) throw fail(403, "owner_required"); gate(t); }
            const staged: { table: string; row: Row }[] = [];
            for (const item of items) {
              const t = item.table ?? "employees";
              const profile = stored(t, memberBatch ? stamp(t, item.profile) : item.profile);
              const id = memberBatch ? hostId() : item.record_id!;
              const mineStaged = staged.filter((s) => s.table === t).map((s) => s.row);
              if (rows(t).some((r) => r.id === id) || mineStaged.some((r) => r.id === id)) throw fail(409, "record_exists");
              rule(t, "create", null, profile);
              if (clash(t, profile, [...rows(t), ...mineStaged])) throw fail(409, "unique_violation");
              staged.push({ table: t, row: { id, revision: 1, profile } });
            }
            for (const s of staged) rows(s.table).push(s.row); // all or nothing
            return { rows: staged.length };
          }
          default: throw new Error(`unexpected ${verb}`);
        }
      };
      try {
        if (hit && !hit.after) throw hit.error;
        const result = run();
        if (hit?.after) throw hit.error;
        return result;
      } catch (error) {
        if (error instanceof ApiError) { call.status = error.status; if (error.status === 403 && !closed.has(who)) closed.set(who, `${verb} ${table}`); }
        throw error;
      }
    };
  }
  const add = (name: string, id: string, profile: Record<string, any>) => { rows(name).push({ id, revision: 1, profile: stored(name, profile) }); };
  const raw = (viewer: Viewer) => (verb: string, args: Record<string, unknown>) => callFor(viewer)(scope, verb, args);
  return { as: actionsFor, raw, tables, calls, closed, fault, add, of: (name: string) => rows(name) };
}
export const person = (no: string, over: Record<string, any> = {}) => ({ display_name: `Person ${no}`, employee_no: no, join_date: "2020-01-01", leave_date: null, status: "active", ...over });
