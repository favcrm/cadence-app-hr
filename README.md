# Cadence HR app

Public repository: https://github.com/favcrm/cadence-app-hr.
App identity is `hr`. Release 0.3.0 adds leave balances as a ledger (below). Release 0.2.0 holds seven tables behind five tabs. People is
the employee directory from 0.1.0. Policies, Leave, Claims and Recruiting are new:
company policies, leave requests and leave types, expense claims, job openings
and candidates. Leave and Claims show a pending queue with approve and reject as
owner actions. Five skills (`app/skills/`) tell the hosted chat agent how to
answer a policy question, stage a leave request or a claim, draft a job
description and write a screening note. The agent stages writes; the owner
approves them. Every table is readable by the workspace owner only.

The app stores names, employee numbers, contact details, leave and claim records,
policy text and candidates' CV text. It holds no pay, identity document number,
bank account or medical information.

## 0.2.1: starter leave types

A fresh install has no leave types, so nobody can file leave and the assistant (correctly) will not guess a type. On
Leave → Leave types, when the list is empty, the owner sees a short explanation and **Add common leave types**
(假期類別 → 加入常用假期類別). It creates `ANNUAL` (Annual leave, paid), `SICK` (Sick leave, paid), `UNPAID` (Unpaid
leave, unpaid) and `COMP` (Time off in lieu, paid) with the existing `leave_types` columns only; `accrual_rule` stays
empty. It is a generic template to edit, with no entitlement figures and no legal advice. No storage migration.

- The rows are created one at a time under fixed record ids (`lt-starter-<code>`), not with `records.batch`: the
  native checker the CI pins (and the latest released `cadence`, 0.3.22) refuses a screen that declares
  `records.batch`, and `assert-app-check.py` accepts only the storage refusal. Move to one `records.batch` once a
  released checker knows it (it would be one transaction, so no partial state).
- The action is offered only while the list is empty. If a load stops part-way, the panel stays with the count that is
  in place; choosing the button again adds only the codes that are missing, and existing leave types are never touched.
  The stored name follows the owner's language at the time (English or written Hong Kong Chinese); the code does not.
- `.github/scripts/assert-app-check.py` accepts a native app-check report only when its single clause after
  `app is not installable — ` (split on `; `) is the app-storage contract refusal (the same fix as the Accounting
  app); `tests/unit/test_assert_app_check.py` runs in CI with the other Python tests.

## 0.3.0: leave balances as an append-only ledger

A leave balance is never stored or edited: it is the host's sum of `leave_entries.half_days` for an employee and leave
type. Approving a request deducts leave, an accrual run adds it, and a correction is a new entry.

- **Storage.** `app/storage/003-leave-ledger.json` creates `leave_entries` (`employee_id`, `leave_type`, `half_days`,
  `kind`, `effective_date`, `source_ref`, nullable `note`) with a unique index on `source_ref` and an index on
  `employee_id`. The descriptor declares it `append_only` and `read_role: owner`, with a `write_schema`: a create only;
  `half_days` an integer, never 0; `accrual` and `carry_forward` add, `taken` and `expiry` remove, an `adjustment` needs
  a note. `leave_types` gets a `write_schema` too, so `accrual_rule` is either null or the format below, whoever
  writes it. 001 and 002 are untouched (a test pins their hashes); 003 backfills nothing (the host refuses a backfill
  of an append-only table). The schema version is 3 and, like 0.2.0, `compatible_schema_versions` is `[3]`.
- **Operations.** The screen now declares `records.batch` and `records.aggregate` (seven operations). `records.batch`
  gets the 49,152-byte write budget in the bridge and the receiver; `records.aggregate` keeps 16,384. The screen sends
  a batch only when the board's pushed actions include it, and balances only when they include `records.aggregate`; on
  a board without them, approval (which uses `records.create` only) keeps working and Balances says what is missing.
- **Accrual rule.** `leave_types.accrual_rule` is `{"v":1,"days_per_year":[{"from_years":0,"days":7},{"from_years":3,"days":8}]}`:
  a yearly entitlement in whole or half days by completed years of service (the first tier starts at 0, years rise).
  The owner edits it on the leave type form as steps ("from 3 years of service: 8 days a year"), never as JSON. Rules
  are the customer's own data: no entitlement figure ships with the app (the example above is synthetic) and nothing
  here is legal advice. A rule the screen cannot read is kept as it is and accrues nothing.
