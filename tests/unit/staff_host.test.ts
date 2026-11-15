// HR-5 acceptance against an in-memory host built from the real storage descriptor, with the AOS-564 member gates
// (`tests/support/staff-host.ts`): one store, the owner and members acting on it. Each test names the acceptance item
// it proves. Run: bun test tests/unit/staff_host.test.ts
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, sdkMock } from "../support/sdk-mock.mjs";

mock.module("@cadence/screen-ui", sdkMock);
const { makeStaffHost, member, OWNER, person, scope, descriptor } = await import("../support/staff-host.ts");
const S = await import("../../src/features/hr/staff.ts");
const { MEMBER_TABLES, STAFF, latestSnapshot, memberStatus } = await import("../../src/domain/staff.ts");
const { readBalances, approveLeave } = await import("../../src/features/hr/ledger.ts");
const { addSalary } = await import("../../src/features/hr/payroll.ts");
const { FormError } = await import("../../src/domain/records.ts");
const { SECTIONS } = await import("../../src/bridge/services.ts");

const AMY = "usr_amy-0001", BEN = "usr_ben-0002", EVE = "usr_eve-0003";
const NOW = Date.UTC(2026, 10, 16, 1, 2) / 1000; // 2026-11-16 09:02 Hong Kong
const leaveForm = { leaveType: "ANNUAL", startDate: "2026-12-22", endDate: "2026-12-23", days: "1.5", reason: "Family trip" };
const claimForm = { category: "travel", claimDate: "2026-11-14", amount: "186.50", merchant: "City Taxi Co. (demo)", description: "Client meeting" };

/** The owner's directory, leave types, a salary and Amy's accrued leave; Amy and Ben have asked to be linked and are. */
async function world({ link = true } = {}) {
  const host = makeStaffHost();
  const owner = host.as(OWNER), amy = host.as(member(AMY)), ben = host.as(member(BEN)), eve = host.as(member(EVE));
  host.add("employees", "emp-amy", person("E001", { display_name: "Amy Chan" }));
  host.add("employees", "emp-ben", person("E002", { display_name: "Ben Lee" }));
  host.add("leave_types", "lt-annual", { code: "ANNUAL", name: "Annual leave", paid: true });
  host.add("leave_types", "lt-sick", { code: "SICK", name: "Sick leave", paid: true });
  host.add("leave_entries", "le-1", { employee_id: "emp-amy", leave_type: "ANNUAL", half_days: 17, kind: "accrual", effective_date: "2026-10-31", source_ref: "accrual-emp-amy-ANNUAL-2026-10" });
  host.add("leave_entries", "le-2", { employee_id: "emp-ben", leave_type: "ANNUAL", half_days: 10, kind: "accrual", effective_date: "2026-10-31", source_ref: "accrual-emp-ben-ANNUAL-2026-10" });
  await addSalary(scope, { employeeNo: "E001", effectiveFrom: "2020-01-01", monthlyMinor: 2000000, mpfExempt: false, note: "" }, "sal-000000000001", owner);
  if (link) {
    await S.requestLink(scope, "Amy Chan", "E001", NOW, amy);
    await S.requestLink(scope, "Ben Lee", "", NOW, ben);
    await S.linkMember(scope, AMY, "E001", NOW, owner);
    await S.linkMember(scope, BEN, "E002", NOW, owner);
  }
  return { host, owner, amy, ben, eve };
}
/** A stored row's profile as a member would send it again: without the owner column the host stamps. */
const resend = (profile: Record<string, unknown>, over: Record<string, unknown>) => { const { member_id: _owner, ...rest } = profile; return { ...rest, ...over }; };
const home = async (a: ReturnType<ReturnType<typeof makeStaffHost>["as"]>) => (await S.readMemberHome(scope, a)).snapshot;

test("the screen tells the owner from a member with an update that can never land", async () => {
  const { host, owner, amy, eve } = await world({ link: false });
  expect(await S.probeViewer(scope, owner)).toBe("owner"); // 409 append_only
  expect(await S.probeViewer(scope, amy)).toBe("member"); // owner_required, kept non-fatal by the board
  expect(await S.probeViewer(scope, eve)).toBe("member");
  // Nothing was written or read by either answer, and no frame was closed.
  expect(host.of(STAFF.withdrawals)).toEqual([]);
  expect(host.closed.size).toBe(0);
  expect(host.calls.filter((c) => c.verb === "records.update").map((c) => [c.viewer, c.table, c.args.record_id])).toEqual([["owner", STAFF.withdrawals, "viewer-probe"], [AMY, STAFF.withdrawals, "viewer-probe"], [EVE, STAFF.withdrawals, "viewer-probe"]]);
});

