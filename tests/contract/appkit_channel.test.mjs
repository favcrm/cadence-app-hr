// Contract tests for the HR channel over the vendored app-kit bridge (`createScreenBridge`). The synthetic host
// here speaks the real records wire: ready, PUSH, call replies and the leave hint.
// Run: bun test tests/contract/appkit_channel.test.mjs

import { test, expect, mock } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);

const { createChannel, channel: screen } = await import("../../src/bridge/channel.ts");
const { clearScope, getScope } = await import("../../src/bridge/scope.ts");
const { markUnsaved } = await import("../../src/bridge/leave.ts");

const ACCEPTS = ["screen.v2", "screen-records.v1", "screen-locale.v1"];

const DIGEST = "sha256:" + "a".repeat(64);
const bootFor = (tag) => ({ tag, bridge_nonce: "b".repeat(64), generation: 1, parent_origin: "https://board.example" });

const push = (extra = {}) => ({
  v: 2,
  op: "screen",
  install_id: "install-test",
  digest: DIGEST,
  tag: "hr",
  installation: { install_id: "install-test", name: "hr", title: "HR", version: "0.1.0", digest: DIGEST, summary: "s" },
  contexts: [],
  runs: [],
  outbox: [],
  publish_intents: [],
  sources: [],
  defaults: [],
  readiness: [],
  actions: ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"],
  now: "2026-11-05T00:00:00Z",
  resume: null,
  route: { section: "people", view: "list", record_id: null, segment_id: null },
  read_observations: [],
  presentation_locale: "en",
  ...extra,
});

