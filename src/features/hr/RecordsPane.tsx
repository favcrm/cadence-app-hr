import { Button, ConfirmDialog, DataTable, Detail, EmptyState, ErrorNotice, Loading, Notice, Select, type DrawerMenuItem, type DrawerTab } from "@cadence/screen-ui";
import { useEffect, useState, type ReactNode } from "react";
import type { RecordFilter } from "../../bridge/services";
import { onScopeRetired } from "../../bridge/scope";
import {
  editable, emptyValues, newRecordId, STAGES, statusOf, stageOf, todayLocal, viewScreening, viewValues,
  type Decision, type TableSpec, type Values,
} from "../../domain/records";
import FrameDrawer from "./FrameDrawer";
import { parseRecord, parseRecordList, type HostRecord, type HostScope } from "./hostActions";
import { hostErrorText } from "./hostErrors";
import ListPager, { LIST_PAGE_SIZE } from "./ListPager";
import { useLocale } from "./locale";
import RecordForm, { optionLabel, type RecordProblem } from "./RecordForm";
import { createRecord, decide, problemFor, setField, updateRecord, type Problem } from "./recordsSubmit";
import { QueryRefresh, useHrQuery } from "./resources";

type Cells = Record<string, unknown>;
export interface View {
  id: string;
  title: string;
  spec: TableSpec;
  newLabel: string;
  searchHint: string;
  /** Status filter: the column, its values, and the one shown first ("all" shows everything). */
  filter?: { field: "status" | "stage"; values: readonly string[]; initial: string };
  /** `decision` rows have an owner approve/reject while open; `candidate` rows have a stage change and a screening note. */
  kind: "plain" | "decision" | "candidate";
  /** The status value that is still open to a decision. */
  open?: string;
  columns: (p: Cells, t: (s: string) => string) => { key: string; header: string; cell: ReactNode; className?: string }[];
  /** Detail rows beyond the form's own fields. */
  extra?: (p: Cells, t: (s: string) => string) => { key: string; term: string; value: ReactNode }[];
  filters?: RecordFilter[];
  createExtra?: Record<string, string>;
  /** When false the New button is disabled with this reason. */
  blockedNew?: string;
  newId: string;
}
const NO_RECORDS: HostRecord[] = [];
export const chip = (value: unknown, t: (s: string) => string) => {
  const v = typeof value === "string" && value !== "" ? value : null;
  return <span className="chip" data-status={v ?? "unknown"}>{t(optionLabel(v ?? ""))}</span>;
};

