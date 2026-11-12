// The read calls a record tab sends, as pure functions so a test can prove every tab names its table.
// Without `table` the host reads the default table (employees), so a missing one would show the wrong records.
import type { CallArgs, RecordFilter } from "../../bridge/services";

/** The part of a tab's view the read calls depend on. */
export interface QueryView { spec: { table: string }; filter?: { field: string }; filters?: RecordFilter[] }
export interface ListState { status: string; query: string; cursor?: string; limit: number }

/** One page of a tab's list: its table, its fixed filters, the chosen status (unless "all"), newest first. */
export function listArgs(view: QueryView, state: ListState): CallArgs["records.list"] {
  const filters: RecordFilter[] = [...(view.filters ?? []), ...(view.filter && state.status !== "all" ? [{ field: view.filter.field, op: "eq" as const, value: state.status }] : [])];
  return {
    table: view.spec.table, query: state.query || undefined, limit: state.limit, cursor: state.cursor,
    filters: filters.length ? filters : undefined, order_by: { field: "created_at", direction: "desc" },
  };
}
/** One record of a tab, read from the tab's own table. */
export const showArgs = (view: QueryView, recordId: string): CallArgs["records.show"] => ({ table: view.spec.table, record_id: recordId });