test("a refusal the board collapses is never read as a role: the owner never gets the staff view", async () => {
  const { host, owner, amy } = await world();
  // Host answers the board collapses to `failed` (status 400), and its own classes; and app-kit's timeout.
  const misreads = [
    new ApiError("bad", 400, { code: "validation_failed" }), new ApiError("big", 413, { code: "too_large" }), new ApiError("slow down", 429, { code: "rate_limited" }),
    new ApiError("boom", 500, { code: "internal" }), new ApiError("edge", 502), new ApiError("down", 503, { code: "unavailable" }), new ApiError("signed out", 401, { code: "unauthorized" }),
  ];
  for (const error of misreads) {
    host.fault("records.update", error, { viewer: "owner" });
    const seen = await S.probeViewer(scope, owner).then((v) => v, (e: ApiError) => `refused ${e.status} ${e.code}`);
    expect([error.status, seen]).not.toEqual([error.status, "member"]);
    expect([error.status, seen]).not.toEqual([error.status, "owner"]);
  }
  host.fault("records.update", new ApiError("timeout", 504, { code: "timeout" }), { viewer: "owner", frame: true });
  await expect(S.probeViewer(scope, owner)).rejects.toMatchObject({ status: 504 });
  // The 400s the board collapses carry code `failed`, never `owner_required`: the old batch probe read them as member.
  host.fault("records.update", new ApiError("boom", 500), { viewer: "owner" });
  await expect(S.probeViewer(scope, owner)).rejects.toMatchObject({ status: 400, code: "failed" });
  // A board that still closes the frame on a member's write 403 (before CAD-2315) is no answer either: it fails closed.
  host.fault("records.update", new ApiError("gone", 403, { code: "forbidden" }), { viewer: AMY });
  await expect(S.probeViewer(scope, amy)).rejects.toMatchObject({ status: 403 });
  // With no fault the answers are the two roles again.
  expect(await S.probeViewer(scope, owner)).toBe("owner");
  expect(await S.probeViewer(scope, amy)).toBe("member");
});

test("linking: a member asks, the owner links them on the employee record, and the member then sees who they are and their balance", async () => {
  const { host, owner, amy, eve } = await world({ link: false });
  expect(await home(amy)).toBeNull();
  const asked = await S.requestLink(scope, "Amy Chan", "e001", NOW, amy);
  expect(asked.id).toMatch(/^mem_/);
  expect(asked.profile).toMatchObject({ member_id: AMY, display_name: "Amy Chan", employee_no: "E001" }); // the host stamped the id
  const { requests } = await S.readLinkRequests(scope, owner);
  expect(requests.map((r) => [r.memberId, r.linkedTo])).toEqual([[AMY, null]]);
  await S.linkMember(scope, AMY, "E001", NOW, owner);
  expect(host.of("employees").find((e) => e.id === "emp-amy")!.profile.member_id).toBe(AMY);
  const snap = (await home(amy))!;
  expect(snap).toMatchObject({ employeeId: "emp-amy", employeeName: "Amy Chan", employeeNo: "E001", asOf: NOW });
  // The balance is the ledger aggregate the owner's Balances tab reads, for Amy only.
  const ledger = await readBalances(scope, [{ field: "employee_id", op: "eq", value: "emp-amy" }], owner);
  expect(snap.balances).toEqual(ledger.groups.map((g) => ({ leaveType: g.leaveType, halfDays: g.halfDays })));
  expect(snap.balances).toEqual([{ leaveType: "ANNUAL", halfDays: 17 }]);
  expect(snap.types.map((x) => x.code)).toEqual(["ANNUAL", "SICK"]);
  // One account per employee, one employee per account.
  await expect(S.linkMember(scope, EVE, "E001", NOW, owner)).rejects.toThrow(/already linked to another account/);
  await expect(S.linkMember(scope, AMY, "E002", NOW, owner)).rejects.toThrow(/already linked to another employee/);
  // The staff view offers an unlinked member only a link request (a screen choice; the owner's checks are the control).
  await expect(S.fileLeave(scope, await home(eve), leaveForm, "slv-000000000001", eve)).rejects.toBeInstanceOf(FormError);
  await expect(S.punch(scope, await home(eve), "in", NOW, "app-000000000001", eve)).rejects.toBeInstanceOf(FormError);
  expect(host.of(STAFF.leave).length + host.of(STAFF.punches).length).toBe(0);
  // Unlinking clears the employee record and tells the member.
  const directory = await S.readDirectory(scope, owner);
  await S.unlinkEmployee(scope, directory.find((e) => e.id === "emp-amy")!, NOW + 60, owner);
  expect(host.of("employees").find((e) => e.id === "emp-amy")!.profile.member_id).toBeNull();
  expect((await home(amy))!.employeeId).toBeNull();
  expect(host.closed.size).toBe(0);
});

