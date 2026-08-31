import type {
  PtyHandoffManifest,
  SafeError,
  StationHostConvergenceCommand,
  StationHostConvergenceResult,
  StationHostHandoffReceipt,
  StationHostTargetBuild,
} from "@station/contracts";
import {
  compareStationHostTerminalLifetimeIdentity,
  parseStationHostConvergenceCommand,
  StationHostConvergenceCommandSchema,
  StationHostExactEvidenceSchema,
  StationHostHandoffReceiptSchema,
} from "@station/contracts";
import {
  type HostRecoveryInventoryResult,
  openStationHostLifecycleSession,
  type StationHostLifecycleSession,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "@station/host";
import type { StationHostCommand } from "./ensureHostRunning.js";
import { inspectStationHost } from "./inspectStationHost.js";
import {
  readStationHostEndpoint,
  readStationHostEvidence,
  type StationHostEndpointObservation,
  type StationHostExactEvidence,
  startCausalStationHost,
  stationHostEndpointsMatch,
  stationHostEvidenceMatches,
} from "./readStationHostEvidence.js";

/**
 * DRIVEN PORT
 *
 * Supplies pinned sessions, causal start, independent inspection, and one clock.
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
    input: Parameters<typeof startCausalStationHost>[0],
  ): ReturnType<typeof startCausalStationHost>;
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
 * Sequences one-deadline incumbent release, causal transfer, pinned `E1`, exact adoption, and
 * independent proof. A transferred or concurrent proven successor is never signaled later.
 */
export async function executeStationHostConvergence(
  input: ExecuteStationHostConvergenceInput,
  ports: StationHostConvergencePorts,
): Promise<StationHostConvergenceResult> {
  const command = StationHostConvergenceCommandSchema.parse(input.command);
  const stateDir = input.stateDir;
  const hostCommand = [...input.hostCommand] as StationHostCommand;
  const detached = input.detached;
  const cutoff = command.deadlineMs - 2_000;
  const progress: Progress = {
    phase: "admission",
    incumbentDisposition: "unknown",
    terminalDisposition: command.action === "handoff" ? "unknown" : "none",
  };
  let incumbent: StationHostLifecycleSession | undefined;
  let manifest: PtyHandoffManifest | undefined;
  try {
    requireReserve(cutoff, ports.now);
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
    requireReserve(cutoff, ports.now);
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
        const validated = validateBegin(command, begun.result);
        manifest = validated.manifest;
        progress.handoffReceipt = validated.receipt;
        progress.terminalDisposition = "parked";
        requireReserve(cutoff, ports.now);
        await incumbent.completeHandoff();
      } catch (error) {
        applyRecovery(progress, await restoreIncumbent(command, incumbent, ports));
        throw error;
      }
    }
    progress.incumbentDisposition = "released";
    incumbent.dispose();
    incumbent = undefined;
    await proveDeparture(command.expected.endpoint, cutoff, ports);
    requireReserve(cutoff, ports.now);

    progress.phase = "target-start";
    let inventory: HostRecoveryInventoryResult | undefined;
    const started = await ports.startTarget({
      socketPath: command.socketPath,
      stateDir,
      hostCommand,
      detached,
      expectedBuildVersion: command.targetBuild.buildVersion,
      startupCutoffMs: cutoff,
      deadlineMs: command.deadlineMs,
      validate: async (session) => {
        inventory = await session.recoveryInventory();
        if (inventory.buildIdentity !== command.targetBuild.buildIdentity || inventory.ptys.length)
          throw hostFailure("Spawned Host was not the empty exact target.", "HOST_TARGET_CONFLICT");
      },
    });
    if (started.status === "failed") {
      if (started.childDisposition !== "settled") throw started.error;
      return await admitWinner(input, progress, manifest, ports, started.error);
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
      requireTarget(targetEvidence, command, started.endpoint, []);
      if (command.action === "handoff") {
        if (manifest === undefined) throw missingHandoffEvidence();
        progress.phase = "adoption";
        await adoptAndProve(command, started.session, started.endpoint, manifest, progress, ports);
      }
    } finally {
      started.session.dispose();
    }
    return await finish(command, started.endpoint, progress, ports);
  } catch (error) {
    return failed(command, progress, error);
  } finally {
    incumbent?.dispose();
  }
}

