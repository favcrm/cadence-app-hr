import { Button, Notice } from "@cadence/screen-ui";
import { useEffect, useRef, useState } from "react";
import { buildProfile, EMPTY_FORM, newEmployeeId, type EmployeeForm as Fields } from "../../domain/people";
import EmployeeForm, { type FieldProblem } from "./EmployeeForm";
import { hostActions, type HostScope } from "./hostActions";
import { useLocale } from "./locale";
import { assertEmployeeNoFree, writeProblem } from "./submit";

const FORM_ID = "hr-employee-new";

export default function EmployeeNew({ scope, canWrite, onCreated, onCancel }: {
  scope: HostScope; canWrite: boolean; onCreated: (recordId: string) => void; onCancel: () => void;
}) {
  const { t } = useLocale();
  const head = useRef<HTMLHeadingElement | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FieldProblem | null>(null);
  // One id per open form: a retry after a lost reply reuses it, so the host refuses a second row instead of adding one.
  const [recordId] = useState(newEmployeeId);
  useEffect(() => { head.current?.focus(); }, []);

  const submit = (fields: Fields) => {
    const profile = buildProfile(fields);
    setPending(true); setProblem(null);
    void assertEmployeeNoFree(scope, profile.employee_no!, null)
      .then(() => hostActions.create(scope, recordId, profile))
      .then((record) => onCreated(record.id))
      .catch((error: unknown) => setProblem(writeProblem(error, t).problem))
      .finally(() => setPending(false));
  };
  return (
    <section aria-label={t("Add employee")}>
      <h3 ref={head} className="text-cardtitle font-medium text-ink-100" tabIndex={-1} data-outlet-heading>{t("Add employee")}</h3>
      <p className="text-label text-ink-400 mt-1"><button type="button" className="lnk" onClick={onCancel}>← {t("People")}</button></p>
      {!canWrite ? <Notice className="mt-2" state="read-only">{t("Read-only view. The owner adds employees.")}</Notice> : (
        <div className="card px-4 py-4 mt-2">
          <EmployeeForm formId={FORM_ID} initial={EMPTY_FORM} problem={problem} onSubmit={submit}>
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
