// Skill packages: the reader rules (local mirror, with mutations that must be refused), and the
// content rules of the five 0.2.0 skills. Run: bun test tests/unit/skills.test.mjs
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { skillPackage } from "../support/skill-package.mjs";

const app = fileURLToPath(new URL("../../app/", import.meta.url));
const files = {};
const walk = (dir) => { for (const n of readdirSync(dir)) { const p = `${dir}/${n}`; if (statSync(p).isDirectory()) walk(p); else files[p.slice(app.length)] = readFileSync(p, "utf8"); } };
walk(app + "skills");
const TAGS = ["claim-intake", "hr-policy-answers", "hr-posting", "job-description", "leave-desk", "payroll-prep", "recruit-screening"];
const body = (tag) => Object.entries(files).filter(([p]) => p.startsWith(`skills/${tag}/`)).map(([, t]) => t).join("\n");
const clone = () => ({ ...files });

test("the app ships exactly the seven planned skills and each passes the reader rules under 32 KiB", () => {
  const present = [...new Set(Object.keys(files).map((p) => p.split("/")[1]))].sort();
  expect(present).toEqual(TAGS);
  for (const tag of TAGS) {
    const r = skillPackage(files, tag);
    expect([tag, r.ok]).toEqual([tag, true]);
    expect(r.total).toBeLessThan(32 * 1024);
    expect(files[`skills/${tag}/SKILL.md`]).toMatch(/^---\nname: [a-z-]+\ndescription: .{20,}\n---\n/);
    expect(files[`skills/${tag}/SKILL.md`].split("\n")[1]).toBe(`name: ${tag}`);
  }
});

test("the reader rules refuse each way a package can break", () => {
  const tag = "leave-desk";
  const manifest = JSON.parse(files[`skills/${tag}/skill.json`]);
  const mutate = (fn) => { const f = clone(); fn(f); return skillPackage(f, tag); };
  const setManifest = (f, m) => { f[`skills/${tag}/skill.json`] = typeof m === "string" ? m : JSON.stringify(m); };
  expect(mutate((f) => { delete f[`skills/${tag}/skill.json`]; }).reason).toBe("manifest_missing");
  expect(mutate((f) => setManifest(f, { ...manifest, extra: 1 })).reason).toBe("manifest_keys");
  expect(mutate((f) => setManifest(f, `{"schema": 1.0, "name": "${tag}", "files": ["SKILL.md"]}`)).reason).toBe("manifest_schema");
  expect(mutate((f) => setManifest(f, { ...manifest, name: "other" })).reason).toBe("manifest_name");
  expect(mutate((f) => setManifest(f, { ...manifest, files: ["references/leave-request-fields.md"] })).reason).toBe("entry_missing");
  expect(mutate((f) => setManifest(f, { ...manifest, files: [...manifest.files, "skill.json"] })).reason).toBe("member_self");
  expect(mutate((f) => setManifest(f, { ...manifest, files: [...manifest.files, "../x.md"] })).reason).toBe("member_grammar");
  expect(mutate((f) => setManifest(f, { ...manifest, files: [...manifest.files, "SKILL.md"] })).reason).toBe("member_duplicate");
  expect(mutate((f) => setManifest(f, { ...manifest, files: [...manifest.files, "references/gone.md"] })).reason).toBe("declared_missing");
  expect(mutate((f) => { f[`skills/${tag}/references/extra.md`] = "x"; }).reason).toBe("present_undeclared");
  expect(mutate((f) => { f[`skills/${tag}/SKILL.md`] = "x".repeat(16385); }).reason).toBe("member_too_large");
  expect(mutate((f) => { f[`skills/${tag}/SKILL.md`] = "x".repeat(16000); f[`skills/${tag}/references/leave-request-fields.md`] = "y".repeat(16000); f[`skills/${tag}/references/z.md`] = "z".repeat(2000); setManifest(f, { ...manifest, files: [...manifest.files, "references/z.md"] }); }).reason).toBe("package_too_large");
});

