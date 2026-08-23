import {
  compareCodeUnitStrings,
  type UpdateConvergencePlan,
  type UpdateReapRecoveryPreflight,
  type UpdateSelectedTarget,
  updateTerminalEvidenceSetsMatch,
} from "@station/contracts";

export type UpdateArtifactPlanAction = "no-op" | "apply" | "defer";

export type UpdateConvergencePlanInput = {
  selectedTarget: UpdateSelectedTarget;
  artifactAction: UpdateArtifactPlanAction;
  handoffFidelity?: "processes" | "screen";
  preflight: UpdateReapRecoveryPreflight;
};

export type UpdateConvergencePlanDraft = Omit<UpdateConvergencePlan, "digest">;

/**
 * POLICY
 *
 * Converts one #665 aggregate inspection into a deterministic, provider-neutral convergence plan.
 * Evidence is admitted per component and action: facts irrelevant to a safe action do not block it.
 */
export function planUpdateConvergence(
  input: UpdateConvergencePlanInput,
): UpdateConvergencePlanDraft {
  const hooks = input.preflight.hooks
    .map((hook): UpdateConvergencePlan["components"]["hooks"][number] => {
      switch (hook.status) {
        case "configured-disabled":
          return { provider: hook.provider, action: "no-op", reason: "configured-disabled" };
        case "unsupported":
          return { provider: hook.provider, action: "no-op", reason: "unsupported" };
        case "healthy":
          return input.artifactAction === "apply"
            ? {
                provider: hook.provider,
                action: "reconcile",
                reason: "target-artifact-may-change",
              }
            : { provider: hook.provider, action: "no-op", reason: "healthy" };
        case "needs-repair":
          return { provider: hook.provider, action: "reconcile", reason: hook.reason };
        case "ownership-conflict":
          return {
            provider: hook.provider,
            action: "blocked",
            reason: "ownership-conflict",
          };
        case "inspection-failed":
          return { provider: hook.provider, action: "blocked", reason: "inspection-failed" };
      }
      return assertNever(hook);
    })
    .sort((left, right) => compareCodeUnitStrings(left.provider, right.provider));

  const observer = observerDecision(input.preflight);
  const { host, terminals, recovery } = hostAndTerminalDecisions(input);
  const hasBlockedComponent =
    hooks.some((hook) => hook.action === "blocked") ||
    observer.action === "blocked" ||
    host.action === "blocked" ||
    terminals.action === "blocked";
  const hasRuntimeAction =
    hooks.some((hook) => hook.action === "reconcile") ||
    observer.action === "start" ||
    observer.action === "restart" ||
    host.action === "replace-idle" ||
    host.action === "handoff";
  const reconcile: UpdateConvergencePlan["components"]["reconcile"] = hasBlockedComponent
    ? { action: "blocked", reason: "inspection-failed" }
    : hasRuntimeAction
      ? { action: "run", reason: "runtime-change" }
      : { action: "no-op", reason: "no-runtime-change" };

  const status = planStatus({
    artifactAction: input.artifactAction,
    hasBlockedComponent,
    hasRuntimeAction,
    hooks,
    observer,
    host,
    terminals,
  });
  const verification: UpdateConvergencePlan["components"]["verification"] =
    status === "converged"
      ? { action: "satisfied", reason: "already-converged" }
      : { action: "reinspect", reason: "reinspect-after-actions" };

  return {
    schemaVersion: 1,
    selectedTarget: input.selectedTarget,
    status,
    components: { hooks, observer, terminals, host, recovery, reconcile, verification },
    phases: [
      {
        id: "artifact-application",
        action:
          input.artifactAction === "apply"
            ? "apply"
            : input.artifactAction === "defer"
              ? "defer"
              : "no-op",
        reason:
          input.artifactAction === "apply"
            ? "channel-apply"
            : input.artifactAction === "defer"
              ? "manager-deferred"
              : "already-selected",
      },
      phaseForHooks(hooks),
      { id: "observer-convergence", action: observer.action, reason: observer.reason },
      { id: "terminal-convergence", action: terminals.action, reason: terminals.reason },
      { id: "host-convergence", action: host.action, reason: host.reason },
      { id: "runtime-reconcile", action: reconcile.action, reason: reconcile.reason },
      { id: "verification", action: verification.action, reason: verification.reason },
    ],
  };
}

function observerDecision(
  preflight: UpdateReapRecoveryPreflight,
): UpdateConvergencePlan["components"]["observer"] {
  const observer = preflight.observer;
  if (observer.status === "absent") return { action: "start", reason: "absent" };
  if (observer.status === "unknown") {
    return observer.reason === "restartable-executable-drift"
      ? { action: "restart", reason: "restartable-executable-drift" }
      : { action: "blocked", reason: "identity-incomplete" };
  }
  if (observer.relation === "unknown") {
    return { action: "blocked", reason: "identity-incomplete" };
  }
  if (observer.relation === "different") return { action: "restart", reason: "different-build" };
  return observer.health === "healthy"
    ? { action: "no-op", reason: "matching-healthy" }
    : { action: "restart", reason: "matching-unhealthy" };
}

