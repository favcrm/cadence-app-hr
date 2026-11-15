import { ErrorNotice, Field, Select } from "@cadence/screen-ui";
import { useState } from "react";
import { useUnsavedEdits } from "../../bridge/leave";
import { FormError, optionLabel, type Field as Spec, type TableSpec, type Values } from "../../domain/records";
import AccrualEditor from "./AccrualEditor";
import { useLocale } from "./locale";

export { optionLabel };
export interface RecordProblem { field: string | null; message: string }
const offered = (list: readonly string[], current: string) => (list.includes(current) || current === "" ? list : [...list, current]);

const inputType = (f: Spec) => (f.kind === "email" ? "email" : f.kind === "phone" ? "tel" : "text");

export default function RecordForm({ spec, formId, initial, problem, onSubmit, aside, children }: {
  spec: TableSpec; formId: string; initial: Values; problem: RecordProblem | null;
  /** Shown under the fields and above the actions, from the values typed so far (a balance next to a request). */
  aside?: (values: Values) => React.ReactNode;
  /** May throw a FormError; the form shows it under its field. Call `settle` once the values are stored, before
   *  moving the screen on, so the board does not warn about edits that are saved. */
  onSubmit: (values: Values, settle: () => void) => void; children?: React.ReactNode;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState<Values>(initial);
  const [local, setLocal] = useState<RecordProblem | null>(null);
  const settle = useUnsavedEdits(Object.keys(values).some((key) => values[key] !== initial[key]));
  const set = (key: string, value: string) => { setValues((prev) => ({ ...prev, [key]: value })); setLocal(null); };
  const shown = local ?? problem;
  const err = (key: string) => (shown?.field === key ? shown.message : undefined);
  // A problem that belongs to no field on this form (a ledger refusal, say) is shown for the whole form, never dropped.
  const formWide = shown !== null && !spec.fields.some((f) => f.key === shown.field);
  const control = (f: Spec, c: { id: string }) => {
    const id = c.id;
    if (f.kind === "code") {
      return <Select id={id} full aria-label={t(f.label)} value={values[f.key]!} onChange={(v) => set(f.key, v)}
        options={offered(f.options!, initial[f.key] ?? "").map((value) => ({ value, label: t(optionLabel(value)) }))} />;
    }
    if (f.kind === "accrual") return <AccrualEditor id={id} value={values[f.key]!} onChange={(v) => set(f.key, v)} />;
    if (f.kind === "longtext") {
      return <textarea {...c} className="field hr-textarea" rows={f.key === "body" || f.key === "cvText" || f.key === "description" ? 8 : 3} value={values[f.key]!}
        maxLength={f.max} onChange={(e) => set(f.key, e.target.value)} />;
    }
    return <input {...c} className="field" type={inputType(f)} inputMode={f.kind === "money" || f.kind === "days" || f.kind === "sdays" ? "decimal" : undefined} value={values[f.key]!}
      maxLength={f.max} autoComplete="off" onChange={(e) => set(f.key, e.target.value)} />;
  };
  return (
    <form id={formId} className="grid gap-3" noValidate onSubmit={(e) => {
      e.preventDefault();
      try { onSubmit(values, settle); }
      catch (error) { if (error instanceof FormError) setLocal({ field: error.field, message: t(error.message) }); else throw error; }
    }}>
      {spec.fields.map((f) => {
        const id = `${formId}-${f.key}`;
        return (
          <Field key={f.key} label={t(f.label)} id={id} required={f.required} hint={f.hint ? t(f.hint) : undefined} error={err(f.key)} className="hr-field">
            {(c) => control(f, c)}
          </Field>
        );
      })}
      {aside?.(values)}
      {shown && formWide && <ErrorNotice bare>{shown.message}</ErrorNotice>}
      {children}
    </form>
  );
}
