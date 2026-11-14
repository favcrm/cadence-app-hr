import { ApiError } from "@cadence/screen-ui";
import { serviceCall, type RecordFilter } from "../../bridge/services";

/** The installation and record ids come from the verified scope or the host's own rows, never from a form field. */
export interface HostScope { installId: string; digest: string }
export interface HostRecord { id: string; revision: number; digest: string; profile: unknown; history: unknown }
export interface ListReceipt { records: HostRecord[]; total: number | null; truncated: boolean; nextCursor: string | null }

export const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const invalid = () => new ApiError("The server returned an invalid record receipt", 502);

export function parseRecord(value: unknown): HostRecord {
  const row = (value as { record?: unknown } | null)?.record as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !RECORD_ID.test(row.id) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || typeof row.digest !== "string") throw invalid();
  return { id: row.id, revision: row.revision as number, digest: row.digest, profile: row.profile, history: row.history };
}
export function parseRecordList(value: unknown): ListReceipt {
  const page = value as { records?: unknown; total?: unknown; truncated?: unknown; next_cursor?: unknown } | null;
  if (!Array.isArray(page?.records)) throw invalid();
  const total = typeof page.total === "number" && Number.isSafeInteger(page.total) && page.total >= page.records.length ? page.total : null;
  return {
    records: page.records.map((row) => parseRecord({ record: row })), total, truncated: page.truncated === true,
    nextCursor: typeof page.next_cursor === "string" && RECORD_ID.test(page.next_cursor) ? page.next_cursor : null,
  };
}

/** One aggregate group: the host's grouped count and integer sums. `key` holds only the columns grouped by. */
export interface AggregateGroup { key: Record<string, string | number | boolean | null>; count: number; sums: Record<string, number> }
export interface AggregateReceipt { groups: AggregateGroup[]; truncated: boolean; groupLimit: number | null }

/** The host's `records.aggregate` answer, read strictly: a malformed group or sum is an invalid receipt, never a zero. */
export function parseAggregate(value: unknown): AggregateReceipt {
  const body = value as { groups?: unknown; truncated?: unknown; group_limit?: unknown } | null;
  if (!body || typeof body !== "object" || !Array.isArray(body.groups) || typeof body.truncated !== "boolean") throw invalid();
  const groups = body.groups.map((row): AggregateGroup => {
    const g = row as { key?: unknown; count?: unknown; sums?: unknown } | null;
    if (!g || typeof g !== "object" || !g.key || typeof g.key !== "object" || Array.isArray(g.key) || !Number.isSafeInteger(g.count) || (g.count as number) < 0
      || !g.sums || typeof g.sums !== "object" || Array.isArray(g.sums)) throw invalid();
    for (const v of Object.values(g.key)) if (v !== null && !["string", "number", "boolean"].includes(typeof v)) throw invalid();
    for (const v of Object.values(g.sums)) if (!Number.isSafeInteger(v)) throw invalid();
    return { key: g.key as AggregateGroup["key"], count: g.count as number, sums: g.sums as Record<string, number> };
  });
  return { groups, truncated: body.truncated, groupLimit: Number.isSafeInteger(body.group_limit) ? (body.group_limit as number) : null };
}

export interface AggregateOptions { table?: string; group_by?: string[]; sum?: string[]; filters?: RecordFilter[]; query?: string }
export interface BatchItem { record_id: string; table?: string; profile: unknown }
export interface ListOptions { table?: string; query?: string; limit?: number; cursor?: string; filters?: RecordFilter[]; order_by?: { field: string; direction?: "asc" | "desc" } }
/** The one function the host client needs: send a records verb for a scope. Tests pass a fake. */
export type CallFn = (scope: HostScope, verb: "records.list" | "records.show" | "records.create" | "records.update" | "records.batch" | "records.aggregate", args: never) => Promise<unknown>;
export type HostActions = ReturnType<typeof createHostActions>;

export function createHostActions(call: CallFn) {
  const send = (scope: HostScope, verb: Parameters<CallFn>[1], args: Record<string, unknown>) => call(scope, verb, args as never);
  return {
    /** Counts and integer sums over a table; the answer says when the host cut it at its group limit. */
    async aggregate(scope: HostScope, opts: AggregateOptions): Promise<AggregateReceipt> {
      return parseAggregate(await send(scope, "records.aggregate", { ...opts }));
    },
    /** Create 1 to 200 rows in one transaction: all of them or none. A resolved call means every item was written. */
    async batch(scope: HostScope, items: BatchItem[]): Promise<void> {
      if (items.length < 1 || items.length > 200 || items.some((item) => !RECORD_ID.test(item.record_id))) throw new ApiError("The batch is out of bounds", 400);
      await send(scope, "records.batch", { items });
    },
    async list(scope: HostScope, opts: ListOptions = {}): Promise<ListReceipt> {
      if (opts.query !== undefined && (opts.query.length === 0 || opts.query.length > 120 || /[\u0000-\u001f\u007f]/.test(opts.query))) throw new ApiError("The search text is out of bounds", 400);
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) throw new ApiError("The page size is out of bounds", 400);
      if (opts.cursor !== undefined && !RECORD_ID.test(opts.cursor)) throw new ApiError("The page cursor is invalid", 400);
      return parseRecordList(await send(scope, "records.list", { ...opts }));
    },
    async show(scope: HostScope, recordId: string, table?: string): Promise<HostRecord> {
      if (!RECORD_ID.test(recordId)) throw new ApiError("The record id is invalid", 400);
      return parseRecord(await send(scope, "records.show", { record_id: recordId, ...(table ? { table } : {}) }));
    },
    async create(scope: HostScope, recordId: string, profile: unknown, table?: string): Promise<HostRecord> {
      if (!RECORD_ID.test(recordId)) throw new ApiError("The record id is invalid", 400);
      return parseRecord(await send(scope, "records.create", { record_id: recordId, profile, ...(table ? { table } : {}) }));
    },
    async update(scope: HostScope, recordId: string, expectedRevision: number, profile: unknown, table?: string): Promise<HostRecord> {
      if (!RECORD_ID.test(recordId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new ApiError("The record id or revision is invalid", 400);
      return parseRecord(await send(scope, "records.update", { record_id: recordId, expected_revision: expectedRevision, profile, ...(table ? { table } : {}) }));
    },
  };
}
export const hostActions = createHostActions((scope, verb, args) => serviceCall(scope, verb, args));
