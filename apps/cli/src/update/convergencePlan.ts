import type {
  UpdateConvergencePlan,
  UpdateConvergencePlanningInput,
  UpdateConvergenceTerminalFact,
  UpdateReapTerminalDisposition,
} from "@station/contracts";
import { compareStationHostTerminalLifetimeIdentity } from "@station/contracts";
import { classifyObserverBuildPrecedence } from "@station/observer/internal";
import { parseStationObserverBuildVersion } from "@station/runtime";
import { deriveUpdateRecoveryTerminalDispositions } from "./recoveryTerminalDispositions.js";

type Phases = UpdateConvergencePlan["phases"];
type HostPhases = Pick<Phases, "terminalConvergence" | "hostConvergence">;
type PhaseWithAction<Phase, Action> = Extract<Phase, { action: Action }>;
type TerminalPhaseWithoutFacts = Phases["terminalConvergence"] extends infer Phase
  ? Phase extends unknown
    ? Omit<Phase, "terminals">
    : never
  : never;

/**
 * POLICY
 *
 * Derives one deterministic, provider-neutral live-convergence plan from #639's aggregate and
 * resolved intent. The result describes work only; it grants no process, lifecycle, or reap
 * authority, and Observer ordering delegates to the build-only singleton precedence policy.
 */
export function deriveUpdateConvergencePlan(
  input: UpdateConvergencePlanningInput,
): UpdateConvergencePlan {
  const artifactApplication = artifactDecision(input);
  const hookReconciliation = hookDecision(input, artifactApplication.action !== "no-op");
  const runtimeValid = selectedRuntimeIsValid(input);
  const observerConvergence = observerDecision(input, runtimeValid);
  const terminalDispositions = deriveUpdateRecoveryTerminalDispositions(input.preflight);
  const hostPhases = hostDecision(
    input,
    runtimeValid,
    terminalDispositions,
    terminalDispositionsMatch(input.preflight.terminalDispositions, terminalDispositions),
  );
  const outcome = planOutcome({
    artifactApplication,
    hookReconciliation,
    observerConvergence,
    ...hostPhases,
  });
  const finalPhases = finalDecisions(outcome, input.targetRuntime.status);
  return {
    authorization: "none",
    selectedTarget: {
      // The aggregate owns the only selected artifact; planning never accepts a parallel copy.
      artifact: input.preflight.target,
      runtimeBuild: input.targetRuntime,
    },
    outcome,
    phases: {
      artifactApplication,
      hookReconciliation,
      observerConvergence,
      ...hostPhases,
      ...finalPhases,
    },
  };
}

function artifactDecision(input: UpdateConvergencePlanningInput): Phases["artifactApplication"] {
  const base = { before: input.preflight.installed, owner: input.installation.owner };
  if (artifactsMatch(input.preflight.installed, input.preflight.target)) {
    return {
      ...base,
      action: "no-op",
      reason: "selected-artifact-current",
      command: input.installation.command,
    };
  }
  return input.installation.whenRequired === "defer"
    ? {
        ...base,
        action: "defer",
        reason: "package-manager-deferred",
        command: input.installation.command,
      }
    : {
        ...base,
        action: "apply",
        reason: "selected-artifact-different",
        command: input.installation.command,
      };
}

function hookDecision(
  input: UpdateConvergencePlanningInput,
  artifactChanges: boolean,
): Phases["hookReconciliation"] {
  const providers: Phases["hookReconciliation"]["providers"] = input.preflight.hooks.map((hook) => {
    switch (hook.status) {
      case "configured-disabled":
        return { provider: hook.provider, action: "no-op", reason: "configured-disabled" };
      case "unsupported":
        return { provider: hook.provider, action: "no-op", reason: "unsupported" };
      case "healthy":
        return artifactChanges
          ? { provider: hook.provider, action: "reconcile", reason: "selected-artifact-change" }
          : { provider: hook.provider, action: "no-op", reason: "healthy" };
      case "needs-repair":
        return { provider: hook.provider, action: "reconcile", reason: hook.reason };
      case "ownership-conflict":
        return { provider: hook.provider, action: "blocked", reason: "ownership-conflict" };
      case "inspection-failed":
        return { provider: hook.provider, action: "blocked", reason: "inspection-failed" };
      default:
        throw new Error("Parsed update preflight contained an unsupported hook status.");
    }
  });
  if (providers.some(({ action }) => action === "blocked")) {
    return { action: "blocked", reason: "hook-evidence-blocked", providers };
  }
  return providers.some(({ action }) => action === "reconcile")
    ? { action: "reconcile", reason: "runtime-change", providers }
    : { action: "no-op", reason: "healthy", providers };
}

