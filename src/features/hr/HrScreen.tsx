import { Button, ErrorNotice, Loading, Notice } from "@cadence/screen-ui";
import { useEffect, useRef, useState } from "react";
import { patchRoute } from "../../bridge/route";
import { scopeError, useScope } from "../../bridge/scope";
import { SECTIONS, type Section } from "../../bridge/services";
import EmployeeDrawer from "./EmployeeDrawer";
import EmployeeNew from "./EmployeeNew";
import "./hr-layout.css";
import "./hr-drawer.css";
import { HrLocaleProvider, useLocale } from "./locale";
import PeopleList from "./PeopleList";
import { ClaimsTab, LeaveTab, PoliciesTab, RecruitingTab } from "./Sections";

// Waiting longer than this for the first verified host push means the host is
// unreachable; the screen says so instead of spinning forever.
const HOST_PUSH_TIMEOUT_MS = 15000;
const TAB_LABEL: Record<Section, string> = { people: "People", policies: "Policies", leave: "Leave", claims: "Claims", recruiting: "Recruiting" };

export default function HrScreen() {
  const snapshot = useScope();
  // Keep the last language through a lost connection, so the notice reads in the owner's language.
  const last = useRef<"en" | "zh-TW">("en");
  if (snapshot) last.current = snapshot.presentationLocale;
  const locale = last.current;
  return <HrLocaleProvider locale={locale}><Body /></HrLocaleProvider>;
}

function Body() {
  const snapshot = useScope();
  const { t } = useLocale();
  const [unreachable, setUnreachable] = useState(false);
  // A closed drawer unmounts at once so its scroll lock and focus trap never outlive the close, even if the host refuses the route patch.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const detail = snapshot?.route.record_id ?? null;
  useEffect(() => { setDismissed(null); }, [detail]);
  useEffect(() => {
    if (snapshot) return;
    const timer = setTimeout(() => setUnreachable(true), HOST_PUSH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [snapshot]);

  if (!snapshot) {
    const reason = scopeError();
    if (reason) return <main className="app-outlet hr"><ErrorNotice>{t("Lost the connection to the workspace. Reload the page to reconnect.")} {reason}</ErrorNotice></main>;
    return <main className="app-outlet hr">{unreachable
      ? <ErrorNotice>{t("The Cadence host is unreachable. Reopen this app once the host is available.")}</ErrorNotice>
      : <Loading>{t("Waiting for the verified HR mount…")}</Loading>}</main>;
  }
  const { scope, route, actions } = snapshot;
  const canList = actions.includes("records.list");
  const canWrite = actions.includes("records.create") && actions.includes("records.update");
  const recordId = detail !== null && detail === dismissed ? null : route.record_id;
  const go = (patch: Parameters<typeof patchRoute>[0]) => { void patchRoute(patch).catch(() => undefined); };
  // A create that landed but could not move the screen on would leave the owner on a filled form, so say so.
  const created = (id: string) => { void patchRoute({ view: "list", record_id: id, segment_id: null }).catch(() => setSavedNotice(true)); };
  const section = route.section;
  const pane = { scope, canWrite, recordId, onSelect: (id: string) => { setDismissed(null); go({ view: "list", record_id: id }); }, onClose: () => { setDismissed(detail); go({ view: "list", record_id: null }); } };
  return (
    <main className="app-outlet hr" key={`${scope.installId}:${snapshot.digest}`}>
      <nav className="hr-tabs hr-actions" aria-label={t("HR sections")}>
        {SECTIONS.map((id) => (
          <Button key={id} size="sm" variant={id === section ? "primary" : "secondary"} aria-pressed={id === section} onClick={() => { if (id !== section) { setSavedNotice(false); go({ section: id, view: "list", record_id: null }); } }}>{t(TAB_LABEL[id])}</Button>
        ))}
      </nav>
      <div className="hr-surface">
        {savedNotice && <Notice className="mb-2" state="saved">{t("The employee was saved, but this screen could not move on. Reload the page to see the list.")}</Notice>}
        {!canList ? <Notice>{t("This workspace does not offer the people directory to this session.")}</Notice>
          : section === "policies" ? <PoliciesTab {...pane} />
          : section === "leave" ? <LeaveTab {...pane} />
          : section === "claims" ? <ClaimsTab {...pane} />
          : section === "recruiting" ? <RecruitingTab {...pane} />
          : route.view === "new"
            ? <EmployeeNew scope={scope} canWrite={canWrite} onCancel={() => go({ view: "list", record_id: null })} onCreated={created} />
            : <PeopleList scope={scope} canWrite={canWrite} onNew={() => go({ view: "new", record_id: null })}
                onSelect={(id) => { setDismissed(null); go({ view: "list", record_id: id }); }} />}
      </div>
      {canList && section === "people" && recordId !== null && (
        <EmployeeDrawer scope={scope} recordId={recordId} canWrite={canWrite} onClose={() => { setDismissed(detail); go({ view: "list", record_id: null }); }} />
      )}
    </main>
  );
}
