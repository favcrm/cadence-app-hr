// Contract tests for the app-kit-backed HR channel. The synthetic host here
// speaks the real records wire: ready, PUSH and call replies.
// Run: bun test tests/contract/appkit_channel.test.mjs

import { test, expect, mock } from "bun:test";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);

const { createChannel } = await import("../../src/bridge/channel.ts");
const { clearScope, getScope } = await import("../../src/bridge/scope.ts");

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

async function mount(pushExtra = {}) {
  clearScope("test reset");
  const env = installEnvironment(bootFor("hr"));
  const channel = createChannel();
  channel.start();
  const ready = await waitFor(() => env.events.find((event) => event.op === "ready"), "ready");
  expect(ready.accepts).toEqual(["screen.v2", "screen-records.v1", "screen-locale.v1"]);
  env.host().postMessage(push(pushExtra));
  await waitFor(() => getScope()?.scope.installId === "install-test", "PUSH scope");
  return { channel, ...env };
}

const retire = (channel) => channel.retire(new ApiError("test cleanup", 403));

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

test("caps in-flight requests at eight", async () => {
  const { channel } = await mount();
  const pending = [];
  try {
    for (let index = 0; index < 8; index += 1) pending.push(channel.request("records.list", {}));
    await expect(channel.request("records.list", {})).rejects.toMatchObject({ status: 429 });
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

test("a push for another app, or with an unknown locale or malformed route, is refused", async () => {
  clearScope("test reset");
  const refusals = [
    { tag: "crm" },
    { presentation_locale: "zh-HK" },
    { route: { section: "people", view: "list", record_id: null, segment_id: null, extra: true } },
  ];
  for (const bad of refusals) {
    const env = installEnvironment(bootFor("hr"));
    const channel = createChannel();
    channel.start();
    await waitFor(() => env.events.find((event) => event.op === "ready"), "ready");
    env.host().postMessage(push(bad));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getScope()).toBeNull();
    retire(channel);
  }

  // Unknown future host sections degrade safely to defaultSection ("people").
  const safe = await mount({ route: { section: "customers", view: "list", record_id: null, segment_id: null } });
  try {
    expect(getScope()?.route.section).toBe("people");
  } finally {
    retire(safe.channel);
  }
});

test("a boot declared for another app never mounts", () => {
  clearScope("test reset");
  installEnvironment(bootFor("crm"));
  expect(() => createChannel().start()).toThrow();
});
