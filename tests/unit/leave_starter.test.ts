// The starter leave types: a generic, editable template written one row at a time, never a duplicate, never an entitlement.
// Run: bun test tests/unit/leave_starter.test.ts
import { expect, mock, test } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";
import { readFileSync } from "node:fs";

mock.module("@cadence/screen-ui", sdkMock);

const L = await import("../../src/domain/leave-starter.ts");
const { createHostActions } = await import("../../src/features/hr/hostActions.ts");
const S = await import("../../src/features/hr/recordsSubmit.ts");
const { zhHK } = await import("../../src/features/hr/localeCatalog.ts");

const scope = { installId: "install-test", digest: "sha256:" + "a".repeat(64) };
const COLUMNS = JSON.parse(readFileSync(new URL("../../app/storage/002-hr-records.json", import.meta.url), "utf8"))
  .operations.find((op: { op: string; table: string }) => op.op === "create_table" && op.table === "leave_types").columns as { name: string; nullable: boolean; max_length?: number; json_schema?: { pattern: string } }[];

/** An in-memory host for leave_types with its rules: one row per record id, and a unique index on `code`. */
function host({ failOnCreate = Infinity, uniqueStatus = 503, hideFromList = false } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: { verb: string; args: Record<string, any> }[] = [];
  let creates = 0;
  const actions = createHostActions(async (_s, verb, args) => {
    const a = args as Record<string, any>;
    calls.push({ verb, args: a });
    if (verb === "records.list") {
      const wanted: string[] = a.filters[0].value;
      const hit = hideFromList ? [] : [...rows].filter(([, p]) => wanted.includes(p.code as string));
      return { records: hit.map(([id, profile]) => ({ id, revision: 1, digest: "sha256:x", profile, history: [] })), total: hit.length, truncated: false, next_cursor: null };
    }
    if (verb === "records.create") {
      creates += 1;
      if (creates === failOnCreate) throw new ApiError("lost", 504);
      if (rows.has(a.record_id)) throw new ApiError("conflict", 409, { code: "conflict" });
      if ([...rows.values()].some((p) => p.code === a.profile.code)) throw new ApiError("store", uniqueStatus);
      rows.set(a.record_id, a.profile);
      return { record: { id: a.record_id, revision: 1, digest: "sha256:x", profile: a.profile, history: [] } };
    }
    throw new Error(`unexpected ${verb}`);
  });
  return { rows, calls, actions, creates: () => calls.filter((c) => c.verb === "records.create").length };
}
const codes = (rows: Map<string, Record<string, unknown>>) => [...rows.values()].map((p) => p.code).sort();