test("acceptance 1: a member creates a leave request, a claim and a punch, and sees them", async () => {
  const { host, amy } = await world();
  const snap = await home(amy);
  const leave = await S.fileLeave(scope, snap, leaveForm, "slv-000000000001", amy);
  const claim = await S.fileClaim(scope, snap, claimForm, "scl-000000000001", amy);
  const clock = await S.punch(scope, snap, "in", NOW, "app-000000000001", amy);
  for (const row of [leave, claim, clock]) { expect(row.id).toMatch(/^mem_[0-9a-f]{32}$/); expect(row.profile.member_id).toBe(AMY); }
  expect(leave.profile).toMatchObject({ employee_id: "emp-amy", employee_name: "Amy Chan", leave_type: "ANNUAL", half_days: 3, status: "pending", decided_on: null });
  expect(claim.profile).toMatchObject({ employee_id: "emp-amy", amount_minor: 18650, currency: "HKD", status: "submitted", receipt_ref: null });
  expect(clock.profile).toMatchObject({ employee_id: "emp-amy", at: NOW, direction: "in", method: "app", lat_e7: null, lng_e7: null, accuracy_m: null });
  expect((await S.listMine(scope, STAFF.leave, {}, amy)).records.map((r) => r.id)).toEqual([leave.id]);
  expect((await S.listMine(scope, STAFF.claims, {}, amy)).records.map((r) => r.id)).toEqual([claim.id]);
  expect((await S.listMine(scope, STAFF.punches, {}, amy)).records.map((r) => r.id)).toEqual([clock.id]);
  expect(host.closed.size).toBe(0);
});

test("a member's lost reply is found by its client_ref, so a retry files nothing twice", async () => {
  const { host, amy } = await world();
  const snap = await home(amy);
  host.fault("records.create", new ApiError("timeout", 504, { code: "timeout" }), { table: STAFF.punches, after: true, frame: true });
  const row = await S.punch(scope, snap, "in", NOW, "app-000000000009", amy);
  expect(row.profile.client_ref).toBe("app-000000000009");
  // The same form sent again meets its own row (the unique member_id + client_ref): still one punch.
  await expect(S.punch(scope, snap, "in", NOW, "app-000000000009", amy)).resolves.toMatchObject({ id: row.id });
  expect(host.of(STAFF.punches).length).toBe(1);
  // A conflict that did not land (the host's per-member row limit answers 409) is read back and said plainly: not saved.
  host.fault("records.create", new ApiError("member_row_limit", 409, { code: "conflict" }), { table: STAFF.punches });
  await expect(S.punch(scope, snap, "out", NOW + 60, "app-00000000000a", amy)).rejects.toThrow(/This was not saved/);
  expect(host.of(STAFF.punches).length).toBe(1);
});

test("acceptance 2: a member cannot see another member's rows, any salary, or the owner tabs' tables", async () => {
  const { host, amy, ben } = await world();
  const benLeave = await S.fileLeave(scope, await home(ben), { ...leaveForm, days: "1" }, "slv-000000000002", ben);
  await S.punch(scope, await home(ben), "in", NOW, "app-000000000002", ben);
  await S.fileLeave(scope, await home(amy), leaveForm, "slv-000000000001", amy);
  // Lists, counts and shows hold only Amy's own rows.
  for (const table of MEMBER_TABLES) for (const r of (await S.listMine(scope, table, { limit: 100 }, amy)).records) expect(r.profile.member_id).toBe(AMY);
  expect((await S.listMine(scope, STAFF.leave, {}, amy)).records.length).toBe(1);
  await expect(amy.show(scope, benLeave.id, STAFF.leave)).rejects.toMatchObject({ status: 404 });
  expect((await S.readMemberHome(scope, amy)).snapshot!.employeeId).toBe("emp-amy");
  // Ben's balance, published to Ben, is not Amy's to read.
  expect((await S.listMine(scope, STAFF.snapshots, {}, amy)).records.every((r) => r.profile.member_id === AMY)).toBe(true);
  // Every owner tab's table refuses her (the real board closes the frame on that 403, which the staff view never sends).
  for (const table of ["employees", "salaries", "payroll_runs", "payroll_lines", "rate_tables", "postings", "leave_requests", "leave_entries", "claims", "policies", "candidates"]) {
    await expect(amy.list(scope, { table })).rejects.toMatchObject({ status: 403 });
  }
  await expect(amy.aggregate(scope, { table: "leave_entries", group_by: ["employee_id"], sum: ["half_days"] })).rejects.toMatchObject({ status: 403 });
  // A member cannot name a record or file a row in someone else's name (crafted requests the screen never sends).
  const crafted = host.raw(member(AMY));
  await expect(crafted("records.create", { table: STAFF.leave, record_id: "lv-mine", profile: resend(benLeave.profile, { client_ref: "slv-x" }) })).rejects.toMatchObject({ status: 400, code: "record_id_not_allowed" });
  await expect(crafted("records.create", { table: STAFF.leave, profile: { ...benLeave.profile, client_ref: "slv-y" } })).rejects.toMatchObject({ status: 403, code: "row_owner_mismatch" });
  expect(host.of(STAFF.leave).filter((r) => r.profile.member_id === BEN).length).toBe(1);
});

