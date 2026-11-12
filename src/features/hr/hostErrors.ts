import { ApiError } from "@cadence/screen-ui";

/** A hosted session that expired answers with a redirect `fetch` cannot follow; it reads as a transport failure. */
export const SESSION_EXPIRED_TEXT = "Your session expired or the connection dropped — reload the page to sign in again.";

/**
 * A 403 has several causes the frame cannot tell apart: the screen's access was withdrawn, the operation is not
 * declared, or the records are owner-only and this member is not the owner. The board closes the frame on the
 * first 403 anyway, so the text names every cause and the one way out.
 */
export const FORBIDDEN_TEXT = "This app's access is no longer available here, or these records are for the workspace owner. Reload the page.";

export function hostErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_TEXT;
    if (error.status === 403) return FORBIDDEN_TEXT;
    return error.message === "" || error.message.startsWith("[object ") ? fallback : error.message;
  }
  if (error instanceof TypeError) return SESSION_EXPIRED_TEXT;
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return fallback;
}
