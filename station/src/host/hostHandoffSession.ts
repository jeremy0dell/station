import type { HostHandoffFidelity, PtyHandoffManifest } from "@station/contracts";
import { StationHostProviderError } from "@station/host";
import type { HostConnectionOwner } from "@station/host";
import {
  PtyHandoffRestorationError,
  unadoptedPtyHandoffManifest,
} from "./ptyHandoff.js";
import type { PtyTable } from "./ptyTable.js";

type HandoffPhase =
  | { kind: "serving" }
  | { kind: "idle-draining"; requestedSuccessorBuildVersion: string }
  | {
      kind: "handing-off";
      requestedSuccessorBuildVersion: string;
      manifest: PtyHandoffManifest;
      connectionOwner: HostConnectionOwner;
    }
  | {
      kind: "restoring";
      requestedSuccessorBuildVersion: string;
      manifest: PtyHandoffManifest;
      connectionOwner: HostConnectionOwner;
    }
  | {
      kind: "recovery-required";
      requestedSuccessorBuildVersion: string;
      manifest: PtyHandoffManifest;
      connectionOwner: HostConnectionOwner;
    }
  | { kind: "adopting" }
  | { kind: "completed" };

/** Lifecycle state whose pre-complete handoff authority belongs to one physical owner. */
export type HostHandoffSession = {
  assertNotDraining(): void;
  beginIdleDrain(requestedSuccessorBuildVersion: string): void;
  beginHandoff(
    requestedSuccessorBuildVersion: string,
    fidelity: HostHandoffFidelity,
    connectionOwner: HostConnectionOwner,
  ): Promise<{
    manifest: PtyHandoffManifest;
    fidelity: HostHandoffFidelity;
    released: string[];
    skipped: Array<{ ptyId: string; reason: string }>;
  }>;
  completeHandoff(connectionOwner: HostConnectionOwner): { stopping: true };
  abortHandoff(
    connectionOwner: HostConnectionOwner,
  ): Promise<Awaited<ReturnType<PtyTable["adoptRegistry"]>>>;
  ownerDisconnected(connectionOwner: HostConnectionOwner): Promise<void>;
  /** Exclude spawn, list, and attach until the successor registry transition is complete. */
  adoptRegistry(manifest: PtyHandoffManifest): Promise<Awaited<ReturnType<PtyTable["adoptRegistry"]>>>;
};

/**
 * Owns drain and handoff phases for one Host process. The requested successor
 * build is caller-reported compatibility context, never authority. Begin binds
 * complete, abort, and disconnect restoration to one admitted physical
 * connection; completion is terminal and makes later disconnect inert.
 * Restoration blocks Host operations until every released PTY is owned again,
 * retaining failed park evidence instead of serving.
 */
