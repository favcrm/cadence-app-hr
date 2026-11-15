// What "Reverse deductions on rejected or cancelled requests" says before and after it posts. Kept apart from the
// Balances pane so a test can render it in both languages without the rest of the screen.
import { signedDays } from "../../domain/leave";
import { RECOVERY_LIMIT, type RecoveryPlan } from "./ledger";
import { useLocale } from "./locale";

/** Every `{count}` in a translated string, not only the first. */
export const fillCount = (text: string, count: string): string => text.replaceAll("{count}", count);

/** The review step: what would be reversed, what was already, what cannot be, and what was not read. */
export function RecoverySummary({ plan, nameOf }: { plan: RecoveryPlan; nameOf: (id: string) => string }) {
  const { t, formatNumber } = useLocale();
  const shown = plan.rows.slice(0, 10);
  return (
    <div className="grid gap-1">
      <p className="text-label">
        {fillCount(t("{count} rejected or cancelled requests still deduct leave."), formatNumber(plan.rows.length))}
        {plan.alreadyThere > 0 && <> {fillCount(t("{count} were already reversed."), formatNumber(plan.alreadyThere))}</>}
      </p>
      {shown.length > 0 && (
        <ul className="hr-reasons">
          {shown.map((r) => <li key={r.requestId}>{nameOf(r.entry.employee_id)} — {r.entry.leave_type}, {t("{days} days").replaceAll("{days}", signedDays(r.entry.half_days))}</li>)}
        </ul>
      )}
      {plan.rows.length > shown.length && <p className="text-micro text-ink-500">{fillCount(t("and {count} more requests"), formatNumber(plan.rows.length - shown.length))}</p>}
      {plan.unusable.length > 0 && <p className="text-label text-ink-400">{fillCount(t("{count} cannot be reversed here because their leave entry is not in the expected form. Correct those balances with an adjustment."), formatNumber(plan.unusable.length))}</p>}
      {plan.more && <p className="text-label text-ink-400" data-recovery-more>{fillCount(t("In each of Leave requests and Staff requests, only the newest {count} rejected and the newest {count} cancelled requests were checked; older ones are not shown."), formatNumber(RECOVERY_LIMIT))}</p>}
      <StaffBalancesNote plan={plan} />
    </div>
  );
}

/** A reversed staff request changes that member's balance, which their own view shows only after it is published again. */
export function StaffBalancesNote({ plan }: { plan: RecoveryPlan }) {
  const { t, formatNumber } = useLocale();
  const staff = plan.rows.filter((r) => r.staff).length;
  if (staff === 0) return null;
  return <p className="text-label text-ink-400" data-staff-balances-note>{fillCount(t("{count} of these requests were filed from the staff view. Use Update staff balances in People → Staff accounts so those employees see the change."), formatNumber(staff))}</p>;
}
