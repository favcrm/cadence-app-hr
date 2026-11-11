import { ErrorNotice, Loading, Notice } from "@cadence/screen-ui";
import { useEffect, useState } from "react";
import { patchRoute } from "../../bridge/route";
import { scopeError, useScope } from "../../bridge/scope";
import EmployeeDrawer from "./EmployeeDrawer";
import EmployeeNew from "./EmployeeNew";
import "./hr-layout.css";
import "./hr-drawer.css";
import { HrLocaleProvider, useLocale } from "./locale";
import PeopleList from "./PeopleList";

// Waiting longer than this for the first verified host push means the host is
// unreachable; the screen says so instead of spinning forever.
const HOST_PUSH_TIMEOUT_MS = 15000;

export default function HrScreen() {
  const snapshot = useScope();
  const locale = snapshot?.presentationLocale ?? "en";
  return <HrLocaleProvider locale={locale}><Body /></HrLocaleProvider>;
}

function Body() {
  const snapshot = useScope();
  const { t } = useLocale();
  const [unreachable, setUnreachable] = useState(false);
  // A closed drawer unmounts at once so its scroll lock and focus trap never outlive the close, even if the host refuses the route patch.
  const [dismissed, setDismissed] = useState<string | null>(null);
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
  return (
    <main className="app-outlet hr" key={`${scope.installId}:${snapshot.digest}`}>
      <div className="hr-surface">
        {!canList ? <Notice>{t("This workspace does not offer the people directory to this session.")}</Notice>
          : route.view === "new"
            ? <EmployeeNew scope={scope} canWrite={canWrite} onCancel={() => go({ view: "list", record_id: null })} onCreated={(id) => go({ view: "list", record_id: id, segment_id: null })} />
            : <PeopleList scope={scope} canWrite={canWrite} onNew={() => go({ view: "new", record_id: null })}
                onSelect={(id) => { setDismissed(null); go({ view: "list", record_id: id }); }} />}
      </div>
      {canList && recordId !== null && (
        <EmployeeDrawer scope={scope} recordId={recordId} canWrite={canWrite} onClose={() => { setDismissed(detail); go({ view: "list", record_id: null }); }} />
      )}
    </main>
  );
}
