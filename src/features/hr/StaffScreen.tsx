import { Button, ConfirmDialog, ErrorNotice, Loading, Notice, Select } from "@cadence/screen-ui";
import { useEffect, useMemo, useState } from "react";
import { FormError, fromHalfDays, fromMinor, toHalfDays, type Values } from "../../domain/records";
import {
  CLAIM_CATEGORIES, clientRef, daySummary, hkDayStart, hkParts, hkWeekStart, isLinked, memberCode, memberStatus, nextDirection, readPunch, STAFF,
  type Direction, type Snapshot,
} from "../../domain/staff";
import type { HostRecord, HostScope } from "./hostActions";
import { hostErrorText } from "./hostErrors";
import { useLocale } from "./locale";
import { useHrLoader } from "./resources";
import { fileClaim, fileLeave, listMine, punch, readMemberHome, requestLink, withdrawLeave } from "./staff";

/** The release the staff view names in its bar. A test keeps it equal to package.json. */
export const APP_VERSION = "0.5.0";
const TABS = ["My leave", "My claims", "Clock"] as const;
const TZ = "Asia/Hong_Kong";
const nowS = () => Math.floor(Date.now() / 1000);
const p = (r: HostRecord) => ((r.profile && typeof r.profile === "object" ? r.profile : {}) as Record<string, unknown>);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const STATUS_LABEL: Record<string, string> = { pending: "Pending", withdrawn: "Withdrawn", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", submitted: "Submitted", unknown: "Unknown" };
const CATEGORY_LABEL: Record<string, string> = { travel: "Travel", meals: "Meals", supplies: "Supplies", other: "Other" };
const pill = (status: string, t: (s: string) => string) => <span className="chip" data-status={status}>{t(STATUS_LABEL[status] ?? "Unknown")}</span>;
/** A save that may have landed (no answer, a conflict, the store busy) is never called a failure that saved nothing. */
const unsure = (e: unknown) => e instanceof Error && "status" in e && [409, 503, 504].includes((e as { status: number }).status);

/**
 * The member's view of HR (0.5.0): My leave, My claims and Clock, phone width first. It reads and files only the
 * member's own rows in tables that declare `row_owner`; it never reads People, salaries, payroll or another person's
 * rows (those tables answer a member 403, and the board would close the frame).
 */
export default function StaffScreen({ scope, actions }: { scope: HostScope; actions: string[] }) {
  const { t } = useLocale();
  const [tab, setTab] = useState(0);
  const home = useHrLoader(scope, "staff-home", {}, () => readMemberHome(scope));
  const snapshot = home.data?.snapshot ?? null;
  const canFile = actions.includes("records.create") && actions.includes("records.list");
  return (
    <main className="app-outlet hr hr-staff">
      <header className="hr-staff-bar">
        <span className="hr-staff-app">HR</span><span className="hr-staff-ver num">v{APP_VERSION}</span>
        {isLinked(snapshot) && <span className="hr-staff-who">{snapshot.employeeName ?? ""}{snapshot.employeeNo ? ` · ${snapshot.employeeNo}` : ""}</span>}
      </header>
      <nav className="hr-staff-tabs" role="tablist" aria-label={t("HR sections")}>
        {TABS.map((label, i) => (
          <button key={label} type="button" role="tab" id={`hr-staff-tab-${i}`} aria-controls="hr-staff-panel" aria-selected={tab === i} className="hr-staff-tab" onClick={() => setTab(i)}
            onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const next = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length; setTab(next); document.getElementById(`hr-staff-tab-${next}`)?.focus(); } }}
            tabIndex={tab === i ? 0 : -1}>{t(label)}</button>
        ))}
      </nav>
      <div id="hr-staff-panel" role="tabpanel" aria-labelledby={`hr-staff-tab-${tab}`} className="hr-staff-body">
        {!canFile ? <Notice>{t("This workspace does not offer HR's records to this session.")}</Notice>
          : home.loading ? <Loading>{t("Reading your HR details…")}</Loading>
          : home.error !== null && !home.data ? (
            <>
              {tab === 0 && <BalanceCard state="error" snapshot={null} />}
              <ErrorNotice onRetry={() => void home.store.refresh()}>{t(hostErrorText(home.failure, "Your HR details could not be read. Try again later."))}</ErrorNotice>
            </>
          )
          : !isLinked(snapshot) ? <NotLinked scope={scope} requested={home.data?.requested ?? null} onSent={() => void home.store.refresh()} />
          : tab === 0 ? <MyLeave scope={scope} snapshot={snapshot} />
          : tab === 1 ? <MyClaims scope={scope} snapshot={snapshot} />
          : <Clock scope={scope} snapshot={snapshot} />}
      </div>
    </main>
  );
}

