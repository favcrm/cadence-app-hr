// Run the app's storage declaration through the host's real schema code.
//
//   bun scripts/host-schema-check.mjs --storage <file> --validation <file>
//
// --storage is the host's app-storage contract module (it exports appStorageDescriptorSchema,
// appStorageMigrationSchema and validateAppStorageModel); --validation is the module that exports
// checkAppStorageJsonSchema. Pass paths into a checkout or an extract of the host's source; the
// modules need `zod` and `@cfworker/json-schema` resolvable from where they sit. Nothing is stubbed:
// the descriptor, every migration, the model and each write-schema case in
// tests/fixtures/write-schema-cases.json go through the host's own functions.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name) => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1] ?? null; };
const storagePath = arg("--storage"), validationPath = arg("--validation");
if (!storagePath || !validationPath) { console.error("usage: --storage <file> --validation <file>"); process.exit(2); }
const root = resolve(import.meta.dirname, "..");
const host = await import(pathToFileURL(resolve(storagePath)).href);
const validation = await import(pathToFileURL(resolve(validationPath)).href);
const json = (p) => JSON.parse(readFileSync(`${root}/${p}`, "utf8"));

const descriptor = host.appStorageDescriptorSchema.parse(json("app/app-storage.json"));
const migrations = descriptor.migrations.map((m) => host.appStorageMigrationSchema.parse(json(`app/${m.path}`)));
host.validateAppStorageModel(descriptor, migrations);
console.log(`descriptor ok: schema_version ${descriptor.schema_version}, ${migrations.length} migrations, tables ${Object.keys(descriptor.tables ?? {}).join(", ")}`);

let failed = 0;
const cases = json("tests/fixtures/write-schema-cases.json");
for (const c of cases) {
  const schema = descriptor.tables?.[c.table]?.write_schema;
  const got = validation.checkAppStorageJsonSchema(schema, { operation: c.operation, before: c.before, after: c.after, provenance: null });
  if (got !== c.ok) { failed += 1; console.log(`FAIL ${c.name}: host says ${got}, expected ${c.ok}`); }
}
console.log(`write-schema cases: ${failed === 0 ? `all ${cases.length} agree with the host validator` : failed + " disagree"}`);
process.exit(failed === 0 ? 0 : 1);
