import {
  type PtyHandoffManifest,
  type StationHostExactEvidence,
  StationHostExactEvidenceSchema,
  type StationHostInspectionResult,
  type StationHostTargetBuild,
  StationHostTargetBuildSchema,
  stationHostEvidenceMatchesTargetBuild,
} from "@station/contracts";
import {
  openStationHostLifecycleSession,
  type StationHostLifecycleSession,
  stationHostSafeError,
} from "@station/host";
import type { StationHostCommand } from "./hostProcess.js";
import { inspectStationHost } from "./inspectStationHost.js";
import {
  adoptParkedOrphanManifest,
  loadParkedOrphanRecoveryEvidence,
  type ParkedOrphanRecoveryEvidence,
  stationHostTerminalConflictsWithUnownedPark,
  stationHostTerminalMatchesParkedOrphan,
} from "./orphanRecovery.js";
import { readStationHostEvidence, stationHostEvidenceMatches } from "./readStationHostEvidence.js";
import { startStationHostWithOwnershipProof } from "./startStationHostWithOwnershipProof.js";
import { stationHostTerminalLifetimesMatch } from "./stationHostHandoffEvidence.js";

export type RecoverExactStationHostOrphansOptions = {
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
  targetBuild: StationHostTargetBuild;
  deadlineMs?: number;
};

export type RecoverExactStationHostOrphansResult = {
  recoveredPtyIds: string[];
};

/** DRIVEN PORT: supplies durable evidence, exact Host lifecycle, adoption, and one clock. */
export type ExactStationHostOrphanRecoveryPorts = {
  loadRecoveryEvidence(stateDir: string): Promise<ParkedOrphanRecoveryEvidence>;
  startTarget: typeof startStationHostWithOwnershipProof;
  inspect: typeof inspectStationHost;
  openSession(input: {
    socketPath: string;
    expectedBuildVersion: string;
    deadlineMs: number;
  }): Promise<StationHostLifecycleSession>;
  readEvidence(
    session: StationHostLifecycleSession,
    endpoint: StationHostExactEvidence["endpoint"],
    deadlineMs: number,
  ): Promise<StationHostExactEvidence>;
  adoptManifest: typeof adoptParkedOrphanManifest;
  now(): number;
};

/**
 * COMPOSITION ROOT
 *
 * Parses target identity and binds local process, socket, evidence, and adoption adapters.
 */
export function recoverExactStationHostOrphans(
  options: RecoverExactStationHostOrphansOptions,
  deps: Partial<ExactStationHostOrphanRecoveryPorts> = {},
): Promise<RecoverExactStationHostOrphansResult> {
  const now = deps.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? now() + 12_000;
  return executeExactStationHostOrphanRecovery(
    {
      socketPath: options.socketPath,
      stateDir: options.stateDir,
      hostCommand: options.hostCommand,
      targetBuild: StationHostTargetBuildSchema.parse(options.targetBuild),
      deadlineMs,
      detached: process.env.STATION_RUNTIME_OWNER_FOREGROUND !== "1",
    },
    {
      loadRecoveryEvidence: deps.loadRecoveryEvidence ?? loadParkedOrphanRecoveryEvidence,
      startTarget: deps.startTarget ?? startStationHostWithOwnershipProof,
      inspect: deps.inspect ?? inspectStationHost,
      openSession: deps.openSession ?? openStationHostLifecycleSession,
      readEvidence:
        deps.readEvidence ??
        ((session, endpoint, deadline) =>
          readStationHostEvidence({
            expectedEndpoint: endpoint,
            session,
            deadlineMs: deadline,
          })),
      adoptManifest: deps.adoptManifest ?? adoptParkedOrphanManifest,
      now,
    },
  );
}

type ExecuteExactStationHostOrphanRecoveryInput = {
  socketPath: string;
  stateDir: string;
  hostCommand: StationHostCommand;
  targetBuild: StationHostTargetBuild;
  deadlineMs: number;
  detached: boolean;
};

/**
 * USE CASE
 *
 * Starts the exact target when durable parks require it, then adopts every validated unowned park
 * whose independent lifetime identities are disjoint from the pinned Host inventory, on one
 * identity-proven physical session, and independently verifies the resulting inventory.
 */