- **Monthly accrual, no drift.** Completed years are counted at the month's last day. With `H` yearly half-days, month
  `m` (1 to 12) adds `floor(H*m/12) - floor(H*(m-1)/12)` half-days, so twelve months at one tier sum to exactly `H`
  (checked for every `H` from 0 to 740) and the rounding falls on whole half-days. A month that adds 0 writes no entry.
  A tier change takes effect in the month whose last day completes the years; each month is exact for its own tier.
  Who accrues: a real join date is required (none: skipped); a month before the join month is skipped; someone who joins
  or leaves mid-month accrues for that whole month; a real leave date before the month starts, or status `left` with
  no leave date, is skipped (`left`). Each skip is shown with its reason.
- **`source_ref` formats.** `taken-<request id>`, `accrual-<employee id>-<leave type>-<YYYY-MM>`,
  `adjustment-<form id>` (one random id per open form, so a retry after a lost reply meets its own entry). The
  column allows 200 characters, the longest accrual ref is 177. Record ids are random (`le-` plus 12 hex): the
  idempotence is the unique `source_ref`, not the record id.
- **Approve.** The owner's Approve re-reads the request (it must still be pending and at the revision shown), creates
  its `taken` entry (minus its half-days, dated its first day; a request across a month boundary is one entry in the
  month it starts), and only then sets the request approved. A conflict, a store refusal (the deployed host answers a
  unique key with 503) or a timeout on the entry counts as "already recorded" only after a re-read by `source_ref`
  finds the same entry; a different entry under that key, or none, stops.
- **Reject.** Rejecting re-reads the request the same way (still pending, at the revision shown). With no `taken`
  entry it writes nothing to the ledger. If an approval stopped after its entry (the status update failed), rejecting
  first writes a compensating `adjustment`: the stored entry's half-days back, same employee, leave type and date,
  `source_ref` `reversal-taken-<request id>` and a note naming the request, retry-safe by the same re-read and
  same-entry check. Only then is the request set rejected. If that status update fails too, rejecting again finishes
  with one reversal; approving is refused while a reversal exists, since it would leave an approved request with
  nothing deducted.
