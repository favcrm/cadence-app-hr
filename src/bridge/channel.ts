import { ApiError } from "@cadence/screen-ui";
import { createScreenBridge, type ScreenBridge, type ScreenBridgeRuntimeOverrides } from "@cadence/app-kit";
import { bindBridgeScope, type DisplayScope } from "./scope";
import { CALL_FIELDS, OPERATIONS, SECTIONS, WRITE_BUDGET, WRITE_VERBS, type Section } from "./services";

export type HrView = "list" | "new";
export type HrBridge = ScreenBridge<Section, HrView, ApiError>;

const unavailable = () => new ApiError("The HR bridge is unavailable", 503);

/**
 * The pinned app-kit bridge, configured for HR. It negotiates `screen.v2`, `screen-records.v1` and
 * `screen-locale.v1`; validates every PUSH; and holds each operation to its field allowlist and argument budget.
 * Record writes get `WRITE_BUDGET` (49,152 bytes); every other operation keeps app-kit's 16,384 default. The
 * receiver underneath is created with the largest of them, so it never sends what the board would close on.
 */
export function createHrBridge(): HrBridge {
  return createScreenBridge<Section, HrView, ApiError>({
    tag: "hr",
    appName: "hr",
    records: true,
    locale: true,
    calls: CALL_FIELDS,
    argBytes: Object.fromEntries(WRITE_VERBS.map((verb) => [verb, WRITE_BUDGET])),
    writeVerbs: WRITE_VERBS,
    route: { sections: SECTIONS, defaultSection: "people", views: ["list", "new"] },
    observations: ["records.list", "records.show"],
    maxInFlight: 8,
    timeoutMs: 65000,
    createError: (message, status, options) => new ApiError(message, status, options),
  });
}

/** The one adapter over the pinned app-kit bridge; the app opens no other channel. */
export class Channel {
  private instance: HrBridge | null = null;

  /** Created on first use, so importing this module never reads the boot or touches the services table. */
  get bridge(): HrBridge {
    this.instance ??= createHrBridge();
    return this.instance;
  }

  start(runtime: ScreenBridgeRuntimeOverrides = {}): void {
    bindBridgeScope(this.bridge);
    this.bridge.start(runtime);
    // A refused boot (another app's tag, a bad nonce or origin) leaves the bridge retired: never mount.
    const state = this.bridge.getState();
    if (state.status === "error") throw state.error ?? unavailable();
  }

  /**
   * Sends one operation for a scope. The board closes the frame on the first 401 or 403, so a 403 retires the
   * session here too, on a write as on a read (app-kit keeps a write's 403 alive on its own).
   */
  call<T = unknown>(scope: DisplayScope, verb: string, args: Record<string, unknown>): Promise<T> {
    if (this.bridge.getState().status !== "ready" || !this.bridge.getSnapshot()) return Promise.reject(unavailable());
    return this.bridge.call<T>(scope, verb, args).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) this.bridge.retire(error);
      throw error;
    });
  }

  /** `call` for the current scope, without the screen's own checks: the contract tests drive the wire with it. */
  request(verb: string, args: Record<string, unknown>): Promise<unknown> {
    const snap = this.bridge.getSnapshot();
    if (!snap) return Promise.reject(unavailable());
    return this.call(snap.scope, verb, args);
  }

  retire(error: ApiError): void {
    this.bridge.retire(error);
  }
}

export const createChannel = (): Channel => new Channel();
export const channel = createChannel();
export function admitted(verb: string, actions: readonly string[]): boolean {
  return OPERATIONS.includes(verb) && actions.includes(verb);
}
