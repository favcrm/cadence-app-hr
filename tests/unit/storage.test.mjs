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
const REQUIRED_NO_DEFAULT = ["display_name", "employee_no", "employee_id", "employee_name", "leave_type", "start_date", "end_date", "half_days", "claim_date", "amount_minor", "currency", "title", "body", "effective_from", "code", "name", "paid", "opening_id", "kind", "effective_date", "source_ref",
  "employer_rate_bp", "employee_rate_bp", "min_relevant_income_minor", "max_relevant_income_minor", "holiday_days", "source_note", "seq", "monthly_minor", "mpf_exempt", "run_ref", "run_no", "entry_date", "line_count", "calc_version", "join_date", "salary_id", "additions_minor", "deductions_minor", "rate_effective_from", "relevant_income_minor", "employer_mpf_minor", "employee_mpf_minor", "net_pay_minor", "source", "source_id", "entry_ref", "batch", "period", "employee_name",
  "member_id", "at", "direction", "method", "client_ref", "requested_at", "as_of", "request_id", "withdrawn_at"];

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
  // 0.3.0 added one migration and no operation on an older table.
  expect(descriptor.migrations[2]).toMatchObject({ version: 3, path: "storage/003-leave-ledger.json" });
  for (const op of migrations[2].body.operations) expect(op.table).toBe("leave_entries");
});

test("migration 003 is byte-identical to the 0.3.0 release; 0.4.0 added 004, byte-identical since, and touched no older table", () => {
  expect(createHash("sha256").update(bytes("app/storage/003-leave-ledger.json")).digest("hex")).toBe("11d19be5a74eb3dfad4c0d76eca5c751c40897329b9fe6f6187ec81523a40dea");
  expect(descriptor.migrations[2].sha256).toBe("sha256:11d19be5a74eb3dfad4c0d76eca5c751c40897329b9fe6f6187ec81523a40dea");
  expect(descriptor.migrations[3]).toMatchObject({ version: 4, path: "storage/004-payroll.json", sha256: "sha256:c556a4f2cd1a94fc308fa94c732b57875cac58def8cb33b7ca4a22fdf823610c" });
  const created = migrations[3].body.operations.filter((o) => o.op === "create_table").map((o) => o.table);
  expect(created).toEqual(["rate_tables", "salaries", "payroll_runs", "payroll_lines", "postings"]);
  for (const op of migrations[3].body.operations) expect(created).toContain(op.table);
});

test("004: append-only rates, salaries and lines; unique keys that make saving and posting retry-safe; owner-only", () => {
  const ops = migrations[3].body.operations;
  const unique = (table) => ops.filter((o) => o.op === "create_index" && o.table === table && o.unique).map((o) => o.columns);
  expect(unique("rate_tables")).toEqual([["effective_from"]]);
  expect(unique("salaries")).toEqual([["employee_id", "effective_from", "seq"]]);
  expect(unique("payroll_runs")).toEqual([["run_ref"], ["period", "run_no"]]);
  expect(unique("payroll_lines")).toEqual([["run_ref", "employee_id"]]);
  expect(unique("postings")).toEqual([["source", "source_id"], ["entry_ref"]]);
  for (const table of ["rate_tables", "salaries", "payroll_lines"]) expect(descriptor.tables[table]).toMatchObject({ append_only: true, read_role: "owner" });
  for (const table of ["payroll_runs", "postings"]) {
    expect(descriptor.tables[table].append_only).toBeUndefined();
    expect(descriptor.tables[table].write_schema).toBeDefined();
    expect(descriptor.tables[table].read_role).toBe("owner");
  }
  // Each payroll line stores its inputs and the version of the calculation that made it.
  const line = ops.find((o) => o.op === "create_table" && o.table === "payroll_lines").columns.map((c) => c.name);
  for (const name of ["join_date", "salary_id", "monthly_minor", "additions_minor", "deductions_minor", "mpf_exempt", "rate_effective_from", "relevant_income_minor", "employer_mpf_minor", "employee_mpf_minor", "net_pay_minor", "calc_version"]) expect(line).toContain(name);
  // Accounting's entry_ref is at most 160 characters; HR's references must fit in it.
  const col = (table, name) => ops.find((o) => o.op === "create_table" && o.table === table).columns.find((c) => c.name === name);
  expect(col("postings", "entry_ref").max_length).toBe(160);
  expect(col("postings", "posting_ref").nullable).toBe(true);
  expect(col("payroll_runs", "run_ref").max_length).toBeLessThanOrEqual(160);
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
  // No identity document, bank account, medical or protected-attribute column anywhere; pay and MPF columns arrive in 004 only.
  for (const c of columns) expect(c.name).not.toMatch(/hkid|identity|passport|bank|account|medical|health|(^|_)age(_|$)|gender|birth|marital|family/);
  for (const m of migrations.slice(0, 3)) for (const o of m.body.operations.filter((op) => op.op === "create_table")) for (const c of o.columns) expect(c.name).not.toMatch(/salary|pay|mpf/);
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
  // The host's listing limits: a longer listing is refused at check time.
  expect(manifest.listing.about.length).toBeLessThanOrEqual(600);
  expect(manifest.listing.tags.length).toBeLessThanOrEqual(5);
  expect(manifest.listing.can.length).toBeLessThanOrEqual(5);
  for (const line of manifest.listing.can) expect(line.length).toBeLessThanOrEqual(100);
  expect(manifest.listing.data.stores.length).toBeLessThanOrEqual(5);
  for (const line of manifest.listing.data.stores) { expect(line.length).toBeLessThanOrEqual(120); expect(line).not.toContain(": "); }
  expect(manifest.summary.length).toBeLessThanOrEqual(160);
  for (const context of json("app/app-chat.json").contexts) expect(context.prompts.length).toBeLessThanOrEqual(3);
  expect(["marketing", "customers", "operations", "finance", "content", "other"]).toContain(manifest.listing.category);
  expect(descriptor.app).toBe(manifest.app);
  expect(json("app/app-chat.json").app).toBe("hr");
  expect(json("app/app-chat.json").contexts[0].prompts.length).toBe(3);
});

