# Payroll records

Money is an integer in minor units (cents) of HKD. Dates are `YYYY-MM-DD`; a period is `YYYY-MM`.

## `payroll_runs` (one row per run)

| Field | Meaning |
| --- | --- |
| `run_ref` | `hr-payroll-<YYYY-MM>-<run>`; unique, and the Accounting reference |
| `period`, `run_no` | the month and its run number (1, 2, ...); a cancelled run keeps its number |
| `entry_date` | the month's last day, the date the run is posted on |
| `status` | `draft`, `approved` or `cancelled`; an approved or cancelled run cannot change |
| `line_count` | how many lines the run has |
| `calc_version` | the version of the screen's calculation |
| `decided_on`, `decision_note` | the owner's approval or cancellation |

## `payroll_lines` (one per employee in a run; never changed)

| Field | Meaning |
| --- | --- |
| `employee_id`, `employee_name` | the employee and their name when the run was saved |
| `join_date` | the join date the contribution holiday was worked out from |
| `salary_id`, `monthly_minor` | the salary row in effect and its monthly amount |
| `additions_minor`, `deductions_minor` | what the owner added (allowances, commission, bonus) or deducted (unpaid leave, a part month) |
| `mpf_exempt` | the salary row's exemption flag |
| `rate_effective_from` | the MPF rate row used |
| `relevant_income_minor` | relevant income for MPF |
| `employer_mpf_minor`, `employee_mpf_minor` | the two mandatory contributions |
| `net_pay_minor` | relevant income less the employee's contribution |
| `calc_version` | the calculation that made the line |

## `salaries` (never changed)

`employee_id`, `effective_from`, `seq`, `monthly_minor`, `currency` (`HKD`), `mpf_exempt`, `note`. The salary in effect for a month is the latest `effective_from` on or before the month's last day; on one date the highest `seq` counts (a correction).

## `rate_tables` (never changed)

`effective_from`, `employer_rate_bp` and `employee_rate_bp` (basis points: 500 is 5%), `min_relevant_income_minor`, `max_relevant_income_minor`, `holiday_days`, `currency`, `source_note`. The row in effect for a month is the latest whose `effective_from` is on or before the month's first day. Quote the row's own `source_note` when asked where the figures come from.
