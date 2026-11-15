import { ErrorNotice, Loading } from "@cadence/screen-ui";
import { forEmployee, readBalances } from "./ledger";
import { signedDays } from "../../domain/leave";
import { hostErrorText } from "./hostErrors";
import type { HostScope } from "./hostActions";
import { useLocale } from "./locale";
import { useHrLoader } from "./resources";

/** An employee's leave balances from the host's sum of their ledger entries, with the moment it was read. A failed read shows no figure. */
export default function EmployeeBalances({ scope, employeeId }: { scope: HostScope; employeeId: string }) {
  const { t, formatDate } = useLocale();
  const state = useHrLoader(scope, "employee-balances", { employeeId }, () => readBalances(scope, forEmployee(employeeId)));
  const data = state.data;
  return (
    <section className="hr-sect" aria-label={t("Leave balances")}>
      <h4>{t("Leave balances")}</h4>
      {state.loading && <Loading>{t("Reading the leave balances…")}</Loading>}
      {state.error !== null && !state.loading && <ErrorNotice bare onRetry={() => void state.store.refresh()}>{t(hostErrorText(state.failure, "The leave balances could not be read."))}</ErrorNotice>}
      {data && (
        <>
          {data.groups.length === 0
            ? <p className="text-label text-ink-400">{t(data.truncated ? "The host's answer was cut short, so no balance is shown." : "No leave has been recorded for this employee yet.")}</p>
            : <ul className="hr-reasons">{data.groups.map((g) => <li key={g.leaveType ?? "—"}><span className="num">{g.leaveType ?? "—"}</span>: <span className="num">{signedDays(g.halfDays)}</span> {t("days")}</li>)}</ul>}
          {data.truncated && data.groups.length > 0 && <p className="text-micro text-ink-500">{t("The host's answer was cut short, so a leave type may be missing.")}</p>}
          <p className="text-micro text-ink-500">{t("As of {time}. The sum of this employee's ledger entries.").replace("{time}", formatDate(Date.parse(data.asOf), { dateStyle: "medium", timeStyle: "short" }))}</p>
        </>
      )}
    </section>
  );
}
