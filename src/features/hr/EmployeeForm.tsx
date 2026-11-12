import { ErrorNotice, Field, Select } from "@cadence/screen-ui";
import { useState } from "react";
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, FormError, LIMITS, type EmployeeForm as Fields } from "../../domain/people";
import { useLocale } from "./locale";

const TYPE_LABEL: Record<string, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", intern: "Intern" };
const STATUS_LABEL: Record<string, string> = { active: "Active", on_leave: "On leave", left: "Left" };
// An unknown stored value is shown as it is; the translation falls back to the same text.
export const typeLabel = (v: string | null) => (v ? TYPE_LABEL[v] ?? v : "—");
export const statusLabel = (v: string | null) => (v ? STATUS_LABEL[v] ?? v : "—");
/** The offered values, plus the record's own value when it is outside the list, so an edit never rewrites it. */
const offered = (list: readonly string[], current: string) => (list.includes(current) || current === "" ? list : [...list, current]);

/** A refusal shown under the field it belongs to; anything else shows once above the buttons. */
export interface FieldProblem { field: keyof Fields | null; message: string }

export default function EmployeeForm({ initial, formId, problem, onSubmit, children }: {
  initial: Fields; formId: string; problem: FieldProblem | null;
  /** May throw a FormError; the form shows it under its field. */
  onSubmit: (fields: Fields) => void;
  /** Extra controls under the notice, e.g. the reload button for a stale save. */
  children?: React.ReactNode;
}) {
  const { t } = useLocale();
  const [fields, setFields] = useState<Fields>(initial);
  const [local, setLocal] = useState<FieldProblem | null>(null);
  const set = (patch: Partial<Fields>) => { setFields((prev) => ({ ...prev, ...patch })); setLocal(null); };
  const shown = local ?? problem;
  const err = (field: keyof Fields) => (shown?.field === field ? shown.message : undefined);
  const text = (field: keyof Fields, label: string, id: string, extra: { max: number; type?: string; hint?: string; required?: boolean; placeholder?: string }) => (
    <Field label={t(label)} id={id} required={extra.required} hint={extra.hint ? t(extra.hint) : undefined} error={err(field)} className="hr-field">
      {(c) => (
        <input {...c} className="field" type={extra.type ?? "text"} value={fields[field]} maxLength={extra.max} autoComplete="off"
          placeholder={extra.placeholder ? t(extra.placeholder) : undefined} onChange={(e) => set({ [field]: e.target.value } as Partial<Fields>)} />
      )}
    </Field>
  );
  return (
    <form id={formId} className="grid gap-3" noValidate onSubmit={(e) => {
      e.preventDefault();
      try { onSubmit(fields); }
      catch (error) { if (error instanceof FormError) setLocal({ field: error.field, message: t(error.message) }); else throw error; }
    }}>
      {text("displayName", "Name", `${formId}-name`, { max: LIMITS.displayName, required: true })}
      <div className="hr-field-row">
        {text("employeeNo", "Employee number", `${formId}-no`, { max: LIMITS.employeeNo, required: true, hint: "Unique. Letters, digits, - and _" })}
        {text("email", "Email (optional)", `${formId}-email`, { max: LIMITS.email, type: "email", placeholder: "name@example.com" })}
      </div>
      <div className="hr-field-row">
        {text("phone", "Phone (optional)", `${formId}-phone`, { max: LIMITS.phone, type: "tel" })}
        {text("jobTitle", "Job title", `${formId}-title`, { max: LIMITS.jobTitle })}
      </div>
      <div className="hr-field-row">
        {text("department", "Department", `${formId}-dept`, { max: LIMITS.department })}
        <Field label={t("Employment type")} id={`${formId}-type`} error={err("employmentType")} className="hr-field">
          {(c) => <Select id={c.id} full aria-label={t("Employment type")} value={fields.employmentType}
            onChange={(v) => set({ employmentType: v })}
            options={offered(EMPLOYMENT_TYPES, initial.employmentType).map((value) => ({ value, label: t(typeLabel(value)) }))} />}
        </Field>
      </div>
      <div className="hr-field-row">
        {text("joinDate", "Join date (optional)", `${formId}-join`, { max: 10, hint: "YYYY-MM-DD", placeholder: "2026-01-31" })}
        {text("leaveDate", "Leave date (optional)", `${formId}-leave`, { max: 10, hint: "YYYY-MM-DD" })}
      </div>
      <Field label={t("Status")} id={`${formId}-status`} error={err("status")} className="hr-field">
        {(c) => <Select id={c.id} full aria-label={t("Status")} value={fields.status}
          onChange={(v) => set({ status: v })}
          options={offered(EMPLOYEE_STATUSES, initial.status).map((value) => ({ value, label: t(statusLabel(value)) }))} />}
      </Field>
      {shown && shown.field === null && <ErrorNotice bare>{shown.message}</ErrorNotice>}
      {children}
    </form>
  );
}