// ---- not linked ----------------------------------------------------------------------------------------------------
function NotLinked({ scope, requested, onSent }: { scope: HostScope; requested: HostRecord | null; onSent: () => void }) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [employeeNo, setEmployeeNo] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FormError | string | null>(null);
  const send = () => {
    setPending(true); setProblem(null);
    void requestLink(scope, name, employeeNo, nowS()).then(onSent).catch((e: unknown) => setProblem(e instanceof FormError ? e : t(hostErrorText(e, "The request was not sent. Try again.")))).finally(() => setPending(false));
  };
  const at = requested ? p(requested).requested_at : null;
  const code = requested ? memberCode(str(p(requested).member_id)) : "";
  return (
    <div className="hr-staff-stack">
      <div className="hr-staff-note warn">{t("Your account is not linked to an employee record, so you cannot request leave, submit claims or clock in. Ask the owner to link you in People.")}</div>
      {requested ? (
        <div className="card hr-staff-card">
          <h2>{t("Request sent")}</h2>
          <p className="text-label text-ink-400">{t("Sent on {date}. Your code is {code}: the owner sees the same code in People → Staff accounts. Tell them it is you.").replace("{date}", typeof at === "number" ? hkParts(at).date : "—").replace("{code}", code)}</p>
        </div>
      ) : (
        <form className="card hr-staff-card" aria-label={t("Ask to be linked")} onSubmit={(e) => { e.preventDefault(); send(); }}>
          <h2>{t("Ask to be linked")}</h2>
          <label className="text-label" htmlFor="hr-link-name">{t("Your name")}</label>
          <input id="hr-link-name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" aria-invalid={problem instanceof FormError && problem.field === "name"} />
          <label className="text-label" htmlFor="hr-link-no">{t("Employee number (optional)")}</label>
          <input id="hr-link-no" className="field" value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} maxLength={32} autoComplete="off" />
          {problem && <ErrorNotice bare>{problem instanceof FormError ? t(problem.message) : problem}</ErrorNotice>}
          <Button type="submit" variant="primary" full loading={pending} disabled={pending}>{t("Ask the owner to link me")}</Button>
        </form>
      )}
    </div>
  );
}

// ---- my leave ------------------------------------------------------------------------------------------------------
function BalanceCard({ state, snapshot }: { state: "ready" | "error"; snapshot: Snapshot | null }) {
  const { t, formatDate } = useLocale();
  const name = (code: string) => snapshot?.types.find((x) => x.code === code)?.name ?? code;
  return (
    <section className="card hr-staff-card" aria-label={t("Leave balance")}>
      <h2>{t("Leave balance")}</h2>
      {state === "error" || snapshot === null ? <div className="hr-staff-note fail">{t("The balance could not be read, so no figure is shown. Try again later.")}</div>
        : snapshot.balances.length === 0 ? <p className="text-label text-ink-400">{t("No leave recorded yet. Your balance shows here once the owner runs accrual.")}</p>
        : (
          <>
            {snapshot.balances.map((b) => (
              <div key={b.leaveType} className="hr-staff-bal"><span>{name(b.leaveType)} <span className="text-ink-500 num">{b.leaveType}</span></span><span className="hr-staff-n num">{fromHalfDays(b.halfDays)}</span></div>
            ))}
            <p className="text-micro text-ink-500">{t("As of {time} · in days · sum of all entries").replace("{time}", formatDate(snapshot.asOf * 1000, { dateStyle: "medium", timeStyle: "short", timeZone: TZ }))}</p>
            {snapshot.truncated && <p className="text-micro text-ink-500">{t("The owner's read was cut short, so a balance may be missing.")}</p>}
          </>
        )}
    </section>
  );
}