export default function RecordsPane({ scope, canWrite, view, recordId, onSelect, onClose }: {
  scope: HostScope; canWrite: boolean; view: View; recordId: string | null; onSelect: (id: string) => void; onClose: () => void;
}) {
  const { t, formatNumber } = useLocale();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState("");
  const [status, setStatus] = useState(view.filter?.initial ?? "all");
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const cursor = page > 0 ? cursors[page - 1] : undefined;
  const filters: RecordFilter[] = [...(view.filters ?? []), ...(view.filter && status !== "all" ? [{ field: view.filter.field, op: "eq" as const, value: status }] : [])];
  const state = useHrQuery(scope, "records.list", {
    table: view.spec.table, query: committed || undefined, limit: LIST_PAGE_SIZE, cursor, filters: filters.length ? filters : undefined, order_by: { field: "created_at", direction: "desc" as const },
  }, parseRecordList);
  const records = state.data?.records ?? NO_RECORDS;
  const nextCursor = state.data?.nextCursor ?? null;
  const total = state.data?.total ?? null;
  const { loading, error } = state;
  const busy = loading || state.updating || query.trim() !== committed;
  const reset = () => { setCursors([]); setPage(0); };

  useEffect(() => {
    const timer = setTimeout(() => { const next = query.trim(); if (next !== committed) { reset(); setCommitted(next); } }, 250);
    const unsubscribe = onScopeRetired(() => clearTimeout(timer));
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [query, committed]);

  const next = () => {
    if (nextCursor === null) return;
    setCursors((known) => { const copy = known.slice(0, page); copy[page] = nextCursor; return copy; });
    setPage(page + 1);
  };
  const columns = (r: HostRecord) => view.columns((r.profile ?? {}) as Cells, t);
  const head = records[0] ? columns(records[0]) : view.columns({}, t);
  const summary = t("{count} on this page").replace("{count}", formatNumber(records.length)) + (total !== null ? ` · ${t("{total} in total").replace("{total}", formatNumber(total))}` : "");
  const filtered = status !== "all" || committed !== "";

  if (creating) {
    return <NewRecord scope={scope} view={view} canWrite={canWrite} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); onSelect(id); }} />;
  }
  return (
    <section aria-label={t(view.title)} className="hr-list hr-list-controls">
      <div className="hr-toolbar hr-list-toolbar">
        <div className="hr-search">
          <label className="sr-only" htmlFor={`hr-${view.id}-search`}>{t(view.searchHint)}</label>
          <input id={`hr-${view.id}-search`} className="field hr-search-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            maxLength={120} autoComplete="off" placeholder={t(view.searchHint)} />
        </div>
        {view.filter && (
          <div className="hr-filter">
            <Select aria-label={t("Filter by status")} value={status} onChange={(v) => { reset(); setStatus(v); }}
              options={["all", ...view.filter.values].map((value) => ({ value, label: t(value === "all" ? "All" : optionLabel(value)) }))} />
          </div>
        )}
        {canWrite && <Button variant="primary" className="hr-list-create" disabled={view.blockedNew !== undefined} title={view.blockedNew ? t(view.blockedNew) : undefined} onClick={() => setCreating(true)}>{t(view.newLabel)}</Button>}
      </div>
      {view.blockedNew && canWrite && <p className="text-label text-ink-400">{t(view.blockedNew)}</p>}
      {loading && <Loading>{t("Reading the records…")}</Loading>}
      {error !== null && !loading && <ErrorNotice onRetry={() => void state.store.refresh()}>{hostErrorText(state.failure, error)}</ErrorNotice>}
      {error === null && !loading && records.length === 0 && (
        <EmptyState name={view.id} title={t(filtered ? "Nothing matches this view" : "Nothing here yet")}>
          {filtered ? t("Clear the search or choose All to see everything.") : t(canWrite ? "Add the first one with the button above." : "Nothing has been added yet.")}
        </EmptyState>
      )}
      <span role="status"><QueryRefresh updating={state.updating} /></span>
      {(records.length > 0 || page > 0) && (
        <>
          {records.length > 0 && (
            <DataTable<HostRecord>
              label={t("Table — scroll horizontally to reach every column")}
              wrapClassName="hr-table-wrap" tableClassName="hr-table" rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-record-id": r.id, className: "hr-row-open", onClick: (e: { target: EventTarget }) => { if (!(e.target as HTMLElement).closest("button, input, a")) onSelect(r.id); } })}
              columns={head.map((c, i) => ({
                key: c.key, header: c.header, cellClassName: c.className,
                cell: (r: HostRecord) => { const cell = columns(r)[i]!.cell; return i === 0 ? <button type="button" className="lnk" onClick={() => onSelect(r.id)}>{cell}</button> : cell; },
              }))}
              rows={records}
            />
          )}
          <ListPager page={page} pageCount={total === null ? null : Math.max(1, Math.ceil(total / LIST_PAGE_SIZE))} summary={summary} busy={busy}
            onPrevious={() => setPage(page - 1)} onNext={next} hasNext={nextCursor !== null} />
        </>
      )}
      {recordId !== null && <RecordDrawer key={`${view.id}:${recordId}`} scope={scope} view={view} recordId={recordId} canWrite={canWrite} onClose={onClose} />}
    </section>
  );
}

