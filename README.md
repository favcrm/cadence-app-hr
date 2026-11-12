# Cadence HR app

Public repository: https://github.com/favcrm/cadence-app-hr.
App identity is `hr`. Release 0.1.0 is a people directory: one `employees`
table and one People screen. The owner can list, search, add and edit
employees; the chat agent can read them and stage changes through the host's
generic `app_call`, and the owner approves them.

The app stores names, employee numbers and work contact details only. It holds
no pay, identity document, bank or medical information.

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
  `storage/001-initial.json` pinned by sha256, `app-chat.json` and the generated
  screen under `screens/hr/`.
- `src/bridge/` is the one adapter over the pinned app-kit receiver.
- `src/domain/` is pure logic (validation, duplicate check, refusal classes).
- `src/features/hr/` holds the People screen.
- `tests/unit/` and `tests/contract/` hold the tests.
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
- `employment_type` and `status` are plain text (`^[a-z_]{1,32}$`) with their defaults, not host enums, so a
  later release can add a value. The screen owns the offered list and shows an unknown stored value as it is.
- `join_date` may be empty. A record without one is stored and shown.
- Dates are text with the pattern `^[0-9-]{10}$`, the strictest the host grammar allows. A write through the
  agent path is not calendar-validated in this release; the screen shows such a value as stored, and its own
  form accepts real calendar dates only.

Language: English and written Hong Kong Chinese. The host sends `zh-TW` for
Chinese; the catalogue behind it is written in Hong Kong usage.