test("acceptance 2: everything the staff view sends goes to a row_owner table, and no frame is closed", async () => {
  const { host, amy } = await world();
  const before = host.calls.length;
  const snap = await home(amy);
  const leave = await S.fileLeave(scope, snap, leaveForm, "slv-000000000001", amy);
  await S.fileClaim(scope, snap, claimForm, "scl-000000000001", amy);
  await S.punch(scope, snap, "in", NOW, "app-000000000001", amy);
  await S.withdrawLeave(scope, leave, NOW, amy);
  await S.listMine(scope, STAFF.punches, { filters: [{ field: "at", op: "gte", value: NOW - 86400 }], orderBy: "at" }, amy);
  await S.listMine(scope, STAFF.withdrawals, {}, amy);
  await S.probeViewer(scope, amy);
  const sent = host.calls.slice(before).filter((c) => c.viewer === AMY);
  expect(sent.length).toBeGreaterThan(8);
  for (const c of sent) expect([c.verb, MEMBER_TABLES.includes(c.table)]).toEqual([c.verb, true]);
  for (const table of MEMBER_TABLES) expect(descriptor.tables[table]).toMatchObject({ row_owner: "member_id", read_role: "owner" });
  expect(host.closed.size).toBe(0);
  // The guard in the staff module refuses any other table before anything is sent.
  await expect(S.listMine(scope, "salaries", {}, amy)).rejects.toThrow(/only its own tables/);
});

test("acceptance 2: the member view is its own screen and offers no owner tab", () => {
  const src = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
  const staff = src("src/features/hr/StaffScreen.tsx");
  // It imports none of the owner panes and names no owner table.
  for (const pane of ["Sections", "PayrollPanes", "RecordsPane", "PeopleList", "BalancesPane", "EmployeeDrawer", "AttendancePane", "StaffAccounts"]) expect(staff).not.toContain(`./${pane}`);
  for (const table of ["\"employees\"", "\"salaries\"", "\"payroll_", "\"leave_entries\"", "\"leave_requests\"", "\"claims\""]) expect(staff).not.toContain(table);
  expect(staff).toMatch(/const TABS = \["My leave", "My claims", "Clock"\] as const;/);
  // The owner screen is never mounted for a member: the probe answers first, and a member gets the staff screen.
  const shell = src("src/features/hr/HrScreen.tsx");
  expect(shell.indexOf('if (who.viewer === "member") return <StaffScreen')).toBeGreaterThan(0);
  expect(shell.indexOf('if (who.viewer === "member")')).toBeLessThan(shell.indexOf("SECTIONS.map"));
  expect(shell.indexOf("if (who.viewer === null)")).toBeLessThan(shell.indexOf('if (who.viewer === "member")'));
});

