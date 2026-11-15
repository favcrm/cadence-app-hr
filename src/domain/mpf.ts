// Mandatory MPF contributions for one monthly wage period. Pure integer arithmetic: money is in minor units (cents)
// and rates are basis points (500 is 5%). The code holds no rate, level or holiday length: every figure comes from a
// `rate_tables` row the owner stored, so a change in the law is a new row, not a new release.
//
// Rounding: the published sources name no rounding rule. Each side's contribution is rounded to the nearest cent on
// its own, half a cent up. At a whole-dollar income a 5% contribution is always a whole number of cents, so in the
// usual case nothing is rounded; the rule only decides an income with odd cents.
import { realDate } from "./people";

/** One stored rate row, read strictly. */
export interface RateTable {
  effectiveFrom: string;
  employerRateBp: number;
  employeeRateBp: number;
  /** Below this relevant income the employee contributes nothing; the employer still does. */
  minRelevantIncomeMinor: number;
  /** Relevant income above this is not contributed on, by either side. */
  maxRelevantIncomeMinor: number;
  /** The employee's contribution holiday: these first days of employment and the incomplete wage period after them. */
  holidayDays: number;
  currency: string;
}

export interface MpfResult { employerMinor: number; employeeMinor: number }

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;
const BP = 10000;

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** `n * bp / 10000` to the nearest whole minor unit, half up. Integers only: never a float multiplication. */
export function applyRate(minor: number, bp: number): number {
  if (!isCount(minor) || !isCount(bp) || bp > BP) throw new RangeError("amount and rate must be non-negative integers");
  return Math.floor((minor * bp * 2 + BP) / (BP * 2));
}

/** A day `days` after a real date, as YYYY-MM-DD. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The last monthly wage period of the employee's contribution holiday, or null when there is none. The holiday is the
 * first `holidayDays` days of employment plus the incomplete wage period that immediately follows; with calendar-month
 * wage periods that is every month up to and including the month holding the last holiday day. (MPFA's own example:
 * joining on 5 June, the 30 days end on 4 July, so neither June nor July carries an employee contribution.)
 */
export function holidayLastPeriod(joinDate: string, holidayDays: number): string | null {
  if (!realDate(joinDate) || !isCount(holidayDays)) throw new RangeError("join date or holiday length is invalid");
  if (holidayDays === 0) return null;
  return addDays(joinDate, holidayDays - 1).slice(0, 7);
}

export function validRate(rate: RateTable): boolean {
  return realDate(rate.effectiveFrom) && [rate.employerRateBp, rate.employeeRateBp].every((bp) => isCount(bp) && bp <= BP)
    && isCount(rate.minRelevantIncomeMinor) && isCount(rate.maxRelevantIncomeMinor) && rate.maxRelevantIncomeMinor >= 1
    && rate.minRelevantIncomeMinor <= rate.maxRelevantIncomeMinor && isCount(rate.holidayDays) && rate.holidayDays <= 366;
}

/**
 * The employer's and the employee's mandatory contribution for one calendar-month wage period.
 *
 * - `exempt`: an employee outside the scheme; neither side contributes.
 * - The employer contributes from the first day of employment, on the relevant income up to the maximum level.
 * - The employee contributes nothing during the contribution holiday, nothing when the relevant income is below the
 *   minimum level, and otherwise on the relevant income up to the maximum level.
 *
 * Throws on an invalid input or a period before the join month: a payroll line is never made from a guess.
 */
export function mpf(relevantIncomeMinor: number, joinDate: string, period: string, rateTable: RateTable, exempt: boolean): MpfResult {
  if (!isCount(relevantIncomeMinor)) throw new RangeError("relevant income must be a non-negative integer");
  if (!PERIOD.test(period)) throw new RangeError("period must be YYYY-MM");
  if (!validRate(rateTable)) throw new RangeError("rate table is invalid");
  if (!realDate(joinDate)) throw new RangeError("join date is invalid");
  if (period < joinDate.slice(0, 7)) throw new RangeError("period is before the join month");
  if (rateTable.effectiveFrom > `${period}-01`) throw new RangeError("rate table is not in effect for the period");
  if (exempt) return { employerMinor: 0, employeeMinor: 0 };
  const base = Math.min(relevantIncomeMinor, rateTable.maxRelevantIncomeMinor);
  const employerMinor = applyRate(base, rateTable.employerRateBp);
  const holiday = holidayLastPeriod(joinDate, rateTable.holidayDays);
  const onHoliday = holiday !== null && period <= holiday;
  const employeeMinor = onHoliday || relevantIncomeMinor < rateTable.minRelevantIncomeMinor ? 0 : applyRate(base, rateTable.employeeRateBp);
  return { employerMinor, employeeMinor };
}

/** The rate row in effect for a period: the latest whose `effective_from` is on or before the period's first day. */
export function rateFor(rates: readonly RateTable[], period: string): RateTable | null {
  const start = `${period}-01`;
  return rates.filter((r) => r.effectiveFrom <= start).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}