const waitFor = async (find, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = find();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

function installEnvironment(boot) {
  let host;
  const events = [];
  const parent = {
    postMessage(message, _origin, transfer) {
      if (message.op !== "init") return;
      host = transfer?.[0];
      host.onmessage = (event) => events.push(event.data);
      host.start?.();
    },
  };
  globalThis.window = { parent, addEventListener() {} };
  globalThis.parent = parent;
  globalThis.document = {
    getElementById: (id) => (id === "cadence-screen-boot" ? { textContent: JSON.stringify(boot) } : null),
  };
  return { events, host: () => host };
}

async function mount(pushExtra = {}, channel = createChannel()) {
  clearScope("test reset");
  const env = installEnvironment(bootFor("hr"));
  channel.start();
  const ready = await waitFor(() => env.events.find((event) => event.op === "ready"), "ready");
  expect(ready).toEqual({ v: 1, op: "ready", accepts: ACCEPTS });
  env.host().postMessage(push(pushExtra));
  await waitFor(() => getScope()?.scope.installId === "install-test", "PUSH scope");
  return { channel, ...env };
}

/** Mount the module's own channel: every screen call (`serviceCall`) and the leave hint go through it. */
function mountScreen(pushExtra = {}) {
  clearScope("test reset");
  screen.bridge.reset();
  return mount(pushExtra, screen);
}

const retire = (channel) => channel.retire(new ApiError("test cleanup", 403));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const calls = (events) => events.filter((event) => event.op === "call");

test("the ready message declares screen-locale.v1, never crm-locale.v1, and a locale push is applied", async () => {
  const { channel, events, host } = await mount({ presentation_locale: "zh-TW" });
  try {
    const ready = events.find((event) => event.op === "ready");
    expect(ready.accepts).toContain("screen-locale.v1");
    expect(ready.accepts).not.toContain("crm-locale.v1");
    expect(getScope().presentationLocale).toBe("zh-TW");
    // The host changes the language on a later push; the same mount follows it.
    host().postMessage(push({ presentation_locale: "en" }));
    await waitFor(() => getScope()?.presentationLocale === "en", "en push");
    host().postMessage(push({ presentation_locale: "zh-TW" }));
    await waitFor(() => getScope()?.presentationLocale === "zh-TW", "zh-TW push");
    // A push without a locale reads as English.
    const { presentation_locale: _, ...plain } = push();
    host().postMessage(plain);
    await waitFor(() => getScope()?.presentationLocale === "en", "push without a locale");
    expect(calls(events)).toEqual([]);
  } finally {
    retire(channel);
  }
});

test("the leave hint tells the board while any form holds unsaved edits, and nothing before the scope is verified", async () => {
  clearScope("test reset");
  screen.bridge.reset();
  const env = installEnvironment(bootFor("hr"));
  screen.start();
  await waitFor(() => env.events.find((event) => event.op === "ready"), "ready");
  const leaves = () => env.events.filter((event) => event.op === "leave");
  const first = Symbol("employee form"), second = Symbol("record form");
  try {
    // Before the first verified push there is no scope: an edit sends nothing.
    markUnsaved(first, true);
    await settle();
    expect(leaves()).toEqual([]);
    markUnsaved(first, false);
    env.host().postMessage(push());
    await waitFor(() => getScope()?.scope.installId === "install-test", "PUSH scope");
    // A clean form opening sends nothing either.
    markUnsaved(first, false);
    await settle();
    expect(leaves()).toEqual([]);
    // An edit: exactly the generic leave message, with no other key.
    markUnsaved(first, true);
    await waitFor(() => leaves().length === 1, "unsaved: true");
    expect(leaves()).toEqual([{ v: 2, op: "leave", unsaved: true }]);
    // A second edited form, then the first saved: some form still holds an edit.
    markUnsaved(second, true);
    markUnsaved(first, false);
    await settle();
    expect(leaves()).toEqual([{ v: 2, op: "leave", unsaved: true }]);
    // The last edited form closes: the board may navigate freely.
    markUnsaved(second, false);
    await waitFor(() => leaves().length === 2, "unsaved: false");
    expect(leaves()[1]).toEqual({ v: 2, op: "leave", unsaved: false });
    expect(calls(env.events)).toEqual([]);
  } finally {
    markUnsaved(first, false);
    markUnsaved(second, false);
    retire(screen);
  }
  // A retired mount sends nothing more.
  markUnsaved(first, true);
  await settle();
  expect(leaves().length).toBe(2);
  markUnsaved(first, false);
});

test("mounts with records capabilities and completes a call", async () => {
  const { channel, events, host } = await mount();
  try {
    const pending = channel.request("records.list", {});
    const request = await waitFor(() => events.find((event) => event.op === "call"), "call");
    expect(request.verb).toBe("records.list");
    host().postMessage({ v: 2, op: "reply", id: request.id, ok: true, data: { records: [] } });
    await expect(pending).resolves.toEqual({ records: [] });
  } finally {
    retire(channel);
  }
});

test("a conflict refusal, the code the board sends for a stale revision, maps to 409", async () => {
  const { channel, events, host } = await mount();
  try {
    const pending = channel.request("records.update", { record_id: "emp-1", expected_revision: 1, profile: {} });
    const request = await waitFor(() => events.find((event) => event.op === "call"), "call");
    host().postMessage({ v: 2, op: "reply", id: request.id, ok: false, refusal: { code: "conflict", text: "That changed. Refresh before trying again." } });
    await expect(pending).rejects.toMatchObject({ status: 409, code: "conflict" });
  } finally {
    retire(channel);
  }
});

test("an authorization refusal retires the mount and clears scope", async () => {
  const { channel, events, host } = await mount();
  try {
    const pending = channel.request("records.list", {});
    const request = await waitFor(() => events.find((event) => event.op === "call"), "call");
    host().postMessage({ v: 2, op: "reply", id: request.id, ok: false, refusal: { code: "unauthorized", text: "expired" } });
    await expect(pending).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(getScope()).toBeNull();
    await expect(channel.request("records.list", {})).rejects.toMatchObject({ status: 503 });
  } finally {
    retire(channel);
  }
});

test("a forbidden refusal on a records call retires the mount and clears scope, as the board does", async () => {
  const { channel, events, host } = await mount();
  try {
    const pending = channel.request("records.list", { table: "claims" });
    const request = await waitFor(() => events.find((event) => event.op === "call"), "call");
    host().postMessage({ v: 2, op: "reply", id: request.id, ok: false, refusal: { code: "forbidden", text: "not for this member" } });
    await expect(pending).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(getScope()).toBeNull();
    await expect(channel.request("records.list", {})).rejects.toMatchObject({ status: 503 });
  } finally {
    retire(channel);
  }
});

test("a forbidden refusal on a record write retires the session too: the board closes the frame on it", async () => {
  const { channel, events, host } = await mount();
  try {
    const pending = channel.request("records.update", { table: "claims", record_id: "clm-1", expected_revision: 1, profile: { status: "approved" } });
    const request = await waitFor(() => events.find((event) => event.op === "call"), "call");
    host().postMessage({ v: 2, op: "reply", id: request.id, ok: false, refusal: { code: "forbidden", text: "not for this member" } });
    await expect(pending).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(getScope()).toBeNull();
    await expect(channel.request("records.list", {})).rejects.toMatchObject({ status: 503 });
  } finally {
    retire(channel);
  }
});

test("caps in-flight requests at eight, and a write refused as busy is not called a conflict", async () => {
  const { classify } = await import("../../src/domain/records.ts");
  const { classifyWriteFailure } = await import("../../src/domain/people.ts");
  const { channel, events } = await mount();
  const pending = [];
  try {
    for (let index = 0; index < 8; index += 1) pending.push(channel.request("records.list", {}));
    await expect(channel.request("records.list", {})).rejects.toMatchObject({ status: 429 });
    // The bridge's busy refusal carries code `conflict`; nothing was sent, so it is neither "changed" nor "maybe saved".
    const busy = await channel.request("records.update", { record_id: "emp-1", expected_revision: 1, profile: {} }).catch((e) => e);
    expect(busy).toMatchObject({ status: 429, code: "conflict" });
    expect(classify(busy, "update")).toBe("neutral");
    expect(classify(busy, "create")).toBe("neutral");
    expect(classifyWriteFailure(busy, "update")).toBe("neutral");
    expect(calls(events).length).toBe(8);
  } finally {
    retire(channel);
    await Promise.allSettled(pending);
  }
});

test("secret fields in a reply refuse and retire the mount", async () => {
  const { channel, events, host } = await mount();
  try {
    const pending = channel.request("records.list", {});
    const request = await waitFor(() => events.find((event) => event.op === "call"), "call");
    host().postMessage({ v: 2, op: "reply", id: request.id, ok: true, data: { confirmation_token: "nope" } });
    await expect(pending).rejects.toMatchObject({ status: 502 });
    expect(getScope()).toBeNull();
  } finally {
    retire(channel);
  }
});

test("a verb outside the closed set, or one the host did not advertise, never reaches the host", async () => {
  const { channel, events } = await mount({ actions: ["records.list", "records.show"] });
  try {
    const { serviceCall } = await import("../../src/bridge/services.ts");
    const scope = getScope().scope;
    await expect(serviceCall(scope, "records.create", { record_id: "emp-1", profile: {} })).rejects.toMatchObject({ status: 403 });
    await expect(serviceCall(scope, "records.delete", {})).rejects.toMatchObject({ status: 403 });
    expect(events.filter((event) => event.op === "call")).toEqual([]);
  } finally {
    retire(channel);
  }
});

test("a push for another app, or with an unknown locale or a malformed route, is refused", async () => {
  clearScope("test reset");
  const refusals = [
    { tag: "crm" },
    { presentation_locale: "zh-HK" },
    { installation: { install_id: "install-test", name: "crm", title: "CRM", version: "0.1.0", digest: DIGEST, summary: "s" } },
    { route: { section: "people", view: "list", record_id: null, segment_id: null, extra: true } },
  ];
  for (const bad of refusals) {
    const env = installEnvironment(bootFor("hr"));
    const channel = createChannel();
    channel.start();
    await waitFor(() => env.events.find((event) => event.op === "ready"), "ready");
    env.host().postMessage(push(bad));
    await settle();
    expect(getScope()).toBeNull();
    retire(channel);
  }
});

test("a section or action this screen does not know is not a refusal: the section reads as People, the action is dropped", async () => {
  const { channel } = await mount({
    route: { section: "payroll", view: "list", record_id: null, segment_id: null },
    actions: ["records.list", "records.show", "records.create", "records.update", "records.delete", "screen.route.patch"],
  });
  try {
    expect(getScope().route.section).toBe("people");
    expect(getScope().actions).not.toContain("records.delete");
    expect(getScope().actions).toContain("records.create");
  } finally {
    retire(channel);
  }
});

test("a boot declared for another app never mounts", () => {
  clearScope("test reset");
  installEnvironment(bootFor("crm"));
  expect(() => createChannel().start()).toThrow();
});

// ---- argument budgets ---------------------------------------------------------------------------
// The board closes a records frame whose write arguments pass 49,152 bytes of JSON (16,384 for any other operation),
// measured as UTF-8 bytes of the JSON text. The bridge measures the same way and refuses first.
const json = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const chinese = (n) => "員工每年可享有十四日有薪年假。".repeat(Math.ceil(n / 15)).slice(0, n);
const BUDGET = { "records.create": 49152, "records.update": 49152, "records.list": 16384, "records.show": 16384, "screen.route.patch": 16384 };
/** Arguments of exactly `size` bytes, padded with written Chinese (three bytes a character) and then ASCII. */
function sized(verb, size) {
  const base = {
    "records.create": { table: "policies", record_id: "pol-0123456789ab", profile: { title: "請假政策", body: "" } },
    "records.update": { table: "policies", record_id: "pol-0123456789ab", expected_revision: 1, profile: { body: "" } },
    "records.list": { table: "policies", query: "" },
    "records.show": { table: "policies", record_id: "" },
    "screen.route.patch": { section: "policies", record_id: "" },
  }[verb];
  const args = structuredClone(base);
  const put = (text) => { if (args.profile) args.profile.body = text; else if ("query" in args) args.query = text; else args.record_id = text; };
  const room = size - json(args);
  const wide = Math.floor(room / 3);
  put(chinese(wide) + "x".repeat(room - wide * 3));
  expect(json(args)).toBe(size);
  return args;
}

test("the bridge sends 49,152 bytes for a record write and 16,384 for any other operation, and refuses one byte more", async () => {
  const { channel, events, host } = await mount();
  try {
    for (const [verb, limit] of Object.entries(BUDGET)) {
      const before = calls(events).length;
      const pending = channel.request(verb, sized(verb, limit));
      const request = await waitFor(() => calls(events)[before], verb);
      expect(request.verb).toBe(verb);
      expect(json(request.args)).toBe(limit);
      host().postMessage({ v: 2, op: "reply", id: request.id, ok: true, data: {} });
      await expect(pending).resolves.toEqual({});
      // One byte more never leaves the frame, and the mount stays live. The screen never asks: its own
      // `cleanArgs` refuses first with a "too long" message (next test).
      await expect(channel.request(verb, sized(verb, limit + 1))).rejects.toMatchObject({ status: 400, code: "invalid" });
      await settle();
      expect(calls(events).length).toBe(before + 1);
      expect(getScope()).not.toBeNull();
    }
  } finally {
    retire(channel);
  }
});

test("the screen refuses an oversized write before sending it, says it is too long, and keeps the mount", async () => {
  const { createRecord, problemFor, TEXT } = await import("../../src/features/hr/recordsSubmit.ts");
  const { POLICY } = await import("../../src/domain/records.ts");
  const env = await mountScreen();
  const calls = () => env.events.filter((event) => event.op === "call");
  const form = (body) => ({ title: "請假政策", category: "leave", language: "zh-HK", effectiveFrom: "2026-01-01", status: "current", body });
  try {
    const scope = getScope().scope;
    // 12,000 characters that keep Word's manual line breaks: JSON writes each U+000B as six bytes.
    const pasted = chinese(6000).split("").map((c) => c + "\u000b").join("");
    const error = await createRecord(scope, POLICY, "pol-0123456789ab", form(pasted)).catch((e) => e);
    expect(problemFor(error, "create", (s) => s)).toMatchObject({ kind: "too_long", message: TEXT.too_long, reload: false });
    expect(calls()).toEqual([]);
    expect(getScope()).not.toBeNull();
    // The mount is still live: the same form with a 12,000-character Chinese body is sent and saved.
    const pending = createRecord(scope, POLICY, "pol-0123456789ab", form(chinese(12000)));
    const request = await waitFor(() => calls()[0], "call");
    expect(request.verb).toBe("records.create");
    expect(request.args.profile.body).toBe(chinese(12000));
    expect(json(request.args)).toBeGreaterThan(16384);
    env.host().postMessage({ v: 2, op: "reply", id: request.id, ok: true, data: { record: { id: "pol-0123456789ab", revision: 1, digest: "sha256:x", profile: request.args.profile, history: [] } } });
    await expect(pending).resolves.toMatchObject({ id: "pol-0123456789ab", revision: 1 });
  } finally {
    retire(screen);
  }
});

test("a too_large refusal the board relays after a write ran is not called 'too long': the record may be saved", async () => {
  const { createRecord, problemFor, TEXT } = await import("../../src/features/hr/recordsSubmit.ts");
  const { POLICY } = await import("../../src/domain/records.ts");
  const env = await mountScreen();
  const form = { title: "請假政策", category: "leave", language: "zh-HK", effectiveFrom: "2026-01-01", status: "current", body: chinese(200) };
  try {
    const pending = createRecord(getScope().scope, POLICY, "pol-0123456789ab", form).catch((e) => e);
    const request = await waitFor(() => calls(env.events)[0], "call");
    // The board sends this when the reply is too big to show; the write itself already ran.
    env.host().postMessage({ v: 2, op: "reply", id: request.id, ok: false, refusal: { code: "too_large", text: "That is too large to show." } });
    const error = await pending;
    expect(error).toMatchObject({ status: 400, code: "too_large" });
    expect(problemFor(error, "create", (s) => s)).toEqual({ field: null, message: TEXT.maybe_saved, kind: "maybe_saved", reload: false });
    expect(problemFor(error, "update", (s) => s)).toMatchObject({ kind: "maybe_saved" });
    expect(getScope()).not.toBeNull();
  } finally {
    retire(screen);
  }
});
