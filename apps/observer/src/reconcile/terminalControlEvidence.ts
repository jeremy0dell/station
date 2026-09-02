import type { TerminalTargetObservation } from "@station/contracts";

type TerminalControlCapabilities = {
  /** Whether the provider can service `terminal.focus` for one of its targets. */
  canFocusTarget?: boolean;
  canCloseTarget?: boolean;
};

export type EffectiveTerminalControlEvidence = {
  /** Effective external provider-focus evidence; renderer-local opening routes are separate. */
  externallyFocusable?: boolean;
  closeable?: boolean;
};

/**
 * POLICY
 *
 * Projects target-specific and provider-wide external focus and close controls with the same
 * optional semantics for canonical attachments and diagnostic target evidence.
 */
export function terminalControlEvidence(
  target: Pick<TerminalTargetObservation, "state" | "externallyFocusable" | "closeable">,
  capabilities?: TerminalControlCapabilities,
): EffectiveTerminalControlEvidence {
  const evidence: EffectiveTerminalControlEvidence = {};
  const externallyFocusable =
    target.externallyFocusable ??
    (capabilities?.canFocusTarget !== false && isExternallyFocusableTerminalState(target.state));
  if (externallyFocusable) {
    evidence.externallyFocusable = true;
  } else if (target.externallyFocusable === false || capabilities?.canFocusTarget === false) {
    evidence.externallyFocusable = false;
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

function isExternallyFocusableTerminalState(state: TerminalTargetObservation["state"]): boolean {
  return state === "open" || state === "detached" || state === "unknown";
}

function isCloseableTerminalState(state: TerminalTargetObservation["state"]): boolean {
  return state === "open" || state === "detached" || state === "unknown" || state === "stale";
}
