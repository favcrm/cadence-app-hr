import type { ScreenLeaveHandle } from "@cadence/app-kit";
import { useEffect, useRef } from "react";
import { channel } from "./channel";

// The board's leave warning is one boolean for the whole frame: `{ v: 2, op: "leave", unsaved }`. The receiver lets
// one owner publish it at a time (a second claim silences the first), so every open form reports here and one
// handle carries the union. The hint has no authority: it only lets the board ask before it navigates away.
const unsaved = new Set<symbol>();
let handle: ScreenLeaveHandle | null = null;
/** What the board was last told. A mount starts clear, so nothing is sent until a form holds an edit. */
let told = false;

function publish(): void {
  const value = unsaved.size > 0;
  if (value === told) return;
  // A handle from a retired or reset mount refuses; claim the live one once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    handle ??= channel.bridge.ownLeaveState();
    if (!handle) { told = false; return; } // no verified scope: nothing to warn about, and a new mount starts clear
    if (handle.publish(value)) { told = value; return; }
    handle = null;
  }
}

/** Record whether one form holds edits that are not saved, and tell the board whether any form does. */
export function markUnsaved(form: symbol, dirty: boolean): void {
  if (dirty) unsaved.add(form); else unsaved.delete(form);
  publish();
}

/** A form's part in the leave warning: `dirty` while it holds unsaved edits, cleared when it unmounts. */
export function useUnsavedEdits(dirty: boolean): void {
  const form = useRef<symbol | null>(null);
  form.current ??= Symbol("hr-form");
  const key = form.current;
  useEffect(() => { markUnsaved(key, dirty); }, [key, dirty]);
  useEffect(() => () => markUnsaved(key, false), [key]);
}
