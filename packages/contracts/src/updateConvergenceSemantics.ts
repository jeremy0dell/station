import type { UpdateConvergencePlan } from "./updateConvergence.js";
import {
  type UpdateReapRecoveryPreflight,
  updateTerminalEvidenceSetsMatch,
} from "./updateRecoveryPreflight.js";

export type UpdateConvergenceSemanticIssue = {
  path: Array<string | number>;
  message: string;
};

type HostTerminalRecoveryDecision = Pick<
  UpdateConvergencePlan["components"],
  "host" | "terminals" | "recovery"
>;

/**
 * POLICY
 *
 * Cross-check a serialized convergence plan against the aggregate facts that give it meaning.
 * This is a trust-boundary invariant, not an execution authorizer or digest recomputation.
 */
export function updateConvergenceSemanticIssues(input: {
  preflight: UpdateReapRecoveryPreflight;
  plan: UpdateConvergencePlan;
}): UpdateConvergenceSemanticIssue[] {
  const issues: UpdateConvergenceSemanticIssue[] = [];
  const { plan, preflight } = input;
  const artifactPhase = plan.phases[0];
  if (artifactPhase === undefined) {
    return [{ path: ["plan", "phases"], message: "Convergence plan requires every phase." }];
  }
  const artifactSelected = artifactsMatch(preflight.installed, preflight.target);
  const expectedBuildStatus = artifactSelected ? "known" : "not-yet-provable";
  if (plan.selectedTarget.buildIdentity.status !== expectedBuildStatus) {
    issues.push({
      path: ["plan", "selectedTarget", "buildIdentity", "status"],
      message: "Selected target build knowledge must match the installed artifact.",
    });
  }

  const artifactAction = artifactPhase?.action;
  const artifactPhaseValid = artifactSelected
    ? artifactAction === "no-op" && artifactPhase.reason === "already-selected"
    : (artifactAction === "apply" && artifactPhase.reason === "channel-apply") ||
      (artifactAction === "defer" && artifactPhase.reason === "manager-deferred");
  if (!artifactPhaseValid) {
    issues.push({
      path: ["plan", "phases", 0],
      message: "Artifact phase action and reason must follow installed and selected artifacts.",
    });
  }
  const effectiveArtifactAction =
    !artifactSelected && artifactAction === "defer"
      ? "defer"
      : !artifactSelected && artifactAction === "apply"
        ? "apply"
        : "no-op";

  const hooks = expectedHookDecisions(preflight, effectiveArtifactAction);
  if (!hookDecisionsMatch(plan.components.hooks, hooks)) {
    issues.push({
      path: ["plan", "components", "hooks"],
      message: "Hook decisions must follow every exact provider inspection result.",
    });
  }

  const observer = expectedObserverDecision(preflight);
  if (!decisionMatches(plan.components.observer, observer)) {
    issues.push({
      path: ["plan", "components", "observer"],
      message: "Observer action and reason must follow exact Observer evidence.",
    });
  }

  const hostAlternatives = expectedHostAlternatives(preflight);
  const defaultHostDecision = hostAlternatives[0];
  if (defaultHostDecision === undefined) {
    return [
      ...issues,
      {
        path: ["plan", "components"],
        message: "Convergence evidence must produce one Host decision.",
      },
    ];
  }
  const hostDecision =
    hostAlternatives.find((candidate) => hostDecisionsMatch(plan.components, candidate)) ??
    defaultHostDecision;
  if (!hostAlternatives.some((candidate) => hostDecisionsMatch(plan.components, candidate))) {
    issues.push({
      path: ["plan", "components"],
      message:
        "Host, terminal, recovery, and terminal-count decisions must jointly follow exact inventory evidence.",
    });
  }

  const hasBlockedComponent =
    hooks.some((hook) => hook.action === "blocked") ||
    observer.action === "blocked" ||
    hostDecision.host.action === "blocked" ||
    hostDecision.terminals.action === "blocked";
  const hasRuntimeAction =
    hooks.some((hook) => hook.action === "reconcile") ||
    observer.action === "start" ||
    observer.action === "restart" ||
    hostDecision.host.action === "replace-idle" ||
    hostDecision.host.action === "handoff";
  const reconcile: UpdateConvergencePlan["components"]["reconcile"] = hasBlockedComponent
    ? { action: "blocked", reason: "inspection-failed" }
    : hasRuntimeAction
      ? { action: "run", reason: "runtime-change" }
      : { action: "no-op", reason: "no-runtime-change" };
  if (!decisionMatches(plan.components.reconcile, reconcile)) {
    issues.push({
      path: ["plan", "components", "reconcile"],
      message: "Reconcile action and reason must follow the exact runtime decisions.",
    });
  }

  const status = expectedPlanStatus({
    artifactAction: effectiveArtifactAction,
    hasBlockedComponent,
    hasRuntimeAction,
    host: hostDecision.host,
    terminals: hostDecision.terminals,
  });
  if (plan.status !== status) {
    issues.push({
      path: ["plan", "status"],
      message: "Convergence plan status must follow its evidence-backed component decisions.",
    });
  }
  const verification: UpdateConvergencePlan["components"]["verification"] =
    status === "converged"
      ? { action: "satisfied", reason: "already-converged" }
      : { action: "reinspect", reason: "reinspect-after-actions" };
  if (!decisionMatches(plan.components.verification, verification)) {
    issues.push({
      path: ["plan", "components", "verification"],
      message: "Verification action and reason must follow convergence status.",
    });
  }

  const hookPhase = hooks.some((hook) => hook.action === "blocked")
    ? ({ action: "blocked", reason: "inspection-failed" } as const)
    : hooks.some((hook) => hook.action === "reconcile")
      ? ({ action: "reconcile", reason: "runtime-change" } as const)
      : ({ action: "no-op", reason: "healthy" } as const);
  const expectedPhases = [
    artifactSelected
      ? ({ action: "no-op", reason: "already-selected" } as const)
      : effectiveArtifactAction === "defer"
        ? ({ action: "defer", reason: "manager-deferred" } as const)
        : ({ action: "apply", reason: "channel-apply" } as const),
    hookPhase,
    observer,
    hostDecision.terminals,
    hostDecision.host,
    reconcile,
    verification,
  ];
  plan.phases.forEach((phase, index) => {
    const expected = expectedPhases[index];
    if (
      expected !== undefined &&
      (phase.action !== expected.action || phase.reason !== expected.reason)
    ) {
      issues.push({
        path: ["plan", "phases", index],
        message: "Every convergence phase must exactly mirror its evidence-backed component.",
      });
    }
  });
  return issues;
}

