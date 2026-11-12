// Run the app's storage declaration through the host's real schema code.
//
//   bun scripts/host-schema-check.mjs --contracts <dir holding the host's app-storage.ts and app-storage-validation.ts>
//
// The host code is read from a checkout or a `git show` extract of agenticos-v2
// `packages/contracts/src/`; it needs `zod` and `@cfworker/json-schema` resolvable from that
// directory. Nothing is stubbed: the descriptor, every migration, the model and each write-schema
// case in tests/fixtures/write-schema-cases.json go through appStorageDescriptorSchema,
// appStorageMigrationSchema, validateAppStorageModel and checkAppStorageJsonSchema.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const at = process.argv.indexOf("--contracts");
if (at < 0 || !process.argv[at + 1]) { console.error("usage: --contracts <dir>"); process.exit(2); }
const dir = resolve(process.argv[at + 1]);
const root = resolve(import.meta.dirname, "..");
const host = await import(pathToFileURL(`${dir}/app-storage.ts`).href);
const validation = await import(pathToFileURL(`${dir}/app-storage-validation.ts`).href);
const json = (p) => JSON.parse(readFileSync(`${root}/${p}`, "utf8"));

const descriptor = host.appStorageDescriptorSchema.parse(json("app/app-storage.json"));
const migrations = descriptor.migrations.map((m) => host.appStorageMigrationSchema.parse(json(`app/${m.path}`)));
host.validateAppStorageModel(descriptor, migrations);
console.log(`descriptor ok: schema_version ${descriptor.schema_version}, ${migrations.length} migrations, tables ${Object.keys(descriptor.tables ?? {}).join(", ")}`);

let failed = 0;
for (const c of json("tests/fixtures/write-schema-cases.json")) {
  const schema = descriptor.tables?.[c.table]?.write_schema;
  const got = validation.checkAppStorageJsonSchema(schema, { operation: c.operation, before: c.before, after: c.after, provenance: null });
  if (got !== c.ok) { failed += 1; console.log(`FAIL ${c.name}: host says ${got}, expected ${c.ok}`); }
}
console.log(`write-schema cases: ${failed === 0 ? "all agree with the host validator" : failed + " disagree"}`);
process.exit(failed === 0 ? 0 : 1);
