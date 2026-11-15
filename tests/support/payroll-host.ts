// An in-memory host for the payroll tests, built from the app's own storage declaration: every table the
// migrations create, its unique indexes, `append_only`, and each table's `write_schema` run through the local schema
// evaluator, with an atomic multi-table `records.batch`. Plus `journal`, a stand-in for the Accounting app's journal
// (unique `entry_ref`, lines that must balance, append-only), for the posting tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError } from "./sdk-mock.mjs";
import { valid } from "./mini-schema.mjs";
import { createHostActions } from "../../src/features/hr/hostActions.ts";
import { cleanArgs } from "../../src/bridge/services.ts";

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8"));
const descriptor = read("app/app-storage.json");
const operations = descriptor.migrations.flatMap((m: { path: string }) => read(`app/${m.path}`).operations);
const TABLES: string[] = operations.filter((o: { op: string }) => o.op === "create_table").map((o: { table: string }) => o.table);
const UNIQUES: Record<string, string[][]> = {};
for (const o of operations) if (o.op === "create_index" && o.unique) (UNIQUES[o.table] ??= []).push(o.columns);

export interface Row { id: string; revision: number; profile: Record<string, any> }
export const scope = { installId: "install-test", digest: "sha256:" + "a".repeat(64) };

export function makePayrollHost(opts: { uniqueStatus?: number } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]]));
  const calls: { verb: string; args: Record<string, any> }[] = [];
  const faults: { verb: string; error: ApiError; after: boolean; table?: string; done: boolean }[] = [];
  const fault = (verb: string, error: ApiError, { after = false, table }: { after?: boolean; table?: string } = {}) => { faults.push({ verb, error, after, table, done: false }); };
  const rows = (name: string) => tables[name] ?? (() => { throw new ApiError("not declared", 403); })();
  const refuse = () => new ApiError("refused", 400, { code: "failed" });
  const rule = (table: string, operation: string, before: Record<string, any> | null, after: Record<string, any>) => {
    const options = descriptor.tables[table] ?? {};
    if (operation === "update" && options.append_only) throw refuse();
    if (options.write_schema && !valid(options.write_schema, { operation, before, after, provenance: null })) throw refuse();
  };
  const clash = (table: string, profile: Record<string, any>, others: Row[]) => (UNIQUES[table] ?? []).some((cols) => others.some((r) => cols.every((c) => r.profile[c] === profile[c])));
  const receipt = (r: Row) => ({ id: r.id, revision: r.revision, digest: "sha256:" + r.id, profile: r.profile, history: [] });
  const matches = (row: Row, f: { field: string; op: string; value: unknown }) => (f.op === "in" ? (f.value as unknown[]).includes(row.profile[f.field]) : row.profile[f.field] === f.value);
  const uniqueError = () => new ApiError("unique_violation", opts.uniqueStatus ?? 409, { code: "conflict" });

  const actions = createHostActions(async (_s, verb, rawArgs) => {
    const args = cleanArgs(verb, rawArgs as Record<string, unknown>) as Record<string, any>;
    calls.push({ verb, args });
    const table: string = args.table ?? "employees";
    const hit = faults.find((f) => !f.done && f.verb === verb && (f.table === undefined || f.table === table));
    if (hit) hit.done = true;
    const run = (): unknown => {
      switch (verb) {
        case "records.list": {
          const all = rows(table).filter((r) => (args.filters ?? []).every((f: any) => matches(r, f)));
          const limit = args.limit ?? 25;
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
          rule(table, "create", null, args.profile);
          if (clash(table, args.profile, rows(table))) throw uniqueError();
          const row = { id: args.record_id, revision: 1, profile: { ...args.profile } };
          rows(table).push(row);
          return { record: receipt(row) };
        }
        case "records.update": {
          const row = rows(table).find((r) => r.id === args.record_id);
          if (!row) throw new ApiError("gone", 404, { code: "not_found" });
          if (row.revision !== args.expected_revision) throw new ApiError("stale", 409, { code: "conflict" });
          const after = { ...row.profile, ...args.profile };
          rule(table, "update", row.profile, after);
          row.profile = after; row.revision += 1;
          return { record: receipt(row) };
        }
        case "records.batch": {
          const staged: { table: string; row: Row }[] = [];
          for (const item of args.items as { record_id: string; table?: string; profile: Record<string, any> }[]) {
            const t = item.table ?? "employees";
            rule(t, "create", null, item.profile);
            const mine = staged.filter((s) => s.table === t).map((s) => s.row);
            if (rows(t).some((r) => r.id === item.record_id) || mine.some((r) => r.id === item.record_id)) throw new ApiError("conflict", 409, { code: "conflict" });
            if (clash(t, item.profile, [...rows(t), ...mine])) throw uniqueError();
            staged.push({ table: t, row: { id: item.record_id, revision: 1, profile: { ...item.profile } } });
          }
          for (const s of staged) rows(s.table).push(s.row); // all or nothing
          return { rows: staged.length };
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

/**
 * The Accounting journal as its 0.3.0 contract describes it: one batch is one entry, a stored `entry_ref` refuses a
 * second batch, lines must sum to zero per reference, and nothing is updated. `find` is the exact `eq` lookup.
 */
export function makeJournal() {
  const entries: Record<string, any>[] = [];
  const lines: Record<string, any>[] = [];
  return {
    entries, lines,
    find: (ref: string) => entries.filter((e) => e.entry_ref === ref),
    batch(items: { table?: string; record_id: string; profile: Record<string, any> }[]) {
      if (items.some((i) => i.table !== "journal_entries" && i.table !== "journal_lines")) throw new ApiError("refused", 400, { code: "failed" });
      const newEntries = items.filter((i) => i.table === "journal_entries").map((i) => i.profile);
      const newLines = items.filter((i) => i.table === "journal_lines").map((i) => i.profile);
      for (const e of newEntries) if (entries.some((x) => x.entry_ref === e.entry_ref) || newEntries.filter((x) => x.entry_ref === e.entry_ref).length > 1) throw new ApiError("unique_violation", 409, { code: "conflict" });
      const sums = new Map<string, number>();
      for (const l of newLines) sums.set(l.entry_ref, (sums.get(l.entry_ref) ?? 0) + l.base_minor);
      if ([...sums.values()].some((s) => s !== 0)) throw new ApiError("unbalanced", 400, { code: "failed" });
      entries.push(...newEntries); lines.push(...newLines);
    },
  };
}

export const person = (no: string, over: Record<string, any> = {}) => ({ display_name: `Person ${no}`, employee_no: no, join_date: "2020-01-01", leave_date: null, status: "active", ...over });
