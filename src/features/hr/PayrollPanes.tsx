import { Button, DataTable, EmptyState, ErrorNotice, Field, Loading, Notice, Select } from "@cadence/screen-ui";
import { useMemo, useState, type ReactNode } from "react";
import { useUnsavedEdits } from "../../bridge/leave";
import { FIRST_MPF_RATE } from "../../domain/mpf-rates";
import { isPeriod, postedEarlier, SKIP_TEXT, supersededBy, type Adjustment, type PayrollLine, type RunPlan, unsavable } from "../../domain/payroll";
import { ACCOUNT_CODE, DEFAULT_PAYROLL_ACCOUNTS, defaultClaimAccounts, type AccountingBatch, type ClaimAccounts, type PayrollAccounts, type Proposal } from "../../domain/posting";
import { FormError, fromMinor, newRecordId, realDate, todayLocal, toMinor } from "../../domain/records";
import type { HostRecord, HostScope } from "./hostActions";
import { hostErrorText } from "./hostErrors";
import { listAll } from "./ledger";
import { useLocale } from "./locale";
import {
  addFirstRate, addSalary, claimProposalFor, computeRun, decideRun, preparePosting, readPostings, readRates, readRunInputs, readRuns, readSalaries, runLines,
  runProposal, saveRun, toRate, toRunFact, toSalary, RUNS, type RunInputs,
} from "./payroll";
import { problemFor } from "./recordsSubmit";
import { useHrLoader } from "./resources";
import { chip } from "./chip";

/** An HKD amount for display, digits grouped: 3000000 is "HKD 30,000.00". */
const hkd = (minor: number | null | undefined) => (typeof minor === "number" && Number.isSafeInteger(minor)
  ? `HKD ${minor < 0 ? "-" : ""}${fromMinor(Math.abs(minor), "HKD").replace(/\B(?=(\d{3})+\.)/g, ",")}` : "—");
const pct = (bp: number) => `${bp / 100}%`;
const prof = (r: HostRecord) => (r.profile ?? {}) as Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : "—");
/** An optional amount the owner types: empty is 0. Null when it is not an exact HKD amount. */
const optionalMinor = (text: string): number | null => (text.trim() === "" || /^0+(\.0{1,2})?$/.test(text.trim()) ? 0 : toMinor(text, "HKD"));

function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="hr-sect card px-4 py-4 grid gap-2" aria-label={title}>
      <h4>{title}</h4>
      {intro && <p className="text-label text-ink-400">{intro}</p>}
      {children}
    </section>
  );
}

/** Names for the employee ids rows store: one read of the directory, page by page. */
function useNames(scope: HostScope) {
  return useHrLoader(scope, "payroll-names", {}, async () => Object.fromEntries((await listAll(scope, undefined, [])).map((r) => [r.id, String(prof(r).display_name ?? r.id)])));
}

