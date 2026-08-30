import type { SessionRecoveryHandle } from "@station/contracts";

type SessionRecoveryCandidate = {
  handle: SessionRecoveryHandle;
};

/**
 * POLICY
 *
 * Selects the newest already-eligible recovery candidate by last activity, observation recency,
 * then opaque Station handle identity so automatic recovery is stable across input order and
 * restart without exposing provider-native targets.
 */
export function selectNewestSessionRecoveryCandidate<TCandidate extends SessionRecoveryCandidate>(
  candidates: readonly TCandidate[],
): TCandidate | undefined {
  let selected: TCandidate | undefined;
  for (const candidate of candidates) {
    if (
      selected === undefined ||
      compareSessionRecoveryHandles(candidate.handle, selected.handle) < 0
    ) {
      selected = candidate;
    }
  }
  return selected;
}

function compareSessionRecoveryHandles(
  left: SessionRecoveryHandle,
  right: SessionRecoveryHandle,
): number {
  return (
    Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
    compareHandleIds(left.id, right.id)
  );
}

function compareHandleIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
