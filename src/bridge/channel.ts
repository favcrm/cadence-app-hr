import { ApiError } from "@cadence/screen-ui";
import {
  createScreenBridge,
  type ScreenBridge,
  type ScreenBridgeRuntimeOverrides,
} from "@cadence/app-kit";
import { bindBridgeScope, type DisplayScope } from "./scope";
import { CALL_FIELDS, OPERATIONS, SECTIONS, WRITE_VERBS, type Section } from "./services";

export type HrView = "list" | "new";

export function createHrBridge(): ScreenBridge<Section, HrView, ApiError> {
  return createScreenBridge<Section, HrView, ApiError>({
    tag: "hr",
    appName: "hr",
    records: true,
    locale: true,
    calls: CALL_FIELDS,
    argBytes: {
      "records.create": 98304,
      "records.update": 98304,
    },
    writeVerbs: WRITE_VERBS,
    route: {
      sections: [...SECTIONS],
      defaultSection: "people",
      views: ["list", "new"],
    },
    observations: ["records.list", "records.show"],
    maxInFlight: 8,
    timeoutMs: 65000,
    createError: (message, status, options) => new ApiError(message, status, options),
  });
}

/** The one adapter over the pinned app-kit bridge; the app opens no other channel. */
export class Channel {
  private instance: ScreenBridge<Section, HrView, ApiError> | null = null;

  get bridge(): ScreenBridge<Section, HrView, ApiError> {
    if (!this.instance) this.instance = createHrBridge();
    return this.instance;
  }

  start(opts: ScreenBridgeRuntimeOverrides = {}): void {
    bindBridgeScope(this.bridge);
    this.bridge.start(opts);
    const state = this.bridge.getState();
    if (state.status === "error") {
      throw state.error ?? new ApiError("The HR bridge refused an invalid or retired response", 502);
    }
  }

  request(verb: string, args: Record<string, unknown>): Promise<unknown> {
    const snap = this.bridge.getSnapshot();
    if (!snap || this.bridge.getState().status !== "ready") {
      return Promise.reject(new ApiError("The HR bridge is unavailable", 503));
    }
    return this.bridge.call(snap.scope, verb, args);
  }

  call<T = unknown>(scope: DisplayScope, verb: string, args: Record<string, unknown>): Promise<T> {
    return this.bridge.call<T>(scope, verb, args);
  }

  retire(error?: ApiError): void {
    this.bridge.retire(error);
  }
}

export const createChannel = (): Channel => new Channel();
export const channel = createChannel();
export function admitted(verb: string, actions: readonly string[]): boolean {
  return OPERATIONS.includes(verb) && actions.includes(verb);
}