function expectedHookDecisions(
  preflight: UpdateReapRecoveryPreflight,
  artifactAction: "no-op" | "apply" | "defer",
): UpdateConvergencePlan["components"]["hooks"] {
  return preflight.hooks.map((hook) => {
    switch (hook.status) {
      case "configured-disabled":
        return {
          provider: hook.provider,
          action: "no-op" as const,
          reason: "configured-disabled" as const,
        };
      case "unsupported":
        return {
          provider: hook.provider,
          action: "no-op" as const,
          reason: "unsupported" as const,
        };
      case "healthy":
        return artifactAction === "apply"
          ? {
              provider: hook.provider,
              action: "reconcile" as const,
              reason: "target-artifact-may-change" as const,
            }
          : { provider: hook.provider, action: "no-op" as const, reason: "healthy" as const };
      case "needs-repair":
        return { provider: hook.provider, action: "reconcile" as const, reason: hook.reason };
      case "ownership-conflict":
        return {
          provider: hook.provider,
          action: "blocked" as const,
          reason: "ownership-conflict" as const,
        };
      case "inspection-failed":
        return {
          provider: hook.provider,
          action: "blocked" as const,
          reason: "inspection-failed" as const,
        };
    }
    return assertNever(hook);
  });
}

function expectedObserverDecision(
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
  if (observer.relation === "different") {
    switch (observer.replacementAdmission) {
      case "candidate-wins":
        return { action: "restart", reason: "different-build" };
      case "not-yet-provable":
        return { action: "reinspect", reason: "target-artifact-may-change" };
      case "incumbent-wins":
      case "refused":
        return { action: "blocked", reason: "singleton-refused" };
      case "exact-build":
      case "unknown":
        return { action: "blocked", reason: "identity-incomplete" };
    }
  }
  return observer.health === "healthy"
    ? { action: "no-op", reason: "matching-healthy" }
    : { action: "restart", reason: "matching-unhealthy" };
}