test("0.5.0 adds 005 (punches) and 006 (staff self-service), touches no older table, and 001-004 are the released bytes", () => {
  expect(descriptor.schema_version).toBe(6);
  expect(descriptor.compatible_schema_versions).toEqual([6]);
  expect(createHash("sha256").update(bytes("app/storage/004-payroll.json")).digest("hex")).toBe("c556a4f2cd1a94fc308fa94c732b57875cac58def8cb33b7ca4a22fdf823610c");
  expect(descriptor.migrations.slice(4).map((m) => [m.version, m.path])).toEqual([[5, "storage/005-attendance.json"], [6, "storage/006-self-service.json"]]);
  const created = (i) => migrations[i].body.operations.filter((o) => o.op === "create_table").map((o) => o.table);
  expect(created(4)).toEqual(["attendance_punches"]);
  expect(created(5)).toEqual(["staff_link_requests", "staff_snapshots", "staff_leave_requests", "staff_claims", "leave_withdrawals"]);
  for (const i of [4, 5]) for (const op of migrations[i].body.operations) expect(created(i)).toContain(op.table);
  // The punch columns the ticket names; location stays nullable until the host can read it (CAD-2334).
  const punch = migrations[4].body.operations[0].columns;
  expect(punch.map((c) => c.name)).toEqual(["employee_id", "member_id", "at", "direction", "method", "lat_e7", "lng_e7", "accuracy_m", "note", "client_ref"]);
  for (const name of ["lat_e7", "lng_e7", "accuracy_m", "note"]) expect(punch.find((c) => c.name === name).nullable).toBe(true);
  expect(punch.find((c) => c.name === "at").type).toBe("integer");
});

test("0.5.0: every new table is member-owned the way the host requires, and no older table gained row_owner", () => {
  const NEW = ["attendance_punches", "staff_link_requests", "staff_snapshots", "staff_leave_requests", "staff_claims", "leave_withdrawals"];
  for (const [name, o] of Object.entries(descriptor.tables)) expect([name, o.row_owner === undefined]).toEqual([name, !NEW.includes(name)]);
  const ops = migrations.slice(4).flatMap((m) => m.body.operations);
  for (const name of NEW) {
    expect(descriptor.tables[name]).toMatchObject({ row_owner: "member_id", read_role: "owner" });
    const owner = ops.find((o) => o.op === "create_table" && o.table === name).columns.find((c) => c.name === "member_id");
    // AOS-564: a text column, not nullable, no default, enum or format, and room for any member id.
    expect(owner).toEqual({ name: "member_id", type: "text", nullable: false, max_length: 200 });
    const indexes = ops.filter((o) => o.op === "create_index" && o.table === name);
    for (const unique of indexes.filter((i) => i.unique)) expect(unique.columns).toContain("member_id");
    expect(indexes.some((i) => !i.unique && i.columns.length === 1 && i.columns[0] === "member_id")).toBe(true);
    expect(descriptor.tables[name].balanced).toBeUndefined();
    expect(descriptor.tables[name].lock).toBeUndefined();
  }
  for (const name of ["attendance_punches", "staff_link_requests", "staff_snapshots", "leave_withdrawals"]) expect(descriptor.tables[name].append_only).toBe(true);
  // A member's request or claim keeps the owner tables' rule: filed open, and frozen once decided.
  expect(descriptor.tables.staff_leave_requests.write_schema).toEqual(descriptor.tables.leave_requests.write_schema);
  expect(descriptor.tables.staff_claims.write_schema).toEqual(descriptor.tables.claims.write_schema);
  // The staff tables copy the owner tables' columns, plus the owner column and the retry key.
  const cols = (table) => [...migrations.flatMap((m) => m.body.operations)].find((o) => o.op === "create_table" && o.table === table).columns.map((c) => c.name);
  expect(cols("staff_leave_requests").filter((c) => !["member_id", "client_ref"].includes(c))).toEqual(cols("leave_requests"));
  expect(cols("staff_claims").filter((c) => !["member_id", "client_ref"].includes(c))).toEqual(cols("claims"));
  // No pay, identity, bank or medical column on any table a member can read.
  for (const name of NEW) for (const c of cols(name)) expect(c).not.toMatch(/salary|pay|mpf|hkid|identity|passport|bank|account|medical|health/);
});
