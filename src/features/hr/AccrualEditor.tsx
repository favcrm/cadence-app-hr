import { Button, Notice } from "@cadence/screen-ui";
import { RULE_KEPT, parseAccrualRule, removeTier } from "../../domain/leave";
import { useLocale } from "./locale";

interface Row { years: string; days: string }
const toRows = (value: string): Row[] => (value === "" || value === RULE_KEPT ? [] : value.split(";").map((part) => { const [years = "", days = ""] = part.split(":"); return { years, days }; }));
const toText = (rows: Row[]): string => rows.map((r) => `${r.years}:${r.days}`).join(";");

/**
 * The accrual rule as steps, not JSON: from how many completed years of service, and how many days a year. The value is
 * the text form (`years:days` joined by `;`) the form keeps; it is checked and turned into the stored rule on save.
 */
export default function AccrualEditor({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  if (value === RULE_KEPT) {
    return (
      <div className="grid gap-2" id={id}>
        <Notice>{t("This leave type has an accrual rule the screen cannot read. It is kept as it is unless you replace it.")}</Notice>
        <div className="hr-actions"><Button size="sm" onClick={() => onChange("")}>{t("Replace it with a new rule")}</Button></div>
      </div>
    );
  }
  const rows = toRows(value);
  const step = (text: string, n: number) => t(text).replace("{n}", String(n));
  const set = (index: number, patch: Partial<Row>) => onChange(toText(rows.map((r, i) => (i === index ? { ...r, ...patch } : r))));
  return (
    <div className="grid gap-2" id={id} role="group" aria-label={t("Leave accrued each month")}>
      {rows.length === 0 && <p className="text-label text-ink-400">{t("No accrual. This leave type does not add leave by itself.")}</p>}
      {rows.map((row, i) => (
        <div className="hr-tier" key={i}>
          <input className="field" type="text" inputMode="numeric" maxLength={2} value={row.years} disabled={i === 0} aria-label={step("Completed years of service, step {n}", i + 1)} onChange={(e) => set(i, { years: e.target.value })} />
          <span className="text-label text-ink-400">{t("years of service:")}</span>
          <input className="field" type="text" inputMode="decimal" maxLength={7} value={row.days} aria-label={step("Days a year, step {n}", i + 1)} onChange={(e) => set(i, { days: e.target.value })} />
          <span className="text-label text-ink-400">{t("days a year")}</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(removeTier(value, i))}>{t("Remove")}</Button>
        </div>
      ))}
      <div className="hr-actions">
        <Button size="sm" onClick={() => onChange(toText([...rows, { years: rows.length === 0 ? "0" : "", days: "" }]))}>{t(rows.length === 0 ? "Add a yearly entitlement" : "Add a step for longer service")}</Button>
      </div>
    </div>
  );
}

/** The stored rule in words, for the record's detail. A missing rule says so; one the screen cannot read says that. */
export function AccrualSummary({ value }: { value: unknown }) {
  const { t, formatNumber } = useLocale();
  if (value === null || value === undefined) return <>{t("Does not accrue")}</>;
  const parsed = parseAccrualRule(value);
  if (!parsed.ok) return <>{t("Not in a format this screen can read")}</>;
  const days = (half: number) => formatNumber(half / 2);
  return (
    <ul className="hr-reasons">
      {parsed.tiers.map((tier, i) => (
        <li key={i}>{(i === 0 ? t("{days} days a year from the start") : t("{days} days a year from {years} years of service")).replace("{days}", days(tier.halfDays)).replace("{years}", formatNumber(tier.fromYears))}</li>
      ))}
    </ul>
  );
}