function MyLeave({ scope, snapshot }: { scope: HostScope; snapshot: Snapshot & { employeeId: string } }) {
  const { t } = useLocale();
  const mine = useHrLoader(scope, "staff-my-leave", {}, async () => {
    const [requests, withdrawals] = await Promise.all([listMine(scope, STAFF.leave, { orderBy: "start_date" }), listMine(scope, STAFF.withdrawals, { limit: 100 })]);
    return { requests, withdrawn: new Set(withdrawals.map((w) => str(p(w).request_id))) };
  });
  const blank: Values = { leaveType: snapshot.types[0]?.code ?? "", startDate: "", endDate: "", days: "", reason: "" };
  const [values, setValues] = useState<Values>(blank);
  const [ref, setRef] = useState(() => clientRef("slv"));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FormError | string | null>(null);
  const [sent, setSent] = useState(false);
  const [withdrawing, setWithdrawing] = useState<HostRecord | null>(null);
  const set = (key: string) => (v: string) => { setValues({ ...values, [key]: v }); setSent(false); };
  const submit = () => {
    setPending(true); setProblem(null); setSent(false);
    void fileLeave(scope, snapshot, values, ref).then(() => { setSent(true); setValues(blank); setRef(clientRef("slv")); void mine.store.refresh(); })
      .catch((e: unknown) => setProblem(e instanceof FormError ? e : t(unsure(e) ? "The workspace did not answer, so your request may not be saved. Check My requests below before you submit again." : hostErrorText(e, "Your request was not saved. Check the fields and try again."))))
      .finally(() => setPending(false));
  };
  const withdraw = () => {
    if (!withdrawing) return;
    setPending(true); setProblem(null);
    void withdrawLeave(scope, withdrawing, nowS()).then(() => { setWithdrawing(null); void mine.store.refresh(); })
      .catch((e: unknown) => setProblem(e instanceof FormError ? e : t(hostErrorText(e, "The request was not withdrawn. Try again.")))).finally(() => setPending(false));
  };
  const half = toHalfDays(values.days ?? "");
  const current = snapshot.balances.find((b) => b.leaveType === values.leaveType)?.halfDays ?? null;
  const fieldError = (key: string) => problem instanceof FormError && problem.field === key ? t(problem.message) : null;
  const typeName = (code: string) => snapshot.types.find((x) => x.code === code)?.name ?? code;
  return (
    <div className="hr-staff-stack">
      <BalanceCard state="ready" snapshot={snapshot} />
      <form className="card hr-staff-card" aria-label={t("Request leave")} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>{t("Request leave")}</h2>
        {snapshot.types.length === 0 ? <p className="text-label text-ink-400">{t("No leave types are set up yet. Ask the owner.")}</p> : (
          <>
            <label className="text-label" htmlFor="hr-my-type">{t("Leave type")}</label>
            <Select id="hr-my-type" aria-label={t("Leave type")} full value={values.leaveType ?? ""} onChange={set("leaveType")} options={snapshot.types.map((x) => ({ value: x.code, label: `${x.name} ${x.code}` }))} />
            <div className="hr-two">
              <div><label className="text-label" htmlFor="hr-my-from">{t("First day")}</label><input id="hr-my-from" className="field" type="date" value={values.startDate} onChange={(e) => set("startDate")(e.target.value)} /></div>
              <div><label className="text-label" htmlFor="hr-my-to">{t("Last day")}</label><input id="hr-my-to" className="field" type="date" value={values.endDate} onChange={(e) => set("endDate")(e.target.value)} /></div>
            </div>
            {(fieldError("startDate") ?? fieldError("endDate")) && <p className="hr-staff-err">{fieldError("startDate") ?? fieldError("endDate")}</p>}
            <label className="text-label" htmlFor="hr-my-days">{t("Days")}</label>
            <input id="hr-my-days" className="field" inputMode="decimal" value={values.days} onChange={(e) => set("days")(e.target.value)} aria-describedby="hr-my-days-hint" />
            <p id="hr-my-days-hint" className="text-micro text-ink-500">
              {t("Whole or half days, for example 1.5.")}{current !== null && half !== null && <> {t("Balance after: {days} days (deducted only when approved)").replace("{days}", fromHalfDays(current - half))}</>}
            </p>
            {fieldError("days") && <p className="hr-staff-err">{fieldError("days")}</p>}
            <label className="text-label" htmlFor="hr-my-reason">{t("Reason (optional)")}</label>
            <textarea id="hr-my-reason" className="field hr-textarea" rows={2} maxLength={500} value={values.reason} onChange={(e) => set("reason")(e.target.value)} placeholder={t("Do not enter medical details")} />
            {problem && !(problem instanceof FormError && ["startDate", "endDate", "days"].includes(problem.field ?? "")) && <ErrorNotice bare>{problem instanceof FormError ? t(problem.message) : problem}</ErrorNotice>}
            <Button type="submit" variant="primary" full loading={pending} disabled={pending}>{t("Submit request")}</Button>
            {sent && <div className="hr-staff-note ok" role="status">{t("Submitted. Waiting for the owner's decision.")}</div>}
          </>
        )}
      </form>
      <section className="card hr-staff-card" aria-label={t("My requests")}>
        <h2>{t("My requests")}</h2>
        {mine.loading ? <Loading>{t("Reading your requests…")}</Loading>
          : mine.error !== null && !mine.data ? <ErrorNotice onRetry={() => void mine.store.refresh()}>{t(hostErrorText(mine.failure, "Your requests could not be read."))}</ErrorNotice>
          : (mine.data?.requests ?? []).length === 0 ? <p className="text-label text-ink-400">{t("You have not requested leave from here yet.")}</p>
          : mine.data!.requests.map((r) => {
            const x = p(r), status = memberStatus(x, mine.data!.withdrawn.has(r.id));
            const days = Number.isSafeInteger(x.half_days) ? fromHalfDays(x.half_days as number) : "—";
            return (
              <div key={r.id} className="hr-staff-row">
                <div className="hr-staff-l"><span className="num">{str(x.start_date)}{x.end_date !== x.start_date ? ` → ${str(x.end_date).slice(5)}` : ""} · {t(days === "1" ? "{days} day" : "{days} days").replace("{days}", days)}</span><span className="text-micro text-ink-500">{typeName(str(x.leave_type))}</span></div>
                <div className="hr-staff-r">{pill(status, t)}{status === "pending" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => setWithdrawing(r)}>{t("Withdraw")}</Button>}</div>
              </div>
            );
          })}
        <p className="text-micro text-ink-500">{t("A decided request cannot be changed. You can withdraw a pending one.")}</p>
      </section>
      {withdrawing && (
        <ConfirmDialog title={t("Withdraw this request?")} confirmLabel={t("Withdraw")} pending={pending} error={typeof problem === "string" ? problem : problem?.message ? t(problem.message) : null}
          body={<p>{t("The owner will see that you withdrew it. To take the leave later, submit a new request.")}</p>}
          onConfirm={withdraw} onCancel={() => { setWithdrawing(null); setProblem(null); }} />
      )}
    </div>
  );
}

