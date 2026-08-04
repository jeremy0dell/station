// Dismissal policy for the island's attention alert: quiet a session's alert
// once the user acts on it (island click, dashboard open); dismissal resets on
// relaunch.

/**
 * How a dismissed attention episode comes back.
 * `"indefinite"` keeps it quiet for the rest of the Station session (reset on
 * relaunch); `"timeout"` re-alerts `timeoutMs` after dismissal. Station ships
 * in indefinite mode; flipping the constant enables the timeout branch.
 */
export type AttentionDismissalMode =
  | { kind: "indefinite" }
  | { kind: "timeout"; timeoutMs: number };

export const ATTENTION_DISMISSAL_MODE: AttentionDismissalMode = { kind: "indefinite" };

/** A worktree can host several canonical sessions, so prefer the session id. */
export function attentionKey(sessionId: string | undefined, worktreeId: string): string {
  return sessionId ?? worktreeId;
}

export function isAttentionDismissed(
  dismissed: Readonly<Record<string, number>>,
  key: string,
  now: number,
  mode: AttentionDismissalMode = ATTENTION_DISMISSAL_MODE,
): boolean {
  const dismissedAt = dismissed[key];
  if (dismissedAt === undefined) {
    return false;
  }
  if (mode.kind === "indefinite") {
    return true;
  }
  return now - dismissedAt < mode.timeoutMs;
}
