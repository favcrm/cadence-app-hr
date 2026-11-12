# Cadence HR app

Public repository: https://github.com/favcrm/cadence-app-hr.
App identity is `hr`. Release 0.2.0 holds seven tables behind five tabs. People is
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

## Local development

Use the Node version in `screen-ui.lock.json` and the pnpm version in
`package.json`. The shared screen UI archive is committed; the released app-kit
receiver is vendored at `app-kit/` and pinned by `app-kit.lock.json` (toolchain
release v0.3.22). No Cadence checkout is needed.

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
cadence app check app        # exit 3 is expected: hosted-only app-storage
python3 scripts/package_app.py check --source app
```

`scripts/pre-push` runs the same sequence and accepts exit 3 only for the
hosted-only storage refusal.

## Layout

- `app/` is the installable package: `app.md`, `app-storage.json` with
  `storage/001-initial.json` and `storage/002-hr-records.json` pinned by sha256,
  `app-chat.json`, `skills/<tag>/` (five skill packages) and the generated screen
  under `screens/hr/`.
- `src/bridge/` is the one adapter over the pinned app-kit receiver.
- `src/domain/` is pure logic: `people.ts` (employees) and `records.ts` (the four new tabs: field
  specs, form to profile, exact lookups, decisions, refusal classes).
- `src/features/hr/` holds the screen: People, and one generic record pane (`RecordsPane.tsx`) driven by
  `views.tsx` for the other tabs.
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

Language: English and written Hong Kong Chinese. The host sends `zh-TW` for
Chinese; the catalogue behind it is written in Hong Kong usage.

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
  always carries reasons. `leave_types.accrual_rule` is JSON with no declared shape (release 0.3.0 defines it).
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
of JSON, or whose other requests pass 16,384. The screen's receiver is created with the 49,152 limit and the bridge
holds every other operation to 16,384. A 12,000-character policy or CV in written Chinese (about 36 KB) fits. A larger
write, such as pasted text full of control characters, is refused in the screen before it is sent: "This text is too
long to save from this screen."

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
0.1.0, retires its own session on a 403.

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
and golden outputs. The graders judge recorded outputs; no model was run for this release. `eval.test.mjs` checks
that the hand-written golden outputs pass and that mutations of them fail.

- An answer case lists every figure the answer may state (`figures`). The answer must state each one and no other
  figure, so "20 days (the policy says 15)" fails.
- A decline case lists the policy substance it must not state (`forbid`), for example "in full", "twelve weeks",
  "Fridays" or "smart casual", and still needs a decline marker. The terms are deliberately strict: a decline that
  repeats the question's own words (for example "on Fridays") fails and needs a reviewer's eye.

The yes/no judged checks in `cases.json` are for a reviewer.
