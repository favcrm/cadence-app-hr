import { Button, DataTable, EmptyState, ErrorNotice, Loading, Notice, Select } from "@cadence/screen-ui";
import { useMemo, useState } from "react";
import { FormError, newRecordId } from "../../domain/records";
import { CORRECTION_PREFIX, hkDayStart, hkParts, type ImportLine, type Punch } from "../../domain/staff";
import type { HostScope } from "./hostActions";
import { hostErrorText } from "./hostErrors";
import { useLocale } from "./locale";
import { useHrLoader } from "./resources";
import { addCorrection, importPunches, previewImport, readDirectory, readPunches } from "./staff";

const DAYS = 7;
const KIND_LABEL: Record<Punch["kind"], string> = { app: "Staff app", import: "Imported", correction: "Correction" };
const STATUS_LABEL: Record<ImportLine["status"], string> = { new: "New", already: "Already imported", unknown_employee: "Unknown employee", invalid: "Not readable", duplicate: "Repeated in this file" };

/** Attendance: the last week's punches, the import from an attendance device, and corrections. Punches are never edited. */
export default function AttendancePane({ scope, canWrite, canBatch }: { scope: HostScope; canWrite: boolean; canBatch: boolean }) {
  const { t } = useLocale();
  const [list, setList] = useState(0);
  return (
    <div className="hr-list">
      <div className="hr-actions hr-subtabs" role="group" aria-label={t("Lists")}>
        {["Punches", "Import from a device", "Add a correction"].map((label, i) => (
          <Button key={label} size="sm" aria-pressed={list === i} variant={list === i ? "primary" : "secondary"} onClick={() => setList(i)}>{t(label)}</Button>
        ))}
      </div>
      {list === 0 ? <Punches scope={scope} /> : list === 1 ? <Import scope={scope} canWrite={canWrite} canBatch={canBatch} /> : <Correction scope={scope} canWrite={canWrite} />}
    </div>
  );
}