// ---- my claims -----------------------------------------------------------------------------------------------------
function MyClaims({ scope, snapshot }: { scope: HostScope; snapshot: Snapshot & { employeeId: string } }) {
  const { t } = useLocale();
  const mine = useHrLoader(scope, "staff-my-claims", {}, () => listMine(scope, STAFF.claims, { orderBy: "claim_date" }));
  const blank: Values = { category: "travel", claimDate: hkParts(nowS()).date, amount: "", merchant: "", description: "" };
  const [values, setValues] = useState<Values>(blank);
  const [ref, setRef] = useState(() => clientRef("scl"));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FormError | string | null>(null);
  const [sent, setSent] = useState(false);
  const set = (key: string) => (v: string) => { setValues({ ...values, [key]: v }); setSent(false); };
  const submit = () => {
    setPending(true); setProblem(null); setSent(false);
    void fileClaim(scope, snapshot, values, ref).then(() => { setSent(true); setValues(blank); setRef(clientRef("scl")); void mine.store.refresh(); })
      .catch((e: unknown) => setProblem(e instanceof FormError ? e : t(unsure(e) ? "The workspace did not answer, so your claim may not be saved. Check My claims below before you submit again." : hostErrorText(e, "Your claim was not saved. Check the fields and try again."))))
      .finally(() => setPending(false));
  };
  return (
    <div className="hr-staff-stack">
      <form className="card hr-staff-card" aria-label={t("Submit a claim")} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>{t("Submit a claim")}</h2>
        <label className="text-label" htmlFor="hr-my-cat">{t("Category")}</label>
        <Select id="hr-my-cat" aria-label={t("Category")} full value={values.category ?? "travel"} onChange={set("category")} options={CLAIM_CATEGORIES.map((c) => ({ value: c, label: t(CATEGORY_LABEL[c]!) }))} />
        <div className="hr-two">
          <div><label className="text-label" htmlFor="hr-my-rdate">{t("Receipt date")}</label><input id="hr-my-rdate" className="field" type="date" value={values.claimDate} onChange={(e) => set("claimDate")(e.target.value)} /></div>
          <div><label className="text-label" htmlFor="hr-my-amount">{t("Amount (HKD)")}</label><input id="hr-my-amount" className="field" inputMode="decimal" value={values.amount} onChange={(e) => set("amount")(e.target.value)} /></div>
        </div>
        <label className="text-label" htmlFor="hr-my-merchant">{t("Merchant")}</label>
        <input id="hr-my-merchant" className="field" maxLength={120} value={values.merchant} onChange={(e) => set("merchant")(e.target.value)} />
        <label className="text-label" htmlFor="hr-my-desc">{t("Description")}</label>
        <textarea id="hr-my-desc" className="field hr-textarea" rows={2} maxLength={500} value={values.description} onChange={(e) => set("description")(e.target.value)} placeholder={t("Do not enter medical details")} />
        <p className="text-micro text-ink-500">{t("Receipt photo: upload is not supported in this release; hand the receipt to the owner.")}</p>
        {problem && <ErrorNotice bare>{problem instanceof FormError ? t(problem.message) : problem}</ErrorNotice>}
        <Button type="submit" variant="primary" full loading={pending} disabled={pending}>{t("Submit claim")}</Button>
        {sent && <div className="hr-staff-note ok" role="status">{t("Submitted. Waiting for the owner's decision.")}</div>}
      </form>
      <section className="card hr-staff-card" aria-label={t("My claims")}>
        <h2>{t("My claims")}</h2>
        {mine.loading ? <Loading>{t("Reading your claims…")}</Loading>
          : mine.error !== null && !mine.data ? <ErrorNotice onRetry={() => void mine.store.refresh()}>{t(hostErrorText(mine.failure, "Your claims could not be read."))}</ErrorNotice>
          : (mine.data ?? []).length === 0 ? <p className="text-label text-ink-400">{t("You have not submitted a claim from here yet.")}</p>
          : mine.data!.map((r) => {
            const x = p(r), currency = str(x.currency) || "HKD";
            return (
              <div key={r.id} className="hr-staff-row">
                <div className="hr-staff-l"><span className="num">{currency} {Number.isSafeInteger(x.amount_minor) ? fromMinor(x.amount_minor as number, currency) : "—"} · {str(x.merchant) || "—"}</span><span className="text-micro text-ink-500">{str(x.claim_date)} · {t(CATEGORY_LABEL[str(x.category)] ?? "Other")}</span></div>
                <div className="hr-staff-r">{pill(memberStatus(x, false), t)}</div>
              </div>
            );
          })}
        <p className="text-micro text-ink-500">{t("Only the owner approves claims. A submitted claim cannot be changed.")}</p>
      </section>
    </div>
  );
}