function selectedRuntimeIsValid(input: UpdateConvergencePlanningInput): boolean {
  if (input.targetRuntime.status === "not-yet-provable") return true;
  const parsed = parseStationObserverBuildVersion(input.targetRuntime.observerSelector);
  const self = classifyObserverBuildPrecedence({
    candidateSelector: input.targetRuntime.observerSelector,
    incumbentSelector: input.targetRuntime.observerSelector,
  });
  return (
    parsed.version === input.preflight.target.version &&
    parsed.buildIdentity === input.targetRuntime.buildIdentity &&
    self.outcome === "exact-build"
  );
}

function observerDecision(
  input: UpdateConvergencePlanningInput,
  runtimeValid: boolean,
): Phases["observerConvergence"] {
  if (!runtimeValid) return { action: "blocked", reason: "selected-target-identity-invalid" };
  const observer = input.preflight.observer;
  if (observer.status === "unknown") {
    return { action: "blocked", reason: "evidence-unknown" };
  }
  if (input.targetRuntime.status === "not-yet-provable") {
    return { action: "reinspect", reason: "target-build-not-yet-provable" };
  }
  if (observer.status === "absent") return { action: "start", reason: "absent" };
  if (observer.relation === "unknown") {
    return { action: "blocked", reason: "evidence-unknown" };
  }
  const precedence = classifyObserverBuildPrecedence({
    candidateSelector: input.targetRuntime.observerSelector,
    incumbentSelector: observer.buildVersion,
  });
  if (precedence.outcome === "exact-build") {
    if (
      observer.relation !== "matching-target" ||
      observer.buildVersion !== input.targetRuntime.observerSelector
    ) {
      return { action: "blocked", reason: "evidence-contradictory" };
    }
    return observer.health === "healthy"
      ? { action: "no-op", reason: "matching-healthy", precedence: "exact-build" }
      : { action: "restart", reason: "matching-unhealthy", precedence: "exact-build" };
  }
  if (observer.relation !== "different")
    return { action: "blocked", reason: "evidence-contradictory" };
  return precedence.outcome === "candidate-precedes"
    ? { action: "restart", reason: "target-precedes", precedence: "candidate-precedes" }
    : { action: "blocked", reason: "singleton-refused", precedence: precedence.outcome };
}

