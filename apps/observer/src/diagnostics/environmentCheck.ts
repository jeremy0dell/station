import type {
  DoctorCheck,
  OrphanedRuntimeState,
  SessionView,
  StationSnapshot,
} from "@station/contracts";

/**
 * Readable `stn doctor` summary of session terminal topology. Detached/stale
 * sessions or orphans warn; full per-session detail remains in the JSON snapshot.
 */
export function buildSessionEnvironmentCheck(
  snapshot: Pick<StationSnapshot, "sessions" | "orphans">,
): DoctorCheck {
  const sessions = snapshot.sessions;
  const orphans = snapshot.orphans ?? [];
  const detached = sessions.filter(isDetachedOrStale);

  const parts = [`${sessions.length} session(s)${summarizeProviders(sessions)}.`];
  if (detached.length > 0) {
    parts.push(
      `${detached.length} detached/stale (running, not attachable here): ${describeSessions(detached)}.`,
    );
  }
  if (orphans.length > 0) {
    parts.push(`${orphans.length} orphaned runtime state(s)${summarizeOrphans(orphans)}.`);
  }

  const status: DoctorCheck["status"] = detached.length > 0 || orphans.length > 0 ? "warn" : "ok";
  return { name: "sessions", status, message: parts.join(" ") };
}

function isDetachedOrStale(session: SessionView): boolean {
  return session.terminal?.state === "detached" || session.terminal?.state === "stale";
}

/** ` — station: 4 open · tmux: 3 detached` (empty for zero sessions). */
function summarizeProviders(sessions: readonly SessionView[]): string {
  if (sessions.length === 0) {
    return "";
  }
  const byProvider = new Map<string, Map<string, number>>();
  let withoutTerminal = 0;
  for (const session of sessions) {
    if (session.terminal === undefined) {
      withoutTerminal += 1;
      continue;
    }
    const states = byProvider.get(session.terminal.provider) ?? new Map<string, number>();
    states.set(session.terminal.state, (states.get(session.terminal.state) ?? 0) + 1);
    byProvider.set(session.terminal.provider, states);
  }
  const segments = sortedEntries(byProvider).map(
    ([provider, states]) => `${provider}: ${countText(states)}`,
  );
  if (withoutTerminal > 0) {
    segments.push(`no terminal: ${withoutTerminal}`);
  }
  return ` — ${segments.join(" · ")}`;
}

const MAX_LISTED = 4;

/** `foo [tmux], bar [tmux], +2 more` */
function describeSessions(sessions: readonly SessionView[]): string {
  const shown = sessions
    .slice(0, MAX_LISTED)
    .map((session) => `${session.title} [${session.terminal?.provider ?? "no terminal"}]`);
  const remainder = sessions.length - shown.length;
  return remainder > 0 ? `${shown.join(", ")}, +${remainder} more` : shown.join(", ");
}

/** ` (2 terminal_target, 1 session)` */
function summarizeOrphans(orphans: readonly OrphanedRuntimeState[]): string {
  const counts = new Map<string, number>();
  for (const orphan of orphans) {
    counts.set(orphan.kind, (counts.get(orphan.kind) ?? 0) + 1);
  }
  return ` (${countText(counts)})`;
}

/** `4 open, 1 detached` from a state→count map, ordered for a stable message. */
function countText(counts: Map<string, number>): string {
  return sortedEntries(counts)
    .map(([label, n]) => `${n} ${label}`)
    .join(", ");
}

function sortedEntries<V>(map: Map<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}
