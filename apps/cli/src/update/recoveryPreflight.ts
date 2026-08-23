import {
  compareCodeUnitStrings,
  type ProviderHookHealth,
  ProviderHookHealthSchema,
  type ProviderId,
  type SafeError,
  type UpdateArtifact,
  type UpdateReapHostEvidence,
  type UpdateReapObserverEvidence,
  type UpdateReapRecoveryPreflight,
  UpdateReapRecoveryPreflightSchema,
  type UpdateReapTerminalDisposition,
  type UpdateReapTerminalDispositionReason,
  updateReapEvidenceIsComplete,
} from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";

/**
 * DRIVEN PORT
 *
 * Supplies already normalized, read-only runtime and provider evidence. Implementations must not
 * start, stop, signal, install, reconcile, resume, or otherwise mutate the inspected system.
 */
export type UpdateRecoveryPreflightPorts = {
  inspectObserver(artifacts: UpdateRecoveryArtifacts): Promise<UpdateReapObserverEvidence>;
  inspectHost(artifacts: UpdateRecoveryArtifacts): Promise<UpdateReapHostEvidence>;
  readHookHealth(provider: ProviderId): Promise<ProviderHookHealth>;
  hookProviderIds: readonly ProviderId[];
};

export type UpdateRecoveryArtifacts = {
  installed: UpdateArtifact;
  target: UpdateArtifact;
};

/**
 * USE CASE
 *
 * Aggregates read-only Observer, Host, retained-session, capability, handle, and hook facts while
 * settling every evidence source. It computes dispositions only; executable actions, authorization,
 * digests, and mutation remain downstream responsibilities.
 */
export async function runUpdateRecoveryPreflight(input: {
  installed: UpdateArtifact;
  target: UpdateArtifact;
  ports: UpdateRecoveryPreflightPorts;
}): Promise<UpdateReapRecoveryPreflight> {
  const artifacts = { installed: input.installed, target: input.target };
  const [observer, host] = await Promise.all([
    inspectObserver(input.ports, artifacts),
    inspectHost(input.ports, artifacts),
  ]);
  const hookProviderIds = providersForHookInspection(input.ports.hookProviderIds, observer);
  const hooks = await Promise.all(
    hookProviderIds.map((provider) => inspectHook(input.ports, provider)),
  );
  const terminalDispositions = terminalDispositionsFor(host, observer);
  const evidence = {
    observer,
    host,
    hookProviderIds,
    hooks,
    terminalDispositions,
  };
  return UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: {
      authorization: "none",
      actions: "not-included",
      digest: "not-included",
    },
    installed: input.installed,
    target: input.target,
    ...evidence,
    evidenceComplete: updateReapEvidenceIsComplete(evidence),
  });
}

async function inspectObserver(
  ports: UpdateRecoveryPreflightPorts,
  artifacts: UpdateRecoveryArtifacts,
): Promise<UpdateReapObserverEvidence> {
  try {
    return await ports.inspectObserver(artifacts);
  } catch (error) {
    return {
      status: "unknown",
      reason: "inspection-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_OBSERVER_INSPECTION_FAILED",
        message: "Observer recovery evidence could not be inspected.",
      }),
    };
  }
}

async function inspectHost(
  ports: UpdateRecoveryPreflightPorts,
  artifacts: UpdateRecoveryArtifacts,
): Promise<UpdateReapHostEvidence> {
  try {
    const host = await ports.inspectHost(artifacts);
    return host.status === "inspected"
      ? { ...host, terminals: [...host.terminals].sort(compareTerminalIdentity) }
      : host;
  } catch (error) {
    return {
      status: "unknown",
      reason: "health-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_HOST_INSPECTION_FAILED",
        message: "Host and terminal evidence could not be inspected.",
      }),
    };
  }
}

async function inspectHook(
  ports: UpdateRecoveryPreflightPorts,
  provider: ProviderId,
): Promise<ProviderHookHealth> {
  try {
    const health = ProviderHookHealthSchema.parse(await ports.readHookHealth(provider));
    if (health.provider !== provider) {
      throw new Error("Hook evidence provider did not match the requested provider.");
    }
    return health;
  } catch (error) {
    return {
      provider,
      status: "inspection-failed",
      error: redactedPreflightError(error, {
        code: "UPDATE_PREFLIGHT_HOOK_INSPECTION_FAILED",
        message: "Configured provider hooks could not be inspected.",
        provider,
      }),
      followUp: { action: "run-doctor" },
    };
  }
}

