import { Button, DataTable, EmptyState, ErrorNotice, Field, Loading, Notice } from "@cadence/screen-ui";
import { useState, type ReactNode } from "react";
import { parseMonth, signedDays, SKIP_TEXT, type AccrualPlan } from "../../domain/leave";
import { emptyValues, ADJUSTMENT, todayLocal, newRecordId, type Values } from "../../domain/records";
import type { HostScope } from "./hostActions";
import { hostErrorText } from "./hostErrors";
import {
  adjustBalance, adjustmentRef, listAll, PostStopped, planMonth, planReconcile, planRecovery, postEntries, readBalances, RECOVERY_LIMIT, type PostResult, type ReconcilePlan,
  type RecoveryPlan,
} from "./ledger";
import { useLocale } from "./locale";
import RecordForm, { type RecordProblem } from "./RecordForm";
import { problemFor } from "./recordsSubmit";
import { QueryRefresh, useHrLoader } from "./resources";

export interface LedgerCaps { aggregate: boolean; batch: boolean }

/** Two steps for a bulk write: read and show what it would do, then post it. Nothing is written until the second step. */
type Phase<P> =
  | { s: "idle" }
  | { s: "reading" }
  | { s: "ready"; plan: P }
  | { s: "posting"; plan: P; done: number; total: number }
  | { s: "done"; plan: P; result: PostResult }
  | { s: "error"; message: string; done: PostResult | null };

function StepAction<P>({ title, intro, children, reviewLabel, reviewDisabled = false, postLabel, review, summary, count, post, disabled, onPosted }: {
  title: string; intro: string; children?: ReactNode; reviewLabel: string; reviewDisabled?: boolean; postLabel: (n: number) => string;
  review: () => Promise<P>; summary: (plan: P) => ReactNode; count: (plan: P) => number;
  post: (plan: P, onProgress: (done: number, total: number) => void) => Promise<PostResult>;
  disabled: string | null; onPosted: () => void;
}) {
  const { t, formatNumber } = useLocale();
  const [phase, setPhase] = useState<Phase<P>>({ s: "idle" });
  const failure = (e: unknown): Phase<P> => {
    const stopped = e instanceof PostStopped ? e : null;
    const cause = stopped ? stopped.cause : e;
    return { s: "error", message: problemFor(cause, "create", t).message, done: stopped ? stopped.done : null };
  };
  const run = () => {
    setPhase({ s: "reading" });
    void review().then((plan) => setPhase({ s: "ready", plan }), (e: unknown) => setPhase(failure(e)));
  };
  const send = (plan: P) => {
    setPhase({ s: "posting", plan, done: 0, total: count(plan) });
    void post(plan, (done, total) => setPhase({ s: "posting", plan, done, total })).then(
      (result) => { setPhase({ s: "done", plan, result }); onPosted(); },
      (e: unknown) => { setPhase(failure(e)); onPosted(); },
    );
  };
  const busy = phase.s === "reading" || phase.s === "posting";
  return (
    <section className="hr-sect card px-4 py-4 grid gap-2" aria-label={title}>
      <h4>{title}</h4>
      <p className="text-label text-ink-400">{intro}</p>
      {disabled !== null ? <Notice>{disabled}</Notice> : (
        <>
          {children}
          <div className="hr-actions"><Button size="sm" loading={phase.s === "reading"} disabled={busy || reviewDisabled} onClick={run}>{reviewLabel}</Button></div>
          {phase.s === "ready" && (
            <div className="grid gap-2">
              {summary(phase.plan)}
              <div className="hr-actions">
                <Button size="sm" variant="primary" disabled={count(phase.plan) === 0} onClick={() => send(phase.plan)}>{count(phase.plan) === 0 ? t("Nothing to post") : postLabel(count(phase.plan))}</Button>
                <Button size="sm" onClick={() => setPhase({ s: "idle" })}>{t("Cancel")}</Button>
              </div>
            </div>
          )}
          {phase.s === "posting" && <p role="status" aria-live="polite">{t("Posting entries… {done} of {total}").replace("{done}", formatNumber(phase.done)).replace("{total}", formatNumber(phase.total))}</p>}
          {phase.s === "done" && (
            <Notice state="saved">
              {t("{posted} entries posted.").replace("{posted}", formatNumber(phase.result.posted))}
              {phase.result.alreadyThere > 0 && <> {t("{count} were already recorded and were not added again.").replace("{count}", formatNumber(phase.result.alreadyThere))}</>}
            </Notice>
          )}
          {phase.s === "error" && (
            <ErrorNotice bare>
              {phase.done !== null && <>{t("Stopped after {done} of the entries. Run it again to post the rest; entries already recorded are not added twice.").replace("{done}", formatNumber(phase.done.posted + phase.done.alreadyThere))} </>}
              {phase.message}
            </ErrorNotice>
          )}
        </>
      )}
    </section>
  );
}