// ---- clock ---------------------------------------------------------------------------------------------------------
function Clock({ scope, snapshot }: { scope: HostScope; snapshot: Snapshot & { employeeId: string } }) {
  const { t, formatDate } = useLocale();
  const [now, setNow] = useState(nowS);
  useEffect(() => { const timer = setInterval(() => setNow(nowS()), 15000); return () => clearInterval(timer); }, []);
  const weekStart = useMemo(() => hkWeekStart(nowS()), []);
  const mine = useHrLoader(scope, "staff-my-punches", { weekStart }, async () => {
    const [punches, leave] = await Promise.all([
      listMine(scope, STAFF.punches, { filters: [{ field: "at", op: "gte", value: weekStart }], orderBy: "at", limit: 100 }),
      listMine(scope, STAFF.leave, { filters: [{ field: "status", op: "eq", value: "approved" }], orderBy: "start_date", limit: 20 }),
    ]);
    return {
      punches: punches.flatMap((r) => { const x = readPunch(r); return x ? [x] : []; }),
      leave: leave.map((r) => ({ start: str(p(r).start_date), end: str(p(r).end_date), leaveType: str(p(r).leave_type) })),
    };
  });
  const [ref, setRef] = useState(() => clientRef("app"));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ kind: "done"; direction: Direction; at: number } | { kind: "fail" | "unsure" } | null>(null);
  const punches = mine.data?.punches ?? [];
  const direction = nextDirection(punches, now);
  const today = hkParts(now).date;
  const press = () => {
    const at = nowS();
    setNow(at); setPending(true); setResult(null);
    void punch(scope, snapshot, direction, at, ref).then(() => { setResult({ kind: "done", direction, at }); setRef(clientRef("app")); void mine.store.refresh(); })
      .catch((e: unknown) => { setResult({ kind: unsure(e) ? "unsure" : "fail" }); void mine.store.refresh(); })
      .finally(() => setPending(false));
  };
  const todays = punches.filter((x) => x.at >= hkDayStart(now)).sort((a, b) => a.at - b.at);
  const firstIn = todays.find((x) => x.direction === "in"), lastOut = todays.filter((x) => x.direction === "out").at(-1);
  const week = daySummary(punches, mine.data?.leave ?? [], hkParts(weekStart).date, today, today);
  const typeName = (code: string) => snapshot.types.find((x) => x.code === code)?.name ?? code;
  const dayLabel = (date: string) => formatDate(Date.parse(`${date}T12:00:00+08:00`), { month: "numeric", day: "numeric", weekday: "short", timeZone: TZ });
  return (
    <div className="hr-staff-stack">
      <section className="card hr-staff-card hr-staff-clock" aria-label={t("Clock")}>
        <div className="hr-staff-time num" aria-live="off">{hkParts(now).time}</div>
        <div className="text-label text-ink-400">{formatDate(now * 1000, { dateStyle: "full", timeZone: TZ })}</div>
        <Button variant={direction === "in" ? "primary" : "secondary"} full className="hr-staff-punch" loading={pending} disabled={pending || mine.loading} onClick={press}>{t(direction === "in" ? "Clock in" : "Clock out")}</Button>
        {result?.kind === "done" && <div className="hr-staff-note ok" role="status">{t(result.direction === "in" ? "Clocked in at {time}. Time only; no location is recorded." : "Clocked out at {time}. Time only; no location is recorded.").replace("{time}", hkParts(result.at).time)}</div>}
        {result?.kind === "fail" && <div className="hr-staff-note fail" role="alert">{t("The punch was not recorded and nothing was saved. Try again; if it keeps failing, tell the owner.")}</div>}
        {result?.kind === "unsure" && <div className="hr-staff-note warn" role="alert">{t("The workspace did not answer, so this punch may not be saved. Check Today below before you punch again.")}</div>}
      </section>
      <section className="card hr-staff-card" aria-label={t("Today")}>
        <h2>{t("Today")}</h2>
        {mine.loading ? <Loading>{t("Reading your punches…")}</Loading> : mine.error !== null && !mine.data ? <ErrorNotice onRetry={() => void mine.store.refresh()}>{t(hostErrorText(mine.failure, "Your punches could not be read."))}</ErrorNotice> : (
          <>
            <div className="hr-staff-row"><span>{t("In")}</span><span className="num">{firstIn ? hkParts(firstIn.at).time : "—"}</span></div>
            <div className="hr-staff-row"><span>{t("Out")}</span><span className="num">{lastOut ? hkParts(lastOut.at).time : "—"}</span></div>
          </>
        )}
        <p className="text-micro text-ink-500">{t("Punches cannot be changed or deleted. If one is wrong or missing, tell the owner to add a correction.")}</p>
      </section>
      <section className="card hr-staff-card" aria-label={t("This week")}>
        <h2>{t("This week")}</h2>
        {week.map((d) => (
          <div key={d.date} className="hr-staff-row">
            <span>{dayLabel(d.date)}</span>
            <span className="num">{d.firstIn !== null || d.lastOut !== null
              ? <>{d.firstIn !== null ? hkParts(d.firstIn).time : "—"} – {d.lastOut !== null && !d.missingOut ? hkParts(d.lastOut).time : d.missingOut ? <span className="chip" data-status="pending">{t("No clock-out")}</span> : "—"}</>
              : d.leaveType !== null ? <span className="text-ink-400">{typeName(d.leaveType)}</span> : <span className="text-ink-500">—</span>}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