function expectedHostAlternatives(
  preflight: UpdateReapRecoveryPreflight,
): HostTerminalRecoveryDecision[] {
  const counts = terminalCounts(preflight);
  const host = preflight.host;
  if (!updateTerminalEvidenceSetsMatch(host, preflight.terminalDispositions)) {
    return [
      {
        host: { action: "blocked", reason: "inventory-incomplete" },
        terminals: { action: "blocked", reason: "inventory-incomplete", ...counts },
        recovery: { relevance: "destructive-follow-up", status: "incomplete" },
      },
    ];
  }
  if (host.status === "absent") {
    return [
      {
        host: { action: "no-op", reason: "absent" },
        terminals: { action: "no-op", reason: "no-terminals", ...counts },
        recovery: { relevance: "not-required", status: "not-required" },
      },
    ];
  }
  if (host.status === "unknown") {
    return [
      {
        host: { action: "blocked", reason: "inventory-incomplete" },
        terminals: { action: "blocked", reason: "inventory-incomplete", ...counts },
        recovery: { relevance: "not-required", status: "not-required" },
      },
    ];
  }
  if (host.relation === "matching-target" && host.compatibility === "reuse") {
    return [
      {
        host: { action: "no-op", reason: "matching-target" },
        terminals: { action: "no-op", reason: "matching-target", ...counts },
        recovery: { relevance: "not-required", status: "not-required" },
      },
    ];
  }
  if (host.relation === "unknown" || host.compatibility === "refuse") {
    const reason = host.compatibility === "refuse" ? "protocol-refused" : "identity-incomplete";
    return [
      {
        host: { action: "blocked", reason },
        terminals: { action: "blocked", reason, ...counts },
        recovery: { relevance: "not-required", status: "not-required" },
      },
    ];
  }
  if (host.terminals.length === 0) {
    return [
      {
        host: { action: "replace-idle", reason: "idle-replacement" },
        terminals: { action: "no-op", reason: "no-terminals", ...counts },
        recovery: { relevance: "not-required", status: "not-required" },
      },
    ];
  }

  const noHandoff: HostTerminalRecoveryDecision = {
    host: { action: "leave-in-place", reason: "handoff-disabled" },
    terminals: { action: "no-op", reason: "handoff-disabled", ...counts },
    recovery: { relevance: "not-required", status: "not-required" },
  };
  if (preflight.terminalDispositions.some((terminal) => terminal.handoff === "unknown")) {
    return [
      noHandoff,
      {
        host: { action: "blocked", reason: "recovery-incomplete" },
        terminals: { action: "blocked", reason: "recovery-incomplete", ...counts },
        recovery: { relevance: "destructive-follow-up", status: "incomplete" },
      },
    ];
  }
  const destructive = preflight.terminalDispositions.filter(
    (terminal) => terminal.handoff === "non-preservable",
  );
  if (destructive.length === 0) {
    const handoffAlternatives = (["processes", "screen"] as const).map(
      (fidelity): HostTerminalRecoveryDecision => ({
        host: { action: "handoff", reason: "busy-handoff", fidelity },
        terminals: {
          action: "preserve-via-handoff",
          reason: "all-bridge-releasable",
          fidelity,
          ...counts,
        },
        recovery: { relevance: "not-required", status: "not-required" },
      }),
    );
    return [noHandoff, ...handoffAlternatives];
  }
  if (destructive.some((terminal) => terminal.reapRecovery === "unknown")) {
    return [
      noHandoff,
      {
        host: { action: "blocked", reason: "recovery-incomplete" },
        terminals: { action: "blocked", reason: "recovery-incomplete", ...counts },
        recovery: { relevance: "destructive-follow-up", status: "incomplete" },
      },
    ];
  }
  return [
    noHandoff,
    {
      host: { action: "await-reap", reason: "non-releasable" },
      terminals: { action: "reap-required", reason: "non-releasable", ...counts },
      recovery: { relevance: "destructive-follow-up", status: "complete" },
    },
  ];
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

function expectedPlanStatus(input: {
  artifactAction: "no-op" | "apply" | "defer";
  hasBlockedComponent: boolean;
  hasRuntimeAction: boolean;
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

function hostDecisionsMatch(
  actual: UpdateConvergencePlan["components"],
  expected: HostTerminalRecoveryDecision,
): boolean {
  return (
    decisionMatches(actual.host, expected.host) &&
    decisionMatches(actual.terminals, expected.terminals) &&
    actual.terminals.liveCount === expected.terminals.liveCount &&
    actual.terminals.recoverableCount === expected.terminals.recoverableCount &&
    actual.terminals.nonResumableCount === expected.terminals.nonResumableCount &&
    actual.terminals.unknownRecoveryCount === expected.terminals.unknownRecoveryCount &&
    actual.recovery.relevance === expected.recovery.relevance &&
    actual.recovery.status === expected.recovery.status
  );
}

function hookDecisionsMatch(
  actual: UpdateConvergencePlan["components"]["hooks"],
  expected: UpdateConvergencePlan["components"]["hooks"],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((hook, index) => {
      const expectedHook = expected[index];
      return (
        expectedHook !== undefined &&
        hook.provider === expectedHook.provider &&
        hook.action === expectedHook.action &&
        hook.reason === expectedHook.reason
      );
    })
  );
}

function decisionMatches(
  actual: { action: string; reason: string; fidelity?: "processes" | "screen" | undefined },
  expected: { action: string; reason: string; fidelity?: "processes" | "screen" | undefined },
): boolean {
  return (
    actual.action === expected.action &&
    actual.reason === expected.reason &&
    actual.fidelity === expected.fidelity
  );
}

function artifactsMatch(
  left: { version: string; revision?: string },
  right: { version: string; revision?: string },
): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected update convergence evidence: ${String(value)}`);
}
