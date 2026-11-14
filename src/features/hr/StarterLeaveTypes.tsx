import { Button, ErrorNotice } from "@cadence/screen-ui";
import { STARTER_LEAVE_TYPES } from "../../domain/leave-starter";
import { useLocale } from "./locale";

export type StarterState =
  | { phase: "idle" }
  | { phase: "running"; done: number }
  | { phase: "stopped"; done: number; reason: string | null };

/**
 * The starter leave types on an empty Leave types list: say what the set is and offer it to the owner. The rows are
 * created one at a time under fixed ids, so choosing the button again after a failure adds only what is missing.
 */
export default function StarterLeaveTypes({ state, canWrite, onRun }: { state: StarterState; canWrite: boolean; onRun: () => void }) {
  const { t, formatNumber } = useLocale();
  const total = STARTER_LEAVE_TYPES.length;
  const progress = (text: string, done: number) => t(text).replace("{done}", formatNumber(done)).replace("{total}", formatNumber(total));
  return (
    <div className="grid gap-2 mt-2">
      <p className="text-label text-ink-400">{t("The starter set is a generic template, not legal advice. It holds no entitlement figures. A code cannot be changed once saved.")}</p>
      {state.phase === "stopped" && (
        <ErrorNotice bare>
          {state.done > 0
            ? progress("Only {done} of {total} common leave types are in place.", state.done)
            : t("The common leave types were not added.")}{" "}
          {state.reason !== null && <>{t(state.reason)}{" "}</>}
          {t("Choose Add common leave types again to add the rest. Leave types already added are kept and are not added twice.")}
        </ErrorNotice>
      )}
      {state.phase === "running" && <p role="status" aria-live="polite">{progress("Adding leave types… {done} of {total}", state.done)}</p>}
      {state.phase !== "running" && (canWrite
        ? <div className="hr-actions"><Button variant="primary" onClick={onRun}>{t("Add common leave types")}</Button></div>
        : <p className="text-label text-ink-400">{t("Nothing has been added yet.")}</p>)}
    </div>
  );
}