test("acceptance 3: a member cannot change a request after it is decided, and cannot edit a punch", async () => {
  const { host, owner, amy } = await world();
  const snap = await home(amy);
  const leave = await S.fileLeave(scope, snap, leaveForm, "slv-000000000001", amy);
  const claim = await S.fileClaim(scope, snap, claimForm, "scl-000000000001", amy);
  const clock = await S.punch(scope, snap, "in", NOW, "app-000000000001", amy);
  // A member never updates, pending or not (403 owner_required at the host; the board keeps it non-fatal for a write).
  for (const [id, table, patch] of [[leave.id, STAFF.leave, { half_days: 1 }], [claim.id, STAFF.claims, { amount_minor: 1 }], [clock.id, STAFF.punches, { at: NOW - 3600 }]] as const) {
    await expect(amy.update(scope, id, 1, patch, table)).rejects.toMatchObject({ status: 400, code: "owner_required" });
    await expect(host.raw(member(AMY))("records.update", { table, record_id: id, expected_revision: 1, profile: patch })).rejects.toMatchObject({ status: 403, code: "owner_required" });
  }
  // Nor can she file a request that is already decided: the write rule pins the starting state.
  await expect(amy.file(scope, resend(leave.profile, { client_ref: "slv-y", status: "approved" }), STAFF.leave)).rejects.toMatchObject({ status: 400, code: "failed" });
  await expect(amy.file(scope, resend(claim.profile, { client_ref: "scl-y", status: "approved", decided_on: "2026-11-16" }), STAFF.claims)).rejects.toMatchObject({ status: 400, code: "failed" });
  await expect(host.raw(member(AMY))("records.create", { table: STAFF.leave, profile: resend(leave.profile, { client_ref: "slv-w", status: "approved" }) })).rejects.toMatchObject({ code: "validation_failed" });
  await expect(amy.file(scope, resend(leave.profile, { client_ref: "slv-z" }), STAFF.leave)).resolves.toBeDefined(); // the same row, pending, is admitted
  // The owner approves: the ledger takes the days once, and the member's balance is published again.
  const { record: approved, published } = await S.decideStaff(scope, STAFF.leave, leave, "approved", "2026-11-16", "", NOW + 60, owner);
  expect(approved.profile.status).toBe("approved");
  expect(published).toBe(true);
  expect(host.of("leave_entries").filter((e) => e.profile.source_ref === `taken-${leave.id}`).map((e) => e.profile.half_days)).toEqual([-3]);
  expect((await home(amy))!.balances).toEqual([{ leaveType: "ANNUAL", halfDays: 14 }]);
  // Decided: not by the member, not by a staged update, and withdrawing is refused by the screen.
  await expect(amy.update(scope, leave.id, approved.revision, { status: "cancelled" }, STAFF.leave)).rejects.toMatchObject({ code: "owner_required" });
  await expect(owner.update(scope, leave.id, approved.revision, { half_days: 1 }, STAFF.leave)).rejects.toMatchObject({ status: 400 });
  await expect(S.withdrawLeave(scope, approved, NOW, amy)).rejects.toThrow(/Only a pending request/);
  // A withdrawal row crafted for a decided request changes nothing: it still reads as approved.
  await amy.file(scope, { request_id: leave.id, withdrawn_at: NOW }, STAFF.withdrawals);
  expect(memberStatus(approved.profile, true)).toBe("approved");
  const decidedClaim = (await S.decideStaff(scope, STAFF.claims, claim, "approved", "2026-11-16", "", NOW, owner)).record;
  await expect(owner.update(scope, claim.id, decidedClaim.revision, { amount_minor: 1 }, STAFF.claims)).rejects.toMatchObject({ status: 400 });
  // A punch is append-only for everyone; a correction is a new row.
  await expect(owner.update(scope, clock.id, 1, { at: NOW - 3600 }, STAFF.punches)).rejects.toMatchObject({ status: 409 });
  const fixed = await S.addCorrection(scope, { employeeNo: "E001", date: "2026-11-16", time: "08:58", direction: "in", note: "Forgot to clock in" }, "cor-000000000001", owner);
  expect(fixed.profile).toMatchObject({ method: "correction", member_id: AMY, employee_id: "emp-amy", note: "Forgot to clock in" });
  expect(host.of(STAFF.punches).length).toBe(2);
  expect(host.closed.size).toBe(0); // the member's refused updates were non-fatal; no frame closed
});

test("withdrawing a pending request: the member sees it withdrawn, the owner cannot approve it and closes it as cancelled", async () => {
  const { host, owner, amy } = await world();
  const leave = await S.fileLeave(scope, await home(amy), leaveForm, "slv-000000000001", amy);
  await S.withdrawLeave(scope, leave, NOW, amy);
  await S.withdrawLeave(scope, leave, NOW, amy); // twice meets the first row
  expect(host.of(STAFF.withdrawals).length).toBe(1);
  expect(memberStatus(leave.profile, true)).toBe("withdrawn");
  expect(await S.isWithdrawn(scope, leave, owner)).toBe(true);
  await expect(S.decideStaff(scope, STAFF.leave, leave, "approved", "2026-11-16", "", NOW, owner)).rejects.toThrow(/withdrew this request/);
  expect(host.of("leave_entries").some((e) => e.profile.source_ref === `taken-${leave.id}`)).toBe(false);
  const closed = (await S.decideStaff(scope, STAFF.leave, leave, "rejected", "2026-11-16", "", NOW, owner)).record;
  expect(closed.profile).toMatchObject({ status: "cancelled", decision_note: "Withdrawn by the employee" });
  expect(memberStatus(closed.profile, true)).toBe("cancelled");
});