export async function executeExactStationHostOrphanRecovery(
  input: ExecuteExactStationHostOrphanRecoveryInput,
  ports: ExactStationHostOrphanRecoveryPorts,
): Promise<RecoverExactStationHostOrphansResult> {
  const { targetBuild, deadlineMs } = input;
  const now = ports.now;
  const startupCutoffMs = deadlineMs - 2_000;
  let recoveryEvidence = await ports.loadRecoveryEvidence(input.stateDir);
  let manifest = recoveryEvidence.manifest;

  let inspection = await ports.inspect({
    socketPath: input.socketPath,
    expectedBuildVersion: targetBuild.buildVersion,
    deadlineMs,
  });
  if (Object.keys(manifest).length === 0) {
    assertEmptyRecoveryTarget(inspection, targetBuild);
    return { recoveredPtyIds: [] };
  }
  let startedSession: StationHostLifecycleSession | undefined;
  let startedEvidence: StationHostExactEvidence | undefined;
  if (inspection.status === "absent" || inspection.status === "stale") {
    if (now() >= startupCutoffMs) throw recoveryDeadlineError();
    let inventory:
      | Awaited<ReturnType<StationHostLifecycleSession["recoveryInventory"]>>
      | undefined;
    const started = await ports.startTarget({
      socketPath: input.socketPath,
      stateDir: input.stateDir,
      hostCommand: input.hostCommand,
      detached: input.detached,
      expectedBuildVersion: targetBuild.buildVersion,
      startupCutoffMs,
      deadlineMs,
      validate: async (session) => {
        inventory = await session.recoveryInventory();
        if (inventory.buildIdentity !== targetBuild.buildIdentity || inventory.ptys.length > 0) {
          throw recoveryError("Spawned Host was not the empty exact update target.");
        }
      },
    });
    if (started.status === "failed") {
      if (started.childDisposition !== "settled") throw started.error;
      inspection = await ports.inspect({
        socketPath: input.socketPath,
        expectedBuildVersion: targetBuild.buildVersion,
        deadlineMs,
      });
      if (
        inspection.status !== "exact" ||
        !stationHostEvidenceMatchesTargetBuild(inspection.evidence, targetBuild)
      ) {
        throw started.error;
      }
      startedEvidence = inspection.evidence;
    } else {
      startedSession = started.session;
    }
    try {
      if (started.status === "transferred") {
        startedEvidence = StationHostExactEvidenceSchema.parse({
          endpoint: started.endpoint,
          health: started.health,
          buildIdentity: inventory?.buildIdentity,
          terminals: inventory?.ptys,
        });
      }
      // Startup reaps dead park records; only the post-start strict inventory is adoptable authority.
      recoveryEvidence = await ports.loadRecoveryEvidence(input.stateDir);
      manifest = recoveryEvidence.manifest;
      if (Object.keys(manifest).length === 0) {
        const finalEmptyInspection = await ports.inspect({
          socketPath: input.socketPath,
          expectedBuildVersion: targetBuild.buildVersion,
          deadlineMs,
        });
        assertEmptyRecoveryTarget(finalEmptyInspection, targetBuild);
        startedSession?.dispose();
        return { recoveredPtyIds: [] };
      }
    } catch (error) {
      startedSession?.dispose();
      throw error;
    }
  }
  if (
    startedEvidence === undefined &&
    (inspection.status !== "exact" ||
      !stationHostEvidenceMatchesTargetBuild(inspection.evidence, targetBuild))
  ) {
    throw recoveryError("Parked terminals require the exact update Host before adoption.");
  }

  const expectedEvidence = startedEvidence ?? exactInspectionEvidence(inspection);
  const session =
    startedSession ??
    (await ports.openSession({
      socketPath: input.socketPath,
      expectedBuildVersion: targetBuild.buildVersion,
      deadlineMs,
    }));
  let after: StationHostExactEvidence;
  let recoveredPtyIds: string[];
  try {
    const pinned = await ports.readEvidence(session, expectedEvidence.endpoint, deadlineMs);
    if (!stationHostEvidenceMatches(pinned, expectedEvidence)) {
      throw recoveryError("Exact update Host evidence changed before parked adoption.");
    }
    // Park files are mutable bridge evidence; admit a fresh strict set immediately before mutation.
    recoveryEvidence = await ports.loadRecoveryEvidence(input.stateDir);
    manifest = recoveryEvidence.manifest;
    const unowned = selectUnownedManifest(recoveryEvidence, pinned);
    recoveredPtyIds = Object.keys(unowned).sort();
    if (recoveredPtyIds.length > 0) {
      if (now() >= deadlineMs) throw recoveryDeadlineError();
      try {
        await ports.adoptManifest(session, unowned);
      } catch (adoptionError) {
        const concurrentlyRecovered = await ports.readEvidence(
          session,
          pinned.endpoint,
          deadlineMs,
        );
        try {
          assertRecoveredEvidence(pinned, concurrentlyRecovered, recoveryEvidence, targetBuild);
          after = concurrentlyRecovered;
        } catch {
          throw adoptionError;
        }
      }
    }
    after ??= await ports.readEvidence(session, pinned.endpoint, deadlineMs);
    assertRecoveredEvidence(pinned, after, recoveryEvidence, targetBuild);
  } finally {
    session.dispose();
  }

  const independentlyInspected = await ports.inspect({
    socketPath: input.socketPath,
    expectedBuildVersion: targetBuild.buildVersion,
    deadlineMs,
  });
  if (
    independentlyInspected.status !== "exact" ||
    !stationHostEvidenceMatches(independentlyInspected.evidence, after)
  ) {
    throw recoveryError("Recovered Host inventory was not independently proved.");
  }
  return { recoveredPtyIds };
}