function providersForHookInspection(
  configured: readonly ProviderId[],
  observer: UpdateReapObserverEvidence,
): ProviderId[] {
  const providers = new Set<ProviderId>(configured);
  if (observer.status === "exact" && observer.recovery.status === "assessed") {
    for (const capability of observer.recovery.assessment.providerCapabilities) {
      providers.add(capability.provider);
    }
  }
  return Array.from(providers).sort(compareCodeUnitStrings);
}

function terminalDispositionsFor(
  host: UpdateReapHostEvidence,
  observer: UpdateReapObserverEvidence,
): UpdateReapTerminalDisposition[] {
  if (host.status !== "inspected") return [];
  const sessions = new Map(
    observer.status === "exact" && observer.recovery.status === "assessed"
      ? observer.recovery.assessment.sessions.map((session) => [session.sessionId, session])
      : [],
  );
  return host.terminals
    .map((terminal): UpdateReapTerminalDisposition => {
      const reasons: UpdateReapTerminalDispositionReason[] = [];
      const handoff =
        terminal.handoffSupport === "bridge-releasable"
          ? "preservable"
          : terminal.handoffSupport === "non-releasable"
            ? "non-preservable"
            : "unknown";
      if (handoff === "unknown") reasons.push("handoff_support_unknown");

      const session = sessions.get(terminal.sessionId);
      let reapRecovery: UpdateReapTerminalDisposition["reapRecovery"];
      if (terminal.kind === "aux") {
        reapRecovery = "non-resumable";
        reasons.push("aux_terminal_not_resumable");
      } else if (session === undefined) {
        reapRecovery =
          observer.status === "exact" && observer.recovery.status === "assessed"
            ? "non-resumable"
            : "unknown";
        reasons.push(
          reapRecovery === "non-resumable"
            ? "retained_session_missing"
            : "session_recovery_unknown",
        );
      } else if (
        session.projectId !== terminal.projectId ||
        session.worktreeId !== terminal.worktreeId ||
        session.harnessProvider !== terminal.harnessProvider
      ) {
        reapRecovery = "unknown";
        reasons.push("retained_session_identity_mismatch");
      } else if (session.disposition === "recoverable") {
        reapRecovery = "recoverable";
      } else if (session.disposition === "unknown") {
        reapRecovery = "unknown";
        reasons.push("session_recovery_unknown");
      } else {
        reapRecovery = "non-resumable";
        reasons.push("session_non_resumable");
      }
      return {
        terminalTargetId: terminal.terminalTargetId,
        ptyId: terminal.ptyId,
        ptyInstanceId: terminal.ptyInstanceId,
        sessionId: terminal.sessionId,
        handoff,
        reapRecovery,
        reasons: Array.from(new Set(reasons)).sort(compareCodeUnitStrings),
      };
    })
    .sort(compareTerminalIdentity);
}

function compareTerminalIdentity(
  left: Pick<UpdateReapTerminalDisposition, "terminalTargetId" | "ptyId" | "ptyInstanceId">,
  right: Pick<UpdateReapTerminalDisposition, "terminalTargetId" | "ptyId" | "ptyInstanceId">,
): number {
  return (
    compareCodeUnitStrings(left.terminalTargetId, right.terminalTargetId) ||
    compareCodeUnitStrings(left.ptyId, right.ptyId) ||
    compareCodeUnitStrings(left.ptyInstanceId, right.ptyInstanceId)
  );
}

export function redactedPreflightError(
  error: unknown,
  fallback: { code: string; message: string; provider?: ProviderId },
): SafeError {
  const normalized = publicSafeErrorFromUnknown(error, {
    tag: "UpdatePreflightError",
    code: fallback.code,
    message: fallback.message,
    ...(fallback.provider === undefined ? {} : { provider: fallback.provider }),
  });
  const safe: SafeError = {
    tag: "UpdatePreflightError",
    code: fallback.code,
    message: fallback.message,
  };
  if (fallback.provider !== undefined) safe.provider = fallback.provider;
  if (normalized.traceId !== undefined) safe.traceId = normalized.traceId;
  if (normalized.diagnosticId !== undefined) safe.diagnosticId = normalized.diagnosticId;
  return safe;
}

