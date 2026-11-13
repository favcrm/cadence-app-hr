import { ApiError } from "@cadence/screen-ui";
import type { ScreenScopeSnapshot } from "@cadence/app-kit";
import { useSyncExternalStore } from "react";
import { admitted, channel, type HrBridge, type HrView } from "./channel";
import type { Section } from "./services";

export interface DisplayScope { installId: string; digest: string }
export interface Route { section: Section; view: HrView; record_id: string | null; segment_id: string | null }
export interface ReadObservation { operation: string; args: Record<string, unknown>; data: unknown }
export interface ScopeSnapshot { presentationLocale: "en" | "zh-TW"; scope: DisplayScope; digest: string; actions: string[]; route: Route; observations: ReadObservation[] }

// The bridge validates every PUSH (tag, install, digest, `screen-locale.v1` locale, route, read observations) and
// keeps the snapshot; this module projects it into the screen's own shape and keeps the screen's listeners.
const listeners = new Set<() => void>();
const retireListeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
const retired = () => retireListeners.forEach((f) => f());

let activeBridge: HrBridge | null = null;
let unsubscribeBridge: (() => void) | null = null;
let cachedRaw: ScreenScopeSnapshot<Section, HrView> | null = null;
let cachedSnap: ScopeSnapshot | null = null;
let manualError: string | null = null;
let wasError = false;

function project(raw: ScreenScopeSnapshot<Section, HrView> | null): ScopeSnapshot | null {
  if (!raw) { cachedRaw = null; cachedSnap = null; return null; }
  if (raw === cachedRaw && cachedSnap) return cachedSnap;
  cachedRaw = raw;
  cachedSnap = {
    presentationLocale: raw.presentationLocale === "zh-TW" ? "zh-TW" : "en",
    scope: { installId: raw.scope.installId, digest: raw.digest },
    digest: raw.digest,
    actions: [...raw.actions],
    route: raw.route ?? { section: "people", view: "list", record_id: null, segment_id: null },
    observations: raw.observations.map((row) => ({ operation: row.operation, args: row.args, data: row.data })),
  };
  return cachedSnap;
}

/** Follow one bridge: its state changes notify the screen, and its first error retires the screen's caches. */
export function bindBridgeScope(bridge: HrBridge): void {
  if (activeBridge === bridge) return;
  unsubscribeBridge?.();
  activeBridge = bridge;
  cachedRaw = null; cachedSnap = null; manualError = null;
  wasError = bridge.getState().status === "error";
  unsubscribeBridge = bridge.subscribe(() => {
    manualError = null;
    const isError = bridge.getState().status === "error";
    if (isError && !wasError) retired();
    wasError = isError;
    notify();
  });
  notify();
}

function bridge(): HrBridge {
  if (!activeBridge) bindBridgeScope(channel.bridge);
  return activeBridge!;
}

export const subscribeScope = (f: () => void) => { bridge(); listeners.add(f); return () => { listeners.delete(f); }; };
export const getScope = (): ScopeSnapshot | null => project(bridge().getSnapshot());
export function useScope() { return useSyncExternalStore(subscribeScope, getScope); }
export function scopeError(): string | null { return bridge().getState().error?.message ?? manualError; }
export function onScopeRetired(f: () => void) { retireListeners.add(f); return () => { retireListeners.delete(f); }; }
/** Drop the scope and close the receiver (tests reset between mounts with it). */
export function clearScope(reason: string): void {
  cachedRaw = null; cachedSnap = null;
  activeBridge?.reset();
  manualError = reason; wasError = false;
  retired(); notify();
}
export function assertCurrentScope(scope: DisplayScope): void {
  const s = getScope();
  if (!s || scope.installId !== s.scope.installId || scope.digest !== s.digest) throw new ApiError("The HR scope is absent or retired", 403);
}
export function requireOperation(verb: string): void {
  const s = getScope();
  if (!s || !admitted(verb, s.actions)) throw new ApiError("This workspace doesn't offer that action.", 403);
}