function hostAndTerminalDecisions(
  input: UpdateConvergencePlanInput,
): Pick<UpdateConvergencePlan["components"], "host" | "terminals" | "recovery"> {
  const hostEvidence = input.preflight.host;
  const counts = terminalCounts(input.preflight);
  const baseTerminals = { ...counts };
  if (!updateTerminalEvidenceSetsMatch(hostEvidence, input.preflight.terminalDispositions)) {
    return {
      host: { action: "blocked", reason: "inventory-incomplete" },
      terminals: { action: "blocked", reason: "inventory-incomplete", ...baseTerminals },
      recovery: { relevance: "destructive-follow-up", status: "incomplete" },
    };
  }
  if (hostEvidence.status === "absent") {
    return {
      host: { action: "no-op", reason: "absent" },
      terminals: { action: "no-op", reason: "no-terminals", ...baseTerminals },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  if (hostEvidence.status === "unknown") {
    return {
      host: { action: "blocked", reason: "inventory-incomplete" },
      terminals: { action: "blocked", reason: "inventory-incomplete", ...baseTerminals },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  if (hostEvidence.relation === "matching-target" && hostEvidence.compatibility === "reuse") {
    return {
      host: { action: "no-op", reason: "matching-target" },
      terminals: { action: "no-op", reason: "matching-target", ...baseTerminals },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  if (hostEvidence.relation === "unknown" || hostEvidence.compatibility === "refuse") {
    return {
      host: {
        action: "blocked",
        reason:
          hostEvidence.compatibility === "refuse" ? "protocol-refused" : "identity-incomplete",
      },
      terminals: {
        action: "blocked",
        reason:
          hostEvidence.compatibility === "refuse" ? "protocol-refused" : "identity-incomplete",
        ...baseTerminals,
      },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  if (hostEvidence.terminals.length === 0) {
    return {
      host: { action: "replace-idle", reason: "idle-replacement" },
      terminals: { action: "no-op", reason: "no-terminals", ...baseTerminals },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  if (input.handoffFidelity === undefined) {
    return {
      host: { action: "leave-in-place", reason: "handoff-disabled" },
      terminals: { action: "no-op", reason: "handoff-disabled", ...baseTerminals },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  if (input.preflight.terminalDispositions.some((terminal) => terminal.handoff === "unknown")) {
    return {
      host: { action: "blocked", reason: "recovery-incomplete" },
      terminals: { action: "blocked", reason: "recovery-incomplete", ...baseTerminals },
      recovery: { relevance: "destructive-follow-up", status: "incomplete" },
    };
  }
  const destructiveDispositions = input.preflight.terminalDispositions.filter(
    (terminal) => terminal.handoff === "non-preservable",
  );
  if (destructiveDispositions.length === 0) {
    return {
      host: { action: "handoff", reason: "busy-handoff" },
      terminals: {
        action: "preserve-via-handoff",
        reason: "all-bridge-releasable",
        ...baseTerminals,
      },
      recovery: { relevance: "not-required", status: "not-required" },
    };
  }
  const consequencesComplete = destructiveDispositions.every(
    (terminal) => terminal.reapRecovery !== "unknown",
  );
  if (!consequencesComplete) {
    return {
      host: { action: "blocked", reason: "recovery-incomplete" },
      terminals: { action: "blocked", reason: "recovery-incomplete", ...baseTerminals },
      recovery: { relevance: "destructive-follow-up", status: "incomplete" },
    };
  }
  return {
    host: { action: "await-reap", reason: "non-releasable" },
    terminals: { action: "reap-required", reason: "non-releasable", ...baseTerminals },
    recovery: { relevance: "destructive-follow-up", status: "complete" },
  };
}

function terminalCounts(preflight: UpdateReapRecoveryPreflight) {
  return {
    liveCount: preflight.host.status === "inspected" ? preflight.host.terminals.length : 0,
    recoverableCount: preflight.terminalDispositions.filter(
      (terminal) => terminal.reapRecovery === "recoverable",
    ).length,
    nonResumableCount: preflight.terminalDispositions.filter(
      (terminal) => terminal.reapRecovery === "non-resumable",
    ).length,
    unknownRecoveryCount: preflight.terminalDispositions.filter(
      (terminal) => terminal.reapRecovery === "unknown",
    ).length,
  };
}

function planStatus(input: {
  artifactAction: UpdateArtifactPlanAction;
  hasBlockedComponent: boolean;
  hasRuntimeAction: boolean;
  hooks: UpdateConvergencePlan["components"]["hooks"];
  observer: UpdateConvergencePlan["components"]["observer"];
  host: UpdateConvergencePlan["components"]["host"];
  terminals: UpdateConvergencePlan["components"]["terminals"];
}): UpdateConvergencePlan["status"] {
  if (input.artifactAction === "defer") return "deferred";
  if (input.hasBlockedComponent) return "blocked";
  if (input.terminals.action === "reap-required") return "reap-required";
  if (input.host.action === "leave-in-place") return "intentionally-incomplete";
  if (input.artifactAction === "apply" || input.hasRuntimeAction) return "actionable";
  return "converged";
}

function phaseForHooks(
  hooks: UpdateConvergencePlan["components"]["hooks"],
): UpdateConvergencePlan["phases"][number] {
  if (hooks.some((hook) => hook.action === "blocked")) {
    return { id: "hook-reconciliation", action: "blocked", reason: "inspection-failed" };
  }
  if (hooks.some((hook) => hook.action === "reconcile")) {
    return { id: "hook-reconciliation", action: "reconcile", reason: "runtime-change" };
  }
  return { id: "hook-reconciliation", action: "no-op", reason: "healthy" };
}

function assertNever(value: never): never {
  throw new Error(`Unexpected convergence evidence: ${String(value)}`);
}
