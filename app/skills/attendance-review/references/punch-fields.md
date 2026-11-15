# Punch fields (`attendance_punches`)

Append-only: no punch is ever updated. Each row belongs to a member account (`member_id`, set by the workspace, never by the person filing it).

| Field | Meaning |
| --- | --- |
| `employee_id` | The employee record the punch is for |
| `member_id` | The account that owns the row: the staff member who punched, or for an import or correction the account linked to the employee then (`-` when none was linked) |
| `at` | Epoch seconds. Convert to Hong Kong time (UTC+8) before grouping by day |
| `direction` | `in` or `out` |
| `method` | `app`, `import` or `correction`, as written; trust the record `id` prefix instead (`imp-`, `cor-`, anything else is a staff punch) |
| `lat_e7`, `lng_e7`, `accuracy_m` | Always null in this release: no location is recorded |
| `note` | A correction's reason |
| `client_ref` | A retry key; ignore it |

An imported punch for an employee with no linked account has `member_id` `-`: it is still that employee's punch.