function exactInspectionEvidence(
  inspection: StationHostInspectionResult,
): StationHostExactEvidence {
  if (inspection.status !== "exact") {
    throw recoveryError("Exact Host evidence was unavailable for parked recovery.");
  }
  return inspection.evidence;
}

function selectUnownedManifest(
  recoveryEvidence: ParkedOrphanRecoveryEvidence,
  evidence: StationHostExactEvidence,
): PtyHandoffManifest {
  const { manifest, payloadPids } = recoveryEvidence;
  const owned = new Map(evidence.terminals.map((terminal) => [terminal.ptyId, terminal]));
  const unowned: PtyHandoffManifest = {};
  for (const [ptyId, entry] of Object.entries(manifest)) {
    const terminal = owned.get(ptyId);
    if (terminal !== undefined) {
      if (!stationHostTerminalMatchesParkedOrphan(terminal, ptyId, entry, payloadPids[ptyId])) {
        throw recoveryError("A parked terminal identity conflicts with the exact Host inventory.");
      }
      continue;
    }
    if (
      evidence.terminals.some((candidate) =>
        stationHostTerminalConflictsWithUnownedPark(candidate, ptyId, entry),
      )
    ) {
      throw recoveryError("A parked terminal identity conflicts with the exact Host inventory.");
    }
    unowned[ptyId] = entry;
  }
  return unowned;
}

function assertRecoveredEvidence(
  before: StationHostExactEvidence,
  after: StationHostExactEvidence,
  recoveryEvidence: ParkedOrphanRecoveryEvidence,
  targetBuild: StationHostTargetBuild,
): void {
  const { manifest, payloadPids } = recoveryEvidence;
  if (!stationHostEvidenceMatchesTargetBuild(after, targetBuild)) {
    throw recoveryError("Parked terminals were adopted by a nonexact Host.");
  }
  const afterById = new Map(after.terminals.map((terminal) => [terminal.ptyId, terminal]));
  const preserved = before.terminals.map(({ ptyId }) => afterById.get(ptyId)).filter(isPresent);
  if (!stationHostTerminalLifetimesMatch(preserved, before.terminals)) {
    throw recoveryError("Existing exact Host terminals changed during parked adoption.");
  }
  const expectedIds = new Set([
    ...before.terminals.map(({ ptyId }) => ptyId),
    ...Object.keys(manifest),
  ]);
  if (after.terminals.length !== expectedIds.size) {
    throw recoveryError("Recovered Host inventory did not contain exactly the expected terminals.");
  }
  for (const [ptyId, entry] of Object.entries(manifest)) {
    const terminal = afterById.get(ptyId);
    if (
      terminal === undefined ||
      !stationHostTerminalMatchesParkedOrphan(terminal, ptyId, entry, payloadPids[ptyId])
    ) {
      throw recoveryError("Recovered Host terminal facts did not match durable park evidence.");
    }
  }
}

function assertEmptyRecoveryTarget(
  inspection: StationHostInspectionResult,
  targetBuild: StationHostTargetBuild,
): void {
  if (
    inspection.status !== "absent" &&
    inspection.status !== "stale" &&
    (inspection.status !== "exact" ||
      !stationHostEvidenceMatchesTargetBuild(inspection.evidence, targetBuild))
  ) {
    throw recoveryError("Fresh Host evidence did not match the exact update target.");
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function recoveryError(message: string) {
  return stationHostSafeError("HOST_HANDOFF_MANIFEST_INVALID", message, {
    hint: "Parked bridges remain under the state dir until exact recovery succeeds or TTL reap.",
  });
}

function recoveryDeadlineError() {
  return stationHostSafeError("HOST_UNREACHABLE", "Parked Host recovery deadline was exceeded.");
}