export type ConvergeStationHostOptions = {
  command: unknown;
  targetBuild: StationHostTargetBuild;
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
};

/**
 * COMPOSITION ROOT
 *
 * Contextually parses and snapshots exact authority before binding local adapters.
 */
export function convergeStationHost(
  options: ConvergeStationHostOptions,
  deps: Partial<StationHostConvergencePorts> = {},
): Promise<StationHostConvergenceResult> {
  const now = deps.now ?? Date.now;
  const command = parseStationHostConvergenceCommand(options.command, {
    targetBuild: options.targetBuild,
    socketPath: options.socketPath,
    nowMs: now(),
  });
  const input: ExecuteStationHostConvergenceInput = {
    command,
    stateDir: options.stateDir,
    hostCommand: [...options.hostCommand] as StationHostCommand,
    detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
  };
  const probeEndpoint =
    deps.probeEndpoint ?? ((deadlineMs) => readStationHostEndpoint(command.socketPath, deadlineMs));
  const openSession =
    deps.openSession ??
    ((buildVersion, deadlineMs) =>
      openStationHostLifecycleSession({
        socketPath: command.socketPath,
        expectedBuildVersion: buildVersion,
        deadlineMs,
      }));
  return executeStationHostConvergence(input, {
    openSession,
    probeEndpoint,
    readEvidence:
      deps.readEvidence ??
      ((session, endpoint, deadlineMs) =>
        readStationHostEvidence({
          expectedEndpoint: endpoint,
          session,
          deadlineMs,
          probeEndpoint: (_path, deadline) => probeEndpoint(deadline),
        })),
    startTarget: deps.startTarget ?? ((startInput) => startCausalStationHost(startInput, { now })),
    inspectTarget:
      deps.inspectTarget ??
      ((buildVersion, deadlineMs) =>
        inspectStationHost(
          { socketPath: command.socketPath, expectedBuildVersion: buildVersion, deadlineMs },
          {
            probeEndpoint: (_path, deadline) => probeEndpoint(deadline),
            openSession: ({ expectedBuildVersion, deadlineMs: deadline }) =>
              openSession(expectedBuildVersion, deadline),
          },
        )),
    now,
  });
}

async function admitWinner(
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
      !sameTerminals(evidence.terminals, command.expected.terminals)
    ) {
      requireTarget(evidence, command, endpoint.endpoint, []);
      if (manifest === undefined) throw missingHandoffEvidence();
      progress.phase = "adoption";
      evidence = await adoptAndProve(
        command,
        session,
        endpoint.endpoint,
        manifest,
        progress,
        ports,
      );
    }
    requireTarget(evidence, command, endpoint.endpoint, command.expected.terminals);
    progress.terminalDisposition = command.action === "handoff" ? "successor" : "none";
  } finally {
    session.dispose();
  }
  return finish(command, endpoint.endpoint, progress, ports);
}

async function adoptAndProve(
  command: Extract<StationHostConvergenceCommand, { action: "handoff" }>,
  session: StationHostLifecycleSession,
  endpoint: StationHostExactEvidence["endpoint"],
  manifest: PtyHandoffManifest,
  progress: Progress,
  ports: StationHostConvergencePorts,
): Promise<StationHostExactEvidence> {
  const report = await session.adoptRegistry(manifest);
  if (report.failed.length || !sameSet(report.adopted, expectedPtyIds(command)))
    throw hostFailure(
      "Successor adoption acknowledgement was incomplete.",
      "HOST_HANDOFF_MANIFEST_INVALID",
    );
  const evidence = await ports.readEvidence(session, endpoint, command.deadlineMs);
  progress.lastExactEvidence = { source: "target-session", evidence };
  requireTarget(evidence, command, endpoint, command.expected.terminals);
  progress.terminalDisposition = "successor";
  return evidence;
}

