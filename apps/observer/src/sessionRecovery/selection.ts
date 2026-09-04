import {
  compareSessionRecoveryHandleRecency,
  type SessionRecoveryHandle,
} from "@station/contracts";

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
      compareSessionRecoveryHandleRecency(candidate.handle, selected.handle) < 0
    ) {
      selected = candidate;
    }
  }
  return selected;
}