function hostDecision(
  input: UpdateConvergencePlanningInput,
  runtimeValid: boolean,
  terminalDispositions: UpdateReapTerminalDisposition[],
  terminalDispositionsAreCanonical: boolean,
): HostPhases {
  const host = input.preflight.host;
  const terminals = terminalFacts(input, terminalDispositions);
  const pair = (
    terminal: TerminalPhaseWithoutFacts,
    hostDecision: Phases["hostConvergence"],
  ): HostPhases => ({
    terminalConvergence: { ...terminal, terminals },
    hostConvergence: hostDecision,
  });
  const blocked = (
    hostReason: PhaseWithAction<Phases["hostConvergence"], "blocked">["reason"],
    terminalReason: PhaseWithAction<Phases["terminalConvergence"], "blocked">["reason"],
  ): HostPhases =>
    pair({ action: "blocked", reason: terminalReason }, { action: "blocked", reason: hostReason });
  if (!runtimeValid) return blocked("evidence-contradictory", "evidence-contradictory");
  if (host.status === "absent")
    return pair({ action: "no-op", reason: "no-terminals" }, { action: "no-op", reason: "absent" });
  if (!terminalDispositionsAreCanonical) {
    return blocked("evidence-contradictory", "evidence-contradictory");
  }
  if (host.status === "inspected" && host.terminals.some((terminal) => !terminal.alive)) {
    return blocked("evidence-contradictory", "evidence-contradictory");
  }
  if (host.status === "inspected" && hostEvidenceContradictsTarget(input, host)) {
    return blocked("evidence-contradictory", "evidence-contradictory");
  }
  if (
    host.status === "inspected" &&
    input.targetRuntime.status === "known" &&
    host.relation === "matching-target" &&
    host.compatibility === "reuse"
  ) {
    return pair(
      { action: "no-op", reason: "matching-host" },
      { action: "no-op", reason: "matching-target" },
    );
  }
  if (input.handoff.action === "leave-in-place") {
    return pair(
      { action: "leave-in-place", reason: "handoff-disabled" },
      { action: "leave-in-place", reason: "handoff-disabled" },
    );
  }
  if (host.status === "unknown") return blocked("inventory-incomplete", "inventory-incomplete");
  if (input.targetRuntime.status === "not-yet-provable") {
    if (host.relation !== "different" || host.buildVersion === input.preflight.target.version) {
      return pair(
        { action: "reinspect", reason: "target-build-not-yet-provable" },
        { action: "reinspect", reason: "target-build-not-yet-provable" },
      );
    }
    if (terminals.some(({ handoff }) => handoff === "unknown")) {
      return blocked("inventory-incomplete", "handoff-support-unknown");
    }
    const nonPreservable = terminals.filter(({ handoff }) => handoff === "non-preservable");
    if (nonPreservable.some(({ reapRecovery }) => reapRecovery === "unknown")) {
      return blocked("recovery-incomplete", "recovery-incomplete");
    }
    if (nonPreservable.length > 0) {
      return pair(
        { action: "reap-required", reason: "non-preservable-terminals" },
        { action: "await-reap", reason: "non-preservable-terminals" },
      );
    }
    return pair(
      { action: "reinspect", reason: "target-build-not-yet-provable" },
      { action: "reinspect", reason: "target-build-not-yet-provable" },
    );
  }
  if (host.relation === "unknown") return blocked("identity-incomplete", "inventory-incomplete");
  if (host.relation !== "different") {
    return blocked("evidence-contradictory", "evidence-contradictory");
  }
  if (terminals.length === 0)
    return pair(
      { action: "no-op", reason: "no-terminals" },
      { action: "replace-idle", reason: "different-idle-host" },
    );
  if (terminals.some(({ handoff }) => handoff === "unknown")) {
    return blocked("inventory-incomplete", "handoff-support-unknown");
  }
  const nonPreservable = terminals.filter(({ handoff }) => handoff === "non-preservable");
  if (nonPreservable.some(({ reapRecovery }) => reapRecovery === "unknown")) {
    return blocked("recovery-incomplete", "recovery-incomplete");
  }
  if (nonPreservable.length > 0)
    return pair(
      { action: "reap-required", reason: "non-preservable-terminals" },
      { action: "await-reap", reason: "non-preservable-terminals" },
    );
  const fidelity = input.handoff.fidelity;
  return pair(
    { action: "preserve-via-handoff", reason: "bridge-preservation", fidelity },
    { action: "handoff", reason: "busy-different-host", fidelity },
  );
}

function hostEvidenceContradictsTarget(
  input: UpdateConvergencePlanningInput,
  host: Extract<UpdateConvergencePlanningInput["preflight"]["host"], { status: "inspected" }>,
): boolean {
  const displayMatches = host.buildVersion === input.preflight.target.version;
  if (host.compatibility === "reuse" && !displayMatches) return true;
  if (host.compatibility === "replace" && displayMatches) return true;
  if (!displayMatches) return host.relation !== "different";
  if (input.targetRuntime.status === "not-yet-provable") {
    return host.relation === "matching-target";
  }
  const identityMatches = host.buildIdentity === input.targetRuntime.buildIdentity;
  return identityMatches ? host.relation !== "matching-target" : host.relation !== "different";
}

