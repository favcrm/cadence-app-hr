// Storage declaration checks: migration pins, contiguity, and a local mirror of the
// host's app-storage/v1 rules (packages/contracts/src/app-storage.ts in the host
// repository). The mirror covers the rules this bundle can break; the real schema
// is exercised separately, see the pull request.
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
const columns = migrations.flatMap((m) => m.body.operations.filter((o) => o.op === "create_table").flatMap((o) => o.columns));
const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

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

test("the descriptor satisfies the host's descriptor rules", () => {
  expect(Object.keys(descriptor).sort()).toEqual(["app", "compatible_schema_versions", "contract", "default_table", "migrations", "record_kind", "record_search_columns", "schema_version"]);
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
  const seen = new Set();
  for (const c of columns) {
    expect(c.name).toMatch(IDENTIFIER);
    expect(HOST_COLUMNS).not.toContain(c.name);
    expect(seen.has(c.name)).toBe(false);
    seen.add(c.name);
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
      expect(Object.keys(c.json_schema).sort()).toEqual(["pattern", "type"]);
      expect(c.json_schema.type).toBe("string");
      expect(c.json_schema.pattern).toMatch(/^\^\[[A-Za-z0-9_-]+\](\{\d+(,\d+)?\})?\$$/);
    }
    // A non-null column the owner must always supply has no default; a nullable one reads as null when omitted.
    if (!c.nullable && !("default" in c)) expect(["display_name", "employee_no"]).toContain(c.name);
  }
  expect(columns.length).toBeLessThanOrEqual(64);
  const indexes = migrations.flatMap((m) => m.body.operations.filter((o) => o.op === "create_index"));
  for (const index of indexes) {
    expect(index.name).toMatch(IDENTIFIER);
    expect(typeof index.unique).toBe("boolean");
    expect(new Set(index.columns).size).toBe(index.columns.length);
    for (const name of index.columns) expect(seen.has(name) || HOST_COLUMNS.includes(name)).toBe(true);
  }
});

test("the employees table has the planned columns, a unique employee number, and no sensitive column", () => {
  expect(columns.map((c) => c.name)).toEqual([
    "display_name", "employee_no", "email", "phone", "job_title", "department", "employment_type", "join_date", "leave_date", "manager_id", "status", "member_id",
  ]);
  const unique = migrations[0].body.operations.filter((o) => o.op === "create_index" && o.unique);
  expect(unique.map((o) => o.columns)).toEqual([["employee_no"]]);
  for (const c of columns) expect(c.name).not.toMatch(/salary|pay|hkid|identity|passport|bank|account|medical|health|mpf/);
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
    expect(byName[name].json_schema.pattern).toBe("^[a-z_]{1,32}$");
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
