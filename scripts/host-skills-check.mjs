// Run every skill package of the app through the host's real reader rules.
//
//   bun scripts/host-skills-check.mjs --module <app-skills.ts>
//
// `app-skills.ts` is agenticos-v2 `apps/api/src/tenant-board/app-skills.ts` (AOS-561). Its
// `skillPackage` and `describeSkills` are the code the hosted agent's `app_skill` and
// `app_describe` run. Outside the host repository its imports must be resolvable: the bundle
// grammar (`packages/contracts/src/bundle-grammar/`) and `zod`, with the three helper imports
// (`marketplace-artifact`, `app-call-summary`, `screen-integrity`) replaced by local stand-ins that
// the package rules do not use, apart from `plainLine`, which only trims the description.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const at = process.argv.indexOf("--module");
if (at < 0 || !process.argv[at + 1]) { console.error("usage: --module <app-skills.ts>"); process.exit(2); }
const mod = await import(pathToFileURL(resolve(process.argv[at + 1])).href);
const root = resolve(import.meta.dirname, "..", "app");
const files = Object.create(null);
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = `${dir}/${name}`; if (statSync(p).isDirectory()) walk(p); else files[relative(root, p).split("\\").join("/")] = readFileSync(p, "utf8"); } };
walk(root);

const described = mod.describeSkills(files);
let bad = described.problems.length;
for (const p of described.problems) console.log(`REFUSED ${p.name}: ${p.reason}`);
for (const s of described.skills) {
  const r = mod.skillPackage(files, s.name);
  if (!r.ok) { bad += 1; console.log(`REFUSED ${s.name}: ${r.message}`); continue; }
  console.log(`ok ${s.name}: ${r.package.files.length} files returned, ${r.package.notReturned.length} not returned; description: ${s.description.slice(0, 60)}...`);
}
console.log(`${described.skills.length} skills described, ${bad} problems`);
process.exit(bad === 0 && described.skills.length > 0 ? 0 : 1);
