import type { TerminalTargetObservation } from "@station/contracts";

type TerminalControlCapabilities = {
  canFocusTarget?: boolean;
  canCloseTarget?: boolean;
};

export type EffectiveTerminalControlEvidence = {
  focusable?: boolean;
  closeable?: boolean;
};

/**
 * POLICY
 *
 * Projects target-specific and provider-wide terminal controls with the same optional semantics
 * for canonical attachments and diagnostic target evidence.
 */
export function terminalControlEvidence(
  target: Pick<TerminalTargetObservation, "state" | "focusable" | "closeable">,
  capabilities?: TerminalControlCapabilities,
): EffectiveTerminalControlEvidence {
  const evidence: EffectiveTerminalControlEvidence = {};
  const focusable =
    target.focusable ??
    (capabilities?.canFocusTarget !== false && isFocusableTerminalState(target.state));
  if (focusable) {
    evidence.focusable = true;
  } else if (target.focusable === false || capabilities?.canFocusTarget === false) {
    evidence.focusable = false;
  }

  const closeable =
    target.closeable ??
    (capabilities?.canCloseTarget !== false && isCloseableTerminalState(target.state));
  if (closeable) {
    evidence.closeable = true;
  } else if (target.closeable === false || capabilities?.canCloseTarget === false) {
    evidence.closeable = false;
  }
  return evidence;
}

function isFocusableTerminalState(state: TerminalTargetObservation["state"]): boolean {
  return state === "open" || state === "detached" || state === "unknown";
}

function isCloseableTerminalState(state: TerminalTargetObservation["state"]): boolean {
  return state === "open" || state === "detached" || state === "unknown" || state === "stale";
}