export function createHostHandoffSession(input: {
  ptyTable: PtyTable;
  buildVersion: string;
}): HostHandoffSession {
  const { ptyTable, buildVersion } = input;
  let phase: HandoffPhase = { kind: "serving" };

  return {
    assertNotDraining() {
      if (phase.kind === "serving") {
        return;
      }
      if (phase.kind === "completed") {
        throw handoffInvalidState("The host has completed handoff and is stopping.");
      }
      if (phase.kind === "adopting") {
        throw handoffInvalidState("The host is adopting a PTY registry.");
      }
      const requestedSuccessorBuildVersion =
        phase.kind === "idle-draining" ||
        phase.kind === "handing-off" ||
        phase.kind === "restoring" ||
        phase.kind === "recovery-required"
          ? phase.requestedSuccessorBuildVersion
          : buildVersion;
      throw drainingSpawnBlocked(buildVersion, requestedSuccessorBuildVersion);
    },
    beginIdleDrain(requestedSuccessorBuildVersion) {
      if (phase.kind !== "serving") {
        throw handoffInvalidState(
          phase.kind === "handing-off" || phase.kind === "completed"
            ? "A live handoff is already in progress."
            : "The host is already draining or handing off.",
        );
      }
      const livePtyCount = ptyTable.list().length;
      if (livePtyCount !== 0) {
        throw livePtyUpgradeBlocked(buildVersion, requestedSuccessorBuildVersion, livePtyCount);
      }
      // Set before returning so no spawn can race the successful acknowledgement.
      phase = { kind: "idle-draining", requestedSuccessorBuildVersion };
    },
    async beginHandoff(requestedSuccessorBuildVersion, fidelity, connectionOwner) {
      if (phase.kind !== "serving") {
        throw handoffInvalidState("The host is already draining or handing off.");
      }
      if (ptyTable.list().length === 0) {
        throw handoffInvalidState(
          "Live handoff requires at least one live terminal; use idle stop-if-idle replacement instead.",
        );
      }
      phase = {
        kind: "handing-off",
        requestedSuccessorBuildVersion,
        manifest: {},
        connectionOwner,
      };
      try {
        const report = await ptyTable.releaseRegistryForHandoff(fidelity);
        if (report.released.length === 0) {
          phase = { kind: "serving" };
          throw handoffInvalidState(emptyReleaseMessage(report.skipped.length));
        }
        phase = {
          kind: "handing-off",
          requestedSuccessorBuildVersion,
          manifest: report.manifest,
          connectionOwner,
        };
        return report;
      } catch (error) {
        if (error instanceof PtyHandoffRestorationError) {
          phase = {
            kind: "recovery-required",
            requestedSuccessorBuildVersion,
            manifest: error.remainingManifest,
            connectionOwner,
          };
          throw error;
        }
        if (phase.kind === "handing-off" && Object.keys(phase.manifest).length === 0) {
          // Release refused or restored after park failure; resume serving.
          phase = { kind: "serving" };
        }
        throw error;
      }
    },
    completeHandoff(connectionOwner) {
      if (phase.kind !== "handing-off" || Object.keys(phase.manifest).length === 0) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      assertConnectionOwner(phase.connectionOwner, connectionOwner);
      // Terminal phase: abort is refused; only process exit remains.
      phase = { kind: "completed" };
      return { stopping: true as const };
    },
    async abortHandoff(connectionOwner) {
      if (phase.kind === "completed") {
        throw handoffInvalidState(
          "Handoff already completed; parked bridges must be adopted by a successor host.",
        );
      }
      if (
        (phase.kind !== "handing-off" && phase.kind !== "recovery-required") ||
        Object.keys(phase.manifest).length === 0
      ) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      assertConnectionOwner(phase.connectionOwner, connectionOwner);
      return restoreIncumbentRegistry(phase);
    },
    async ownerDisconnected(connectionOwner) {
      if (
        (phase.kind !== "handing-off" && phase.kind !== "recovery-required") ||
        phase.connectionOwner !== connectionOwner
      ) {
        return;
      }
      if (Object.keys(phase.manifest).length > 0) {
        await restoreIncumbentRegistry(phase);
      }
    },
    async adoptRegistry(manifest) {
      if (phase.kind !== "serving") {
        throw handoffInvalidState(
          "Registry adoption is only allowed on a serving host that is not draining or handing off.",
        );
      }
      phase = { kind: "adopting" };
      try {
        return await ptyTable.adoptRegistry(manifest);
      } finally {
        phase = { kind: "serving" };
      }
    },
  };

  async function restoreIncumbentRegistry(
    recoveryPhase: Extract<HandoffPhase, { kind: "handing-off" | "recovery-required" }>,
  ): Promise<Awaited<ReturnType<PtyTable["adoptRegistry"]>>> {
    const { requestedSuccessorBuildVersion, manifest, connectionOwner } = recoveryPhase;
    // Commit the transition before awaiting so complete and duplicate abort cannot race restoration.
    phase = { kind: "restoring", requestedSuccessorBuildVersion, manifest, connectionOwner };
    try {
      const report = await ptyTable.adoptRegistry(manifest);
      const remainingManifest = unadoptedPtyHandoffManifest(manifest, report.adopted);
      phase = Object.keys(remainingManifest).length === 0
        ? { kind: "serving" }
        : {
            kind: "recovery-required",
            requestedSuccessorBuildVersion,
            manifest: remainingManifest,
            connectionOwner,
          };
      return report;
    } catch (error) {
      phase = {
        kind: "recovery-required",
        requestedSuccessorBuildVersion,
        manifest,
        connectionOwner,
      };
      throw error;
    }
  }
}

function assertConnectionOwner(expected: HostConnectionOwner, received: HostConnectionOwner): void {
  if (expected !== received) {
    throw handoffInvalidState("Handoff lifecycle authority belongs to another connection.");
  }
}

function emptyReleaseMessage(skippedCount: number): string {
  return skippedCount > 0
    ? "Live handoff requires every live terminal to be bridge-backed and releasable."
    : "No bridge-backed terminals could be released for handoff.";
}

export function livePtyUpgradeBlocked(
  runningBuildVersion: string,
  requestedSuccessorBuildVersion: string,
  livePtyCount: number,
): StationHostProviderError {
  const terminalLabel = livePtyCount === 1 ? "terminal" : "terminals";
  return new StationHostProviderError(
    "HOST_UPGRADE_BLOCKED",
    `Station host build "${runningBuildVersion}" has ${livePtyCount} live ${terminalLabel} and cannot be replaced by build "${requestedSuccessorBuildVersion}".`,
    {
      hint: `Reopen Station with build "${runningBuildVersion}", finish or close its live terminals, then retry build "${requestedSuccessorBuildVersion}".`,
    },
  );
}

export function drainingSpawnBlocked(
  runningBuildVersion: string,
  requestedSuccessorBuildVersion: string,
): StationHostProviderError {
  return new StationHostProviderError(
    "HOST_UPGRADE_BLOCKED",
    `Station host build "${runningBuildVersion}" is stopping for build "${requestedSuccessorBuildVersion}" and cannot spawn a new terminal.`,
  );
}

export function handoffInvalidState(message: string): StationHostProviderError {
  return new StationHostProviderError("HOST_HANDOFF_INVALID_STATE", message);
}