test("a row filed under another employee is never approved, and a member's own snapshot is never trusted", async () => {
  const { host, owner, amy, eve } = await world();
  // Eve is not linked, but crafts a request naming Amy's employee record (a member chooses every column but the owner).
  const forged = await eve.file(scope, { employee_id: "emp-amy", employee_name: "Amy Chan", leave_type: "ANNUAL", start_date: "2026-12-01", end_date: "2026-12-01", half_days: 2, status: "pending", decided_on: null, decision_note: null, client_ref: "slv-forged" }, STAFF.leave);
  expect(forged.profile.member_id).toBe(EVE);
  await expect(S.decideStaff(scope, STAFF.leave, forged, "approved", "2026-11-16", "", NOW, owner)).rejects.toThrow(/not filed from the account linked to this employee/);
  const forgedClaim = await eve.file(scope, { employee_id: "emp-amy", employee_name: "Amy Chan", claim_date: "2026-11-01", amount_minor: 99999, currency: "HKD", status: "submitted", decided_on: null, decision_note: null, client_ref: "scl-forged" }, STAFF.claims);
  await expect(S.decideStaff(scope, STAFF.claims, forgedClaim, "approved", "2026-11-16", "", NOW, owner)).rejects.toThrow(/not filed from the account linked/);
  expect(host.of("leave_entries").some((e) => e.profile.source_ref === `taken-${forged.id}`)).toBe(false);
  // Eve writes herself a "snapshot" linking her to Amy: the staff view reads only snapshots the owner's screen named.
  await eve.file(scope, { employee_id: "emp-amy", employee_name: "Amy Chan", employee_no: "E001", as_of: NOW + 999, leave: null }, STAFF.snapshots);
  expect(await home(eve)).toBeNull();
  expect(latestSnapshot((await S.listMine(scope, STAFF.snapshots, {}, eve)).records)).toBeNull();
  // Amy's own punch is trusted as hers; Eve's punch naming Amy's record is shown to the owner as not from the linked account.
  const evePunch = await eve.file(scope, { employee_id: "emp-amy", at: NOW, direction: "in", method: "import", client_ref: "app-forged" }, STAFF.punches);
  const { punches } = await S.readPunches(scope, NOW - 3600, owner);
  const row = punches.find((x) => x.id === evePunch.id)!;
  expect(row.kind).toBe("app"); // its method column says "import"; its host-named id says a member filed it
  const directory = await S.readDirectory(scope, owner);
  expect(directory.find((e) => e.id === row.employeeId)!.memberId).not.toBe(row.memberId);
  expect(host.closed.size).toBe(0);
});

test("acceptance 4: the owner view is unchanged — same tabs in the same order, and an owner request decides exactly as before", async () => {
  expect(SECTIONS.slice(0, 6)).toEqual(["people", "policies", "leave", "claims", "payroll", "recruiting"]);
  const sections = readFileSync(fileURLToPath(new URL("../../src/features/hr/Sections.tsx", import.meta.url)), "utf8");
  expect(sections).toContain('labels={["Leave requests", "Leave types", "Balances", "Staff requests"]}');
  expect(sections).toContain('labels={["Claims", "Staff claims"]}');
  const { host, owner } = await world();
  host.add("leave_requests", "lv-owner", { employee_id: "emp-ben", employee_name: "Ben Lee", leave_type: "ANNUAL", start_date: "2026-12-01", end_date: "2026-12-01", half_days: 2 });
  const request = await owner.show(scope, "lv-owner", "leave_requests");
  const approved = await approveLeave(scope, request, "2026-11-16", "", owner);
  expect(approved.profile.status).toBe("approved");
  expect(host.of("leave_entries").find((e) => e.profile.source_ref === "taken-lv-owner")!.profile.half_days).toBe(-2);
  // The owner reads every row of a staff table, as the host allows.
  const { amy, ben } = { amy: host.as(member(AMY)), ben: host.as(member(BEN)) };
  await S.fileLeave(scope, await home(amy), leaveForm, "slv-1", amy);
  await S.fileLeave(scope, await home(ben), leaveForm, "slv-1", ben);
  expect((await owner.list(scope, { table: STAFF.leave })).records.length).toBe(2);
});

