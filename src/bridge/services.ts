import { ApiError } from "@cadence/screen-ui";
import { channel } from "./channel";
import { assertCurrentScope, requireOperation, type DisplayScope } from "./scope";

type Bag = Record<string, unknown>;
export const SECTIONS = ["people", "policies", "leave", "claims", "recruiting"] as const;
export type Section = (typeof SECTIONS)[number];
export interface RecordFilter { field: string; op: "eq" | "in" | "prefix" | "contains" | "gte" | "lte"; value: string | number | boolean | (string | number | boolean)[] }
export interface CallArgs {
  "records.list": { table?: string; query?: string; limit?: number; cursor?: string; filters?: RecordFilter[]; order_by?: { field: string; direction?: "asc" | "desc" } };
  "records.show": { table?: string; record_id: string };
  "records.create": { table?: string; record_id: string; profile: unknown };
  "records.update": { table?: string; record_id: string; expected_revision: number; profile: unknown };
  /** 1 to 200 creates in one all-or-nothing transaction; a duplicate unique key refuses the whole batch. */
  "records.batch": { items: { record_id: string; table?: string; profile: unknown }[] };
  /** Count and integer sums over a declared table, grouped by at most two columns (at most 1,000 groups; `truncated` says when cut). */
  "records.aggregate": { table?: string; group_by?: string[]; sum?: string[]; filters?: RecordFilter[]; query?: string };
  "screen.route.patch": { section?: Section; view?: "list" | "new"; record_id?: string | null; segment_id?: string | null; replace?: boolean };
}
// A closed field allowlist is checked again at runtime before serialization.
export const CALL_FIELDS: Record<keyof CallArgs, readonly string[]> = {
  "records.list": ["table", "query", "limit", "cursor", "filters", "order_by"], "records.show": ["table", "record_id"],
  "records.create": ["table", "record_id", "profile"], "records.update": ["table", "record_id", "expected_revision", "profile"],
  "records.batch": ["items"], "records.aggregate": ["table", "group_by", "sum", "filters", "query"],
  "screen.route.patch": ["section", "view", "record_id", "segment_id", "replace"],
};
export const OPERATIONS: string[] = Object.keys(CALL_FIELDS);
// The board shell's records-frame argument limits. It closes the frame on a larger message, so the screen refuses
// first. A write carries a policy body or a CV of 12,000 characters (about 36 KB in written Chinese).
/** Largest `records.create` / `records.update` / `records.batch` arguments, in bytes of JSON; the bridge holds each write to it. */
export const WRITE_BUDGET = 49152;
/** Largest arguments of every other operation, in bytes of JSON: app-kit's default, which the bridge keeps. */
export const REQUEST_BUDGET = 16384;
/** The record writes: they get the write budget, and a successful one invalidates cached reads. `records.aggregate` is a read. */
export const WRITE_VERBS: readonly string[] = ["records.create", "records.update", "records.batch"];
export const isWrite = (verb: string): boolean => WRITE_VERBS.includes(verb);
export const requestBudget = (verb: string): number => (isWrite(verb) ? WRITE_BUDGET : REQUEST_BUDGET);
/** The code of a request the screen refused for its size (the screen words it as "too long"); nothing was sent. */
const TOO_LARGE = "too_large";
export function cleanArgs(verb: string, args: Bag): Bag {
  const fields = CALL_FIELDS[verb as keyof CallArgs] as readonly string[] | undefined;
  if (!fields || !args || typeof args !== "object" || Array.isArray(args)) throw new ApiError("Unlisted HR operation", 400);
  for (const key of Object.keys(args)) if (!fields.includes(key)) throw new ApiError(`Refused HR field: ${key}`, 400);
  const value = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  if (new TextEncoder().encode(JSON.stringify(value)).length > requestBudget(verb)) {
    throw new ApiError("The HR request exceeds its operation budget", 413, { code: TOO_LARGE });
  }
  return value;
}
/** Called after every successful record write (the bridge's `writeVerbs`). */
export const onWrite = (f: () => void): (() => void) => channel.bridge.onWrite(f);
export async function serviceCall<T = unknown, K extends keyof CallArgs = keyof CallArgs>(scope: DisplayScope, verb: K, args: CallArgs[K]): Promise<T> {
  assertCurrentScope(scope); requireOperation(verb);
  return channel.call<T>(scope, verb, cleanArgs(verb, args as Bag));
}
