# Posting steps: reads, the batch and the HR record

## The prepared posting (HR, table `postings`)

| Field | Meaning |
| --- | --- |
| `source` | `payroll` or `claim` |
| `source_id` | the payroll run's record id (its reference) or the claim's record id |
| `entry_ref` | the Accounting reference: `hr-payroll-<YYYY-MM>-<run>` or `hr-claim-<claim id>`; unique |
| `entry_date`, `period` | the entry's date and its month |
| `batch` | the exact `records.batch` arguments for Accounting: one `journal_entries` item and two or more `journal_lines` items |
| `stage` | `prepared`, or `posted` once HR has recorded it; a posted row cannot change |
| `posting_ref`, `posted_on` | null until step 8 records them |

Until it is recorded as posted, the owner can prepare the row again with other accounts, so the journal's lines can differ from the row's: step 8 compares them before it records anything.

A payroll run is posted as totals by account (salaries, employer MPF, net pay, MPF payable), never per employee. A claim is its expense against the amount owed to the employee. The screen computed every figure; you copy them.

## Opening balances (Accounting)

1. `records.list`, `table: "journal_entries"`, `filters: [{"field": "source", "op": "eq", "value": "opening"}]`, `limit: 100`, following `next_cursor` to the end.
2. For each entry found: `records.list`, `table: "journal_entries"`, `filters: [{"field": "reverses", "op": "eq", "value": "<its entry_ref>"}]`, `limit: 2`.
3. The standing opening balances are the latest-dated opening entry that no entry reverses. If there is one, the posting's `entry_date` must be after its `entry_date`.

Any read that fails, is refused or is cut short (`truncated`): the check could not be made. Say so and stop.

## Worked example

The owner asks: "Post the January payroll." The prepared posting for `hr-payroll-2026-01-1` holds (synthetic figures):

| Account | Debit | Credit |
| --- | --- | --- |
| 6010 | 35,000.00 | |
| 6020 | 1,750.00 | |
| 1020 | | 34,000.00 |
| 2110 | | 2,750.00 |

`app_describe` lists Accounting; the HR run is `approved`; `journal_entries` has no `hr-payroll-2026-01-1`; the chart returns all four codes active; the standing opening balances are dated 2025-12-31, before 2026-01-31. You stage `records.batch` on Accounting with the posting's `batch` unchanged. The owner approves; the `eq` read finds the entry; you stage the HR `postings` update with `stage` `posted`, `posting_ref` `hr-payroll-2026-01-1` and today's date.

## Saying it

- Not installed: "Posting to Accounting is unavailable: the Accounting app is not installed (or not active) on this board. Everything else in HR works as before."
- Already there: "`hr-payroll-2026-01-1` is already in the Accounting journal, so I have not staged it again."
- Recorded: "The Accounting journal has `hr-payroll-2026-01-1`, and HR now records it as posted on 2026-02-03."
