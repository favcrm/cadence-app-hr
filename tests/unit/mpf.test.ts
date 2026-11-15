// The MPF golden table: each case to the exact cent, from the first rate row (HR-4's confirmed figures), plus the
// rules the table rests on. Run: bun test tests/unit/mpf.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIRST_MPF_RATE } from "../../src/domain/mpf-rates.ts";
import { applyRate, holidayLastPeriod, mpf, rateFor, type RateTable } from "../../src/domain/mpf.ts";

const RATE: RateTable = {
  effectiveFrom: FIRST_MPF_RATE.effective_from, employerRateBp: FIRST_MPF_RATE.employer_rate_bp, employeeRateBp: FIRST_MPF_RATE.employee_rate_bp,
  minRelevantIncomeMinor: FIRST_MPF_RATE.min_relevant_income_minor, maxRelevantIncomeMinor: FIRST_MPF_RATE.max_relevant_income_minor,
  holidayDays: FIRST_MPF_RATE.holiday_days, currency: FIRST_MPF_RATE.currency,
};
const LONG_AGO = "2020-01-01";

// [name, relevant income (cents), join date, period, exempt, employer (cents), employee (cents)]
const GOLDEN: [string, number, string, string, boolean, number, number][] = [
  ["below the minimum: 7,000.00", 700000, LONG_AGO, "2026-01", false, 35000, 0],
  ["one cent below the minimum: 7,099.99", 709999, LONG_AGO, "2026-01", false, 35500, 0],
  ["at the minimum: 7,100.00", 710000, LONG_AGO, "2026-01", false, 35500, 35500],
  ["no income", 0, LONG_AGO, "2026-01", false, 0, 0],
  ["between the levels: 20,000.00", 2000000, LONG_AGO, "2026-01", false, 100000, 100000],
  ["between, odd cents: 12,345.67 (617.2835 each, to the cent)", 1234567, LONG_AGO, "2026-01", false, 61728, 61728],
  ["between, exactly half a cent: 10,000.10 (500.005 rounds up)", 1000010, LONG_AGO, "2026-01", false, 50001, 50001],
  ["at the maximum: 30,000.00", 3000000, LONG_AGO, "2026-01", false, 150000, 150000],
  ["one cent above the maximum: 30,000.01", 3000001, LONG_AGO, "2026-01", false, 150000, 150000],
  ["above the maximum: 85,000.00", 8500000, LONG_AGO, "2026-01", false, 150000, 150000],
  // The contribution holiday: the first 30 days and the incomplete wage period after them; the employer pays from day one.
  ["holiday, MPFA's example: joins 5 June, June", 2000000, "2026-06-05", "2026-06", false, 100000, 0],
  ["holiday, MPFA's example: joins 5 June, July (day 30 is 4 July)", 2000000, "2026-06-05", "2026-07", false, 100000, 0],
  ["holiday over, MPFA's example: joins 5 June, August", 2000000, "2026-06-05", "2026-08", false, 100000, 100000],
  ["holiday: joins 15 January, February (day 30 is 13 February)", 2500000, "2026-01-15", "2026-02", false, 125000, 0],
  ["holiday over: joins 15 January, March", 2500000, "2026-01-15", "2026-03", false, 125000, 125000],
  ["holiday: joins 2 March, day 30 is 31 March, so March only", 2000000, "2026-03-02", "2026-03", false, 100000, 0],
  ["holiday over: joins 2 March, April", 2000000, "2026-03-02", "2026-04", false, 100000, 100000],
  ["holiday: joins 1 February 2026, day 30 is 2 March, so March too", 2000000, "2026-02-01", "2026-03", false, 100000, 0],
  ["holiday, above the maximum: the employer is still capped", 5000000, "2026-06-05", "2026-06", false, 150000, 0],
  ["holiday, leap year: joins 1 February 2028, day 30 is 1 March", 2000000, "2028-02-01", "2028-03", false, 100000, 0],
  // Exempt: outside the scheme, neither side contributes.
  ["exempt, between the levels", 2000000, LONG_AGO, "2026-01", true, 0, 0],
  ["exempt, above the maximum", 8500000, LONG_AGO, "2026-01", true, 0, 0],
];

test("the golden table: below, at and between the levels, above the maximum, the contribution holiday and exempt, to the cent", () => {
  for (const [name, income, join, period, exempt, employer, employee] of GOLDEN) {
    expect([name, mpf(income, join, period, RATE, exempt)]).toEqual([name, { employerMinor: employer, employeeMinor: employee }]);
  }
});