function AccrualSummaryView({ plan }: { plan: AccrualPlan }) {
  const { t, formatNumber } = useLocale();
  const n = (text: string, count: number) => t(text).replace("{count}", formatNumber(count));
  const shown = plan.skipped.slice(0, 10);
  return (
    <div className="grid gap-1">
      {plan.accruingTypes.length === 0 && <p className="text-label">{t("No leave type has an accrual rule yet. Add one under Leave types.")}</p>}
      <p className="text-label">{n("{count} entries to post.", plan.entries.length)}{plan.alreadyRecorded > 0 && <> {n("{count} already recorded for this month.", plan.alreadyRecorded)}</>}</p>
      {plan.nothingDue > 0 && <p className="text-label text-ink-400">{n("{count} employee and leave type pairs add nothing this month, so no entry is written for them.", plan.nothingDue)}</p>}
      {plan.unreadableRules.length > 0 && <p className="text-label text-ink-400">{t("These leave types have an accrual rule the screen cannot read, so they accrue nothing: {codes}.").replace("{codes}", plan.unreadableRules.join(", "))}</p>}
      {plan.skipped.length > 0 && (
        <>
          <p className="text-label">{n("{count} employees are skipped:", plan.skipped.length)}</p>
          <ul className="hr-reasons">{shown.map((s) => <li key={s.employeeId}>{s.name} — {t(SKIP_TEXT[s.reason])}</li>)}</ul>
          {plan.skipped.length > shown.length && <p className="text-micro text-ink-500">{n("and {count} more", plan.skipped.length - shown.length)}</p>}
        </>
      )}
    </div>
  );
}

function RunAccrual({ scope, caps, onPosted }: { scope: HostScope; caps: LedgerCaps; onPosted: () => void }) {
  const { t } = useLocale();
  const [month, setMonth] = useState(() => todayLocal().slice(0, 7));
  const valid = parseMonth(month) !== null && month <= todayLocal().slice(0, 7);
  const problem = month.trim() !== "" && !valid ? t("Choose a month that has started, as YYYY-MM.") : null;
  return (
    <StepAction<AccrualPlan>
      title={t("Run accrual")}
      intro={t("Adds each employee's accrued leave for one month, from the accrual rules on your leave types and each employee's join date. Running it twice for a month adds each entry once.")}
      disabled={caps.aggregate && caps.batch ? null : t("This workspace does not offer batch entries to this screen, so accrual cannot run here.")}
      reviewLabel={t("Review accrual")} reviewDisabled={!valid} postLabel={(count) => t("Post {count} entries").replace("{count}", String(count))}
      review={() => planMonth(scope, month.trim())}
      summary={(plan) => <AccrualSummaryView plan={plan} />}
      count={(plan) => plan.entries.length}
      post={(plan, onProgress) => postEntries(scope, plan.entries, onProgress)}
      onPosted={onPosted}
    >
      <Field label={t("Month")} id="hr-accrual-month" hint={t("YYYY-MM")} error={problem ?? undefined} className="hr-field">
        {(c) => <input {...c} className="field" type="text" inputMode="numeric" maxLength={7} value={month} onChange={(e) => setMonth(e.target.value)} autoComplete="off" />}
      </Field>
    </StepAction>
  );
}

function RecordEarlier({ scope, caps, onPosted }: { scope: HostScope; caps: LedgerCaps; onPosted: () => void }) {
  const { t, formatNumber } = useLocale();
  return (
    <StepAction<ReconcilePlan>
      title={t("Record earlier approvals")}
      intro={t("Leave approved before the ledger existed, or approved from the chat, has no entry, so it has not reduced a balance. This adds the missing entries once; approved requests that already have one are left alone.")}
      disabled={caps.aggregate && caps.batch ? null : t("This workspace does not offer batch entries to this screen, so this cannot run here.")}
      reviewLabel={t("Find approved requests without an entry")} postLabel={(count) => t("Record {count} entries").replace("{count}", String(count))}
      review={() => planReconcile(scope)}
      summary={(plan) => (
        <div className="grid gap-1">
          <p className="text-label">{t("{count} approved requests have no leave entry.").replace("{count}", formatNumber(plan.entries.length))}{plan.alreadyThere > 0 && <> {t("{count} already have one.").replace("{count}", formatNumber(plan.alreadyThere))}</>}</p>
          {plan.unusable.length > 0 && <p className="text-label text-ink-400">{t("{count} approved requests cannot be recorded because they are missing details. Open them in Leave requests.").replace("{count}", formatNumber(plan.unusable.length))}</p>}
        </div>
      )}
      count={(plan) => plan.entries.length}
      post={(plan, onProgress) => postEntries(scope, plan.entries, onProgress)}
      onPosted={onPosted}
    />
  );
}