// ---- MPF rates -------------------------------------------------------------------------------------------------------
export function RatesPane({ scope, canWrite }: { scope: HostScope; canWrite: boolean }) {
  const { t } = useLocale();
  const rates = useHrLoader(scope, "payroll-rates", {}, () => readRates(scope));
  const [state, setState] = useState<{ s: "idle" } | { s: "running" } | { s: "error"; message: string }>({ s: "idle" });
  const refresh = () => { void rates.store.refresh(); };
  const add = () => {
    setState({ s: "running" });
    void addFirstRate(scope).then(() => { setState({ s: "idle" }); refresh(); }, (e: unknown) => setState({ s: "error", message: problemFor(e, "create", t).message }));
  };
  const rows = [...(rates.data ?? [])].sort((a, b) => String(prof(b).effective_from).localeCompare(String(prof(a).effective_from)));
  return (
    <section aria-label={t("MPF rates")} className="hr-list">
      <p className="text-label text-ink-400">{t("Payroll reads MPF rates and levels from these rows, never from the app's code. Each row applies from its date until a later row. Rows are never edited: a change in the law is a new row.")}</p>
      {rates.loading && <Loading>{t("Reading the MPF rates…")}</Loading>}
      {rates.error !== null && !rates.loading && <ErrorNotice onRetry={refresh}>{t(hostErrorText(rates.failure, "The MPF rates could not be read."))}</ErrorNotice>}
      {rates.data && rows.length === 0 && (
        <EmptyState name="rates" title={t("No MPF rates yet")}>
          <div className="grid gap-2">
            <p className="text-label text-ink-400">{t("Add the MPF rates in effect since {date}: employer {er} and employee {ee}, monthly relevant income levels of {min} and {max}, and the employee's {days}-day contribution holiday. The figures were checked against the MPFA's publication; they are generic, not advice, so check them before you rely on them.")
              .replace("{date}", FIRST_MPF_RATE.effective_from).replace("{er}", pct(FIRST_MPF_RATE.employer_rate_bp)).replace("{ee}", pct(FIRST_MPF_RATE.employee_rate_bp))
              .replace("{min}", hkd(FIRST_MPF_RATE.min_relevant_income_minor)).replace("{max}", hkd(FIRST_MPF_RATE.max_relevant_income_minor)).replace("{days}", String(FIRST_MPF_RATE.holiday_days))}</p>
            {state.s === "error" && <ErrorNotice bare>{state.message}</ErrorNotice>}
            {canWrite ? <div className="hr-actions"><Button variant="primary" loading={state.s === "running"} disabled={state.s === "running"} onClick={add}>{t("Add the MPF rates")}</Button></div>
              : <p className="text-label text-ink-400">{t("Nothing has been added yet.")}</p>}
          </div>
        </EmptyState>
      )}
      {rows.length > 0 && (
        <DataTable<HostRecord>
          label={t("MPF rates — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table hr-pay-table" rowKey={(r) => r.id}
          columns={[
            { key: "from", header: t("Effective from"), cell: (r) => <span className="num">{s(prof(r).effective_from)}</span>, cellClassName: "hr-nowrap" },
            { key: "er", header: t("Employer rate"), cell: (r) => { const x = toRate(r); return x ? pct(x.employerRateBp) : "—"; } },
            { key: "ee", header: t("Employee rate"), cell: (r) => { const x = toRate(r); return x ? pct(x.employeeRateBp) : "—"; } },
            { key: "min", header: t("Minimum relevant income"), cell: (r) => <span className="num">{hkd(toRate(r)?.minRelevantIncomeMinor)}</span>, cellClassName: "hr-nowrap" },
            { key: "max", header: t("Maximum relevant income"), cell: (r) => <span className="num">{hkd(toRate(r)?.maxRelevantIncomeMinor)}</span>, cellClassName: "hr-nowrap" },
            { key: "holiday", header: t("Holiday days"), cell: (r) => <span className="num">{String(toRate(r)?.holidayDays ?? "—")}</span> },
            { key: "source", header: t("Source"), cell: (r) => s(prof(r).source_note) },
          ]}
          rows={rows}
        />
      )}
    </section>
  );
}

// ---- salaries ------------------------------------------------------------------------------------------------------
function SalaryForm({ scope, onDone, onCancel }: { scope: HostScope; onDone: () => void; onCancel: () => void }) {
  const { t } = useLocale();
  // One record id per open form: a retry after a lost reply meets its own row.
  const [recordId] = useState(() => newRecordId("sal"));
  const empty = { employeeNo: "", effectiveFrom: todayLocal().slice(0, 7) + "-01", amount: "", exempt: "no", note: "" };
  const [v, setV] = useState(empty);
  const [problem, setProblem] = useState<{ field: string | null; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const settle = useUnsavedEdits(Object.entries(v).some(([k, x]) => x !== empty[k as keyof typeof empty]));
  const set = (key: keyof typeof v) => (value: string) => { setV((prev) => ({ ...prev, [key]: value })); setProblem(null); };
  const err = (key: string) => (problem?.field === key ? problem.message : undefined);
  const submit = () => {
    const monthly = toMinor(v.amount, "HKD");
    const local = v.employeeNo.trim() === "" ? new FormError("employeeNo", "Enter the employee number.")
      : !realDate(v.effectiveFrom) ? new FormError("effectiveFrom", "Enter a real date as YYYY-MM-DD.")
      : monthly === null ? new FormError("amount", "Enter the monthly amount in HKD, for example 18000 or 18000.50.")
      : Array.from(v.note.trim()).length > 500 ? new FormError("note", "This is too long.") : null;
    if (local) { setProblem({ field: local.field, message: t(local.message) }); return; }
    setPending(true);
    void addSalary(scope, { employeeNo: v.employeeNo, effectiveFrom: v.effectiveFrom, monthlyMinor: monthly!, mpfExempt: v.exempt === "yes", note: v.note }, recordId)
      .then(() => { settle(); onDone(); }, (e: unknown) => setProblem(problemFor(e, "create", t))).finally(() => setPending(false));
  };
  return (
    <section aria-label={t("Add salary")}>
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading tabIndex={-1} ref={(n) => n?.focus()}>{t("Add salary")}</h3>
      <p className="text-label text-ink-400 mt-1"><button type="button" className="lnk" onClick={onCancel}>← {t("Salaries")}</button></p>
      <form className="card px-4 py-4 mt-2 grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="text-label text-ink-400">{t("A salary applies from its date until a later one. Salaries are never edited: to correct one, add it again with the same date; the latest addition for a date counts.")}</p>
        <Field label={t("Employee number")} id="hr-sal-no" required error={err("employeeNo")} className="hr-field">
          {(c) => <input {...c} className="field" value={v.employeeNo} maxLength={32} autoComplete="off" onChange={(e) => set("employeeNo")(e.target.value)} />}
        </Field>
        <Field label={t("Effective from")} id="hr-sal-from" required hint="YYYY-MM-DD" error={err("effectiveFrom")} className="hr-field">
          {(c) => <input {...c} className="field" value={v.effectiveFrom} maxLength={10} autoComplete="off" onChange={(e) => set("effectiveFrom")(e.target.value)} />}
        </Field>
        <Field label={t("Monthly salary (HKD)")} id="hr-sal-amount" required error={err("amount")} className="hr-field">
          {(c) => <input {...c} className="field" inputMode="decimal" value={v.amount} maxLength={15} autoComplete="off" onChange={(e) => set("amount")(e.target.value)} />}
        </Field>
        <Field label={t("Exempt from MPF")} id="hr-sal-exempt" hint={t("Only for an employee the MPF law exempts. Neither side contributes.")} className="hr-field">
          {(c) => <Select id={c.id} full aria-label={t("Exempt from MPF")} value={v.exempt} onChange={set("exempt")} options={[{ value: "no", label: t("No") }, { value: "yes", label: t("Yes") }]} />}
        </Field>
        <Field label={t("Note (optional)")} id="hr-sal-note" error={err("note")} className="hr-field">
          {(c) => <textarea {...c} className="field hr-textarea" rows={2} maxLength={500} value={v.note} onChange={(e) => set("note")(e.target.value)} />}
        </Field>
        {problem !== null && problem.field === null && <ErrorNotice bare>{problem.message}</ErrorNotice>}
        <div className="hr-actions">
          <Button type="submit" variant="primary" loading={pending} disabled={pending}>{t("Add salary")}</Button>
          <Button onClick={onCancel} disabled={pending}>{t("Cancel")}</Button>
        </div>
      </form>
    </section>
  );
}

export function SalariesPane({ scope, canWrite }: { scope: HostScope; canWrite: boolean }) {
  const { t } = useLocale();
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState(false);
  const salaries = useHrLoader(scope, "payroll-salaries", {}, () => readSalaries(scope));
  const names = useNames(scope);
  if (adding) return <SalaryForm scope={scope} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); setSaved(true); void salaries.store.refresh(); }} />;
  const nameOf = (id: string) => names.data?.[id] ?? id;
  const rows = (salaries.data ?? []).map((r) => ({ r, x: toSalary(r) })).sort((a, b) => nameOf(a.x?.employeeId ?? "").localeCompare(nameOf(b.x?.employeeId ?? "")) || (b.x?.effectiveFrom ?? "").localeCompare(a.x?.effectiveFrom ?? "") || (b.x?.seq ?? 0) - (a.x?.seq ?? 0));
  return (
    <section aria-label={t("Salaries")} className="hr-list">
      {saved && <Notice className="mb-2" state="saved">{t("The salary was added.")}</Notice>}
      {canWrite && <div className="hr-actions"><Button variant="primary" onClick={() => { setSaved(false); setAdding(true); }}>{t("Add salary")}</Button></div>}
      {salaries.loading && <Loading>{t("Reading the salaries…")}</Loading>}
      {salaries.error !== null && !salaries.loading && <ErrorNotice onRetry={() => void salaries.store.refresh()}>{t(hostErrorText(salaries.failure, "The salaries could not be read."))}</ErrorNotice>}
      {salaries.data && rows.length === 0 && <EmptyState name="salaries" title={t("No salaries yet")}>{t(canWrite ? "Add a monthly salary for each employee before the first payroll run." : "Nothing has been recorded yet.")}</EmptyState>}
      {rows.length > 0 && (
        <DataTable<(typeof rows)[number]>
          label={t("Salaries — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table hr-pay-table" rowKey={(row) => row.r.id}
          columns={[
            { key: "employee", header: t("Employee"), cell: (row) => (row.x ? nameOf(row.x.employeeId) : "—"), cellClassName: "text-ink-100" },
            { key: "from", header: t("Effective from"), cell: (row) => <span className="num">{row.x?.effectiveFrom ?? "—"}</span>, cellClassName: "hr-nowrap" },
            { key: "monthly", header: t("Monthly salary"), cell: (row) => <span className="num">{row.x && row.x.currency === "HKD" ? hkd(row.x.monthlyMinor) : "—"}</span>, cellClassName: "hr-nowrap" },
            { key: "exempt", header: t("Exempt from MPF"), cell: (row) => (row.x?.mpfExempt ? t("Yes") : t("No")) },
            { key: "seq", header: t("Entry"), cell: (row) => <span className="num">{row.x?.seq ?? "—"}</span> },
            { key: "note", header: t("Note"), cell: (row) => row.x?.note ?? "—" },
          ]}
          rows={rows}
        />
      )}
    </section>
  );
}

// ---- runs ---------------------------------------------------------------------------------------------------------
type LineView = Pick<PayrollLine, "employee_id" | "employee_name" | "monthly_minor" | "additions_minor" | "deductions_minor" | "relevant_income_minor" | "employer_mpf_minor" | "employee_mpf_minor" | "net_pay_minor" | "mpf_exempt" | "join_date" | "rate_effective_from">;

function LinesTable({ lines, edit }: { lines: readonly LineView[]; edit?: { values: Record<string, { add: string; ded: string }>; set: (id: string, key: "add" | "ded", v: string) => void } }) {
  const { t } = useLocale();
  const amountCell = (l: LineView, key: "add" | "ded", stored: number) => (edit
    ? <input className="field hr-amount" aria-label={t(key === "add" ? "Additions" : "Deductions")} inputMode="decimal" maxLength={15} value={edit.values[l.employee_id]?.[key] ?? ""}
        onChange={(e) => edit.set(l.employee_id, key, e.target.value)} />
    : <span className="num">{hkd(stored)}</span>);
  return (
    <DataTable<LineView>
      label={t("Payroll lines — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table hr-pay-table" rowKey={(l) => l.employee_id}
      columns={[
        { key: "employee", header: t("Employee"), cell: (l) => l.employee_name, cellClassName: "text-ink-100" },
        { key: "join", header: t("Join date"), cell: (l) => <span className="num">{l.join_date}</span>, cellClassName: "hr-nowrap" },
        { key: "salary", header: t("Monthly salary"), cell: (l) => <span className="num">{hkd(l.monthly_minor)}</span>, cellClassName: "hr-nowrap" },
        { key: "add", header: t("Additions"), cell: (l) => amountCell(l, "add", l.additions_minor), cellClassName: "hr-nowrap" },
        { key: "ded", header: t("Deductions"), cell: (l) => amountCell(l, "ded", l.deductions_minor), cellClassName: "hr-nowrap" },
        { key: "relevant", header: t("Relevant income"), cell: (l) => <span className="num">{hkd(l.relevant_income_minor)}</span>, cellClassName: "hr-nowrap" },
        { key: "er", header: t("Employer MPF"), cell: (l) => <span className="num">{hkd(l.employer_mpf_minor)}</span>, cellClassName: "hr-nowrap" },
        { key: "ee", header: t("Employee MPF"), cell: (l) => <span className="num">{hkd(l.employee_mpf_minor)}</span>, cellClassName: "hr-nowrap" },
        { key: "net", header: t("Net pay"), cell: (l) => <span className="num">{hkd(l.net_pay_minor)}</span>, cellClassName: "hr-nowrap" },
        { key: "note", header: t("MPF"), cell: (l) => (l.mpf_exempt ? t("Exempt") : `${t("Rates from")} ${l.rate_effective_from}`), cellClassName: "hr-nowrap" },
      ]}
      rows={[...lines]}
    />
  );
}

function TotalsView({ lines }: { lines: readonly LineView[] }) {
  const { t } = useLocale();
  const sum = (k: keyof LineView) => lines.reduce((n, l) => n + (l[k] as number), 0);
  return (
    <p className="text-label">
      {t("Totals")}: {t("Relevant income")} <span className="num">{hkd(sum("relevant_income_minor"))}</span> · {t("Employer MPF")} <span className="num">{hkd(sum("employer_mpf_minor"))}</span> · {t("Employee MPF")} <span className="num">{hkd(sum("employee_mpf_minor"))}</span> · {t("Net pay")} <span className="num">{hkd(sum("net_pay_minor"))}</span>
    </p>
  );
}

function NewRun({ scope, onSaved, onCancel }: { scope: HostScope; onSaved: () => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [period, setPeriod] = useState(() => todayLocal().slice(0, 7));
  const [inputs, setInputs] = useState<RunInputs | null>(null);
  const [values, setValues] = useState<Record<string, { add: string; ded: string }>>({});
  const [phase, setPhase] = useState<{ s: "idle" | "reading" | "saving" } | { s: "error"; message: string }>({ s: "idle" });
  const settle = useUnsavedEdits(Object.values(values).some((x) => x.add !== "" || x.ded !== ""));
  const parsed = useMemo(() => {
    const adjustments: Record<string, Adjustment> = {};
    const bad: string[] = [];
    for (const [id, x] of Object.entries(values)) {
      const add = optionalMinor(x.add), ded = optionalMinor(x.ded);
      if (add === null || ded === null) bad.push(id); else adjustments[id] = { additionsMinor: add, deductionsMinor: ded };
    }
    return { adjustments, bad };
  }, [values]);
  const plan: RunPlan | null = useMemo(() => (inputs ? computeRun(inputs, parsed.adjustments) : null), [inputs, parsed]);
  const live = (inputs?.earlier ?? []).filter((r) => prof(r).status === "draft" || prof(r).status === "approved");
  const read = () => {
    setPhase({ s: "reading" }); setInputs(null);
    void readRunInputs(scope, period.trim()).then((x) => { setInputs(x); setPhase({ s: "idle" }); }, (e: unknown) => setPhase({ s: "error", message: problemFor(e, "create", t).message }));
  };
  const save = () => {
    if (!plan) return;
    setPhase({ s: "saving" });
    void saveRun(scope, plan).then(() => { settle(); onSaved(); }, (e: unknown) => setPhase({ s: "error", message: problemFor(e, "create", t).message }));
  };
  const blocked = plan ? (parsed.bad.length > 0 ? "Enter additions and deductions as HKD amounts, for example 500 or 500.50." : unsavable(plan)) : null;
  const validPeriod = isPeriod(period.trim());
  return (
    <section aria-label={t("New payroll run")} className="grid gap-3">
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading tabIndex={-1} ref={(n) => n?.focus()}>{t("New payroll run")}</h3>
      <p className="text-label text-ink-400"><button type="button" className="lnk" onClick={onCancel}>← {t("Payroll runs")}</button></p>
      <Section title={t("Month")} intro={t("The screen computes each line from the salary in effect and the MPF rate row for the month. Nothing is saved until you save the run; a saved run is a draft until you approve it.")}>
        <Field label={t("Month")} id="hr-run-period" hint="YYYY-MM" error={period.trim() !== "" && !validPeriod ? t("Choose a month as YYYY-MM.") : undefined} className="hr-field">
          {(c) => <input {...c} className="field" inputMode="numeric" maxLength={7} value={period} autoComplete="off" onChange={(e) => { setPeriod(e.target.value); setInputs(null); setValues({}); }} />}
        </Field>
        <div className="hr-actions"><Button size="sm" loading={phase.s === "reading"} disabled={!validPeriod || phase.s === "reading" || phase.s === "saving"} onClick={read}>{t("Compute the run")}</Button></div>
      </Section>
      {phase.s === "error" && <ErrorNotice bare>{phase.message}</ErrorNotice>}
      {plan && (
        <>
          <p className="text-label">{t("Run {ref}, dated {date}.").replace("{ref}", plan.runRef).replace("{date}", plan.entryDate)}</p>
          {live.length > 0 && <Notice>{t("This month already has a run that is a draft or approved: {refs}. Save another only to replace it; cancel a draft first, and post a corrected run only after the earlier entry is reversed in Accounting.").replace("{refs}", live.map((r) => String(prof(r).run_ref)).join(", "))}</Notice>}
          {plan.rate === null && <Notice>{t("No MPF rate is in effect for this month. Add the MPF rates first.")}</Notice>}
          {plan.skipped.length > 0 && (
            <div>
              <p className="text-label">{t("Not in this run:")}</p>
              <ul className="hr-reasons">{plan.skipped.slice(0, 10).map((x) => <li key={x.employeeId}>{x.name} — {t(SKIP_TEXT[x.reason])}</li>)}</ul>
              {plan.skipped.length > 10 && <p className="text-micro text-ink-500">{t("and {count} more").replace("{count}", String(plan.skipped.length - 10))}</p>}
            </div>
          )}
          {plan.invalid.length > 0 && <ErrorNotice bare>{t("Deductions are more than the pay for: {names}.").replace("{names}", plan.invalid.map((x) => x.name).join(", "))}</ErrorNotice>}
          {(plan.lines.length > 0 || plan.invalid.length > 0) && inputs && (
            <LinesTable
              lines={[...plan.lines, ...plan.invalid.map((x) => ({ employee_id: x.employeeId, employee_name: x.name, monthly_minor: 0, additions_minor: 0, deductions_minor: 0, relevant_income_minor: 0, employer_mpf_minor: 0, employee_mpf_minor: 0, net_pay_minor: 0, mpf_exempt: false, join_date: "—", rate_effective_from: "—" }))]}
              edit={{ values, set: (id, key, v) => setValues((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { add: "", ded: "" }), [key]: v } })) }}
            />
          )}
          {plan.lines.length > 0 && <TotalsView lines={plan.lines} />}
          <p className="text-micro text-ink-500">{t("Additions are relevant income such as allowances, commission or a bonus; deductions are unpaid leave or a part month. The minimum and maximum levels are the monthly ones, also for a part month.")}</p>
          {blocked !== null && <p className="text-label text-ink-400">{t(blocked)}</p>}
          <div className="hr-actions">
            <Button variant="primary" loading={phase.s === "saving"} disabled={blocked !== null || phase.s === "saving"} onClick={save}>{t("Save run as draft")}</Button>
            <Button onClick={onCancel} disabled={phase.s === "saving"}>{t("Cancel")}</Button>
          </div>
        </>
      )}
    </section>
  );
}

function RunDetail({ scope, run, canWrite, onBack, onChanged }: { scope: HostScope; run: HostRecord; canWrite: boolean; onBack: () => void; onChanged: () => void }) {
  const { t } = useLocale();
  const x = prof(run);
  const lines = useHrLoader(scope, "payroll-run-lines", { id: run.id, revision: run.revision }, () => runLines(scope, run));
  const [confirm, setConfirm] = useState<"approved" | "cancelled" | null>(null);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<{ s: "idle" | "saving" } | { s: "error"; message: string }>({ s: "idle" });
  const decide = (decision: "approved" | "cancelled") => {
    setPhase({ s: "saving" });
    void decideRun(scope, run, decision, todayLocal(), note).then(() => { setConfirm(null); setPhase({ s: "idle" }); onChanged(); }, (e: unknown) => setPhase({ s: "error", message: problemFor(e, "update", t).message }));
  };
  return (
    <section aria-label={String(x.run_ref ?? run.id)} className="grid gap-3">
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading tabIndex={-1} ref={(n) => n?.focus()}>{s(x.run_ref)}</h3>
      <p className="text-label text-ink-400"><button type="button" className="lnk" onClick={onBack}>← {t("Payroll runs")}</button></p>
      <p className="text-label">{t("Month")} <span className="num">{s(x.period)}</span> · {t("Dated")} <span className="num">{s(x.entry_date)}</span> · {chip(x.status, t)}{x.decided_on ? <> · {t("Decided on")} <span className="num">{s(x.decided_on)}</span></> : null}</p>
      {typeof x.decision_note === "string" && x.decision_note !== "" && <p className="text-label text-ink-400">{x.decision_note}</p>}
      {x.status === "approved" && <p className="text-label text-ink-400">{t("An approved run cannot be changed. To correct it, reverse its entry in Accounting if it was posted, then save a new run for the month.")}</p>}
      {lines.loading && <Loading>{t("Reading the run's lines…")}</Loading>}
      {lines.error !== null && !lines.loading && <ErrorNotice onRetry={() => void lines.store.refresh()}>{t(hostErrorText(lines.failure, "The run's lines could not be read."))}</ErrorNotice>}
      {lines.data && <><LinesTable lines={lines.data} /><TotalsView lines={lines.data} /></>}
      {phase.s === "error" && <ErrorNotice bare>{phase.message}</ErrorNotice>}
      {canWrite && x.status === "draft" && (confirm === null
        ? <div className="hr-actions">
            <Button variant="primary" disabled={!lines.data} onClick={() => setConfirm("approved")}>{t("Approve run")}</Button>
            <Button onClick={() => setConfirm("cancelled")}>{t("Cancel run")}</Button>
          </div>
        : <div className="card px-4 py-4 grid gap-2">
            <p className="text-label">{t(confirm === "approved" ? "Approve this run? An approved run cannot be changed." : "Cancel this draft? Its number is not used again.")}</p>
            <Field label={t("Note (optional)")} id="hr-run-note" className="hr-field">
              {(c) => <input {...c} className="field" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div className="hr-actions">
              <Button variant="primary" loading={phase.s === "saving"} disabled={phase.s === "saving"} onClick={() => decide(confirm)}>{t(confirm === "approved" ? "Approve run" : "Cancel run")}</Button>
              <Button onClick={() => setConfirm(null)} disabled={phase.s === "saving"}>{t("Back")}</Button>
            </div>
          </div>)}
    </section>
  );
}

export function RunsPane({ scope, canWrite, canBatch }: { scope: HostScope; canWrite: boolean; canBatch: boolean }) {
  const { t } = useLocale();
  const [view, setView] = useState<{ s: "list" } | { s: "new" } | { s: "run"; id: string }>({ s: "list" });
  const [saved, setSaved] = useState(false);
  const runs = useHrLoader(scope, "payroll-runs", {}, () => readRuns(scope));
  const refresh = () => { void runs.store.refresh(); };
  if (view.s === "new") return <NewRun scope={scope} onCancel={() => setView({ s: "list" })} onSaved={() => { setSaved(true); refresh(); setView({ s: "list" }); }} />;
  const rows = [...(runs.data ?? [])].sort((a, b) => String(prof(b).period).localeCompare(String(prof(a).period)) || Number(prof(b).run_no) - Number(prof(a).run_no));
  const open = view.s === "run" ? rows.find((r) => r.id === view.id) : undefined;
  if (open) return <RunDetail key={`${open.id}:${open.revision}`} scope={scope} run={open} canWrite={canWrite} onBack={() => setView({ s: "list" })} onChanged={refresh} />;
  return (
    <section aria-label={t("Payroll runs")} className="hr-list">
      {saved && <Notice className="mb-2" state="saved">{t("The run was saved as a draft. Open it to approve it.")}</Notice>}
      {canWrite && (canBatch
        ? <div className="hr-actions"><Button variant="primary" onClick={() => { setSaved(false); setView({ s: "new" }); }}>{t("New payroll run")}</Button></div>
        : <Notice>{t("This workspace does not offer batch saves to this screen, so a payroll run cannot be saved here.")}</Notice>)}
      {runs.loading && <Loading>{t("Reading the payroll runs…")}</Loading>}
      {runs.error !== null && !runs.loading && <ErrorNotice onRetry={refresh}>{t(hostErrorText(runs.failure, "The payroll runs could not be read."))}</ErrorNotice>}
      {runs.data && rows.length === 0 && <EmptyState name="runs" title={t("No payroll runs yet")}>{t(canWrite ? "Add the MPF rates and salaries, then start a new payroll run." : "Nothing has been recorded yet.")}</EmptyState>}
      {rows.length > 0 && (
        <DataTable<HostRecord>
          label={t("Payroll runs — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table hr-pay-table" rowKey={(r) => r.id}
          rowProps={(r) => ({ className: "hr-row-open", onClick: (e: { target: EventTarget }) => { if (!(e.target as HTMLElement).closest("button, input, a")) setView({ s: "run", id: r.id }); } })}
          columns={[
            { key: "ref", header: t("Run"), cell: (r) => <button type="button" className="lnk" onClick={() => setView({ s: "run", id: r.id })}>{s(prof(r).run_ref)}</button>, cellClassName: "text-ink-100 hr-nowrap" },
            { key: "period", header: t("Month"), cell: (r) => <span className="num">{s(prof(r).period)}</span>, cellClassName: "hr-nowrap" },
            { key: "lines", header: t("Lines"), cell: (r) => <span className="num">{String(prof(r).line_count ?? "—")}</span> },
            { key: "status", header: t("Status"), cell: (r) => chip(prof(r).status, t) },
            { key: "decided", header: t("Decided on"), cell: (r) => <span className="num">{s(prof(r).decided_on)}</span>, cellClassName: "hr-nowrap" },
          ]}
          rows={rows}
        />
      )}
    </section>
  );
}

// ---- postings -------------------------------------------------------------------------------------------------------
interface Postable {
  source: "payroll" | "claim"; id: string; ref: string; label: string; category: string; posting: HostRecord | null;
  /** For a run: its month and number, the later approved run that supersedes it, and earlier runs HR records as posted. */
  period: string; runNo: number; supersededBy: string | null; postedEarlier: string[];
}

function BatchView({ batch }: { batch: AccountingBatch | Proposal }) {
  const { t } = useLocale();
  const lines = "items" in batch ? batch.items.flatMap((i) => (i.table === "journal_lines" ? [{ code: i.profile.account_code, amount: i.profile.amount_minor, memo: i.profile.memo }] : []))
    : batch.lines.map((l) => ({ code: l.account_code, amount: l.amount_minor, memo: l.memo }));
  const debit = lines.reduce((n, l) => n + Math.max(l.amount, 0), 0);
  return (
    <div className="grid gap-1">
      <DataTable<(typeof lines)[number]>
        label={t("Journal lines")} wrapClassName="hr-table-wrap" tableClassName="hr-table hr-pay-table" rowKey={(l) => `${l.code}:${l.amount}`}
        columns={[
          { key: "code", header: t("Account"), cell: (l) => <span className="num">{l.code}</span> },
          { key: "dr", header: t("Debit"), cell: (l) => <span className="num">{l.amount > 0 ? hkd(l.amount) : ""}</span>, cellClassName: "hr-nowrap" },
          { key: "cr", header: t("Credit"), cell: (l) => <span className="num">{l.amount < 0 ? hkd(-l.amount) : ""}</span>, cellClassName: "hr-nowrap" },
          { key: "memo", header: t("Memo"), cell: (l) => l.memo ?? "—" },
        ]}
        rows={lines}
      />
      <p className="text-label text-ink-400">{t("Debits and credits each {amount}.").replace("{amount}", hkd(debit))}</p>
    </div>
  );
}

function PrepareForm({ scope, item, onDone, onCancel }: { scope: HostScope; item: Postable; onDone: () => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [codes, setCodes] = useState<Record<string, string>>(() => ({ ...(item.source === "payroll" ? DEFAULT_PAYROLL_ACCOUNTS : defaultClaimAccounts(item.category)) }));
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [phase, setPhase] = useState<{ s: "idle" | "busy" } | { s: "error"; message: string }>({ s: "idle" });
  // The screen cannot read Accounting: the owner confirms an earlier posted run of the month is reversed there, and
  // the hr-posting skill checks the journal before it stages anything.
  const [reversedConfirmed, setReversedConfirmed] = useState(false);
  const labels: Record<string, string> = item.source === "payroll"
    ? { salaries: "Salaries expense account", mpfExpense: "MPF expense account", netPay: "Net pay paid from (bank account)", mpfPayable: "MPF payable account" }
    : { expense: "Expense account", payable: "Owed to the employee (liability account)" };
  const bad = Object.values(codes).some((c) => !ACCOUNT_CODE.test(c.trim()));
  const fail = (e: unknown) => setPhase({ s: "error", message: problemFor(e, "create", t).message });
  const preview = () => {
    setPhase({ s: "busy" }); setProposal(null);
    const trimmed = Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, v.trim()]));
    const next = item.source === "payroll" ? runProposal(scope, item.id, trimmed as unknown as PayrollAccounts, undefined, new Set(reversedConfirmed ? item.postedEarlier : [])) : claimProposalFor(scope, item.id, trimmed as unknown as ClaimAccounts);
    void next.then((p) => { setProposal(p); setPhase({ s: "idle" }); }, (e: unknown) => fail(e instanceof Error && e.name === "PostingError" ? new FormError(null, e.message) : e));
  };
  const save = () => {
    if (!proposal) return;
    setPhase({ s: "busy" });
    void preparePosting(scope, proposal).then(onDone, fail);
  };
  return (
    <section aria-label={t("Prepare posting")} className="grid gap-3">
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading tabIndex={-1} ref={(n) => n?.focus()}>{t("Prepare posting")} {item.ref}</h3>
      <p className="text-label text-ink-400"><button type="button" className="lnk" onClick={onCancel}>← {t("Postings")}</button></p>
      <Section title={t("Accounts")} intro={t("Codes from the Accounting app's chart. The defaults are its starter chart's accounts, a generic template rather than accounting advice; change them to match your chart.")}>
        {Object.keys(labels).map((key) => (
          <Field key={key} label={t(labels[key]!)} id={`hr-post-${key}`} className="hr-field" error={ACCOUNT_CODE.test((codes[key] ?? "").trim()) ? undefined : t("An account code is 1 to 12 capitals, digits or hyphens, as in the Accounting chart.")}>
            {(c) => <input {...c} className="field" maxLength={12} autoComplete="off" value={codes[key] ?? ""} onChange={(e) => { setCodes((prev) => ({ ...prev, [key]: e.target.value.toUpperCase() })); setProposal(null); }} />}
          </Field>
        ))}
        {item.postedEarlier.length > 0 && (
          <div className="grid gap-1">
            <p className="text-label">{t("HR records an earlier run of this month as posted: {refs}. Only one payroll a month belongs in the books. Reverse it in the Accounting app's Journal before this run is posted.").replace("{refs}", item.postedEarlier.join(", "))}</p>
            <label className="text-label hr-actions"><input type="checkbox" checked={reversedConfirmed} onChange={(e) => { setReversedConfirmed(e.target.checked); setProposal(null); }} /> {t("I have reversed it in the Accounting app's Journal. The assistant checks the journal before it posts this run.")}</label>
          </div>
        )}
        <div className="hr-actions"><Button size="sm" loading={phase.s === "busy" && !proposal} disabled={bad || phase.s === "busy"} onClick={preview}>{t("Show the entry")}</Button></div>
      </Section>
      {phase.s === "error" && <ErrorNotice bare>{phase.message}</ErrorNotice>}
      {proposal && (
        <Section title={proposal.entryRef} intro={t("Dated {date}. {description}").replace("{date}", proposal.entryDate).replace("{description}", proposal.description)}>
          <BatchView batch={proposal} />
          <div className="hr-actions">
            <Button variant="primary" loading={phase.s === "busy"} disabled={phase.s === "busy"} onClick={save}>{t("Save for posting")}</Button>
            <Button onClick={onCancel} disabled={phase.s === "busy"}>{t("Cancel")}</Button>
          </div>
        </Section>
      )}
    </section>
  );
}

function PostingState({ item }: { item: Postable }) {
  const { t } = useLocale();
  const x = item.posting ? prof(item.posting) : null;
  const superseded = item.supersededBy !== null && <> {t("Superseded by {ref}: only the latest approved run of a month is posted.").replace("{ref}", item.supersededBy)}</>;
  if (x === null) return item.supersededBy !== null ? <span className="text-ink-400">{superseded}</span> : <span className="text-ink-400">{t("Not prepared")}</span>;
  if (x.stage === "posted") {
    const mismatch = x.posting_ref !== x.entry_ref;
    return <span>{t("HR has a record that this was posted as {ref} on {date}.").replace("{ref}", s(x.posting_ref)).replace("{date}", s(x.posted_on))}{mismatch && <> {t("That reference is not this entry's; check the Accounting journal.")}</>}{superseded}</span>;
  }
  return <span>{t("Prepared as {ref}; not yet recorded as posted.").replace("{ref}", s(x.entry_ref))}{superseded}</span>;
}

export function PostingsPane({ scope, canWrite }: { scope: HostScope; canWrite: boolean }) {
  const { t } = useLocale();
  const [preparing, setPreparing] = useState<Postable | null>(null);
  const [saved, setSaved] = useState(false);
  const data = useHrLoader(scope, "payroll-postings", {}, async () => {
    const [runs, claims, postings] = await Promise.all([
      listAll(scope, RUNS, [{ field: "status", op: "eq", value: "approved" }]), listAll(scope, "claims", [{ field: "status", op: "eq", value: "approved" }]), readPostings(scope),
    ]);
    const find = (source: string, id: string) => postings.find((r) => prof(r).source === source && prof(r).source_id === id) ?? null;
    const facts = runs.map(toRunFact);
    const posted = new Set(postings.filter((r) => prof(r).source === "payroll" && prof(r).stage === "posted").map((r) => String(prof(r).source_id)));
    const items: Postable[] = [
      ...runs.map((r) => {
        const fact = toRunFact(r);
        return {
          source: "payroll" as const, id: r.id, ref: fact.runRef, label: `${t("Payroll")} ${s(prof(r).period)}`, category: "", posting: find("payroll", r.id),
          period: fact.period, runNo: fact.runNo, supersededBy: supersededBy(fact, facts)?.runRef ?? null, postedEarlier: postedEarlier(fact, facts, posted).map((e) => e.runRef),
        };
      }),
      ...claims.map((r) => ({ source: "claim" as const, id: r.id, ref: `hr-claim-${r.id}`, label: `${t("Claim")}: ${s(prof(r).employee_name)}, ${s(prof(r).merchant)} ${prof(r).currency ?? ""} ${typeof prof(r).amount_minor === "number" ? fromMinor(prof(r).amount_minor as number, String(prof(r).currency ?? "HKD")) : ""}`, category: String(prof(r).category ?? "other"), posting: find("claim", r.id), period: "", runNo: 0, supersededBy: null, postedEarlier: [] })),
    ];
    // Runs first, newest month and highest run number first (numbers compared as numbers: run 10 after run 9), then claims.
    return items.sort((a, b) => Number(a.source === "claim") - Number(b.source === "claim") || b.period.localeCompare(a.period) || b.runNo - a.runNo || a.ref.localeCompare(b.ref));
  });
  const refresh = () => { void data.store.refresh(); };
  if (preparing) return <PrepareForm scope={scope} item={preparing} onCancel={() => setPreparing(null)} onDone={() => { setPreparing(null); setSaved(true); refresh(); }} />;
  const rows = data.data ?? [];
  return (
    <section aria-label={t("Postings")} className="hr-list">
      <p className="text-label text-ink-400">{t("Approved payroll runs and claims can be posted to the Accounting app's journal. HR prepares the entry; ask the assistant to post it. It checks the Accounting chart and journal, stages the entry for your approval, and records it here as posted only after it finds the entry in the journal. This screen cannot read the Accounting journal, which is the record of what was posted. Accounting refuses an entry dated on or before its opening balances. Without the Accounting app, posting is unavailable and the rest of HR works as before.")}</p>
      {saved && <Notice className="mb-2" state="saved">{t("The entry was prepared. Ask the assistant to post it to Accounting.")}</Notice>}
      {data.loading && <Loading>{t("Reading approved runs and claims…")}</Loading>}
      {data.error !== null && !data.loading && <ErrorNotice onRetry={refresh}>{t(hostErrorText(data.failure, "The approved runs and claims could not be read."))}</ErrorNotice>}
      {data.data && rows.length === 0 && <EmptyState name="postings" title={t("Nothing to post yet")}>{t("Approved payroll runs and approved claims appear here.")}</EmptyState>}
      {rows.length > 0 && (
        <DataTable<Postable>
          label={t("Postings — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table hr-pay-table" rowKey={(r) => `${r.source}:${r.id}`}
          columns={[
            { key: "what", header: t("Approved"), cell: (r) => r.label, cellClassName: "text-ink-100" },
            { key: "ref", header: t("Accounting reference"), cell: (r) => <span className="num">{r.ref}</span>, cellClassName: "hr-nowrap" },
            { key: "state", header: t("Posting"), cell: (r) => <PostingState item={r} /> },
            { key: "act", header: t("Actions"), cell: (r) => (canWrite && r.supersededBy === null && (r.posting === null || prof(r.posting).stage === "prepared")
              ? <Button size="sm" onClick={() => { setSaved(false); setPreparing(r); }}>{t(r.posting === null ? "Prepare posting" : "Change accounts")}</Button> : null) },
          ]}
          rows={rows}
        />
      )}
      {rows.some((r) => r.posting !== null && prof(r.posting).stage === "prepared") && (
        <p className="text-micro text-ink-500">{t("Before asking again for a prepared entry, check the Accounting journal for its reference: it may already be there.")}</p>
      )}
    </section>
  );
}
