# claims fields

All inside `profile` on `records.create` with `table: "claims"`.

| Field | Value |
| --- | --- |
| `employee_id` | the employee record's `id` |
| `employee_name` | the employee's `display_name` at the time of the claim |
| `claim_date` | the receipt date, `YYYY-MM-DD` |
| `category` | one of `travel`, `meals`, `supplies`, `other` (lowercase) |
| `merchant` | as printed on the receipt, up to 120 characters |
| `amount_minor` | integer in minor units, 1 or more |
| `currency` | three capital letters, as on the receipt |
| `description` | short neutral text, up to 500 characters; no medical detail |
| `receipt_ref` | the attached file's name, or empty |
| `status` | `submitted` (the default; the host refuses anything else on create) |