/** Rejected or cancelled requests whose deduction still stands: list them, then write each one's reversal once. */
function RecoverDeductions({ scope, caps, nameOf, onPosted }: { scope: HostScope; caps: LedgerCaps; nameOf: (id: string) => string; onPosted: () => void }) {
  const { t, formatNumber } = useLocale();
  const n = (text: string, count: number) => t(text).replace("{count}", formatNumber(count));
  return (
    <StepAction<RecoveryPlan>
      title={t("Reverse deductions on rejected requests")}
      intro={t("A request rejected or cancelled outside this screen, for example from the chat, after its approval had already deducted the leave keeps that deduction. This finds those requests and adds the reversing entry once each; requests already reversed are left alone.")}
      disabled={caps.aggregate && caps.batch ? null : t("This workspace does not offer batch entries to this screen, so this cannot run here.")}
      reviewLabel={t("Find rejected requests that still deduct leave")} postLabel={(count) => t("Reverse {count} deductions").replace("{count}", String(count))}
      review={() => planRecovery(scope)}
      summary={(plan) => {
        const shown = plan.rows.slice(0, 10);
        const staff = plan.rows.filter((r) => r.staff).length;
        return (
          <div className="grid gap-1">
            <p className="text-label">{n("{count} rejected or cancelled requests still deduct leave.", plan.rows.length)}{plan.alreadyThere > 0 && <> {n("{count} were already reversed.", plan.alreadyThere)}</>}</p>
            {shown.length > 0 && (
              <ul className="hr-reasons">
                {shown.map((r) => <li key={r.requestId}>{nameOf(r.entry.employee_id)} — {r.entry.leave_type}, {t("{days} days").replace("{days}", signedDays(r.entry.half_days))}</li>)}
              </ul>
            )}
            {plan.rows.length > shown.length && <p className="text-micro text-ink-500">{n("and {count} more requests", plan.rows.length - shown.length)}</p>}
            {plan.unusable.length > 0 && <p className="text-label text-ink-400">{n("{count} cannot be reversed here because their leave entry is not in the expected form. Correct those balances with an adjustment.", plan.unusable.length)}</p>}
            {plan.more && <p className="text-label text-ink-400">{n("Only the newest {count} rejected and {count} cancelled requests in each of Leave requests and Staff requests were checked; older ones are not shown.", RECOVERY_LIMIT)}</p>}
            {staff > 0 && <p className="text-label text-ink-400">{n("{count} of them were filed from the staff view. After reversing, use Update staff balances in People → Staff accounts so those employees see the change.", staff)}</p>}
          </div>
        );
      }}
      count={(plan) => plan.rows.length}
      post={(plan, onProgress) => postEntries(scope, plan.rows.map((r) => r.entry), onProgress)}
      onPosted={onPosted}
    />
  );
}

