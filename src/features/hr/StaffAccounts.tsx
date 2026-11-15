import { Button, DataTable, EmptyState, ErrorNotice, Loading, Notice } from "@cadence/screen-ui";
import { useState } from "react";
import { hkParts, memberCode } from "../../domain/staff";
import { FormError } from "../../domain/records";
import type { HostScope } from "./hostActions";
import { hostErrorText } from "./hostErrors";
import { useLocale } from "./locale";
import { useHrLoader } from "./resources";
import { linkMember, publishAllSnapshots, readLinkRequests, unlinkEmployee, type LinkRequestRow } from "./staff";

const now = () => Math.floor(Date.now() / 1000);

/**
 * People → Staff accounts: members who asked to use HR from their own account, and the employee each is linked to.
 * The link is the employee record's account field (owner-only); linking also publishes what that member sees.
 */
export default function StaffAccounts({ scope, canWrite, canBatch, onBack }: { scope: HostScope; canWrite: boolean; canBatch: boolean; onBack: () => void }) {
  const { t, formatNumber } = useLocale();
  const data = useHrLoader(scope, "staff-accounts", {}, () => readLinkRequests(scope));
  const [linking, setLinking] = useState<string | null>(null);
  const [employeeNo, setEmployeeNo] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const refresh = () => { void data.store.refresh(); };
  const fail = (e: unknown, fallback: string) => setProblem(e instanceof FormError ? t(e.message) : t(hostErrorText(e, fallback)));
  const act = (work: () => Promise<string>, fallback: string) => {
    setPending(true); setProblem(null); setDone(null);
    void work().then((message) => { setDone(message); setLinking(null); setEmployeeNo(""); refresh(); }).catch((e: unknown) => fail(e, fallback)).finally(() => setPending(false));
  };
  // One row per account: its newest request.
  const rows = (data.data?.requests ?? []).filter((r, i, all) => all.findIndex((x) => x.memberId === r.memberId) === i);
  const linkedCount = (data.data?.directory ?? []).filter((e) => e.memberId !== null).length;
  return (
    <section aria-label={t("Staff accounts")} className="hr-list">
      <h3 className="text-cardtitle font-medium text-ink-100" data-outlet-heading>{t("Staff accounts")}</h3>
      <p className="text-label text-ink-400"><button type="button" className="lnk" onClick={onBack}>← {t("People")}</button></p>
      <p className="text-label text-ink-400">{t("Staff who open HR with their own account see only My leave, My claims and Clock, and only their own records. They ask to be linked from there; check the code on their screen matches the code here, then link them to their employee record.")}</p>
      {canWrite && (
        <div className="hr-actions">
          <Button disabled={pending || !canBatch || linkedCount === 0} loading={pending && linking === null}
            onClick={() => act(async () => t("Balances published for {count} staff.").replace("{count}", formatNumber(await publishAllSnapshots(scope, now()))), "The balances could not be published.")}>{t("Update staff balances")}</Button>
          <span className="text-label text-ink-400">{t("Staff see their leave balances as of the last update. Approving or rejecting their requests updates theirs; after an accrual run, update everyone here.")}</span>
        </div>
      )}
      {done && <Notice state="saved">{done}</Notice>}
      {problem && <ErrorNotice>{problem}</ErrorNotice>}
      {data.loading && <Loading>{t("Reading staff accounts…")}</Loading>}
      {data.error !== null && !data.loading && <ErrorNotice onRetry={refresh}>{t(hostErrorText(data.failure, "The staff accounts could not be read."))}</ErrorNotice>}
      {data.data && rows.length === 0 && <EmptyState name="staff-accounts" title={t("No requests yet")}>{t("When a member of this workspace opens HR and asks to be linked, they appear here.")}</EmptyState>}
      {rows.length > 0 && (
        <DataTable<LinkRequestRow>
          label={t("Staff accounts — scroll horizontally to reach every column")} wrapClassName="hr-table-wrap" tableClassName="hr-table" rowKey={(r) => r.id}
          columns={[
            { key: "name", header: t("Name given"), cell: (r) => r.name, cellClassName: "text-ink-100" },
            { key: "no", header: t("Employee number given"), cell: (r) => <span className="num">{r.employeeNo ?? "—"}</span> },
            { key: "code", header: t("Code"), cell: (r) => <span className="num">{memberCode(r.memberId)}</span>, cellClassName: "hr-nowrap" },
            { key: "asked", header: t("Asked on"), cell: (r) => <span className="num">{hkParts(r.requestedAt).date}</span>, cellClassName: "hr-nowrap" },
            { key: "linked", header: t("Linked to"), cell: (r) => r.linkedTo ? `${r.linkedTo.name} · ${r.linkedTo.employeeNo}` : <span className="text-ink-400">{t("Not linked")}</span> },
            { key: "act", header: t("Actions"), cell: (r) => !canWrite ? null : r.linkedTo ? (
              <Button size="sm" disabled={pending} onClick={() => act(async () => { await unlinkEmployee(scope, r.linkedTo!, now()); return t("Unlinked."); }, "The account could not be unlinked.")}>{t("Unlink")}</Button>
            ) : linking === r.id ? (
              <form className="hr-actions" onSubmit={(e) => { e.preventDefault(); act(async () => { await linkMember(scope, r.memberId, employeeNo, now()); return t("Linked."); }, "The account could not be linked."); }}>
                <label className="sr-only" htmlFor={`hr-link-${r.id}`}>{t("Employee number")}</label>
                <input id={`hr-link-${r.id}`} className="field" value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} maxLength={32} autoComplete="off" placeholder={t("Employee number")} />
                <Button size="sm" type="submit" variant="primary" loading={pending} disabled={pending || employeeNo.trim() === ""}>{t("Link")}</Button>
                <Button size="sm" disabled={pending} onClick={() => { setLinking(null); setProblem(null); }}>{t("Cancel")}</Button>
              </form>
            ) : <Button size="sm" disabled={pending} onClick={() => { setLinking(r.id); setEmployeeNo(r.employeeNo ?? ""); setProblem(null); }}>{t("Link…")}</Button> },
          ]}
          rows={rows}
        />
      )}
    </section>
  );
}
