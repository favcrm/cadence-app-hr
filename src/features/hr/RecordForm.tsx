import { ErrorNotice, Field, Select } from "@cadence/screen-ui";
import { useState } from "react";
import { useUnsavedEdits } from "../../bridge/leave";
import { FormError, optionLabel, type Field as Spec, type TableSpec, type Values } from "../../domain/records";
import { useLocale } from "./locale";

export { optionLabel };
export interface RecordProblem { field: string | null; message: string }
const offered = (list: readonly string[], current: string) => (list.includes(current) || current === "" ? list : [...list, current]);

const inputType = (f: Spec) => (f.kind === "email" ? "email" : f.kind === "phone" ? "tel" : "text");

export default function RecordForm({ spec, formId, initial, problem, onSubmit, children }: {
  spec: TableSpec; formId: string; initial: Values; problem: RecordProblem | null;
  /** May throw a FormError; the form shows it under its field. */
  onSubmit: (values: Values) => void; children?: React.ReactNode;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState<Values>(initial);
  const [local, setLocal] = useState<RecordProblem | null>(null);
  useUnsavedEdits(Object.keys(values).some((key) => values[key] !== initial[key]));
  const set = (key: string, value: string) => { setValues((prev) => ({ ...prev, [key]: value })); setLocal(null); };
  const shown = local ?? problem;
  const err = (key: string) => (shown?.field === key ? shown.message : undefined);
  const control = (f: Spec, c: { id: string }) => {
    const id = c.id;
    if (f.kind === "code") {
      return <Select id={id} full aria-label={t(f.label)} value={values[f.key]!} onChange={(v) => set(f.key, v)}
        options={offered(f.options!, initial[f.key] ?? "").map((value) => ({ value, label: t(optionLabel(value)) }))} />;
    }
    if (f.kind === "longtext") {
      return <textarea {...c} className="field hr-textarea" rows={f.key === "body" || f.key === "cvText" || f.key === "description" ? 8 : 3} value={values[f.key]!}
        maxLength={f.max} onChange={(e) => set(f.key, e.target.value)} />;
    }
    return <input {...c} className="field" type={inputType(f)} inputMode={f.kind === "money" || f.kind === "days" ? "decimal" : undefined} value={values[f.key]!}
      maxLength={f.max} autoComplete="off" onChange={(e) => set(f.key, e.target.value)} />;
  };
  return (
    <form id={formId} className="grid gap-3" noValidate onSubmit={(e) => {
      e.preventDefault();
      try { onSubmit(values); }
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
      {shown && shown.field === null && <ErrorNotice bare>{shown.message}</ErrorNotice>}
      {children}
    </form>
  );
}
