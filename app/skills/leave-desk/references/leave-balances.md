# Leave balances

The ledger is the table `leave_entries`. Each entry has a signed integer `half_days` (never 0), a `kind` and a unique `source_ref`:

| `kind` | Sign | Written by |
| --- | --- | --- |
| `accrual` | + | the owner's "Run accrual" on the Balances list |
| `taken` | - | the owner's approval of a leave request (`source_ref` is `taken-<request id>`) |
| `adjustment` | + or - | the owner's "Adjust balance", with a note |
| `carry_forward` | + | reserved; the owner or a later release |
| `expiry` | - | reserved; the owner or a later release |

Entries are never edited or deleted. A balance is their sum, computed by the host:

```
app_call records.aggregate
  table: "leave_entries"
  group_by: ["employee_id", "leave_type"]
  sum: ["half_days"]
  filters: [{"field": "employee_id", "op": "eq", "value": "<employee record id>"}]
```

The answer is `{groups: [{key: {employee_id, leave_type}, count, sums: {half_days}}], truncated}`.

## Half days to days

One full day is 2 half days. Print `sums.half_days` as days exactly like this, so your figure equals the screen's:

| `half_days` | days |
| --- | --- |
| 14 | 7 |
| 3 | 1.5 |
| 1 | 0.5 |
| 0 | 0 |
| -1 | -0.5 |
| -3 | -1.5 |

Divide by 2; a half day shows as `.5`; a negative keeps its minus sign (a single half day below zero is `-0.5`, never `0.5`).

## What you may and may not say

- "Avery Sample has 5.5 days of ANNUAL leave, as of 2026-03-09 14:05." is right when `sums.half_days` was 11 in a read made then.
- If the aggregate was cut short (`truncated: true`) or failed, there is no figure to state.
- The accrual rule that fills the ledger is the owner's own data, held on the leave type (`leave_types.accrual_rule`). You never say what an employee is legally entitled to.
