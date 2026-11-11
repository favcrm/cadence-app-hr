import { ApiError } from "@cadence/screen-ui";
import { serviceCall } from "../../bridge/services";

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

export const hostActions = {
  async list(scope: HostScope, opts: { query?: string; limit?: number; cursor?: string } = {}): Promise<ListReceipt> {
    if (opts.query !== undefined && (opts.query.length === 0 || opts.query.length > 120 || /[\u0000-\u001f\u007f]/.test(opts.query))) throw new ApiError("The search text is out of bounds", 400);
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) throw new ApiError("The page size is out of bounds", 400);
    if (opts.cursor !== undefined && !RECORD_ID.test(opts.cursor)) throw new ApiError("The page cursor is invalid", 400);
    return parseRecordList(await serviceCall(scope, "records.list", { ...opts }));
  },
  async create(scope: HostScope, recordId: string, profile: unknown): Promise<HostRecord> {
    if (!RECORD_ID.test(recordId)) throw new ApiError("The record id is invalid", 400);
    return parseRecord(await serviceCall(scope, "records.create", { record_id: recordId, profile }));
  },
  async update(scope: HostScope, recordId: string, expectedRevision: number, profile: unknown): Promise<HostRecord> {
    if (!RECORD_ID.test(recordId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new ApiError("The record id or revision is invalid", 400);
    return parseRecord(await serviceCall(scope, "records.update", { record_id: recordId, expected_revision: expectedRevision, profile }));
  },
};
