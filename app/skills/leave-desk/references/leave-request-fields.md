# leave_requests fields

All inside `profile` on `records.create` with `table: "leave_requests"`.

| Field | Value |
| --- | --- |
| `employee_id` | the employee record's `id` (not the employee number) |
| `employee_name` | the employee's `display_name` at the time of the request |
| `leave_type` | the leave type `code`, in capitals, as it appears in `leave_types` |
| `start_date`, `end_date` | `YYYY-MM-DD`; the end is on or after the start |
| `half_days` | integer, 1 or more; one full day is 2; at most twice the calendar days from `start_date` to `end_date` inclusive |
| `reason` | short neutral text, or empty; no medical detail |
| `status` | `pending` (the default; the host refuses anything else on create) |

Leave `decided_on` and `decision_note` out: the owner's decision fills them, and the host refuses a create that carries either.
