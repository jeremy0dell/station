import type {
  PtyHandoffManifest,
  SafeError,
  StationHostConvergenceCommand,
  StationHostConvergenceResult,
  StationHostExactEvidence,
  StationHostHandoffReceipt,
} from "@station/contracts";
import {
  StationHostConvergenceCommandSchema,
  StationHostExactEvidenceSchema,
} from "@station/contracts";
import {
  type HostRecoveryInventoryResult,
  type StationHostLifecycleSession,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "@station/host";
import type { StationHostCommand } from "./hostProcess.js";
import type { inspectStationHost } from "./inspectStationHost.js";
import {
  type StationHostEndpointObservation,
  stationHostEndpointsMatch,
  stationHostEvidenceMatches,
} from "./readStationHostEvidence.js";
import type { startStationHostWithOwnershipProof } from "./startStationHostWithOwnershipProof.js";
import {
  stationHostHandoffPtyIdsMatch,
  stationHostTerminalLifetimesMatch,
  validateStationHostHandoffBegin,
} from "./stationHostHandoffEvidence.js";

/**
 * DRIVEN PORT
 *
 * Supplies pinned sessions, direct-child ownership proof, independent inspection, and one clock.
 */
export type StationHostConvergencePorts = {
  openSession(buildVersion: string, deadlineMs: number): Promise<StationHostLifecycleSession>;
  probeEndpoint(deadlineMs: number): Promise<StationHostEndpointObservation>;
  readEvidence(
    session: StationHostLifecycleSession,
    endpoint: StationHostExactEvidence["endpoint"],
    deadlineMs: number,
  ): Promise<StationHostExactEvidence>;
  startTarget(
    input: Parameters<typeof startStationHostWithOwnershipProof>[0],
  ): ReturnType<typeof startStationHostWithOwnershipProof>;
  inspectTarget(buildVersion: string, deadlineMs: number): ReturnType<typeof inspectStationHost>;
  now(): number;
};
export type ExecuteStationHostConvergenceInput = {
  command: StationHostConvergenceCommand;
  stateDir: string;
  hostCommand: StationHostCommand;
  detached: boolean;
};
type Failure = Extract<StationHostConvergenceResult, { status: "failed" }>;
type Sourced = NonNullable<Failure["lastExactEvidence"]>;
type Progress = Pick<Failure, "phase" | "incumbentDisposition" | "terminalDisposition"> & {
  handoffReceipt?: StationHostHandoffReceipt;
  lastExactEvidence?: Sourced;
};

/**
 * USE CASE
 *
 * Sequences one-deadline incumbent release, direct-child ownership transfer, exact adoption, and
 * independent proof of the successor's complete terminal lifetimes. Mutation delivery makes the
 * prior incumbent disposition unknown until fresh evidence proves otherwise. A transferred or
 * concurrent proven successor is never signaled.
 */
export async function executeStationHostConvergence(
  input: ExecuteStationHostConvergenceInput,
  ports: StationHostConvergencePorts,
): Promise<StationHostConvergenceResult> {
  const command = StationHostConvergenceCommandSchema.parse(input.command);
  const stateDir = input.stateDir;
  const hostCommand = [...input.hostCommand] as StationHostCommand;
  const detached = input.detached;
  const startupCutoffMs = command.deadlineMs - 2_000;
  const progress: Progress = {
    phase: "admission",
    incumbentDisposition: "unknown",
    terminalDisposition: command.action === "handoff" ? "unknown" : "none",
  };
  let incumbent: StationHostLifecycleSession | undefined;
  let manifest: PtyHandoffManifest | undefined;
  try {
    requireCleanupReserve(startupCutoffMs, ports.now);
    progress.phase = "incumbent-validation";
    incumbent = await ports.openSession(command.expected.health.buildVersion, command.deadlineMs);
    const observed = await ports.readEvidence(
      incumbent,
      command.expected.endpoint,
      command.deadlineMs,
    );
    progress.lastExactEvidence = { source: "incumbent-session", evidence: observed };
    if (!stationHostEvidenceMatches(observed, command.expected))
      throw hostFailure("Incumbent Host evidence drifted.");
    progress.incumbentDisposition = "preserved";
    progress.terminalDisposition = command.action === "handoff" ? "incumbent" : "none";

    progress.phase = "incumbent-release";
    requireCleanupReserve(startupCutoffMs, ports.now);
    progress.incumbentDisposition = "unknown";
    if (command.action === "handoff") progress.terminalDisposition = "unknown";
    if (command.action === "replace-idle") {
      await incumbent.stopIfIdle(command.targetBuild.buildVersion);
    } else {
      const begun = await incumbent.beginHandoff(
        command.targetBuild.buildVersion,
        command.fidelity,
      );
      if (begun.status === "refused") throw begun.error;
      if (begun.status === "malformed-success") {
        progress.terminalDisposition = "unknown";
        applyRecovery(progress, await restoreIncumbent(command, incumbent, ports));
        throw begun.error;
      }
      try {
        const validated = validateStationHostHandoffBegin(command, begun.result);
        manifest = validated.manifest;
        progress.handoffReceipt = validated.receipt;
        progress.terminalDisposition = "parked";
        requireCleanupReserve(startupCutoffMs, ports.now);
        await incumbent.completeHandoff();
      } catch (error) {
        applyRecovery(progress, await restoreIncumbent(command, incumbent, ports));
        throw error;
      }
    }
    progress.incumbentDisposition = "released";
    incumbent.dispose();
    incumbent = undefined;
    await proveIncumbentDeparture(command.expected.endpoint, startupCutoffMs, ports);
    requireCleanupReserve(startupCutoffMs, ports.now);

    progress.phase = "target-start";
    let inventory: HostRecoveryInventoryResult | undefined;
    const started = await ports.startTarget({
      socketPath: command.socketPath,
      stateDir,
      hostCommand,
      detached,
      expectedBuildVersion: command.targetBuild.buildVersion,
      startupCutoffMs,
      deadlineMs: command.deadlineMs,
      validate: async (session) => {
        inventory = await session.recoveryInventory();
        if (inventory.buildIdentity !== command.targetBuild.buildIdentity || inventory.ptys.length)
          throw hostFailure("Spawned Host was not the empty exact target.", "HOST_TARGET_CONFLICT");
      },
    });
    if (started.status === "failed") {
      if (started.childDisposition !== "settled") throw started.error;
      return await admitConcurrentSuccessor(input, progress, manifest, ports, started.error);
    }

    progress.phase = "target-validation";
    try {
      const targetEvidence = StationHostExactEvidenceSchema.parse({
        endpoint: started.endpoint,
        health: started.health,
        buildIdentity: inventory?.buildIdentity,
        terminals: inventory?.ptys,
      });
      progress.lastExactEvidence = { source: "target-session", evidence: targetEvidence };
      assertExactSuccessor(targetEvidence, command, started.endpoint, []);
      if (command.action === "handoff") {
        if (manifest === undefined) throw missingHandoffEvidence();
        progress.phase = "adoption";
        await adoptAndVerifySuccessor(
          command,
          started.session,
          started.endpoint,
          manifest,
          progress,
          ports,
        );
      }
    } finally {
      started.session.dispose();
    }
    return await independentlyVerifySuccessor(command, started.endpoint, progress, ports);
  } catch (error) {
    return failed(command, progress, error);
  } finally {
    incumbent?.dispose();
  }
}

async function admitConcurrentSuccessor(
  input: ExecuteStationHostConvergenceInput,
  progress: Progress,
  manifest: PtyHandoffManifest | undefined,
  ports: StationHostConvergencePorts,
  loserError: unknown,
): Promise<StationHostConvergenceResult> {
  const command = input.command;
  const endpoint = await ports.probeEndpoint(command.deadlineMs);
  if (endpoint.status !== "listening") throw loserError;
  const session = await ports.openSession(command.targetBuild.buildVersion, command.deadlineMs);
  try {
    let evidence = await ports.readEvidence(session, endpoint.endpoint, command.deadlineMs);
    progress.lastExactEvidence = { source: "target-session", evidence };
    if (
      command.action === "handoff" &&
      !stationHostTerminalLifetimesMatch(evidence.terminals, command.expected.terminals)
    ) {
      assertExactSuccessor(evidence, command, endpoint.endpoint, []);
      if (manifest === undefined) throw missingHandoffEvidence();
      progress.phase = "adoption";
      evidence = await adoptAndVerifySuccessor(
        command,
        session,
        endpoint.endpoint,
        manifest,
        progress,
        ports,
      );
    }
    assertExactSuccessor(evidence, command, endpoint.endpoint, command.expected.terminals);
    progress.terminalDisposition = command.action === "handoff" ? "successor" : "none";
  } finally {
    session.dispose();
  }
  return independentlyVerifySuccessor(command, endpoint.endpoint, progress, ports);
}

async function adoptAndVerifySuccessor(
  command: Extract<StationHostConvergenceCommand, { action: "handoff" }>,
  session: StationHostLifecycleSession,
  endpoint: StationHostExactEvidence["endpoint"],
  manifest: PtyHandoffManifest,
  progress: Progress,
  ports: StationHostConvergencePorts,
): Promise<StationHostExactEvidence> {
  const report = await session.adoptRegistry(manifest);
  if (report.failed.length > 0 || !stationHostHandoffPtyIdsMatch(report.adopted, command))
    throw hostFailure(
      "Successor adoption acknowledgement was incomplete.",
      "HOST_HANDOFF_MANIFEST_INVALID",
    );
  const evidence = await ports.readEvidence(session, endpoint, command.deadlineMs);
  progress.lastExactEvidence = { source: "target-session", evidence };
  assertExactSuccessor(evidence, command, endpoint, command.expected.terminals);
  progress.terminalDisposition = "successor";
  return evidence;
}

async function independentlyVerifySuccessor(
  command: StationHostConvergenceCommand,
  endpoint: StationHostExactEvidence["endpoint"],
  progress: Progress,
  ports: StationHostConvergencePorts,
): Promise<StationHostConvergenceResult> {
  progress.phase = "final-verification";
  const inspection = await ports.inspectTarget(
    command.targetBuild.buildVersion,
    command.deadlineMs,
  );
  if (inspection.status !== "exact")
    throw hostFailure("Independent successor inspection was not exact.");
  progress.lastExactEvidence = { source: "independent-inspection", evidence: inspection.evidence };
  assertExactSuccessor(inspection.evidence, command, endpoint, command.expected.terminals);
  if (command.action === "handoff") {
    if (progress.handoffReceipt === undefined) throw missingHandoffEvidence();
    return {
      status: "completed",
      action: "handoff",
      targetBuild: command.targetBuild,
      finalEvidence: inspection.evidence,
      handoffReceipt: progress.handoffReceipt,
    };
  }
  return {
    status: "completed",
    action: "replace-idle",
    targetBuild: command.targetBuild,
    finalEvidence: inspection.evidence,
  };
}

function missingHandoffEvidence(): SafeError {
  return hostFailure("Validated Host handoff evidence was not retained.");
}

async function proveIncumbentDeparture(
  endpoint: StationHostExactEvidence["endpoint"],
  startupCutoffMs: number,
  ports: StationHostConvergencePorts,
): Promise<void> {
  while (ports.now() < startupCutoffMs) {
    const current = await ports.probeEndpoint(startupCutoffMs);
    if (current.status === "absent") return;
    if (current.status === "stale") {
      if (stationHostEndpointsMatch(current.endpoint, endpoint)) return;
      throw hostFailure("Incumbent endpoint departure was not exclusive.", "HOST_UNREACHABLE");
    }
    if (
      current.status === "inaccessible" &&
      (current.endpoint === undefined || !stationHostEndpointsMatch(current.endpoint, endpoint))
    )
      throw hostFailure("Incumbent endpoint departure was not exclusive.", "HOST_UNREACHABLE");
    if (current.status === "listening" && !stationHostEndpointsMatch(current.endpoint, endpoint))
      throw hostFailure("Incumbent endpoint departure was not exclusive.", "HOST_UNREACHABLE");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, startupCutoffMs - ports.now())),
    );
  }
  throw hostFailure("Incumbent endpoint did not depart before cutoff.", "HOST_UNREACHABLE");
}