async function finish(
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
  requireTarget(inspection.evidence, command, endpoint, command.expected.terminals);
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

async function proveDeparture(
  endpoint: StationHostExactEvidence["endpoint"],
  cutoff: number,
  ports: StationHostConvergencePorts,
): Promise<void> {
  while (ports.now() < cutoff) {
    const current = await ports.probeEndpoint(cutoff);
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
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, cutoff - ports.now())));
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
    if (!report.failed.length && sameSet(report.adopted, expectedPtyIds(command))) {
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

function validateBegin(
  command: Extract<StationHostConvergenceCommand, { action: "handoff" }>,
  result: Awaited<ReturnType<StationHostLifecycleSession["beginHandoff"]>> extends infer _
    ? { manifest: PtyHandoffManifest; fidelity: string; released: string[]; skipped: unknown[] }
    : never,
): { manifest: PtyHandoffManifest; receipt: StationHostHandoffReceipt } {
  const terminals = Object.entries(result.manifest)
    .map(([ptyId, entry]) => ({
      terminalTargetId: entry.identity.terminalTargetId,
      ptyId,
      ptyInstanceId: entry.ptyInstanceId,
    }))
    .sort(compareStationHostTerminalLifetimeIdentity);
  const receipt = StationHostHandoffReceiptSchema.parse({ fidelity: result.fidelity, terminals });
  if (
    result.fidelity !== command.fidelity ||
    result.skipped.length ||
    !sameSet(result.released, expectedPtyIds(command)) ||
    !sameTerminals(receipt.terminals, command.expected.terminals)
  )
    throw hostFailure(
      "Handoff manifest identity or fidelity drifted.",
      "HOST_HANDOFF_MANIFEST_INVALID",
    );
  for (const expected of command.expected.terminals) {
    const entry = result.manifest[expected.ptyId];
    if (
      !entry ||
      entry.identity.kind !== expected.kind ||
      entry.identity.worktreeId !== expected.worktreeId ||
      entry.identity.projectId !== expected.projectId ||
      entry.identity.sessionId !== expected.sessionId ||
      entry.identity.worktreePath !== expected.worktreePath ||
      entry.identity.harnessProvider !== expected.harnessProvider ||
      entry.cols !== expected.cols ||
      entry.rows !== expected.rows
    )
      throw hostFailure(
        "Handoff manifest terminal facts drifted.",
        "HOST_HANDOFF_MANIFEST_INVALID",
      );
  }
  return { manifest: result.manifest, receipt };
}

function requireTarget(
  evidence: StationHostExactEvidence,
  command: StationHostConvergenceCommand,
  endpoint: StationHostExactEvidence["endpoint"],
  terminals: StationHostExactEvidence["terminals"],
): void {
  if (
    !stationHostEndpointsMatch(evidence.endpoint, endpoint) ||
    evidence.health.buildVersion !== command.targetBuild.buildVersion ||
    evidence.buildIdentity !== command.targetBuild.buildIdentity ||
    !sameTerminals(evidence.terminals, terminals)
  )
    throw hostFailure("Exact target Host evidence was not proved.", "HOST_TARGET_CONFLICT");
}
function expectedPtyIds(command: StationHostConvergenceCommand): string[] {
  return command.expected.terminals.map(({ ptyId }) => ptyId);
}
function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const unique = [...new Set(actual)].sort();
  const sorted = [...expected].sort();
  return unique.length === sorted.length && unique.every((value, index) => value === sorted[index]);
}
function sameTerminals(
  actual: readonly { terminalTargetId: string; ptyId: string; ptyInstanceId: string }[],
  expected: readonly { terminalTargetId: string; ptyId: string; ptyInstanceId: string }[],
): boolean {
  return (
    JSON.stringify(
      actual.map(({ terminalTargetId, ptyId, ptyInstanceId }) => ({
        terminalTargetId,
        ptyId,
        ptyInstanceId,
      })),
    ) ===
    JSON.stringify(
      expected.map(({ terminalTargetId, ptyId, ptyInstanceId }) => ({
        terminalTargetId,
        ptyId,
        ptyInstanceId,
      })),
    )
  );
}
function requireReserve(cutoff: number, now: () => number): void {
  if (now() >= cutoff)
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