function terminalFacts(
  input: UpdateConvergencePlanningInput,
  terminalDispositions: UpdateReapTerminalDisposition[],
): UpdateConvergenceTerminalFact[] {
  if (input.preflight.host.status !== "inspected") return [];
  return input.preflight.host.terminals.map((terminal, index) => {
    const disposition = terminalDispositions[index];
    if (disposition === undefined)
      throw new Error("Parsed update preflight omitted a terminal disposition.");
    return {
      kind: terminal.kind,
      alive: terminal.alive,
      terminalTargetId: terminal.terminalTargetId,
      ptyId: terminal.ptyId,
      ptyInstanceId: terminal.ptyInstanceId,
      sessionId: terminal.sessionId,
      handoff: disposition.handoff,
      reapRecovery: disposition.reapRecovery,
      reasons: disposition.reasons,
    };
  });
}

function terminalDispositionsMatch(
  supplied: readonly UpdateReapTerminalDisposition[],
  canonical: readonly UpdateReapTerminalDisposition[],
): boolean {
  return (
    supplied.length === canonical.length &&
    supplied.every((disposition, index) => {
      const expected = canonical[index];
      return (
        expected !== undefined &&
        compareStationHostTerminalLifetimeIdentity(disposition, expected) === 0 &&
        disposition.sessionId === expected.sessionId &&
        disposition.handoff === expected.handoff &&
        disposition.reapRecovery === expected.reapRecovery &&
        disposition.reasons.length === expected.reasons.length &&
        disposition.reasons.every((reason, reasonIndex) => reason === expected.reasons[reasonIndex])
      );
    })
  );
}

function planOutcome(
  phases: Omit<Phases, "persistedStateReconcile" | "finalVerification">,
): UpdateConvergencePlan["outcome"] {
  if (phases.artifactApplication.action === "defer") return "deferred";
  if (Object.values(phases).some((phase) => phase.action === "blocked")) return "blocked";
  if (phases.terminalConvergence.action === "reap-required") return "reap-required";
  if (phases.hostConvergence.action === "leave-in-place") return "intentionally-incomplete";
  return Object.values(phases).some((phase) => phase.action !== "no-op")
    ? "actionable"
    : "converged";
}

function finalDecisions(
  outcome: UpdateConvergencePlan["outcome"],
  runtimeStatus: UpdateConvergencePlanningInput["targetRuntime"]["status"],
): Pick<Phases, "persistedStateReconcile" | "finalVerification"> {
  switch (outcome) {
    case "converged":
      return {
        persistedStateReconcile: { action: "no-op", reason: "no-runtime-change" },
        finalVerification: { action: "satisfied", reason: "initial-inspection-converged" },
      };
    case "actionable":
      return {
        persistedStateReconcile:
          runtimeStatus === "not-yet-provable"
            ? { action: "await-artifact", reason: "target-build-not-yet-provable" }
            : { action: "run", reason: "runtime-change" },
        finalVerification: { action: "inspect", reason: "after-actions" },
      };
    case "deferred":
      return {
        persistedStateReconcile: { action: "await-artifact", reason: "package-manager-deferred" },
        finalVerification: { action: "await-artifact", reason: "package-manager-deferred" },
      };
    case "reap-required":
      return {
        persistedStateReconcile: { action: "await-reap", reason: "reap-required" },
        finalVerification: { action: "await-reap", reason: "reap-required" },
      };
    case "intentionally-incomplete":
      return {
        persistedStateReconcile: { action: "not-planned", reason: "intentionally-incomplete" },
        finalVerification: { action: "not-planned", reason: "intentionally-incomplete" },
      };
    case "blocked":
      return {
        persistedStateReconcile: { action: "blocked", reason: "convergence-blocked" },
        finalVerification: { action: "blocked", reason: "convergence-blocked" },
      };
  }
}

function artifactsMatch(
  left: { version: string; revision?: string },
  right: { version: string; revision?: string },
): boolean {
  return left.version === right.version && left.revision === right.revision;
}
