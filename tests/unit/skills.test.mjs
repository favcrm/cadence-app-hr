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
const TAGS = ["claim-intake", "hr-policy-answers", "job-description", "leave-desk", "recruit-screening"];
const body = (tag) => Object.entries(files).filter(([p]) => p.startsWith(`skills/${tag}/`)).map(([, t]) => t).join("\n");
const clone = () => ({ ...files });

test("the app ships exactly the five planned skills and each passes the reader rules under 32 KiB", () => {
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
