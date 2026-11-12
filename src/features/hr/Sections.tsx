import { Button, Select } from "@cadence/screen-ui";
import { useMemo, useState } from "react";
import { parseRecordList, type HostScope } from "./hostActions";
import { useLocale } from "./locale";
import { listArgs } from "./recordQueries";
import RecordsPane from "./RecordsPane";
import { useHrQuery } from "./resources";
import { candidatesView, claimsView, leaveRequestsView, leaveTypesView, openingsView, policiesView } from "./views";

/** Every opening's title, for the candidates' opening filter (one page of up to 100). */
const OPENING_TITLES = listArgs(openingsView, { status: "all", query: "", limit: 100 });

export interface PaneProps { scope: HostScope; canWrite: boolean; recordId: string | null; onSelect: (id: string) => void; onClose: () => void }

/** Two lists under one tab. The choice is local; a different list closes any open drawer. */
function SubTabs({ labels, current, onChange, onClose }: { labels: readonly [string, string]; current: 0 | 1; onChange: (i: 0 | 1) => void; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <div className="hr-actions hr-subtabs" role="group" aria-label={t("Lists")}>
      {labels.map((label, i) => (
        <Button key={label} size="sm" aria-pressed={current === i} variant={current === i ? "primary" : "secondary"} onClick={() => { if (current !== i) { onClose(); onChange(i as 0 | 1); } }}>{t(label)}</Button>
      ))}
    </div>
  );
}

export const PoliciesTab = (p: PaneProps) => <RecordsPane {...p} view={policiesView} />;
export const ClaimsTab = (p: PaneProps) => <RecordsPane {...p} view={claimsView} />;

export function LeaveTab(p: PaneProps) {
  const [list, setList] = useState<0 | 1>(0);
  return (
    <div className="hr-list">
      <SubTabs labels={["Leave requests", "Leave types"]} current={list} onChange={setList} onClose={p.onClose} />
      <RecordsPane key={list} {...p} view={list === 0 ? leaveRequestsView : leaveTypesView} />
    </div>
  );
}

export function RecruitingTab(p: PaneProps) {
  const { t } = useLocale();
  const [list, setList] = useState<0 | 1>(0);
  const [opening, setOpening] = useState("all");
  const openings = useHrQuery(p.scope, "records.list", OPENING_TITLES, parseRecordList);
  const rows = openings.data?.records;
  const titles = useMemo(() => Object.fromEntries((rows ?? []).map((r) => [r.id, String((r.profile as { title?: unknown } | null)?.title ?? "—")])), [rows]);
  const view = useMemo(() => candidatesView(opening === "all" ? null : opening, titles), [opening, titles]);
  return (
    <div className="hr-list">
      <SubTabs labels={["Openings", "Candidates"]} current={list} onChange={setList} onClose={p.onClose} />
      {list === 0 ? <RecordsPane key="openings" {...p} view={openingsView} /> : (
        <>
          <div className="hr-toolbar">
            <label className="text-label text-ink-400" htmlFor="hr-opening-filter">{t("Opening")}</label>
            <Select id="hr-opening-filter" aria-label={t("Opening")} value={opening} onChange={(v) => { p.onClose(); setOpening(v); }}
              options={[{ value: "all", label: t("All openings") }, ...(rows ?? []).map((r) => ({ value: r.id, label: titles[r.id]! }))]} />
          </div>
          {openings.error !== null && <p className="text-label text-ink-400">{t("The openings could not be read, so candidates cannot be filtered by opening.")}</p>}
          <RecordsPane key={`candidates:${opening}`} {...p} view={view} />
        </>
      )}
    </div>
  );
}
