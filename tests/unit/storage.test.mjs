// Storage declaration checks: migration pins, contiguity, and a local mirror of the
// host's app-storage/v1 rules. The mirror covers the rules this bundle can break; the
// host's real schema code is run separately by scripts/host-schema-check.mjs.
// Run: bun test tests/unit/storage.test.mjs

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { LIMITS } from "../../src/domain/people.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = (path) => readFileSync(root + path);
const json = (path) => JSON.parse(bytes(path).toString("utf8"));
const descriptor = json("app/app-storage.json");
const migrations = descriptor.migrations.map((m) => ({ ...m, body: json("app/" + m.path) }));

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const HOST_COLUMNS = ["id", "context_id", "revision", "created_at", "updated_at"];
const COLUMN_TYPES = ["text", "integer", "real", "boolean", "json"];
const FORMATS = ["email", "phone", "tag"];
const tableOps = migrations.flatMap((m) => m.body.operations.filter((o) => o.op === "create_table"));
const columns = tableOps.flatMap((o) => o.columns);
// The employees table is created by migration 1; its columns are looked up by name.
const employeeColumns = migrations[0].body.operations.find((o) => o.op === "create_table" && o.table === "employees").columns;
const byName = Object.fromEntries(employeeColumns.map((c) => [c.name, c]));
const REQUIRED_NO_DEFAULT = ["display_name", "employee_no", "employee_id", "employee_name", "leave_type", "start_date", "end_date", "half_days", "claim_date", "amount_minor", "currency", "title", "body", "effective_from", "code", "name", "paid", "opening_id", "kind", "effective_date", "source_ref"];

test("every migration file's sha256 equals its pin and migrations are contiguous from 1", () => {
  expect(descriptor.migrations.length).toBe(descriptor.schema_version);
  descriptor.migrations.forEach((pin, index) => {
    expect(pin.version).toBe(index + 1);
    expect(pin.sha256).toBe("sha256:" + createHash("sha256").update(bytes("app/" + pin.path)).digest("hex"));
    expect(pin.path).toMatch(/^storage\/[a-z0-9][a-z0-9-]{0,31}\.json$/);
    expect(json("app/" + pin.path).version).toBe(pin.version);
  });
  expect(new Set(descriptor.migrations.map((m) => m.path)).size).toBe(descriptor.migrations.length);
  expect(descriptor.compatible_schema_versions).toContain(descriptor.schema_version);
});

test("migration 001 is byte-identical to the 0.1.0 release", () => {
  // The host has no alter operation: a released migration never changes.
  expect(createHash("sha256").update(bytes("app/storage/001-initial.json")).digest("hex")).toBe("e90022e7a06babd0b69ffec315fa7637ae17d2cbf881c10d72a0b216b69da7f1");
});

test("migration 002 is byte-identical to the 0.2.x release, and 001 and 002 are never edited", () => {
  // 0.2.x storage is permanent: a released migration, and every column in it, is read-only from 0.3.0 on.
  expect(createHash("sha256").update(bytes("app/storage/002-hr-records.json")).digest("hex")).toBe("3e9227727792d7ae3bda0d7b523fbd0ca95eebac15f93053a711e5496451318b");
  expect(descriptor.migrations[0].sha256).toBe("sha256:e90022e7a06babd0b69ffec315fa7637ae17d2cbf881c10d72a0b216b69da7f1");
  expect(descriptor.migrations[1].sha256).toBe("sha256:3e9227727792d7ae3bda0d7b523fbd0ca95eebac15f93053a711e5496451318b");
  // 0.3.0 adds one migration and no operation on an older table.
  expect(descriptor.schema_version).toBe(3);
  expect(descriptor.compatible_schema_versions).toEqual([3]);
  expect(descriptor.migrations[2]).toMatchObject({ version: 3, path: "storage/003-leave-ledger.json" });
  for (const op of migrations[2].body.operations) expect(op.table).toBe("leave_entries");
});