/** Deterministic terminal-first text presentation shared by update dry-run and TUI callers. */
export function renderUpdateRecoveryPreflight(preflight: UpdateReapRecoveryPreflight): string {
  const lines = [
    "recovery preflight (facts only; authorizes no action)",
    `installed: ${artifactText(preflight.installed)}`,
    `target: ${artifactText(preflight.target)}`,
    `evidence: ${preflight.evidenceComplete ? "complete" : "incomplete"}`,
    `observer: ${observerText(preflight.observer)}`,
    `host: ${hostText(preflight.host)}`,
  ];
  if (preflight.host.status === "unknown") {
    lines.push("terminals: unknown (Host inventory unavailable)");
  } else if (preflight.host.status === "absent") {
    lines.push("terminals: none (Host absent)");
  } else if (preflight.terminalDispositions.length === 0) {
    lines.push("terminals: none");
  } else {
    lines.push("terminals:");
    for (const terminal of preflight.terminalDispositions) {
      const recovery =
        terminal.reapRecovery === "non-resumable" ? "NON-RESUMABLE" : terminal.reapRecovery;
      lines.push(
        `  ${terminalText(terminal.terminalTargetId)} pty=${terminalText(terminal.ptyId)}/${terminalText(terminal.ptyInstanceId)} session=${terminalText(terminal.sessionId)} handoff=${terminal.handoff} reapRecovery=${recovery}`,
      );
      if (terminal.reasons.length > 0) lines.push(`    reasons: ${terminal.reasons.join(", ")}`);
    }
  }
  lines.push("sessions:");
  if (preflight.observer.status === "exact" && preflight.observer.recovery.status === "assessed") {
    const assessment = preflight.observer.recovery.assessment;
    if (assessment.sessions.length === 0) lines.push("  none retained");
    for (const session of assessment.sessions) {
      const disposition =
        session.disposition === "non-resumable" ? "NON-RESUMABLE" : session.disposition;
      lines.push(`  ${terminalText(session.sessionId)}: ${disposition}`);
      if (session.reasons.length > 0) lines.push(`    reasons: ${session.reasons.join(", ")}`);
      const resolution = session.handleResolution;
      if (resolution.kind === "selected") {
        lines.push(
          `    handle: selected eligible=${resolution.eligibleHandleCount} rejected=${resolution.rejectedHandleCount}`,
        );
        if (resolution.rejectedReasons.length > 0) {
          lines.push(`    handle rejected reasons: ${resolution.rejectedReasons.join(", ")}`);
        }
      } else if (resolution.kind === "none") {
        lines.push(`    handle: none eligible=0 rejected=${resolution.rejectedHandleCount}`);
        lines.push(`    handle reasons: ${resolution.reasons.join(", ")}`);
      } else {
        lines.push(`    handle: unknown (${resolution.reasons.join(", ")})`);
      }
    }
    lines.push("resume capabilities:");
    if (assessment.providerCapabilities.length === 0) lines.push("  none reported");
    for (const capability of assessment.providerCapabilities) {
      lines.push(`  ${terminalText(capability.provider)}: ${capability.status}`);
    }
  } else {
    lines.push("  unknown");
  }
  lines.push("hooks:");
  if (preflight.hooks.length === 0) lines.push("  none configured");
  for (const hook of preflight.hooks) {
    lines.push(`  ${terminalText(hook.provider)}: ${hook.status}`);
  }
  lines.push("actions: not included (#640)", "digest: not included (#640)");
  return `${lines.join("\n")}\n`;
}

function artifactText(artifact: UpdateArtifact): string {
  return artifact.revision === undefined
    ? terminalText(artifact.version)
    : `${terminalText(artifact.version)} (${terminalText(artifact.revision)})`;
}

function observerText(observer: UpdateReapObserverEvidence): string {
  if (observer.status === "absent") return "absent";
  if (observer.status === "unknown") return `unknown (${observer.reason})`;
  return `exact build=${terminalText(observer.buildVersion)} relation=${observer.relation} health=${observer.health} recovery=${observer.recovery.status}`;
}

function hostText(host: UpdateReapHostEvidence): string {
  if (host.status === "absent") return "absent";
  if (host.status === "unknown") return `unknown (${host.reason})`;
  const build = host.buildVersion === undefined ? "legacy" : terminalText(host.buildVersion);
  const identity = host.buildIdentity === undefined ? "unknown" : terminalText(host.buildIdentity);
  return `inspected build=${build} identity=${identity} relation=${host.relation} compatibility=${host.compatibility} terminals=${host.terminals.length}`;
}

function terminalText(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isTerminalControl =
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 8_232 ||
      codePoint === 8_233;
    escaped += isTerminalControl ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
  }
  return escaped;
}