test("import from an attendance device: preview, import, and a second run adds nothing", async () => {
  const { host, owner } = await world();
  const csv = [
    "Employee No,Time,Direction",
    "E001,2026-11-16 09:02,IN",
    "E001,2026-11-16 18:10:30,out",
    "E002,2026-11-16T08:55,in",
    "E009,2026-11-16 09:00,in",
    "E001,2026-11-16 9:00,in",
    "E001,2026-11-16 09:02,in",
  ].join("\n");
  const lines = await S.previewImport(scope, csv, owner);
  expect(lines.map((l) => [l.line, l.status])).toEqual([[2, "new"], [3, "new"], [4, "new"], [5, "unknown_employee"], [6, "invalid"], [7, "duplicate"]]);
  expect(host.of(STAFF.punches).length).toBe(0); // a preview writes nothing
  // The first batch lands but its reply is lost: the read-back counts it and nothing is written twice.
  host.fault("records.batch", new ApiError("timeout", 504, { code: "timeout" }), { after: true, frame: true });
  expect(await S.importPunches(scope, lines, undefined, owner)).toEqual({ imported: 0, alreadyThere: 3, blocked: [] });
  const rows = host.of(STAFF.punches);
  expect(rows.map((r) => r.id).every((id) => id.startsWith("imp-"))).toBe(true);
  expect(rows.map((r) => [r.profile.employee_id, r.profile.member_id, r.profile.direction, r.profile.method])).toEqual([
    ["emp-amy", AMY, "in", "import"], ["emp-amy", AMY, "out", "import"], ["emp-ben", BEN, "in", "import"],
  ]);
  const again = await S.previewImport(scope, csv, owner);
  expect(again.filter((l) => l.status === "already").length).toBe(3);
  expect(await S.importPunches(scope, again, undefined, owner)).toEqual({ imported: 0, alreadyThere: 0, blocked: [] });
  expect(host.of(STAFF.punches).length).toBe(3);
  // The member sees the imported punches of their own employee record (stamped with their linked account).
  expect((await S.listMine(scope, STAFF.punches, {}, host.as(member(AMY)))).records.length).toBe(2);
});

test("a large import and a staff-wide balance update are cut to the board's batch byte limit", async () => {
  const { host, owner } = await world();
  // 300 punches: about 280 bytes each, so 200 items would be about 56 KB, over the board's 16,384-byte batch limit.
  const csv = Array.from({ length: 300 }, (_, i) => `E00${1 + (i % 2)},2026-11-${String(1 + Math.floor(i / 20)).padStart(2, "0")} ${String(7 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")},${i % 2 ? "out" : "in"}`).join("\n");
  const lines = await S.previewImport(scope, csv, owner);
  expect(lines.filter((l) => l.status === "new").length).toBe(300);
  expect(await S.importPunches(scope, lines, undefined, owner)).toEqual({ imported: 300, alreadyThere: 0, blocked: [] });
  expect(await S.publishAllSnapshots(scope, NOW + 120, owner)).toBe(2);
  const batches = host.calls.filter((c) => c.verb === "records.batch" && c.status === 200);
  expect(batches.length).toBeGreaterThan(5);
  for (const b of batches) expect(new TextEncoder().encode(JSON.stringify(b.args)).length).toBeLessThanOrEqual(16384);
  expect(host.of(STAFF.punches).length).toBe(300);
});

test("a member_id set on an employee before 0.5.0 is not a link until the owner confirms it", async () => {
  const { host, owner, eve } = await world({ link: false });
  // Set outside Staff accounts (0.4.0 data, or an edit): the employee record names Eve's account.
  host.of("employees").find((e) => e.id === "emp-amy")!.profile.member_id = EVE;
  const before = (await S.readDirectory(scope, owner)).find((e) => e.id === "emp-amy")!;
  expect(before).toMatchObject({ memberId: EVE, linked: false });
  expect(S.linkedAccount(before)).toBeNull();
  // Staff accounts lists it for confirmation; Eve's own view still reads as not linked.
  const { requests } = await S.readLinkRequests(scope, owner);
  expect(requests.map((r) => [r.memberId, r.linkedTo?.id, r.confirmed, r.requestedAt])).toEqual([[EVE, "emp-amy", false, null]]);
  expect(await home(eve)).toBeNull();
  // A row Eve crafts for that employee is not approved, and "Update staff balances" does not publish to her.
  const forged = await eve.file(scope, { employee_id: "emp-amy", employee_name: "Amy Chan", leave_type: "ANNUAL", start_date: "2026-12-01", end_date: "2026-12-01", half_days: 2, status: "pending", decided_on: null, decision_note: null, client_ref: "slv-pre" }, STAFF.leave);
  await expect(S.decideStaff(scope, STAFF.leave, forged, "approved", "2026-11-16", "", NOW, owner)).rejects.toThrow(/not filed from the account linked/);
  expect(await S.publishAllSnapshots(scope, NOW, owner)).toBe(0);
  expect(host.of(STAFF.snapshots).length).toBe(0);
  // An import stamps the employee's punches with no account while the link is unconfirmed.
  const lines = await S.previewImport(scope, "E001,2026-11-16 09:00,in", owner);
  expect(lines[0]!.memberId).toBe("-");
  // The owner checks the code and confirms: now it counts.
  await S.linkMember(scope, EVE, "E001", NOW, owner);
  expect((await S.readDirectory(scope, owner)).find((e) => e.id === "emp-amy")!.linked).toBe(true);
  expect((await home(eve))!.employeeId).toBe("emp-amy");
  expect((await S.decideStaff(scope, STAFF.leave, forged, "approved", "2026-11-16", "", NOW, owner)).record.profile.status).toBe("approved");
});