function Punches({ scope }: { scope: HostScope }) {
  const { t } = useLocale();
  const from = useMemo(() => hkDayStart(Math.floor(Date.now() / 1000)) - (DAYS - 1) * 86400, []);
  const data = useHrLoader(scope, "punches", { from }, async () => {
    const [punches, directory] = await Promise.all([readPunches(scope, from), readDirectory(scope)]);
    return { punches: punches.punches, more: punches.more, directory: new Map(directory.map((e) => [e.id, e])) };
  });
  const refresh = () => { void data.store.refresh(); };
  const rows = data.data?.punches ?? [];
  return (
    <section aria-label={t("Punches")} className="hr-list">
      <p className="text-label text-ink-400">{t("The last 7 days, newest first, in Hong Kong time. Staff punches record the time only; no location is recorded. A punch is never changed: add a correction instead.")}</p>
      {data.loading && <Loading>{t("Reading punches…")}</Loading>}
      {data.error !== null && !data.loading && <ErrorNotice onRetry={refresh}>{t(hostErrorText(data.failure, "The punches could not be read."))}</ErrorNotice>}
      {data.data?.more && <Notice>{t("Only the newest 100 punches are shown. Ask the assistant for a full attendance review of the period.")}</Notice>}
      {data.data && rows.length === 0 && <EmptyState name="punches" title={t("No punches in the last 7 days")}>{t("Staff clock in from their own view of HR, or import punches from an attendance device.")}</EmptyState>}
      {rows.length > 0 && (
        <DataTable<Punch>
          label={t("Punches — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table" rowKey={(r) => r.id}
          columns={[
            { key: "who", header: t("Employee"), cell: (r) => { const e = data.data!.directory.get(r.employeeId); return e ? `${e.name} · ${e.employeeNo}` : "—"; }, cellClassName: "text-ink-100" },
            { key: "when", header: t("Time"), cell: (r) => <span className="num">{hkParts(r.at).date} {hkParts(r.at).time}</span>, cellClassName: "hr-nowrap" },
            { key: "dir", header: t("In or out"), cell: (r) => t(r.direction === "in" ? "In" : "Out") },
            { key: "kind", header: t("Source"), cell: (r) => t(KIND_LABEL[r.kind]) },
            { key: "check", header: t("Check"), cell: (r) => {
              // A staff punch counts only from the account linked to that employee; the owner's own rows are trusted.
              const linked = data.data!.directory.get(r.employeeId)?.memberId ?? null;
              return r.kind === "app" && r.memberId !== linked ? <span className="chip" data-status="rejected">{t("Not from this employee's linked account")}</span> : r.note ? <span className="text-ink-400">{r.note}</span> : null;
            } },
          ]}
          rows={rows}
        />
      )}
    </section>
  );
}

function Import({ scope, canWrite, canBatch }: { scope: HostScope; canWrite: boolean; canBatch: boolean }) {
  const { t, formatNumber } = useLocale();
  const [text, setText] = useState("");
  const [lines, setLines] = useState<ImportLine[] | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fresh = (lines ?? []).filter((l) => l.status === "new").length;
  const fail = (e: unknown, fallback: string) => setProblem(e instanceof FormError ? t(e.message) : t(hostErrorText(e, fallback)));
  const preview = () => { setPending(true); setProblem(null); setDone(null); void previewImport(scope, text).then(setLines).catch((e: unknown) => fail(e, "The file could not be checked.")).finally(() => setPending(false)); };
  const run = () => {
    if (!lines) return;
    setPending(true); setProblem(null);
    void importPunches(scope, lines).then((r) => {
      setDone(t("{imported} punches imported; {already} were already there.").replace("{imported}", formatNumber(r.imported)).replace("{already}", formatNumber(r.alreadyThere)));
      setLines(null);
    }).catch((e: unknown) => fail(e, "The import stopped. Check the file again: lines already imported are skipped.")).finally(() => setPending(false));
  };
  if (!canWrite) return <Notice state="read-only">{t("Read-only view. The owner imports punches.")}</Notice>;
  if (!canBatch) return <Notice>{t("This workspace does not offer batch writes to this screen, so punches cannot be imported here.")}</Notice>;
  return (
    <section aria-label={t("Import from a device")} className="hr-list">
      <p className="text-label text-ink-400">{t("Paste the attendance device's CSV export: one punch per line as employee number, date and time (YYYY-MM-DD HH:MM, Hong Kong time), and in or out. Check the preview, then import. Importing the same file again adds nothing twice.")}</p>
      <label className="text-label" htmlFor="hr-punch-csv">{t("CSV lines")}</label>
      <textarea id="hr-punch-csv" className="field hr-textarea" rows={8} value={text} onChange={(e) => { setText(e.target.value); setLines(null); }} spellCheck={false} placeholder="E001,2026-11-16 09:02,in" />
      <div className="hr-actions">
        <Button disabled={pending || text.trim() === ""} loading={pending && lines === null} onClick={preview}>{t("Check the file")}</Button>
        {lines && <Button variant="primary" disabled={pending || fresh === 0} loading={pending} onClick={run}>{t("Import {count} punches").replace("{count}", formatNumber(fresh))}</Button>}
      </div>
      {done && <Notice state="saved">{done}</Notice>}
      {problem && <ErrorNotice>{problem}</ErrorNotice>}
      {lines && lines.length === 0 && <Notice>{t("No punch lines were found.")}</Notice>}
      {lines && lines.length > 0 && (
        <DataTable<ImportLine>
          label={t("Import preview — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table" rowKey={(l) => `${l.line}`}
          columns={[
            { key: "line", header: t("Line"), cell: (l) => <span className="num">{l.line}</span> },
            { key: "no", header: t("Employee number"), cell: (l) => <span className="num">{l.employeeNo || "—"}</span> },
            { key: "when", header: t("Time"), cell: (l) => l.at === null ? "—" : <span className="num">{hkParts(l.at).date} {hkParts(l.at).time}</span>, cellClassName: "hr-nowrap" },
            { key: "dir", header: t("In or out"), cell: (l) => l.direction === null ? "—" : t(l.direction === "in" ? "In" : "Out") },
            { key: "status", header: t("Result"), cell: (l) => <>{t(STATUS_LABEL[l.status])}{l.reason && <span className="text-ink-400"> — {t(l.reason)}</span>}</> },
          ]}
          rows={lines}
        />
      )}
    </section>
  );
}

function Correction({ scope, canWrite }: { scope: HostScope; canWrite: boolean }) {
  const { t } = useLocale();
  const blank = { employeeNo: "", date: hkParts(Math.floor(Date.now() / 1000)).date, time: "", direction: "in", note: "" };
  const [values, setValues] = useState(blank);
  const [recordId, setRecordId] = useState(() => newRecordId(CORRECTION_PREFIX.slice(0, -1)));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (key: keyof typeof blank) => (v: string) => { setValues({ ...values, [key]: v }); setDone(false); };
  const submit = () => {
    setPending(true); setProblem(null);
    void addCorrection(scope, values, recordId).then(() => { setDone(true); setValues(blank); setRecordId(newRecordId(CORRECTION_PREFIX.slice(0, -1))); })
      .catch((e: unknown) => setProblem(e instanceof FormError ? t(e.message) : t(hostErrorText(e, "The correction was not saved.")))).finally(() => setPending(false));
  };
  if (!canWrite) return <Notice state="read-only">{t("Read-only view. The owner adds corrections.")}</Notice>;
  return (
    <form className="card px-4 py-4 grid gap-2" aria-label={t("Add a correction")} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <p className="text-label text-ink-400">{t("A correction is a new punch with a note. The wrong punch stays in the record; the correction sits beside it.")}</p>
      <label className="text-label" htmlFor="hr-cor-no">{t("Employee number")}</label>
      <input id="hr-cor-no" className="field" value={values.employeeNo} onChange={(e) => set("employeeNo")(e.target.value)} maxLength={32} autoComplete="off" />
      <div className="hr-two">
        <div><label className="text-label" htmlFor="hr-cor-date">{t("Date")}</label><input id="hr-cor-date" className="field" value={values.date} onChange={(e) => set("date")(e.target.value)} placeholder="YYYY-MM-DD" /></div>
        <div><label className="text-label" htmlFor="hr-cor-time">{t("Time (Hong Kong)")}</label><input id="hr-cor-time" className="field" value={values.time} onChange={(e) => set("time")(e.target.value)} placeholder="HH:MM" /></div>
      </div>
      <label className="text-label" htmlFor="hr-cor-dir">{t("In or out")}</label>
      <Select id="hr-cor-dir" aria-label={t("In or out")} value={values.direction} onChange={set("direction")} options={[{ value: "in", label: t("In") }, { value: "out", label: t("Out") }]} />
      <label className="text-label" htmlFor="hr-cor-note">{t("Why")}</label>
      <textarea id="hr-cor-note" className="field hr-textarea" rows={2} maxLength={500} value={values.note} onChange={(e) => set("note")(e.target.value)} />
      {problem && <ErrorNotice bare>{problem}</ErrorNotice>}
      {done && <Notice state="saved">{t("The correction was added.")}</Notice>}
      <div className="hr-actions"><Button type="submit" variant="primary" loading={pending} disabled={pending}>{t("Add correction")}</Button></div>
    </form>
  );
}