test("003 creates the append-only ledger: its columns, a unique source_ref, owner-only reads, and no backfill anywhere", () => {
  const ops = migrations[2].body.operations;
  expect(ops.map((o) => o.op)).toEqual(["create_table", "create_index", "create_index"]);
  const table = ops[0];
  expect(table.table).toBe("leave_entries");
  expect(table.columns.map((c) => c.name)).toEqual(["employee_id", "leave_type", "half_days", "kind", "effective_date", "source_ref", "note"]);
  const col = Object.fromEntries(table.columns.map((c) => [c.name, c]));
  expect(col.half_days.type).toBe("integer");
  expect(col.half_days.json_schema.minimum).toBeLessThan(0);
  expect(col.half_days.json_schema.maximum).toBeGreaterThan(0);
  expect(col.note.nullable).toBe(true);
  for (const name of ["employee_id", "leave_type", "half_days", "kind", "effective_date", "source_ref"]) expect(col[name].nullable).toBe(false);
  expect(col.effective_date.json_schema.pattern).toBe("^[0-9-]{10}$");
  expect(col.leave_type.json_schema.pattern).toBe(byLeaveType().json_schema.pattern);
  // A refusal host-side needs the column rule to admit the longest source_ref the screen writes.
  expect(col.source_ref.max_length).toBeGreaterThanOrEqual(8 + 128 + 1 + 32 + 1 + 7);
  expect(col.source_ref.json_schema.pattern).toBe(`^[A-Za-z0-9_-]{1,${col.source_ref.max_length}}$`);
  expect(ops[1]).toEqual({ op: "create_index", table: "leave_entries", name: "leave_entries_source_ref", columns: ["source_ref"], unique: true });
  expect(descriptor.tables.leave_entries).toMatchObject({ append_only: true, read_role: "owner" });
  expect(descriptor.tables.leave_entries.write_schema).toBeDefined();
  // The host refuses a migration that backfills an append-only table, a locked one or a balanced column.
  const protectedTables = Object.entries(descriptor.tables).filter(([, o]) => o.append_only || o.lock || o.balanced).map(([name]) => name);
  for (const m of migrations) for (const op of m.body.operations) if (op.op === "backfill") expect(protectedTables).not.toContain(op.table);
  expect(migrations.flatMap((m) => m.body.operations).filter((op) => op.op === "backfill")).toEqual([]);
  // No pay, identity or medical column came with the ledger.
  for (const c of table.columns) expect(c.name).not.toMatch(/salary|pay|hkid|identity|passport|bank|account|medical|health|mpf/);
});
const byLeaveType = () => migrations[1].body.operations.find((o) => o.op === "create_table" && o.table === "leave_requests").columns.find((c) => c.name === "leave_type");

test("the descriptor satisfies the host's descriptor rules", () => {
  expect(Object.keys(descriptor).sort()).toEqual(["app", "compatible_schema_versions", "contract", "default_table", "migrations", "record_kind", "record_search_columns", "schema_version", "tables"]);
  expect(descriptor.contract).toBe("app-storage/v1");
  expect(descriptor.app).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  expect(descriptor.record_kind).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(descriptor.default_table).toMatch(IDENTIFIER);
  expect(new Set(descriptor.record_search_columns).size).toBe(descriptor.record_search_columns.length);
  const table = migrations[0].body.operations.find((o) => o.op === "create_table" && o.table === descriptor.default_table);
  expect(table).toBeDefined();
  for (const name of descriptor.record_search_columns) expect(["text", "json"]).toContain(table.columns.find((c) => c.name === name)?.type);
  expect(descriptor.record_kind).toBe("employee");
  expect(descriptor.default_table).toBe("employees");
});

test("the migration satisfies the host's column and operation rules", () => {
  let operations = 0;
  for (const m of migrations) {
    expect(Object.keys(m.body).sort()).toEqual(["operations", "version"]);
    expect(Buffer.byteLength(JSON.stringify(m.body))).toBeLessThan(64 * 1024);
    for (const op of m.body.operations) {
      operations += 1;
      expect(["create_table", "add_column", "create_index", "backfill"]).toContain(op.op);
      expect(op.table).toMatch(IDENTIFIER);
    }
  }
  expect(operations).toBeLessThan(128);
  for (const o of tableOps) {
    const names = o.columns.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(64);
  }
  const seen = new Set(columns.map((c) => c.name));
  for (const c of columns) {
    expect(c.name).toMatch(IDENTIFIER);
    expect(HOST_COLUMNS).not.toContain(c.name);
    expect(Object.keys(c).every((k) => ["name", "type", "nullable", "default", "max_length", "enum", "format", "json_schema"].includes(k))).toBe(true);
    expect(COLUMN_TYPES).toContain(c.type);
    expect(typeof c.nullable).toBe("boolean");
    if (c.max_length !== undefined) { expect(c.type).toBe("text"); expect(c.max_length).toBeGreaterThan(0); }
    if (c.format !== undefined) { expect(c.type).toBe("text"); expect(FORMATS).toContain(c.format); }
    if (c.enum !== undefined) { expect(c.type).not.toBe("json"); expect(c.enum.length).toBeGreaterThan(0); }
    if (c.enum !== undefined && "default" in c) expect(c.enum).toContain(c.default);
    if ("default" in c && c.type === "text" && c.default !== null) expect(typeof c.default).toBe("string");
    if (c.json_schema !== undefined) {
      // The host admits one scalar type name and one anchored ASCII character class with one linear quantifier.
      if (c.type === "text") {
        expect(Object.keys(c.json_schema).sort()).toEqual(["pattern", "type"]);
        expect(c.json_schema.type).toBe("string");
        expect(c.json_schema.pattern).toMatch(/^\^\[[A-Za-z0-9_-]+\](\{\d+(,\d+)?\})?\$$/);
      } else if (c.type === "integer") {
        expect(Object.keys(c.json_schema).sort()).toEqual(["maximum", "minimum", "type"]);
      }
    }
    // A non-null column the owner must always supply has no default; a nullable one reads as null when omitted.
    if (!c.nullable && !("default" in c)) expect(REQUIRED_NO_DEFAULT).toContain(c.name);
  }
  const indexes = migrations.flatMap((m) => m.body.operations.filter((o) => o.op === "create_index"));
  for (const index of indexes) {
    expect(index.name).toMatch(IDENTIFIER);
    expect(typeof index.unique).toBe("boolean");
    expect(new Set(index.columns).size).toBe(index.columns.length);
    for (const name of index.columns) expect(seen.has(name) || HOST_COLUMNS.includes(name)).toBe(true);
  }
});

