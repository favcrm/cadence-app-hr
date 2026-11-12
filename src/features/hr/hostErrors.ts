import { ApiError } from "@cadence/screen-ui";

/** A hosted session that expired answers with a redirect `fetch` cannot follow; it reads as a transport failure. */
export const SESSION_EXPIRED_TEXT = "Your session expired or the connection dropped — reload the page to sign in again.";

export const FORBIDDEN_TEXT = "This session cannot read these records. They are for the workspace owner.";

export function hostErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_TEXT;
    // The board names a refusal by status only; a 403 also answers a reader who is not the owner.
    if (error.status === 403) return FORBIDDEN_TEXT;
    return error.message === "" || error.message.startsWith("[object ") ? fallback : error.message;
  }
  if (error instanceof TypeError) return SESSION_EXPIRED_TEXT;
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return fallback;
}