type Recovery = { restored: boolean; last?: Sourced };
async function restoreIncumbent(
  command: Extract<StationHostConvergenceCommand, { action: "handoff" }>,
  session: StationHostLifecycleSession,
  ports: StationHostConvergencePorts,
): Promise<Recovery> {
  let last: Sourced | undefined;
  try {
    const report = await session.abortHandoff();
    if (report.failed.length === 0 && stationHostHandoffPtyIdsMatch(report.adopted, command)) {
      const evidence = await ports.readEvidence(
        session,
        command.expected.endpoint,
        command.deadlineMs,
      );
      last = { source: "incumbent-session", evidence };
      if (stationHostEvidenceMatches(evidence, command.expected)) return { restored: true, last };
    }
  } catch {}
  try {
    const found = await ports.inspectTarget(
      command.expected.health.buildVersion,
      command.deadlineMs,
    );
    if (found.status === "exact") {
      last = { source: "independent-inspection", evidence: found.evidence };
      return { restored: stationHostEvidenceMatches(found.evidence, command.expected), last };
    }
  } catch {}
  return last === undefined ? { restored: false } : { restored: false, last };
}

function applyRecovery(progress: Progress, recovery: Recovery): void {
  if (recovery.last !== undefined) progress.lastExactEvidence = recovery.last;
  progress.incumbentDisposition = recovery.restored ? "preserved" : "unknown";
  progress.terminalDisposition = recovery.restored ? "incumbent" : "unknown";
}

