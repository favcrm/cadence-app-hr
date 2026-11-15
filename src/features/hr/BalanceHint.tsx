import { Notice } from "@cadence/screen-ui";
import { useEffect, useState } from "react";
import { balanceHintView, signedDays, type Balances } from "../../domain/leave";
import { toHalfDays, type Values } from "../../domain/records";
import type { HostScope } from "./hostActions";
import { readRequestBalance } from "./ledger";
import { useLocale } from "./locale";

type State =
  | { status: "idle" }
  | { status: "reading" }
  | { status: "ready"; employeeId: string; balances: Balances }
  | { status: "error" };
const UCODE = /^[A-Z0-9_-]{1,32}$/;

/**
 * The balance next to a new leave request: the employee's current sum for the leave type from the host's aggregate, and
 * what the request would leave. It warns when the request would take the balance below zero; it never blocks the save.
 * Nothing is shown as 0 unless the host's answer was complete, and a failed read says so instead of showing a figure.
 */
export default function BalanceHint({ scope, values }: { scope: HostScope; values: Values }) {
  const { t, formatDate } = useLocale();
  const employeeNo = (values.employeeNo ?? "").trim().toUpperCase();
  const leaveType = (values.leaveType ?? "").trim().toUpperCase();
  const [state, setState] = useState<State>({ status: "idle" });
  const ready = employeeNo !== "" && UCODE.test(leaveType);
  useEffect(() => {
    if (!ready) { setState({ status: "idle" }); return; }
    let live = true;
    setState({ status: "reading" });
    const timer = setTimeout(() => {
      readRequestBalance(scope, employeeNo, leaveType).then(
        (r) => { if (live) setState({ status: "ready", employeeId: r.employeeId, balances: r.balances }); },
        // An unknown employee or leave type is the form's own check to report; the hint stays quiet and shows no figure.
        () => { if (live) setState({ status: "error" }); },
      );
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [scope.installId, scope.digest, employeeNo, leaveType, ready]);

  if (!ready || state.status === "idle") return null;
  if (state.status === "reading") return <p className="text-label text-ink-400" role="status">{t("Reading the leave balance…")}</p>;
  if (state.status === "error") return <p className="text-label text-ink-400" role="status">{t("The leave balance could not be read, so none is shown. You can still save the request.")}</p>;
  const view = balanceHintView(state.balances, state.employeeId, leaveType, toHalfDays(values.days ?? ""));
  const asOf = formatDate(Date.parse(state.balances.asOf), { dateStyle: "medium", timeStyle: "short" });
  const after = view.kind === "cut_short" ? null : view.after;
  // Never "0 days" for someone with no entries: like their own balances and the leave-desk skill, say none is recorded.
  return (
    <div className="grid gap-1" data-balance-hint>
      <p className="text-label" role="status">
        {view.kind === "cut_short" && t("The balance could not be worked out because the host's answer was cut short.")}
        {view.kind === "none_recorded" && t("No leave has been recorded for this employee and leave type yet (as of {time}).").replace("{time}", asOf)}
        {view.kind === "balance" && t("Current balance: {days} days (as of {time}).").replace("{days}", signedDays(view.halfDays)).replace("{time}", asOf)}
        {after !== null && <> {t("After this request: {days} days.").replace("{days}", signedDays(after))}</>}
      </p>
      {after !== null && after < 0 && (
        <Notice state="negative-balance">{t("This request would take the balance below zero. You can still save it; the owner decides.")}</Notice>
      )}
    </div>
  );
}
