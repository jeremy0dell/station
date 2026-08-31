import type { HostHandoffFidelity, PtyHandoffManifest } from "@station/contracts";
import { StationHostProviderError } from "@station/host";
import type { HostConnectionOwner } from "@station/host";
import type { PtyTable } from "./ptyTable.js";

type HandoffPhase =
  | { kind: "serving" }
  | { kind: "idle-draining"; forBuild: string }
  | {
      kind: "handing-off";
      forBuild: string;
      manifest: PtyHandoffManifest;
      owner: HostConnectionOwner;
    }
  | { kind: "adopting" }
  | { kind: "completed" };

/** Lifecycle state whose pre-complete handoff authority belongs to one physical owner. */
export type HostHandoffSession = {
  assertNotDraining(): void;
  beginIdleDrain(requestingBuildVersion: string): void;
  beginHandoff(
    requestingBuildVersion: string,
    fidelity: HostHandoffFidelity,
    owner: HostConnectionOwner,
  ): Promise<{
    manifest: PtyHandoffManifest;
    fidelity: HostHandoffFidelity;
    released: string[];
    skipped: Array<{ ptyId: string; reason: string }>;
  }>;
  completeHandoff(owner: HostConnectionOwner): { stopping: true };
  abortHandoff(owner: HostConnectionOwner): Promise<Awaited<ReturnType<PtyTable["adoptRegistry"]>>>;
  ownerDisconnected(owner: HostConnectionOwner): Promise<void>;
  /** Exclude spawn, list, and attach until the successor registry transition is complete. */
  adoptRegistry(manifest: PtyHandoffManifest): Promise<Awaited<ReturnType<PtyTable["adoptRegistry"]>>>;
};

/**
 * Owns drain and handoff phases for one Host process. Begin binds complete,
 * abort, and disconnect restoration to one physical connection; completion is
 * terminal and makes later disconnect inert. Park readiness remains in PTY release.
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
      const forBuild = phase.kind === "idle-draining" || phase.kind === "handing-off"
        ? phase.forBuild
        : buildVersion;
      throw drainingSpawnBlocked(buildVersion, forBuild);
    },
    beginIdleDrain(requestingBuildVersion) {
      if (phase.kind !== "serving") {
        throw handoffInvalidState(
          phase.kind === "handing-off" || phase.kind === "completed"
            ? "A live handoff is already in progress."
            : "The host is already draining or handing off.",
        );
      }
      const livePtyCount = ptyTable.list().length;
      if (livePtyCount !== 0) {
        throw livePtyUpgradeBlocked(buildVersion, requestingBuildVersion, livePtyCount);
      }
      // Set before returning so no spawn can race the successful acknowledgement.
      phase = { kind: "idle-draining", forBuild: requestingBuildVersion };
    },
    async beginHandoff(requestingBuildVersion, fidelity, owner) {
      if (phase.kind !== "serving") {
        throw handoffInvalidState("The host is already draining or handing off.");
      }
      if (ptyTable.list().length === 0) {
        throw handoffInvalidState(
          "Live handoff requires at least one live terminal; use idle stop-if-idle replacement instead.",
        );
      }
      phase = { kind: "handing-off", forBuild: requestingBuildVersion, manifest: {}, owner };
      try {
        const report = await ptyTable.releaseRegistryForHandoff(fidelity);
        if (report.released.length === 0) {
          phase = { kind: "serving" };
          throw handoffInvalidState(emptyReleaseMessage(report.skipped.length));
        }
        phase = {
          kind: "handing-off",
          forBuild: requestingBuildVersion,
          manifest: report.manifest,
          owner,
        };
        return report;
      } catch (error) {
        if (phase.kind === "handing-off" && Object.keys(phase.manifest).length === 0) {
          // Release refused or restored after park failure; resume serving.
          phase = { kind: "serving" };
        }
        throw error;
      }
    },
    completeHandoff(owner) {
      if (phase.kind !== "handing-off" || Object.keys(phase.manifest).length === 0) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      assertOwner(phase.owner, owner);
      // Terminal phase: abort is refused; only process exit remains.
      phase = { kind: "completed" };
      return { stopping: true as const };
    },
    async abortHandoff(owner) {
      if (phase.kind === "completed") {
        throw handoffInvalidState(
          "Handoff already completed; parked bridges must be adopted by a successor host.",
        );
      }
      if (phase.kind !== "handing-off" || Object.keys(phase.manifest).length === 0) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      assertOwner(phase.owner, owner);
      const report = await ptyTable.adoptRegistry(phase.manifest);
      phase = { kind: "serving" };
      return report;
    },
    async ownerDisconnected(owner) {
      if (phase.kind !== "handing-off" || phase.owner !== owner) return;
      const manifest = phase.manifest;
      if (Object.keys(manifest).length > 0) await ptyTable.adoptRegistry(manifest);
      phase = { kind: "serving" };
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
}

function assertOwner(expected: HostConnectionOwner, received: HostConnectionOwner): void {
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
  requestingBuildVersion: string,
  livePtyCount: number,
): StationHostProviderError {
  const terminalLabel = livePtyCount === 1 ? "terminal" : "terminals";
  return new StationHostProviderError(
    "HOST_UPGRADE_BLOCKED",
    `Station host build "${runningBuildVersion}" has ${livePtyCount} live ${terminalLabel} and cannot be replaced by build "${requestingBuildVersion}".`,
    {
      hint: `Reopen Station with build "${runningBuildVersion}", finish or close its live terminals, then retry build "${requestingBuildVersion}".`,
    },
  );
}

export function drainingSpawnBlocked(
  runningBuildVersion: string,
  requestingBuildVersion: string,
): StationHostProviderError {
  return new StationHostProviderError(
    "HOST_UPGRADE_BLOCKED",
    `Station host build "${runningBuildVersion}" is stopping for build "${requestingBuildVersion}" and cannot spawn a new terminal.`,
  );
}

export function handoffInvalidState(message: string): StationHostProviderError {
  return new StationHostProviderError("HOST_HANDOFF_INVALID_STATE", message);
}
