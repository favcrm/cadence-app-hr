import { ApiError } from "@cadence/screen-ui";
import { getScope, type Route } from "./scope";
import { serviceCall, type CallArgs } from "./services";
export const currentRoute = (): Route => getScope()?.route ?? { section: "people", view: "list", record_id: null, segment_id: null };
export function patchRoute(patch: CallArgs["screen.route.patch"]): Promise<unknown> {
  const s = getScope();
  if (!s) return Promise.reject(new ApiError("The HR route is unavailable", 403));
  return serviceCall(s.scope, "screen.route.patch", patch);
}
