import { Button, DataTable, EmptyState, ErrorNotice, Loading } from "@cadence/screen-ui";
import { useEffect, useState } from "react";
import { onScopeRetired } from "../../bridge/scope";
import { viewProfile } from "../../domain/people";
import { statusLabel, typeLabel } from "./EmployeeForm";
import { parseRecordList, type HostRecord, type HostScope } from "./hostActions";
import ListPager, { LIST_PAGE_SIZE } from "./ListPager";
import { useLocale } from "./locale";
import { QueryRefresh, useHrQuery } from "./resources";

const NO_RECORDS: HostRecord[] = [];

export default function PeopleList({ scope, canWrite, onSelect, onNew }: {
  scope: HostScope; canWrite: boolean; onSelect: (recordId: string) => void; onNew: () => void;
}) {
  const { t, formatNumber } = useLocale();
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState("");
  // The host pages by cursor: cursors[n - 1] opens page n, so Previous is a lookup and Next is the cursor the page gave.
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const cursor = page > 0 ? cursors[page - 1] : undefined;
  const state = useHrQuery(scope, "records.list", { query: committed || undefined, limit: LIST_PAGE_SIZE, cursor }, parseRecordList);
  const records = state.data?.records ?? NO_RECORDS;
  const nextCursor = state.data?.nextCursor ?? null;
  const total = state.data?.total ?? null;
  const { loading, error } = state;
  const busy = loading || state.updating || query.trim() !== committed;

  // Typing never navigates, so no employee data reaches the URL or history.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = query.trim();
      if (next !== committed) { setCursors([]); setPage(0); setCommitted(next); }
    }, 250);
    const unsubscribe = onScopeRetired(() => clearTimeout(timer));
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [query, committed]);

  const next = () => {
    if (nextCursor === null) return;
    setCursors((known) => { const copy = known.slice(0, page); copy[page] = nextCursor; return copy; });
    setPage(page + 1);
  };
  const summary = (records.length === 1 ? t("{count} employee on this page") : t("{count} employees on this page")).replace("{count}", formatNumber(records.length))
    + (total !== null ? ` · ${t("{total} in total").replace("{total}", formatNumber(total))}` : "");

  return (
    <section aria-label={t("People list")} className="hr-list hr-list-controls">
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading>{t("People")}</h3>
      <div className="hr-toolbar hr-list-toolbar">
        <div className="hr-search">
          <label className="sr-only" htmlFor="hr-people-search">{t("Search people")}</label>
          <input id="hr-people-search" className="field hr-search-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            maxLength={120} autoComplete="off" placeholder={t("Search people…")} title={t("Search by name, employee number, email or department")} />
        </div>
        {canWrite && <Button variant="primary" className="hr-list-create" onClick={onNew}>{t("Add employee")}</Button>}
      </div>
      {loading && <Loading>{t("Reading the directory…")}</Loading>}
      {error !== null && !loading && <ErrorNotice onRetry={() => void state.store.refresh()}>{error}</ErrorNotice>}
      {error === null && !loading && records.length === 0 && (
        <EmptyState name="people" title={t(committed === "" ? "No employees yet" : "No employees match this search")}>
          {committed === "" ? t(canWrite ? "Add the first employee with Add employee." : "Nobody has been added to the directory yet.") : t("Clear the search to see everyone.")}
        </EmptyState>
      )}
      <span role="status"><QueryRefresh updating={state.updating} /></span>
      {(records.length > 0 || page > 0) && (
        <>
          {records.length > 0 && (
            <DataTable<HostRecord>
              label={t("People table — scroll horizontally to reach every column")}
              wrapClassName="hr-table-wrap" tableClassName="hr-table" rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-record-id": r.id, className: "hr-row-open", onClick: (e: { target: EventTarget }) => { if (!(e.target as HTMLElement).closest("button, input, a")) onSelect(r.id); } })}
              columns={[
                { key: "name", header: t("Name"), cellClassName: "text-ink-100", cell: (r) => <button type="button" className="lnk" onClick={() => onSelect(r.id)}>{viewProfile(r.profile).displayName || "—"}</button> },
                { key: "no", header: t("Employee number"), cellClassName: "num text-ink-300 hr-nowrap", cell: (r) => viewProfile(r.profile).employeeNo || "—" },
                { key: "title", header: t("Job title"), cellClassName: "text-ink-300", cell: (r) => viewProfile(r.profile).jobTitle || "—" },
                { key: "dept", header: t("Department"), cellClassName: "text-ink-300", cell: (r) => viewProfile(r.profile).department || "—" },
                { key: "type", header: t("Employment type"), cellClassName: "text-ink-300 hr-nowrap", cell: (r) => t(typeLabel(viewProfile(r.profile).employmentType)) },
                { key: "status", header: t("Status"), cell: (r) => { const s = viewProfile(r.profile).status; return <span className="chip" data-status={s ?? "unknown"}>{t(statusLabel(s))}</span>; } },
              ]}
              rows={records}
            />
          )}
          <ListPager page={page} pageCount={total === null ? null : Math.max(1, Math.ceil(total / LIST_PAGE_SIZE))} summary={summary} busy={busy}
            onPrevious={() => setPage(page - 1)} onNext={next} hasNext={nextCursor !== null} />
        </>
      )}
    </section>
  );
}