test("the contribution holiday ends with the month holding its last day", () => {
  expect(holidayLastPeriod("2026-06-05", 30)).toBe("2026-07");
  expect(holidayLastPeriod("2026-01-01", 30)).toBe("2026-01");
  expect(holidayLastPeriod("2026-01-02", 30)).toBe("2026-01");
  expect(holidayLastPeriod("2026-01-03", 30)).toBe("2026-02");
  expect(holidayLastPeriod("2026-12-15", 30)).toBe("2027-01");
  expect(holidayLastPeriod("2026-06-05", 0)).toBeNull();
  // With no holiday the employee contributes in the join month.
  expect(mpf(2000000, "2026-06-05", "2026-06", { ...RATE, holidayDays: 0 }, false)).toEqual({ employerMinor: 100000, employeeMinor: 100000 });
});

test("integer arithmetic only: half a cent rounds up, less rounds down, and nothing is a float", () => {
  expect(applyRate(1000010, 500)).toBe(50001); // 500.005
  expect(applyRate(1000009, 500)).toBe(50000); // 500.0045
  expect(applyRate(1000011, 500)).toBe(50001); // 500.0055
  expect(applyRate(99999999999, 10000)).toBe(99999999999);
  for (let income = 0; income <= 4000000; income += 997) {
    const r = mpf(income, LONG_AGO, "2026-01", RATE, false);
    expect(Number.isSafeInteger(r.employerMinor) && Number.isSafeInteger(r.employeeMinor)).toBe(true);
    expect(r.employerMinor).toBeLessThanOrEqual(150000);
    expect(r.employeeMinor === 0 || r.employeeMinor === r.employerMinor).toBe(true);
  }
  expect(() => applyRate(1.5, 500)).toThrow();
  expect(() => mpf(-1, LONG_AGO, "2026-01", RATE, false)).toThrow();
  expect(() => mpf(100, LONG_AGO, "2026-1", RATE, false)).toThrow();
  expect(() => mpf(100, "2026-02-30", "2026-03", RATE, false)).toThrow();
});

test("a period before the join month, or before the rate row takes effect, is refused rather than guessed", () => {
  expect(() => mpf(2000000, "2026-06-05", "2026-05", RATE, false)).toThrow();
  expect(() => mpf(2000000, "2010-01-01", "2014-05", RATE, false)).toThrow();
  expect(() => mpf(2000000, LONG_AGO, "2026-01", { ...RATE, minRelevantIncomeMinor: 5, maxRelevantIncomeMinor: 4 }, false)).toThrow();
});

test("the rates are data: the row in effect is the latest on or before the period's first day", () => {
  const later: RateTable = { ...RATE, effectiveFrom: "2027-07-01", maxRelevantIncomeMinor: 3500000 };
  expect(rateFor([RATE, later], "2027-06")).toBe(RATE);
  expect(rateFor([RATE, later], "2027-07")).toBe(later);
  expect(rateFor([RATE], "2014-05")).toBeNull();
  expect(mpf(8500000, LONG_AGO, "2027-07", later, false)).toEqual({ employerMinor: 175000, employeeMinor: 175000 });
});

test("mpf.ts holds no rate, level or holiday length", () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/domain/mpf.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toMatch(/\b(500|5|7100|710000|30000|3000000|1500|150000|30|0\.05)\b/);
});

test("the first rate row is HR-4's confirmed figures and names its source", () => {
  expect(FIRST_MPF_RATE).toMatchObject({ effective_from: "2014-06-01", employer_rate_bp: 500, employee_rate_bp: 500, min_relevant_income_minor: 710000, max_relevant_income_minor: 3000000, holiday_days: 30, currency: "HKD" });
  expect(FIRST_MPF_RATE.source_note).toContain("https://www.mpfa.org.hk/en/mpf-system/mandatory-contributions/employees");
  expect(FIRST_MPF_RATE.source_note.length).toBeLessThanOrEqual(1000);
  const columns = JSON.parse(readFileSync(fileURLToPath(new URL("../../app/storage/004-payroll.json", import.meta.url)), "utf8")).operations[0].columns.map((c: { name: string }) => c.name);
  expect(Object.keys(FIRST_MPF_RATE)).toEqual(columns);
});