function assertExactSuccessor(
  evidence: StationHostExactEvidence,
  command: StationHostConvergenceCommand,
  endpoint: StationHostExactEvidence["endpoint"],
  terminals: StationHostExactEvidence["terminals"],
): void {
  if (
    !stationHostEndpointsMatch(evidence.endpoint, endpoint) ||
    evidence.health.buildVersion !== command.targetBuild.buildVersion ||
    evidence.buildIdentity !== command.targetBuild.buildIdentity ||
    !stationHostTerminalLifetimesMatch(evidence.terminals, terminals)
  )
    throw hostFailure("Exact target Host evidence was not proved.", "HOST_TARGET_CONFLICT");
}
function requireCleanupReserve(startupCutoffMs: number, now: () => number): void {
  if (now() >= startupCutoffMs)
    throw hostFailure("Host convergence lacks the fixed cleanup reserve.", "HOST_UNREACHABLE");
}
function hostFailure(
  message: string,
  code:
    | "HOST_REQUEST_FAILED"
    | "HOST_TARGET_CONFLICT"
    | "HOST_HANDOFF_MANIFEST_INVALID"
    | "HOST_UNREACHABLE" = "HOST_REQUEST_FAILED",
): SafeError {
  return stationHostSafeError(code, message);
}
function failed(
  command: StationHostConvergenceCommand,
  progress: Progress,
  error: unknown,
): Failure {
  const last = progress.terminalDisposition;
  return {
    status: "failed",
    action: command.action,
    targetBuild: command.targetBuild,
    phase: progress.phase,
    incumbentDisposition: progress.incumbentDisposition,
    terminalDisposition: last,
    recoveryAuthority: "none",
    terminalRecovery: command.expected.terminals.map(
      ({ terminalTargetId, ptyId, ptyInstanceId }) => ({
        terminalTargetId,
        ptyId,
        ptyInstanceId,
        lastProvenDisposition:
          last === "incumbent" || last === "parked" || last === "successor" ? last : "unknown",
      }),
    ),
    ...(progress.handoffReceipt === undefined ? {} : { handoffReceipt: progress.handoffReceipt }),
    ...(progress.lastExactEvidence === undefined
      ? {}
      : { lastExactEvidence: progress.lastExactEvidence }),
    error: stationHostErrorFromUnknown(error, {
      code: "HOST_REQUEST_FAILED",
      message: "Station Host convergence could not be proved.",
    }),
  };
}
