# Cadence HR App development

Read README.md first. The app id is `hr`; repository names do not change
installation or data identities.

This repository is public: no credentials, tokens, real people, customer data,
real prices or internal hostnames. Fixtures use invented people and the
reserved `example.invalid` domain.

Cadence keeps scope, storage execution, approvals and every write. The screen
uses only the pinned `@cadence/app-kit` receiver and `@cadence/screen-ui`;
never add a private `postMessage` receiver, a copy of the host frame or host
CSS. The host contract is `app-storage.ts` (descriptor and
limits), `app-records.ts` (the `records.*` verbs) and `screen-services.ts`.

Release scope is in the ticket. 0.1.0 has one table. Do not add salary,
identity document, bank account or medical columns. Dates are `text` holding
`YYYY-MM-DD`; money, when it arrives, is an integer in minor units with a
currency column.

Work on a branch, open a draft PR, keep tests under `tests/`. Never tag or
publish from an agent session without the owner's say.
