// The leave hint from a real form: EmployeeNew rendered with React in happy-dom, over the module's own channel and
// the vendored app-kit receiver, against a synthetic host that answers the records wire.
// The board checks the hint when it applies the screen's own route patch, so a save that moves the screen on must
// clear the hint before it sends that patch.
// Run: bun test tests/contract/leave_forms.test.mjs

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { sdkMock } from "../support/sdk-mock.mjs";

// The port pair must be the runtime's own: the receiver transfers one end to the host.
const NativeMessageChannel = globalThis.MessageChannel;
GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@cadence/screen-ui", sdkMock);

const { createRoot } = await import("react-dom/client");
const { channel } = await import("../../src/bridge/channel.ts");
const { getScope } = await import("../../src/bridge/scope.ts");
const { patchRoute } = await import("../../src/bridge/route.ts");
const { default: EmployeeNew } = await import("../../src/features/hr/EmployeeNew.tsx");

const DIGEST = "sha256:" + "a".repeat(64);
const BOOT = { tag: "hr", bridge_nonce: "b".repeat(64), generation: 1, parent_origin: "https://board.example" };
const PUSH = {
  v: 2, op: "screen", install_id: "install-test", digest: DIGEST, tag: "hr",
  installation: { install_id: "install-test", name: "hr", title: "HR", version: "0.3.0", digest: DIGEST, summary: "s" },
  actions: ["records.list", "records.show", "records.create", "records.update", "screen.route.patch"],
  route: { section: "people", view: "new", record_id: null, segment_id: null }, presentation_locale: "en",
};

const waitFor = async (find, label) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = find();
    if (value) return value;
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** The synthetic board: it records every frame message and answers records calls; `refuseCreate` refuses the write. */
function host({ refuseCreate = false } = {}) {
  const events = [];
  let port = null;
  const reply = (id, data) => port.postMessage({ v: 2, op: "reply", id, ok: true, data });
  const parent = {
    postMessage(message, _origin, transfer) {
      if (message.op !== "init") return;
      port = transfer[0];
      port.onmessage = ({ data }) => {
        events.push(data);
        if (data.op === "ready") port.postMessage(PUSH);
        if (data.op !== "call") return;
        if (data.verb === "records.list") reply(data.id, { records: [], total: 0, truncated: false, next_cursor: null });
        else if (data.verb === "records.create" && refuseCreate) port.postMessage({ v: 2, op: "reply", id: data.id, ok: false, refusal: { code: "failed", text: "Refused." } });
        else if (data.verb === "records.create") reply(data.id, { record: { id: data.args.record_id, revision: 1, digest: "sha256:x", profile: data.args.profile, history: [] } });
        else reply(data.id, {});
      };
      port.start?.();
    },
  };
  return { parent, events };
}

const document = () => globalThis.document;
function type(id, value) {
  const input = document().getElementById(id);
  Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
}

async function openForm(options) {
  const board = host(options);
  channel.bridge.reset();
  channel.start({ parent: board.parent, MessageChannel: NativeMessageChannel, document: { getElementById: (id) => (id === "cadence-screen-boot" ? { textContent: JSON.stringify(BOOT) } : null) } });
  await waitFor(() => getScope(), "verified scope");
  const outlet = document().body.appendChild(document().createElement("div"));
  const root = createRoot(outlet);
  // As HrScreen does: a create that landed moves the screen to the new record with a route patch.
  const onCreated = (id) => { void patchRoute({ view: "list", record_id: id, segment_id: null }).catch(() => undefined); };
  await act(async () => { root.render(createElement(EmployeeNew, { scope: getScope().scope, canWrite: true, onCreated, onCancel: () => undefined })); });
  const leaves = () => board.events.filter((event) => event.op === "leave");
  const index = (find) => board.events.findIndex(find);
  return { board, root, leaves, index };
}

test("a save that moves the screen on clears the leave hint before the route patch reaches the board", async () => {
  const { board, root, leaves, index } = await openForm();
  try {
    expect(leaves()).toEqual([]);
    await act(async () => { type("field-Name", "Casey Example"); type("field-Employee-number", "e-0042"); });
    await waitFor(() => leaves().length === 1, "unsaved: true");
    expect(leaves()).toEqual([{ v: 2, op: "leave", unsaved: true }]);
    await act(async () => { document().querySelector("form").dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })); });
    const patched = await waitFor(() => board.events.find((event) => event.op === "call" && event.verb === "screen.route.patch"), "route patch");
    const created = index((event) => event.op === "call" && event.verb === "records.create");
    const cleared = index((event) => event.op === "leave" && event.unsaved === false);
    expect(created).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(created);
    expect(cleared).toBeLessThan(board.events.indexOf(patched));
    expect(patched.args).toMatchObject({ view: "list", record_id: board.events[created].args.record_id });
    // The form is still shown until the board answers with a new route: it does not warn again.
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(leaves()).toEqual([{ v: 2, op: "leave", unsaved: true }, { v: 2, op: "leave", unsaved: false }]);
  } finally {
    await act(async () => root.unmount());
    channel.retire(new Error("test cleanup"));
  }
});

test("a refused save keeps the leave hint, and closing the form clears it", async () => {
  const { board, root, leaves } = await openForm({ refuseCreate: true });
  try {
    await act(async () => { type("field-Name", "Casey Example"); type("field-Employee-number", "E-0043"); });
    await waitFor(() => leaves().length === 1, "unsaved: true");
    await act(async () => { document().querySelector("form").dispatchEvent(new globalThis.Event("submit", { bubbles: true, cancelable: true })); });
    await waitFor(() => document().querySelector("[role=alert]"), "the refusal notice");
    expect(board.events.some((event) => event.op === "call" && event.verb === "screen.route.patch")).toBe(false);
    expect(leaves()).toEqual([{ v: 2, op: "leave", unsaved: true }]);
    await act(async () => root.unmount());
    await waitFor(() => leaves().length === 2, "unsaved: false");
    expect(leaves()[1]).toEqual({ v: 2, op: "leave", unsaved: false });
  } finally {
    channel.retire(new Error("test cleanup"));
  }
});
