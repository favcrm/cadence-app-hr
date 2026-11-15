# Cadence HR App development

Read README.md first. The app id is `hr`; repository names do not change
installation or data identities.

This repository is public: no credentials, tokens, real people, customer data,
real prices or internal hostnames. Fixtures use invented people and the
reserved `example.invalid` domain.

Cadence keeps scope, storage execution, approvals and every write. The screen
uses only the pinned `@cadence/app-kit` receiver and `@cadence/screen-ui`;
never add a private `postMessage` receiver, a copy of the host frame or host
CSS. The host contract is its app storage descriptor and limits, the
`records.*` verbs and the screen services.

Release scope is in the ticket. Every table is owner-only. From 0.4.0 the app stores salaries
and payroll; never add identity document (HKID), bank account number or medical columns. The agent
never computes pay, MPF or posting amounts: tested code in the screen does. Dates are `text` holding
`YYYY-MM-DD`; money, when it arrives, is an integer in minor units with a
currency column.

Work on a branch, open a draft PR, keep tests under `tests/`. Never tag or
publish from an agent session without the owner's say.
