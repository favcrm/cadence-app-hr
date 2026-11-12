import { ApiError } from "@cadence/screen-ui";
import { channel } from "./channel";
import { assertCurrentScope, requireOperation, type DisplayScope } from "./scope";

type Bag = Record<string, unknown>;
export interface CallArgs {
  "records.list": { query?: string; limit?: number; cursor?: string; filters?: { field: string; op: "eq"; value: string }[] };
  "records.show": { record_id: string };
  "records.create": { record_id: string; profile: unknown };
  "records.update": { record_id: string; expected_revision: number; profile: unknown };
  "screen.route.patch": { section?: "people"; view?: "list" | "new"; record_id?: string | null; segment_id?: string | null; replace?: boolean };
}
// A closed field allowlist is checked again at runtime before serialization.
export const CALL_FIELDS: Record<keyof CallArgs, readonly string[]> = {
  "records.list": ["query", "limit", "cursor", "filters"], "records.show": ["record_id"],
  "records.create": ["record_id", "profile"], "records.update": ["record_id", "expected_revision", "profile"],
  "screen.route.patch": ["section", "view", "record_id", "segment_id", "replace"],
};
export const OPERATIONS: string[] = Object.keys(CALL_FIELDS);
export function cleanArgs(verb: string, args: Bag): Bag {
  const fields = CALL_FIELDS[verb as keyof CallArgs] as readonly string[] | undefined;
  if (!fields || !args || typeof args !== "object" || Array.isArray(args)) throw new ApiError("Unlisted HR operation", 400);
  for (const key of Object.keys(args)) if (!fields.includes(key)) throw new ApiError(`Refused HR field: ${key}`, 400);
  const value = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  const cap = ["records.create", "records.update"].includes(verb) ? 49152 : 16384;
  if (new TextEncoder().encode(JSON.stringify(value)).length > cap) throw new ApiError("The HR request exceeds its operation budget", 413);
  return value;
}
const writeListeners = new Set<() => void>();
export const onWrite = (f: () => void) => { writeListeners.add(f); return () => { writeListeners.delete(f); }; };
const written = () => writeListeners.forEach(f => f());
export async function serviceCall<T = unknown, K extends keyof CallArgs = keyof CallArgs>(scope: DisplayScope, verb: K, args: CallArgs[K]): Promise<T> {
  assertCurrentScope(scope); requireOperation(verb);
  const result = await channel.request(verb, cleanArgs(verb, args as Bag)) as T;
  if (verb === "records.create" || verb === "records.update") written();
  return result;
}
