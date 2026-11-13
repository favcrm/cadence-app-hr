import { Button, Notice } from "@cadence/screen-ui";
import { useEffect, useRef, useState } from "react";
import { buildProfile, EMPTY_FORM, newEmployeeId, type EmployeeForm as Fields } from "../../domain/people";
import EmployeeForm, { type FieldProblem } from "./EmployeeForm";
import type { HostScope } from "./hostActions";
import { useLocale } from "./locale";
import { createEmployee, writeProblem } from "./submit";

const FORM_ID = "hr-employee-new";

export default function EmployeeNew({ scope, canWrite, onCreated, onCancel }: {
  scope: HostScope; canWrite: boolean; onCreated: (recordId: string) => void; onCancel: () => void;
}) {
  const { t } = useLocale();
  const head = useRef<HTMLHeadingElement | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FieldProblem | null>(null);
  // Stored, though the screen may not have moved on (a refused route patch): leaving loses nothing.
  const [saved, setSaved] = useState(false);
  // One id per open form. A retry after a lost reply reuses it: the pre-check ignores this id's own row, and if the
  // first attempt did land, the host refuses a second create under the same id instead of adding another row.
  const [recordId] = useState(newEmployeeId);
  useEffect(() => { head.current?.focus(); }, []);

  const submit = (fields: Fields) => {
    const profile = buildProfile(fields);
    setPending(true); setProblem(null);
    void createEmployee(scope, recordId, profile)
      .then((record) => { setSaved(true); onCreated(record.id); })
      .catch((error: unknown) => setProblem(writeProblem(error, "create", t).problem))
      .finally(() => setPending(false));
  };
  return (
    <section aria-label={t("Add employee")}>
      <h3 ref={head} className="text-cardtitle font-medium text-ink-100" tabIndex={-1} data-outlet-heading>{t("Add employee")}</h3>
      <p className="text-label text-ink-400 mt-1"><button type="button" className="lnk" onClick={onCancel}>← {t("People")}</button></p>
      {!canWrite ? <Notice className="mt-2" state="read-only">{t("Read-only view. The owner adds employees.")}</Notice> : (
        <div className="card px-4 py-4 mt-2">
          <EmployeeForm formId={FORM_ID} initial={EMPTY_FORM} problem={problem} onSubmit={submit} saved={saved}>
            <div className="hr-actions">
              <Button type="submit" variant="primary" loading={pending} disabled={pending}>{t("Add employee")}</Button>
              <Button onClick={onCancel} disabled={pending}>{t("Cancel")}</Button>
            </div>
          </EmployeeForm>
        </div>
      )}
    </section>
  );
}
