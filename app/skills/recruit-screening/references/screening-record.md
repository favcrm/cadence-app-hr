# The screening field

`screening` is a JSON object inside `profile`. The host requires `summary` (1 to 1,000 characters) and `reasons` (1 to 20 strings of up to 400 characters). Anything else is up to you; keep it to these.

```json
{
  "summary": "Evidences 3 of the 4 listed requirements; the team-lead requirement is not mentioned.",
  "reasons": [
    "Requirement: five years of bookkeeping. CV: 'six years as a bookkeeper' (evidenced).",
    "Requirement: payroll experience. Not mentioned in the CV (unknown, ask at interview).",
    "Neutral next step for the owner: a first conversation would clear the open point."
  ]
}
```

Every reason names the requirement it is about and what the CV does or does not show. No reason may rest on a protected attribute.