function NewRecord({ scope, view, canWrite, onCreated, onCancel }: { scope: HostScope; view: View; canWrite: boolean; onCreated: (id: string) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<RecordProblem | null>(null);
  // One id per open form: a retry after a lost reply reuses it, so the host refuses a second create under the same id.
  const [recordId] = useState(() => newRecordId(view.newId));
  const submit = (values: Values) => {
    setPending(true); setProblem(null);
    void createRecord(scope, view.spec, recordId, values, view.createExtra)
      .then((record) => onCreated(record.id))
      .catch((e: unknown) => setProblem(problemFor(e, "create", t)))
      .finally(() => setPending(false));
  };
  const formId = `hr-${view.id}-new`;
  return (
    <section aria-label={t(view.newLabel)}>
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading tabIndex={-1} ref={(n) => n?.focus()}>{t(view.newLabel)}</h3>
      <p className="text-label text-ink-400 mt-1"><button type="button" className="lnk" onClick={onCancel}>← {t(view.title)}</button></p>
      {!canWrite ? <Notice className="mt-2" state="read-only">{t("Read-only view. The owner adds records.")}</Notice> : (
        <div className="card px-4 py-4 mt-2">
          <RecordForm spec={view.spec} formId={formId} initial={emptyValues(view.spec)} problem={problem} onSubmit={submit}>
            <div className="hr-actions">
              <Button type="submit" variant="primary" loading={pending} disabled={pending}>{t("Save")}</Button>
              <Button onClick={onCancel} disabled={pending}>{t("Cancel")}</Button>
            </div>
          </RecordForm>
        </div>
      )}
    </section>
  );
}

function RecordDrawer({ scope, view, recordId, canWrite, onClose }: { scope: HostScope; view: View; recordId: string; canWrite: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const state = useHrQuery(scope, "records.show", { table: view.spec.table, record_id: recordId }, parseRecord);
  const { loading, error } = state;
  const record = state.data;
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [stage, setStage] = useState("");

  const profile = (record?.profile ?? {}) as Cells;
  const isOpen = view.kind === "decision" && statusOf(profile) === view.open;
  const reload = () => { setProblem(null); void state.store.refresh(); };
  const fail = (e: unknown, op: "create" | "update") => setProblem(problemFor(e, op, t));
  const run = (work: () => Promise<HostRecord | null>, after?: () => void) => {
    setPending(true); setProblem(null);
    void work().then((next) => { if (next) state.store.write(() => next); after?.(); }).catch((e: unknown) => fail(e, "update")).finally(() => setPending(false));
  };
  const decideNow = (decision: Decision, text: string) => record && run(() => decide(scope, view.spec, record, decision, todayLocal(), text), () => { setRejecting(false); setNote(""); });
  const values = record ? viewValues(view.spec, record.profile) : null;
  const spec = view.spec;
  const title = record ? view.columns(profile, t)[0]?.cell : null;
  const screening = view.kind === "candidate" ? viewScreening(profile.screening) : null;

  const items = record && values ? [
    ...spec.fields.filter((f) => f.kind !== "lookup").map((f) => ({
      key: f.key, term: t(f.label.replace(" (optional)", "")),
      value: f.kind === "code" ? chip(values[f.key], t) : f.kind === "longtext" ? <span className="hr-prose">{values[f.key] || "—"}</span> : <span className="num">{values[f.key] || "—"}</span>,
    })),
    ...(view.extra ? view.extra(profile, t) : []),
  ] : [];
  const tabs: DrawerTab[] = record ? [
    { id: "overview", label: t("Overview"), panel: (
      <>
        <section className="hr-sect" aria-label={t("Fields")}><Detail className="hr-detail" label={t("Record fields")} items={items} /></section>
        {view.kind === "candidate" && (
          <section className="hr-sect" aria-label={t("Screening")}>
            <h4>{t("Screening")}</h4>
            {screening ? <><p className="hr-prose">{screening.summary}</p><ul className="hr-reasons">{screening.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></>
              : <p className="text-label text-ink-400">{t("No screening note yet. Ask the chat agent to screen this candidate against the opening.")}</p>}
            <p className="text-micro text-ink-500">{t("A screening note gives reasons only. It never changes the stage; the owner moves it.")}</p>
          </section>
        )}
        {view.kind === "candidate" && canWrite && (
          <section className="hr-sect" aria-label={t("Stage")}>
            <h4>{t("Move stage")}</h4>
            <div className="hr-actions">
              <Select aria-label={t("Stage")} value={stage || stageOf(profile) || "new"} onChange={setStage}
                options={[...new Set([...STAGES, stageOf(profile) ?? "new"])].map((value) => ({ value, label: t(optionLabel(value)) }))} />
              <Button disabled={pending || !stage || stage === stageOf(profile)} loading={pending} onClick={() => run(() => setField(scope, view.spec, record, "stage", stage))}>{t("Move")}</Button>
            </div>
          </section>
        )}
        {view.kind === "decision" && !isOpen && <p className="text-label text-ink-400 hr-sect">{t("This record is decided and cannot be changed.")}</p>}
        {problem && <ErrorNotice className="mt-2" bare>{problem.message}{problem.reload && <> <button type="button" className="lnk" onClick={reload}>{t("Reload this record")}</button></>}</ErrorNotice>}
      </>
    ) },
    { id: "details", label: t("Details"), panel: <p className="num text-micro text-ink-500">{t("Record")} <span className="num">{recordId}</span> · {t("revision")} r{record.revision} · {t("digest")} {record.digest.slice(0, 18)}…</p> },
  ] : [];
  const canEdit = canWrite && record !== null && (view.kind !== "decision" || isOpen);
  const menu: DrawerMenuItem[] = isOpen && canWrite ? [{ key: "reject", label: t("Reject…"), destructive: true, onSelect: () => { setProblem(null); setRejecting(true); } }] : [];

  return (
    <>
      <FrameDrawer
        kind={spec.table} kicker={t(optionLabel(spec.noun))} label={t("Record details")} title={(loading ? "" : flat(title)) || t("Record details")}
        pills={record && view.filter ? chip(profile[view.filter.field], t) : undefined}
        tabs={tabs}
        state={loading ? <Loading>{t("Reading the record…")}</Loading> : error !== null && !record ? <ErrorNotice onRetry={reload}>{hostErrorText(state.failure, error)}</ErrorNotice> : state.updating ? <span role="status"><QueryRefresh updating /></span> : undefined}
        edit={editing && canEdit && record ? {
          formId: `hr-${view.id}-edit`, title: t("Edit — saving is refused if the record changed since you opened it"), pending, onCancel: () => { setEditing(false); setProblem(null); },
          body: (
            <RecordForm key={record.revision} spec={editable(spec)} formId={`hr-${view.id}-edit`} initial={viewValues(spec, record.profile)} problem={problem}
              onSubmit={(v) => { setPending(true); setProblem(null); void updateRecord(scope, spec, record, v).then((next) => { if (next) state.store.write(() => next); setEditing(false); }).catch((e: unknown) => fail(e, "update")).finally(() => setPending(false)); }}>
              {problem?.reload && <div><Button size="sm" onClick={reload}>{t("Reload this record")}</Button></div>}
            </RecordForm>
          ),
        } : null}
        menu={menu}
        secondary={canEdit ? <Button size="sm" onClick={() => { setEditing(true); setProblem(null); }}>{t("Edit")}</Button> : undefined}
        primary={isOpen && canWrite ? <Button size="sm" variant="primary" loading={pending} disabled={pending} onClick={() => decideNow("approved", "")}>{t("Approve")}</Button> : undefined}
        note={record && !canWrite ? t("Read-only view. Edits are disabled on this board.") : undefined}
        onClose={onClose}
      />
      {rejecting && (
        <ConfirmDialog title={t("Reject this record?")} confirmLabel={t("Reject")} pending={pending} error={problem?.message ?? null}
          body={<div className="grid gap-2"><p>{t("The owner's decision is final: a decided record cannot be changed. You may leave a short note for the record.")}</p>
            <label className="text-label" htmlFor="hr-reject-note">{t("Note (optional)")}</label>
            <textarea id="hr-reject-note" className="field hr-textarea" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></div>}
          onConfirm={() => decideNow("rejected", note)} onCancel={() => { setRejecting(false); setProblem(null); }} />
      )}
    </>
  );
}
/** A drawer title is plain text: reduce the first column's cell to its text. */
function flat(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object" && "props" in node) return flat((node as { props: { children?: ReactNode } }).props.children ?? "");
  return Array.isArray(node) ? node.map(flat).join(" ") : "";
}