test("the template is four generic types with no entitlement figure, in the leave_types columns only", () => {
  expect(L.STARTER_LEAVE_TYPES.map((r) => [r.code, r.paid])).toEqual([["ANNUAL", true], ["SICK", true], ["UNPAID", false], ["COMP", true]]);
  const known = new Set(COLUMNS.map((c) => c.name));
  const accrual = COLUMNS.find((c) => c.name === "accrual_rule")!;
  expect(accrual.nullable).toBe(true);
  for (const item of L.starterItems("en")) {
    expect(Object.keys(item.profile).sort()).toEqual(["code", "name", "paid"]);
    for (const key of Object.keys(item.profile)) expect(known.has(key)).toBe(true);
    expect(item.profile).not.toHaveProperty("accrual_rule");
    expect(new RegExp(COLUMNS.find((c) => c.name === "code")!.json_schema!.pattern).test(item.profile.code)).toBe(true);
    expect(item.profile.name.length).toBeLessThanOrEqual(COLUMNS.find((c) => c.name === "name")!.max_length!);
    expect(JSON.stringify(item)).not.toMatch(/\d/);
    expect(item.record_id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  }
});

test("the locale chooses the stored name and nothing else", () => {
  const en = L.starterItems("en"), zh = L.starterItems("zh-TW");
  expect(zh.map((i) => i.profile.name)).toEqual(["年假", "病假", "無薪假", "補假"]);
  expect(zh.map((i) => ({ ...i, profile: { ...i.profile, name: "" } }))).toEqual(en.map((i) => ({ ...i, profile: { ...i.profile, name: "" } })));
});

test("a first load creates each type once, one write per row, in list order", async () => {
  const h = host();
  const progress: number[][] = [];
  const result = await S.addStarterLeaveTypes(scope, "en", (d, t) => progress.push([d, t]), h.actions);
  expect(result).toEqual({ created: 4, alreadyThere: 0 });
  expect(codes(h.rows)).toEqual(["ANNUAL", "COMP", "SICK", "UNPAID"]);
  expect(h.calls.filter((c) => c.verb === "records.create").map((c) => c.args.table)).toEqual(Array(4).fill("leave_types"));
  expect(progress.at(-1)).toEqual([4, 4]);
  expect(h.calls[0]!.args).toMatchObject({ table: "leave_types", filters: [{ field: "code", op: "in" }] });
});

test("a second load adds nothing and sends no create", async () => {
  const h = host();
  await S.addStarterLeaveTypes(scope, "en", undefined, h.actions);
  const before = h.creates();
  expect(await S.addStarterLeaveTypes(scope, "en", undefined, h.actions)).toEqual({ created: 0, alreadyThere: 4 });
  expect(h.creates()).toBe(before);
});

test("a load that stops part-way keeps its rows and the next run adds only the rest", async () => {
  const h = host({ failOnCreate: 3 });
  let done = 0;
  const error = await S.addStarterLeaveTypes(scope, "en", (d) => { done = d; }, h.actions).catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(done).toBe(2);
  expect(codes(h.rows)).toEqual(["ANNUAL", "SICK"]);
  expect(await S.addStarterLeaveTypes(scope, "en", undefined, h.actions)).toEqual({ created: 2, alreadyThere: 2 });
  expect(codes(h.rows)).toEqual(["ANNUAL", "COMP", "SICK", "UNPAID"]);
});

test("existing leave types are never touched: a stored code is skipped, even under another record id", async () => {
  const h = host();
  h.rows.set("lt-own-1", { code: "SICK", name: "Sick days (edited)", paid: false });
  expect(await S.addStarterLeaveTypes(scope, "en", undefined, h.actions)).toEqual({ created: 3, alreadyThere: 1 });
  expect(h.rows.get("lt-own-1")).toEqual({ code: "SICK", name: "Sick days (edited)", paid: false });
  expect(h.rows.size).toBe(4);
});

test("a stale listing cannot duplicate: the store's refusal counts as there only when a re-read proves the code", async () => {
  for (const uniqueStatus of [503, 409]) {
    const h = host({ uniqueStatus });
    h.rows.set("lt-own-1", { code: "ANNUAL", name: "Annual", paid: true });
    // The first read is blind, so the create is sent and refused; the proving re-read then sees the row.
    let reads = 0;
    const blind = { ...h.actions, list: (s: any, o: any) => (reads++ === 0 ? Promise.resolve({ records: [], total: 0, truncated: false, nextCursor: null }) : h.actions.list(s, o)) };
    const result = await S.addStarterLeaveTypes(scope, "en", undefined, blind as any);
    expect(result).toEqual({ created: 3, alreadyThere: 1 });
    expect(h.rows.size).toBe(4);
  }
});

test("a refusal with no stored row behind it is not called a duplicate: it stops the load", async () => {
  const h = host();
  const refused = { ...h.actions, create: () => Promise.reject(new ApiError("store", 503)) };
  await expect(S.addStarterLeaveTypes(scope, "en", undefined, refused as any)).rejects.toThrow();
});

test("a failed read of the stored codes stops the load before any write", async () => {
  const h = host();
  const broken = { ...h.actions, list: () => Promise.reject(new ApiError("down", 503)) };
  await expect(S.addStarterLeaveTypes(scope, "en", undefined, broken as any)).rejects.toThrow();
  expect(h.creates()).toBe(0);
});

test("only a cause the owner can act on is named", () => {
  expect(S.starterReason(new ApiError("x", 401))).toBe("Your session expired or the connection dropped — reload the page to sign in again.");
  expect(S.starterReason(new ApiError("x", 403))).toContain("workspace owner");
  expect(S.starterReason(new ApiError("x", 503))).toBeNull();
  expect(S.starterReason(new Error("x"))).toBeNull();
});

test("every new text has a zh-HK line", () => {
  const source = readFileSync(new URL("../../src/features/hr/StarterLeaveTypes.tsx", import.meta.url), "utf8") + readFileSync(new URL("../../src/features/hr/RecordsPane.tsx", import.meta.url), "utf8");
  const wanted = ["No leave types yet", "Add common leave types", "The common leave types are ready. Edit them to match your own policy.", "Adding leave types… {done} of {total}",
    "Only {done} of {total} common leave types are in place.", "The common leave types were not added.",
    "Choose Add common leave types again to add the rest. Leave types already added are kept and are not added twice.",
    "Leave requests need a leave type. You can add a small starter set — annual, sick, unpaid and time off in lieu — and then edit or add to it to match your own policy.",
    "The starter set is a generic template, not legal advice. It holds no entitlement figures. A code cannot be changed once saved."];
  for (const text of wanted) { expect(source).toContain(text); expect(zhHK[text]).toBeTruthy(); }
  for (const key of ["{done}", "{total}"]) for (const text of wanted.filter((w) => w.includes(key))) expect(zhHK[text]).toContain(key);
});
