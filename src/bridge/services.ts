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
  "screen.route.patch": { section?: Section; view?: "list" | "new"; record_id?: string | null; segment_id?: string | null; replace?: boolean };
}
// A closed field allowlist is checked again at runtime before serialization.
export const CALL_FIELDS: Record<keyof CallArgs, readonly string[]> = {
  "records.list": ["table", "query", "limit", "cursor", "filters", "order_by"], "records.show": ["table", "record_id"],
  "records.create": ["table", "record_id", "profile"], "records.update": ["table", "record_id", "expected_revision", "profile"],
  "screen.route.patch": ["section", "view", "record_id", "segment_id", "replace"],
};
export const OPERATIONS: string[] = Object.keys(CALL_FIELDS);
export function cleanArgs(verb: string, args: Bag): Bag {
  const fields = CALL_FIELDS[verb as keyof CallArgs] as readonly string[] | undefined;
  if (!fields || !args || typeof args !== "object" || Array.isArray(args)) throw new ApiError("Unlisted HR operation", 400);
  for (const key of Object.keys(args)) if (!fields.includes(key)) throw new ApiError(`Refused HR field: ${key}`, 400);
  const value = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  // The host accepts 128 KiB of arguments; a policy body is the largest write (12,000 characters, up to 36 KB).
  const cap = ["records.create", "records.update"].includes(verb) ? 98304 : 16384;
  if (new TextEncoder().encode(JSON.stringify(value)).length > cap) throw new ApiError("The HR request exceeds its operation budget", 413);
  return value;
}
export const WRITE_VERBS: readonly string[] = ["records.create", "records.update"];
export const onWrite = (f: () => void) => channel.bridge.onWrite(f);
export async function serviceCall<T = unknown, K extends keyof CallArgs = keyof CallArgs>(scope: DisplayScope, verb: K, args: CallArgs[K]): Promise<T> {
  assertCurrentScope(scope); requireOperation(verb);
  return channel.call<T>(scope, verb, cleanArgs(verb, args as Bag));
}