- **Editing a request.** The screen refuses to edit a pending request while its `taken` entry exists ("finish the
  approval first", or with a reversal, "finish the rejection first"): the entry was made from the request as it was,
  and an edit would leave the two out of step.
- **Run accrual** (Leave → Balances, owner). Pick a month (`YYYY-MM`, not after the current month), review (nothing is
  written), then post. It reads employees and leave types, plans the month's refs, and looks those exact refs up in
  the ledger (`source_ref` `in`, 50 at a time; a read that fails or does not finish stops, it is never read as
  "none"). It posts only the missing entries with `records.batch`. Chunks hold at most 200 items and 16,384 bytes of arguments:
  the receiver allows 49,152, but a board without the CAD-2263 limit closes the frame above 16,384, and the limit
  is not in a released board yet. A chunk is all or nothing. A chunk refused for a duplicate key is re-read: an entry
  already there counts as recorded only when it is the same entry (a different one under the ref stops the run), and
  the missing entries are posted once; a stopped run reports how many are in and running it again continues. Running it twice
  yields one entry each.
- **Record earlier approvals** (Leave → Balances, owner). Finds every approved request without a `taken` entry,
  whenever and however it was approved (before 0.3.0, or from a chat-staged approval, which skips the screen) and posts
  the missing entries once. Requests that already have one are left alone.
- **Adjust balance** (owner). A new `adjustment` entry with a required note, whole or half days with a sign. No entry is
  ever updated; a mistake is corrected by another adjustment.
- **Balances.** The Balances list, the employee detail and the balance beside a new request all come from one
  `records.aggregate` grouped by `employee_id` and `leave_type`, with the moment of the read. A truncated answer is
  said to be cut short and a person missing from it is not shown as zero; a failed read shows no figure. A request that
  would take the balance below zero shows a warning and is still saved. The balance includes entries dated in the future
  (approved leave not yet taken). `leave-desk` states a balance only from the same aggregate, with its as-of moment.
- **Known limits.** If a request is rejected or changed from another session between the screen's re-read and its status
  update, a `taken` entry can exist for a request that did not end approved; correct it with an adjustment. The edit
  refusal is the screen's: the host's write rule lets a staged chat edit change a pending request that has a `taken`
  entry (approve then meets a different entry and stops; reject reverses the stored entry). A chat-staged approval is
  not refused by the host either (the `leave_requests` rule allows pending to approved): it writes no `taken` entry, so
  the balance is unchanged until the owner runs "Record earlier approvals"; `leave-desk` tells the agent never to
  stage a status change and to send the owner to the screen instead. A request approved from the chat after a
  rejection reversed its entry stays at a net zero ("Record earlier approvals" sees its `taken` entry and leaves it
  alone); correct it with an adjustment. Employee
  ids are the record ids; an employee deleted later keeps their entries. Balances list names from one read of up to
  5,000 employees.
- **Checker pin.** CI checks the bundle with Cadence v0.3.23-beta.1 (the first checker that knows the two operations;
  the released v0.3.22 refuses them). Publishing still needs a released checker through `cadence_version`.

## Local development

Use the Node version in `screen-ui.lock.json` and the pnpm version in
`package.json`. The shared screen UI archive is committed; `@cadence/app-kit`
0.3.0 is vendored at `app-kit/` from `favcrm/cadence`, and `app-kit.lock.json`
pins the source commit and every file. No Cadence checkout is needed.

```sh
pnpm install --frozen-lockfile
cadence app dev --package . --port 3187 --host localhost
```

The preview at `/dev/preview/` runs the real screen against synthetic
fixtures held in the browser tab. Choose a scenario (`loaded`, `empty`,
`loading`, `refused`, `lost`, `stale`, `unreachable`) and a language (`en`,
`zh-TW`) from the header. It is not a signed-in host session. The `hr` preview
port is 3187, inside the 3110-3199 range.

```sh
pnpm typecheck
pnpm build
pnpm verify
pnpm test
# the checker must be v0.3.23-beta.1 or later (CADENCE_BIN for scripts/pre-push)
cadence app check app        # exit 3 is expected: hosted-only app-storage
python3 scripts/package_app.py check --source app
```

`scripts/pre-push` runs the same sequence and accepts exit 3 only for the
hosted-only storage refusal.

## Layout

- `app/` is the installable package: `app.md`, `app-storage.json` with
  `storage/001-initial.json`, `storage/002-hr-records.json` and `storage/003-leave-ledger.json` pinned by sha256,
  `app-chat.json`, `skills/<tag>/` (five skill packages) and the generated screen
  under `screens/hr/`.
- `src/bridge/` is the one adapter over the pinned app-kit bridge (`createScreenBridge`): the scope, the
  operations and their budgets, and the leave hint.
- `src/domain/` is pure logic: `people.ts` (employees), `records.ts` (the four new tabs: field
  specs, form to profile, exact lookups, decisions, refusal classes) and `leave.ts` (the accrual rule, monthly accrual,
  ledger entries, batch chunking).
- `src/features/hr/` holds the screen: People, and one generic record pane (`RecordsPane.tsx`) driven by
  `views.tsx` for the other tabs; `ledger.ts` holds the ledger's host calls and `BalancesPane.tsx` the Balances list.
- `tests/unit/`, `tests/contract/` and `tests/eval/` hold the tests; `tests/eval/` is the evaluation set.
- `scripts/host-schema-check.mjs` and `scripts/host-skills-check.mjs` run the package through the host's own
  schema and skill-reader code (see Verification).
- `dev/preview/` is local tooling and is not part of the screen build.

## Release

The manifest version and the `vX.Y.Z` tag identify an immutable release. A
merged commit is not a published or installed app. Publishing runs from
`.github/workflows/publish.yml` on a tag and needs the catalogue publisher
registration; see the Cadence app catalogue guide.

## Storage decisions that cannot change after release

The host has no alter-column operation, so 0.1.0 fixes these:

- `employee_no` is stored in capitals (`^[A-Z0-9_-]{1,32}$`). The screen upper-cases what is typed
  before it looks for a duplicate and before it writes, which makes the unique index ignore case.
- `employment_type` and `status` are plain text (`^[a-z0-9_]{1,32}$`) with their defaults, not host enums, so a
  later release can add a value. The screen owns the offered list and shows an unknown stored value as it is.
- `join_date` may be empty. A record without one is stored and shown.
- Dates are text with the pattern `^[0-9-]{10}$`, the strictest the host grammar allows. A write through the
  agent path is not calendar-validated in this release; the screen shows such a value as stored, and its own
  form accepts real calendar dates only.

Language: English and written Hong Kong Chinese. The screen asks for the host's generic `screen-locale.v1`
contract, and the host sends `zh-TW` for Chinese; the catalogue behind it is written in Hong Kong usage.

Unsaved edits: while any form holds an edit that is not saved, the screen tells the board
(`{ v: 2, op: "leave", unsaved: true }`), and the board asks before it navigates away. The hint carries no authority.

## 0.2.0 storage decisions that cannot change after release

Migration `002-hr-records.json` adds six tables. The host has no alter-column operation, so these are fixed:

- Every status, stage and category is plain text (`^[a-z0-9_]{1,32}$`), not a host enum. The screen owns the offered
  list and shows an unknown stored value as it is. A claim category list has no `medical` entry on purpose.
- `leave_types.code` and `leave_requests.leave_type` are capitals (`^[A-Z0-9_-]{1,32}$`); `leave_types.code` has a
  unique index. A request stores the leave type's code, not its record id.
- `leave_requests` and `claims` store `employee_id` (the employee record id) and `employee_name` (a snapshot of the
  name when the record was made). There is no `member_id` and no `decided_by`: the host journal records who approved,
  and the screen has no identity of its own. Either can be added later with `add_column`.
- Dates are text `^[0-9-]{10}$`. `decided_on` and `decision_note` are nullable. `receipt_ref`, `email` and `phone` are nullable.
- Money is an integer in minor units, 1 to 99,999,999,999, with a three-capital `currency`. Leave is an integer number
  of half days, 1 to 1000.
- `policies.body` holds up to 12,000 characters (`record_bytes` 131072); `candidates.cv_text` up to 12,000 characters
  (`record_bytes` 65536); `job_openings.description` up to 8,000 (`record_bytes` 32768).
- `candidates.screening` is JSON with a required `summary` and at least one `reasons` entry, so a screening result
  always carries reasons. `leave_types.accrual_rule` is JSON with no declared column shape; release 0.3.0 defines its format in the descriptor's write schema (see below).
- A policy change is a new row plus a `retired` mark on the old one: a record's journal keeps 64 revisions.

Write rules (`tables.leave_requests.write_schema`, `tables.claims.write_schema`) are not migrations: they change with
the descriptor version, so they are not permanent decisions. In 0.2.0:

- A create can only be open (`pending` / `submitted`) and must leave `decided_on` and `decision_note` null.
- An update is refused unless the stored record is still open. The rule sees the stored row (`before`) and the merged
  row (`after`) but cannot compare a field across them, so "an approved claim's amount cannot change" is enforced by
  freezing the whole decided claim.
- A claim's status can only be `submitted`, `approved` or `rejected`. Nothing in 0.2.0 (rule, screen or skill) can
  mark a claim paid; `paid` returns with payroll in 0.4.0, which must change the rule first.

The host reports a refused write as status 400, which the board shows as `failed`: the screen says the record
"may already be decided" and offers a reload instead of claiming a cause.

Request size: the board closes a records frame whose `records.create` or `records.update` arguments pass 49,152 bytes
of JSON, or whose other requests pass 16,384. The app-kit bridge holds each record write to 49,152 bytes and every
other operation to 16,384, measured the same way, so nothing the board would close on is sent. A 12,000-character
policy or CV in written Chinese (about 36 KB) fits. A larger write, such as pasted text full of control characters, is
refused in the screen before it is sent: "This text is too long to save from this screen." The board also refuses with
the code `too_large` when a reply is too big to show, after a write ran; the screen words that as "this record may
already be saved", never as too long.

Unique leave type codes: the screen looks for the code exactly before it creates a leave type, and a code cannot be
changed once saved. Two creates of the same code at the same moment can still both pass that check; the unique index
then refuses the second. The deployed host answers that refusal with 503, which the screen words as "the store could
not save this change; if a code may already exist, search for it first". The hosted board's next release answers 409
`unique_violation` instead (merged on its staging line, not yet deployed). The board shows that 409 to the frame as a
generic conflict until a Cadence change ships, so the screen keeps its hedged create wording ("this record may already
be saved") and never calls it a duplicate without a read that proves it.

Owner-only reads: every table, including `employees` (declared through the `tables` map), carries
`read_role: "owner"`. Before this release a non-owner member could read every record of an installed app.

A non-owner member who opens this app sees the board close it. Their first read is refused with 403, and the board
retires the mount and closes the frame on the first 401 or 403, whatever the app does. A 403 can also mean the
screen's access was withdrawn or an operation is not declared, so the screen never claims one cause: it says "This
app's access is no longer available here, or these records are for the workspace owner. Reload the page." and, like
0.1.0, retires its own session on a 403, on a write as on a read.

## Verification

```sh
# the host's real descriptor, migration, model and write-schema code
bun scripts/host-schema-check.mjs --storage <host app-storage contract module> --validation <host JSON-schema validation module>
# the host's real app skill reader (the module exporting skillPackage and describeSkills)
bun scripts/host-skills-check.mjs --module <host app skill reader module>
```

Pass paths into a checkout or an extract of the host's source; `zod` and `@cfworker/json-schema` must resolve from
there. The scripts are run by hand, not in CI. `tests/unit/storage.test.mjs`, `write_schema.test.mjs` and
`skills.test.mjs` hold local mirrors of the same rules that CI does run.

## Files, receipts and CVs

A hosted board does not offer `documents_intake`. A file the owner attaches in chat is stored with the conversation;
the agent reads PDF, Word, Excel and text files through `chat_attachment_read` (extracted text) and sees a PNG, JPEG
or WebP only when the board's model accepts images. There is no OCR. `claim-intake` and `recruit-screening` say this
and ask for typed details when the text or the picture is not readable.

## Evaluation set

`tests/eval/` holds 10 policy questions (with expected citations and four decline cases), 5 leave requests, 5
receipts and 5 CVs (with protected-attribute and prompt-injection bait), all synthetic, plus deterministic graders
and golden outputs. The graders judge recorded outputs. No model has been run on the set: every graded output is
hand-written. `eval.test.mjs` checks that the golden outputs and other correct answers pass and that wrong ones fail.

- An answer case lists the figures the answer must state (`figures`). Any other figure it states must appear in the
  cited policy's body (the skill says to quote or closely paraphrase the clause) or be its effective date, so "20
  days (the policy says 15)" fails and "capped at 200 per day, within 30 days" passes.
- Figures are compared as values. English and Chinese number words, including 廿 and the formal 拾/伍 forms, and
  am/pm times are read as digits first: "fifteen", "15", "十五" and "拾伍" agree, and "4pm" is "16:00". A run of
  Chinese numerals counts before a unit (日, 天, 週, 個月, 元, 小時) or when no other Chinese character follows it,
  so 一般 and 每一年 are not figures. "no one" is not a figure. Only the exact citation
  `Source: <title> (effective <date>)` is left out, so a figure after it on the same line still counts.
- A decline case lists the policy substance it must not state (`forbid`), for example "in full", "twelve weeks",
  "Fridays" or "smart casual", and still needs a decline marker. A term the question itself uses may be repeated in
  the clause that says no current policy covers it: "No current policy covers working from home on Fridays" passes,
  and "the draft lets staff work from home on Fridays" fails.

What the graders cannot catch: they match keywords, so a leak in other words passes them. "100%" for "in full",
"84 days" or "three months" for "twelve weeks" and "suit and tie" for a dress code are not seen; a test pins these as
known limits. A clause-final word such as 唯一 or 統一 reads as the figure 1. The yes/no judged checks in `cases.json`
are where a reviewer catches a paraphrased leak; they are not run here.
