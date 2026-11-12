import { ApiError } from "@cadence/screen-ui";
import {
  createScreenReceiver,
  ScreenClosedError,
  ScreenRefusalError,
  ScreenTimeoutError,
  type ScreenBoot,
  type ScreenReceiver,
} from "@cadence/app-kit";
import { acceptPush, clearScope } from "./scope";
import { OPERATIONS, WRITE_BUDGET } from "./services";

const MAX_PUSH_BYTES = 131072;
const MAX_DATA_BYTES = 1048576;
const SECRET_KEYS = ["confirmation_nonce", "confirmation_token", "confirm_token", "action_token"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).every(k => keys.includes(k)); }
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const invalid = () => new ApiError("The HR bridge refused an invalid or retired response", 502);

function guardData(value: unknown): unknown {
  if (bytes(value) > MAX_DATA_BYTES) throw invalid();
  if (object(value) && SECRET_KEYS.some(k => k in value)) throw invalid();
  return value;
}

/** The one adapter over the pinned app-kit receiver; the app opens no other channel. */
class Channel {
  private receiver: ScreenReceiver | null = null;
  private retired = false;
  private inFlight = 0;
  private cause: ApiError | null = null;

  start(): void {
    if (this.receiver || this.retired) return;
    const node = document.getElementById("cadence-screen-boot");
    if (!node?.textContent || node.textContent.length > 2048) throw invalid();
    const boot: unknown = JSON.parse(node.textContent);
    if (!object(boot) || !exact(boot, ["tag", "bridge_nonce", "generation", "parent_origin"]) || boot.tag !== "hr" ||
        typeof boot.bridge_nonce !== "string" || !/^[a-f0-9]{64}$/.test(boot.bridge_nonce) ||
        !Number.isSafeInteger(boot.generation) || (boot.generation as number) < 0 || typeof boot.parent_origin !== "string") throw invalid();
    const origin = new URL(boot.parent_origin);
    if (origin.origin !== boot.parent_origin || !["http:", "https:"].includes(origin.protocol) || window.parent === window) throw invalid();

    const receiver = createScreenReceiver({
      boot: boot as unknown as ScreenBoot,
      accepts: ["screen.v2", "screen-records.v1", "crm-locale.v1"],
      timeoutMs: 65000,
      // The largest per-operation budget (a record write); `cleanArgs` holds every other operation to 16 KiB.
      // Without it the receiver keeps its 16 KiB default and refuses a long policy or CV.
      maxArgsBytes: WRITE_BUDGET,
      onPush: (push) => {
        if (bytes(push) > MAX_PUSH_BYTES) throw invalid();
        acceptPush(push);
      },
      onError: (reason) => {
        this.retire(new ApiError(reason, 502));
      },
    });
    // app-kit reports a refused boot through an inert receiver; keep the app's
    // own tag check so a different app's boot can never mount HR.
    if (!receiver.boot || receiver.boot.tag !== "hr") {
      receiver.teardown();
      throw invalid();
    }
    this.receiver = receiver;
  }

  request(verb: string, args: Record<string, unknown>): Promise<unknown> {
    const receiver = this.receiver;
    if (!receiver || this.retired) return Promise.reject(new ApiError("The HR bridge is unavailable", 503));
    if (this.inFlight >= 8) return Promise.reject(new ApiError("The HR bridge is busy; wait for the current request", 429));
    this.inFlight += 1;
    const settle = () => { this.inFlight -= 1; };
    return receiver.call(verb, args).then(
      value => {
        settle();
        try { return guardData(value); }
        catch (error) { const mapped = this.mapError(error); this.retire(mapped); throw mapped; }
      },
      error => {
        settle();
        const mapped = this.mapError(error);
        if ([401, 403, 504, 502].includes(mapped.status)) this.retire(mapped);
        return Promise.reject(mapped);
      },
    );
  }

  private mapError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof ScreenRefusalError) return new ApiError(error.text || error.code, error.status, { code: error.code });
    if (error instanceof ScreenTimeoutError) {
      return new ApiError("The request did not answer. Check the record before retrying a change.", 504);
    }
    if (error instanceof ScreenClosedError) return this.cause ?? new ApiError("The HR bridge is unavailable", 503);
    return invalid();
  }

  retire(error: ApiError): void {
    if (this.retired) return;
    this.retired = true; this.cause = error;
    this.receiver?.teardown(); this.receiver = null;
    clearScope(error.message);
  }
}
export const createChannel = (): Channel => new Channel();
export const channel = createChannel();
export function admitted(verb: string, actions: readonly string[]): boolean { return OPERATIONS.includes(verb) && actions.includes(verb); }
