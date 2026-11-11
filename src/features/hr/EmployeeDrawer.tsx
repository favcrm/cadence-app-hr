import { Button, Detail, ErrorNotice, Loading, type DrawerTab } from "@cadence/screen-ui";
import { useEffect, useState } from "react";
import { buildProfile, changedFields, formFromProfile, viewProfile, type EmployeeForm as Fields } from "../../domain/people";
import EmployeeForm, { statusLabel, typeLabel, type FieldProblem } from "./EmployeeForm";
import FrameDrawer from "./FrameDrawer";
import { hostActions, parseRecord, type HostScope } from "./hostActions";
import { useLocale } from "./locale";
import { QueryRefresh, useHrQuery } from "./resources";
import { assertEmployeeNoFree, writeProblem } from "./submit";

const FORM_ID = "hr-employee-edit";

export default function EmployeeDrawer({ scope, recordId, canWrite, onClose }: {
  scope: HostScope; recordId: string; canWrite: boolean; onClose: () => void;
}) {
  const { t } = useLocale();
  const state = useHrQuery(scope, "records.show", { record_id: recordId }, parseRecord);
  const { loading, error } = state;
  const record = state.data;
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FieldProblem | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => { setEditing(false); setProblem(null); setStale(false); }, [recordId]);

  const view = record ? viewProfile(record.profile) : null;
  const initials = view ? Array.from(view.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]?.toUpperCase() ?? "").join("")).join("") : "";
  const reload = () => { setStale(false); setProblem(null); void state.store.refresh(); };

  const save = (fields: Fields) => {
    if (!record) return;
    const profile = buildProfile(fields);
    const patch = changedFields(record.profile, profile);
    if (Object.keys(patch).length === 0) { setEditing(false); return; }
    setPending(true); setProblem(null); setStale(false);
    const free = "employee_no" in patch ? assertEmployeeNoFree(scope, profile.employee_no!, recordId) : Promise.resolve();
    void free
      .then(() => hostActions.update(scope, recordId, record.revision, patch))
      .then((next) => { state.store.write(() => next); setEditing(false); })
      .catch((e: unknown) => { const r = writeProblem(e, "update", t); setProblem(r.problem); setStale(r.kind === "stale"); })
      .finally(() => setPending(false));
  };

  const tabs: DrawerTab[] = record && view ? [
    { id: "overview", label: t("Overview"), panel: (
      <section className="hr-sect" aria-label={t("Employment")}>
        <h4>{t("Employment")}</h4>
        <Detail className="hr-detail" label={t("Employee fields")} items={[
          { key: "no", term: t("Employee number"), value: <span className="num">{view.employeeNo || "—"}</span> },
          { key: "title", term: t("Job title"), value: view.jobTitle || "—" },
          { key: "dept", term: t("Department"), value: view.department || "—" },
          { key: "type", term: t("Employment type"), value: t(typeLabel(view.employmentType)) },
          { key: "status", term: t("Status"), value: t(statusLabel(view.status)) },
          { key: "join", term: t("Join date"), value: <span className="num">{view.joinDate || "—"}</span> },
          { key: "leave", term: t("Leave date"), value: <span className="num">{view.leaveDate ?? "—"}</span> },
          { key: "email", term: t("Email"), value: <span className="num">{view.email ?? "—"}</span> },
          { key: "phone", term: t("Phone"), value: <span className="num">{view.phone ?? "—"}</span> },
          ...(view.managerId ? [{ key: "manager", term: t("Manager"), value: <span className="num">{view.managerId}</span> }] : []),
        ]} />
      </section>
    ) },
    { id: "details", label: t("Details"), panel: (
      <section aria-label={t("Record diagnostics")}>
        <p className="num text-micro text-ink-500">{t("Record")} <span className="num">{recordId}</span> · {t("revision")} r{record.revision} · {t("digest")} {record.digest.slice(0, 18)}…</p>
      </section>
    ) },
  ] : [];

  return (
    <FrameDrawer
      kind="employee" kicker={t("Employee")} label={t("Employee details")}
      title={loading ? t("Employee details") : (view?.displayName || t("Employee details"))}
      avatar={initials || undefined} subtitle={view ? [view.jobTitle, view.department].filter(Boolean).join(" · ") || undefined : undefined}
      pills={view ? <><span className="chip" data-status={view.status ?? "unknown"}>{t(statusLabel(view.status))}</span><span className="chip">{t(typeLabel(view.employmentType))}</span></> : undefined}
      tabs={tabs}
      state={loading ? <Loading>{t("Reading the employee…")}</Loading> : error !== null && !record ? <ErrorNotice onRetry={reload}>{error}</ErrorNotice> : state.updating ? <span role="status"><QueryRefresh updating /></span> : undefined}
      edit={editing && canWrite && record ? {
        formId: FORM_ID, title: t("Edit employee — saving is refused if the record changed since you opened it"), pending, onCancel: () => { setEditing(false); setProblem(null); setStale(false); },
        body: (
          <EmployeeForm key={record.revision} formId={FORM_ID} initial={formFromProfile(record.profile)} problem={problem} onSubmit={save}>
            {stale && <div><Button size="sm" onClick={reload}>{t("Reload this employee")}</Button></div>}
          </EmployeeForm>
        ),
      } : null}
      secondary={record && canWrite ? <Button size="sm" onClick={() => { setEditing(true); setProblem(null); }}>{t("Edit")}</Button> : undefined}
      note={record && !canWrite ? t("Read-only view. Edits are disabled on this board.") : undefined}
      onClose={onClose}
    />
  );
}
