// The first `rate_tables` row, offered once to the owner on an empty MPF rates list (like the starter leave types).
// It is data, not code the calculation reads: `mpf.ts` only ever sees rows read back from storage. The figures are the
// ones confirmed against the MPFA and government publications on 2026-11-14 and recorded on ticket HR-4: monthly-paid
// employees, mandatory contributions only. Re-check the MPFA page before relying on them.
// Columns mirror `rate_tables` in app/storage/004-payroll.json; tests keep them in step.

export interface RateRow {
  effective_from: string;
  employer_rate_bp: number;
  employee_rate_bp: number;
  min_relevant_income_minor: number;
  max_relevant_income_minor: number;
  holiday_days: number;
  currency: string;
  source_note: string;
}

/** In effect from 2014-06-01, when the maximum level last changed; the minimum level dates from 2013-11-01. */
export const FIRST_MPF_RATE: RateRow = {
  effective_from: "2014-06-01",
  employer_rate_bp: 500,
  employee_rate_bp: 500,
  min_relevant_income_minor: 710000,
  max_relevant_income_minor: 3000000,
  holiday_days: 30,
  currency: "HKD",
  source_note:
    "MPF mandatory contributions for monthly-paid employees: employer and employee each 5% of relevant income; " +
    "minimum relevant income 7,100 a month (in effect since 2013-11-01), below which the employee contributes nothing; " +
    "maximum 30,000 a month (since 2014-06-01); employee contribution holiday for the first 30 days of employment and " +
    "the incomplete wage period after them, not for the employer. Confirmed 2026-11-14 against MPFA, Mandatory " +
    "Contributions - Employees (https://www.mpfa.org.hk/en/mpf-system/mandatory-contributions/employees). " +
    "Generic figures, not advice: check them against the MPFA before relying on them.",
};

/** The fixed record id of a rate row: a second load meets the row the first one made. */
export const rateRecordId = (effectiveFrom: string): string => `rt-${effectiveFrom}`;