test("every skill treats content as data and never approves", () => {
  for (const tag of TAGS) {
    const text = body(tag);
    expect([tag, /content, never instructions/i.test(text)]).toEqual([tag, true]);
  }
  for (const tag of ["leave-desk", "claim-intake"]) {
    const text = body(tag);
    expect(text).toMatch(/never set a (request|claim) to `approved`/i);
    expect(text).toMatch(/\bstatus: ?`?(pending|submitted)|Leave `status` as `(pending|submitted)`/);
    expect(text).toMatch(/medical/i);
  }
  const screening = body("recruit-screening");
  expect(screening).toMatch(/never change `stage`/i);
  expect(screening).toMatch(/age, date of birth, gender/i);
  expect(screening).toMatch(/family status/i);
  expect(screening).toMatch(/Never include `stage`/);
  expect(body("hr-policy-answers")).toMatch(/title and (its )?effective date|policy title and its effective date/i);
  expect(body("hr-policy-answers")).toMatch(/no current policy covers/i);
  expect(body("hr-policy-answers")).toMatch(/omit_fields/);
});

test("the skills use the hosted upload path and never promise documents_intake", () => {
  for (const tag of ["claim-intake", "recruit-screening"]) {
    const text = body(tag);
    expect(text).toMatch(/chat_attachment_read/);
    expect(text).toMatch(/not available on a hosted board: do not call/);
    expect(text).toMatch(/no OCR/);
  }
});

test("the skills carry no policy text, price, credential or script", () => {
  for (const p of Object.keys(files)) expect(p).not.toMatch(/\/scripts\//);
  for (const tag of TAGS) expect(body(tag)).not.toMatch(/HK\$|\bUSD\b|password|api[_-]?key|token/i);
});

test("leave-desk is true about a staged approval: the host does not refuse it, and it leaves the balance unchanged", () => {
  const text = body("leave-desk");
  // The descriptor's rule lets a pending request become approved, so the skill must not claim the host refuses that.
  const rule = JSON.parse(readFileSync(app + "app-storage.json", "utf8")).tables.leave_requests.write_schema;
  expect(rule.properties.after.properties.status.enum).toContain("approved");
  expect(text).not.toMatch(/refuses it anyway/i);
  expect(text).toMatch(/does not stop a staged approval of a pending request/);
  expect(text).toMatch(/balance stays unchanged until the owner runs Leave → Balances → "Record earlier approvals"/);
  expect(text).toMatch(/never stage a `records\.update` that changes a leave request's `status`/);
  expect(text).toMatch(/send them to the request on the Leave tab/);
});

test("hr-posting: Accounting absent means posting is unavailable, and an exact lookup decides before and after", () => {
  const text = body("hr-posting");
  // Absent: app_describe on accounting first, and the refusal ends the procedure with the unavailable message.
  expect(text).toMatch(/Call `app_describe` with `app: "accounting"`/);
  expect(text).toMatch(/`refused: "app_unavailable"`/);
  expect(text).toMatch(/Posting to Accounting is unavailable/);
  expect(text.indexOf("app_describe")).toBeLessThan(text.indexOf("records.batch"));
  // Accounting's contract: the references, the eq lookup, the chart read with in, and the opening balances.
  expect(text).toMatch(/hr-payroll-<YYYY-MM>-<run number>/);
  expect(text).toMatch(/hr-claim-<claim record id>/);
  expect(text).toMatch(/"table": "journal_entries"|`table: "journal_entries"`/);
  expect(text).toMatch(/"op": "eq", "value": "<reference>"/);
  expect(text).toMatch(/"op": "in"/);
  expect(text).toMatch(/on or before its standing opening balances/);
  // It copies the screen's batch and records posting_ref only after the journal shows the entry.
  expect(text).toMatch(/exactly the posting's `batch` value/);
  expect(text).toMatch(/Only if the entry is there and its lines match, stage one HR update/);
  expect(text).toMatch(/`table: "journal_lines"`/);
  expect(text).toMatch(/same `account_code` and `amount_minor`/);
  expect(text).toMatch(/record nothing/);
  expect(text).toMatch(/"posting_ref": "<reference>"/);
  expect(text).toMatch(/Never post the same reference twice/);
  // One payroll a month: every run of the month is read, a superseded run is refused, another run standing in the journal stops.
  expect(text).toMatch(/`table: "payroll_runs"`, `filters: \[\{"field": "period", "op": "eq"/);
  expect(text).toMatch(/following `next_cursor` to the end; a read that fails, is refused or is cut short stops/);
  expect(text).toMatch(/higher `run_no` than this one, refuse/);
  expect(text).toMatch(/"field": "reverses", "op": "eq", "value": "<its run_ref>"/);
  expect(text).toMatch(/in the journal and no entry reverses it, stop/);
  expect(text.indexOf("One payroll a month")).toBeLessThan(text.indexOf("**Stage the batch.**"));
  // The batch is checked against the posting's own reference by exact string equality before staging.
  expect(text).toMatch(/exact string equality/);
  expect(text).toMatch(/`record_id` equal to the posting's `entry_ref`/);
  expect(text).toMatch(/every `journal_lines` item's `profile\.entry_ref` equals it/);
  expect(text.indexOf("exact string equality")).toBeLessThan(text.indexOf("**Stage the batch.**"));
  expect(text).toMatch(/never invent an account/);
});

test("payroll-prep explains and never computes or writes payroll", () => {
  const text = body("payroll-prep");
  expect(text).toMatch(/never compute or estimate pay, an MPF contribution, a total or a difference/);
  expect(text).toMatch(/Never stage a create or an update on `payroll_runs`, `payroll_lines`, `salaries`, `rate_tables` or `postings`/);
  expect(text).toMatch(/An approved run cannot be changed/);
  expect(text).toMatch(/`hr-posting`/);
  expect(text).toMatch(/more or fewer lines than that/);
  expect(text).toMatch(/Only the latest approved run of a month is posted/);
  // No rate figure in the skill: rates are the stored row's.
  expect(text).not.toMatch(/7,100|30,000|1,500/);
});