function AdjustForm({ scope, onDone, onCancel }: { scope: HostScope; onDone: () => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<RecordProblem | null>(null);
  // One reference per open form: a retry after a lost reply meets its own entry instead of adding a second.
  const [ref] = useState(() => adjustmentRef(newRecordId("adj")));
  const [initial] = useState<Values>(() => ({ ...emptyValues(ADJUSTMENT), effectiveDate: todayLocal() }));
  const submit = (values: Values, settle: () => void) => {
    setPending(true); setProblem(null);
    void adjustBalance(scope, values, ref).then(() => { settle(); onDone(); }, (e: unknown) => setProblem(problemFor(e, "create", t))).finally(() => setPending(false));
  };
  return (
    <section aria-label={t("Adjust balance")}>
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading tabIndex={-1} ref={(n) => n?.focus()}>{t("Adjust balance")}</h3>
      <p className="text-label text-ink-400 mt-1"><button type="button" className="lnk" onClick={onCancel}>← {t("Balances")}</button></p>
      <div className="card px-4 py-4 mt-2 grid gap-2">
        <p className="text-label text-ink-400">{t("An adjustment adds a new entry to the ledger. Entries are never edited or deleted, so correct a mistake with another adjustment.")}</p>
        <RecordForm spec={ADJUSTMENT} formId="hr-adjust" initial={initial} problem={problem} onSubmit={submit}>
          <div className="hr-actions">
            <Button type="submit" variant="primary" loading={pending} disabled={pending}>{t("Add adjustment")}</Button>
            <Button onClick={onCancel} disabled={pending}>{t("Cancel")}</Button>
          </div>
        </RecordForm>
      </div>
    </section>
  );
}

/** Balances are the host's sum of ledger entries. The screen never adds them up itself; it shows the aggregate and when it was read. */
export default function BalancesPane({ scope, canWrite, caps }: { scope: HostScope; canWrite: boolean; caps: LedgerCaps }) {
  const { t, formatDate, formatNumber } = useLocale();
  const [adjusting, setAdjusting] = useState(false);
  const [saved, setSaved] = useState(false);
  const balances = useHrLoader(scope, "balances", {}, () => readBalances(scope));
  // Names for the table: one page of 100 at a time up to the screen's limit; a missing name falls back to the record id.
  const names = useHrLoader(scope, "balance-names", {}, async () => Object.fromEntries((await listAll(scope, undefined, [])).map((r) => [r.id, String((r.profile as { display_name?: unknown } | null)?.display_name ?? r.id)])));
  if (adjusting) return <AdjustForm scope={scope} onCancel={() => setAdjusting(false)} onDone={() => { setAdjusting(false); setSaved(true); }} />;
  const data = balances.data;
  const nameOf = (id: string | null) => (id === null ? "—" : names.data?.[id] ?? id);
  const rows = data ? [...data.groups].sort((a, b) => nameOf(a.employeeId).localeCompare(nameOf(b.employeeId)) || String(a.leaveType).localeCompare(String(b.leaveType))) : [];
  const refresh = () => { void balances.store.refresh(); };
  return (
    <section aria-label={t("Balances")} className="hr-list">
      {saved && <Notice className="mb-2" state="saved">{t("The adjustment was added to the ledger.")}</Notice>}
      {balances.loading && <Loading>{t("Reading the leave balances…")}</Loading>}
      {balances.error !== null && !balances.loading && <ErrorNotice onRetry={refresh}>{t(hostErrorText(balances.failure, "The leave balances could not be read."))}</ErrorNotice>}
      <span role="status"><QueryRefresh updating={balances.updating} /></span>
      {data && (
        <>
          <p className="text-label text-ink-400">{t("As of {time}. A balance is the sum of that employee's ledger entries for the leave type, in days.").replace("{time}", formatDate(Date.parse(data.asOf), { dateStyle: "medium", timeStyle: "short" }))}</p>
          {data.truncated && <Notice state="truncated">{t("The host's answer was cut short, so some balances are missing. A person missing from this list is not necessarily at zero. Open an employee to see their own balances.")}</Notice>}
          {rows.length === 0 && !balances.loading && (
            <EmptyState name="balances" title={t("No leave entries yet")}>{t(canWrite ? "Run accrual, or add an adjustment for an opening balance." : "Nothing has been recorded yet.")}</EmptyState>
          )}
          {rows.length > 0 && (
            <DataTable<(typeof rows)[number]>
              label={t("Balances — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table" rowKey={(r) => `${r.employeeId}:${r.leaveType}`}
              columns={[
                { key: "employee", header: t("Employee"), cell: (r) => nameOf(r.employeeId), cellClassName: "text-ink-100" },
                { key: "type", header: t("Leave type"), cell: (r) => r.leaveType ?? "—", cellClassName: "hr-nowrap" },
                { key: "balance", header: t("Balance (days)"), cell: (r) => <span className="num" data-negative={r.halfDays < 0 ? "true" : undefined}>{signedDays(r.halfDays)}</span>, cellClassName: "hr-nowrap" },
                { key: "entries", header: t("Entries"), cell: (r) => <span className="num">{formatNumber(r.entries)}</span> },
              ]}
              rows={rows}
            />
          )}
        </>
      )}
      {canWrite && (
        <div className="grid gap-3 mt-3">
          <div className="hr-actions"><Button variant="primary" onClick={() => { setSaved(false); setAdjusting(true); }}>{t("Adjust balance")}</Button></div>
          <RunAccrual scope={scope} caps={caps} onPosted={refresh} />
          <RecordEarlier scope={scope} caps={caps} onPosted={refresh} />
          <RecoverDeductions scope={scope} caps={caps} nameOf={nameOf} onPosted={refresh} />
        </div>
      )}
    </section>
  );
}