test("the newest snapshot is the host's newest row, whatever the owner device's clock said", async () => {
  const { owner, amy } = await world();
  // The owner's device clock is a day behind on this publish: `as_of` is older than the first snapshot's.
  const directory = await S.readDirectory(scope, owner);
  await S.unlinkEmployee(scope, directory.find((e) => e.id === "emp-amy")!, NOW - 86400, owner);
  expect((await home(amy))!.employeeId).toBeNull();
});

test("a withdrawal counts only from the account that filed the request", async () => {
  const { owner, amy, ben } = await world();
  const leave = await S.fileLeave(scope, await home(amy), leaveForm, "slv-000000000001", amy);
  // Ben files a withdrawal naming Amy's request id: the host matches both columns, so it is not Amy's withdrawal.
  await ben.file(scope, { request_id: leave.id, withdrawn_at: NOW }, STAFF.withdrawals);
  expect(await S.isWithdrawn(scope, leave, owner)).toBe(false);
  expect((await S.decideStaff(scope, STAFF.leave, leave, "approved", "2026-11-16", "", NOW, owner)).record.profile.status).toBe("approved");
});

test("a member who takes an import's reference blocks only that line, and the owner is told which", async () => {
  const { host, owner, amy } = await world();
  const csv = ["E001,2026-11-16 09:02,in", "E001,2026-11-16 18:10,out", "E002,2026-11-16 08:55,in"].join("\n");
  const lines = await S.previewImport(scope, csv, owner);
  // Amy predicts the first line's id and files her own punch with it as client_ref: (member_id, client_ref) is unique.
  await amy.file(scope, { employee_id: "emp-amy", at: NOW, direction: "in", method: "app", client_ref: lines[0]!.recordId! }, STAFF.punches);
  const result = await S.importPunches(scope, lines, undefined, owner);
  expect(result.imported).toBe(2);
  expect(result.alreadyThere).toBe(0);
  expect(result.blocked.map((l) => l.line)).toEqual([1]);
  expect(host.of(STAFF.punches).filter((r) => r.id.startsWith("imp-")).length).toBe(2);
});

test("a member write the board reports as failed is read back: saved if it is there, plainly not saved if not", async () => {
  const { host, amy } = await world();
  const snap = await home(amy);
  // The host answered 500 after the row landed: the frame sees 400 `failed`; the read-back finds it.
  host.fault("records.create", new ApiError("boom", 500), { table: STAFF.punches, after: true });
  const row = await S.punch(scope, snap, "in", NOW, "app-000000000011", amy);
  expect(row.profile.client_ref).toBe("app-000000000011");
  // Refused before landing: the read-back answers without it, so the screen can say it was not saved.
  host.fault("records.create", new ApiError("bad", 400, { code: "validation_failed" }), { table: STAFF.claims });
  await expect(S.fileClaim(scope, snap, claimForm, "scl-000000000011", amy)).rejects.toThrow(/This was not saved/);
  // If the read-back fails too, the original failure is thrown (the screen says it may not be saved).
  host.fault("records.create", new ApiError("boom", 500), { table: STAFF.leave });
  host.fault("records.list", new ApiError("boom", 500), { table: STAFF.leave });
  await expect(S.fileLeave(scope, snap, leaveForm, "slv-000000000011", amy)).rejects.toMatchObject({ status: 400, code: "failed" });
  expect(host.closed.size).toBe(0);
});