test("the employees table has the planned columns, a unique employee number, and no sensitive column", () => {
  expect(employeeColumns.map((c) => c.name)).toEqual([
    "display_name", "employee_no", "email", "phone", "job_title", "department", "employment_type", "join_date", "leave_date", "manager_id", "status", "member_id",
  ]);
  const unique = migrations[0].body.operations.filter((o) => o.op === "create_index" && o.unique);
  expect(unique.map((o) => o.columns)).toEqual([["employee_no"]]);
  for (const c of columns) expect(c.name).not.toMatch(/salary|pay|hkid|identity|passport|bank|account|medical|health|mpf|(^|_)age(_|$)|gender|birth|marital|family/);
  // Dates are text holding YYYY-MM-DD; the contract has no date type.
  for (const name of ["join_date", "leave_date"]) {
    expect(byName[name].type).toBe("text");
    expect(byName[name].json_schema.pattern).toBe("^[0-9-]{10}$");
  }
  expect(byName.join_date.nullable).toBe(true);
  expect(byName.leave_date.nullable).toBe(true);
  expect(byName.manager_id.nullable).toBe(true);
  expect(byName.member_id.nullable).toBe(true);
});

test("the screen's enums and bounds are the stored ones", () => {
  // The closed lists live in the screen: a host enum can never gain a value after release.
  for (const name of ["employment_type", "status"]) {
    expect(byName[name].enum).toBeUndefined();
    expect(byName[name].json_schema.pattern).toBe("^[a-z0-9_]{1,32}$");
  }
  expect(byName.employee_no.json_schema.pattern).toBe("^[A-Z0-9_-]{1,32}$");
  expect(byName.employment_type.default).toBe("full_time");
  expect(byName.status.default).toBe("active");
  expect(byName.display_name.max_length).toBe(LIMITS.displayName);
  expect(byName.employee_no.max_length).toBe(LIMITS.employeeNo);
  expect(byName.email.max_length).toBe(LIMITS.email);
  expect(byName.phone.max_length).toBe(LIMITS.phone);
  expect(byName.job_title.max_length).toBe(LIMITS.jobTitle);
  expect(byName.department.max_length).toBe(LIMITS.department);
});

test("the manifest names app hr at the package version and requires the four contracts", () => {
  const manifest = parse(bytes("app/app.md").toString("utf8").split("\n---\n")[0].replace(/^---\n/, ""));
  expect(manifest.app).toBe("hr");
  expect(manifest.version).toBe(json("package.json").version);
  expect(manifest.needs.requires.contracts).toEqual({ "app-screens": [1], "screen-records": [1], "screen-startup": [1], "app-storage": [1] });
  expect(manifest.listing.data.personal).toBe(true);
  expect(manifest.listing.can.join(" ")).toContain("welcome note");
  expect(manifest.listing.tagline.length).toBeLessThanOrEqual(80);
  expect(["marketing", "customers", "operations", "finance", "content", "other"]).toContain(manifest.listing.category);
  expect(descriptor.app).toBe(manifest.app);
  expect(json("app/app-chat.json").app).toBe("hr");
  expect(json("app/app-chat.json").contexts[0].prompts.length).toBe(3);
});
