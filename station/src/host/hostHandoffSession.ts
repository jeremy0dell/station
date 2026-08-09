import type { HostHandoffFidelity, PtyHandoffManifest } from "@station/contracts";
import { StationHostProviderError } from "@station/host";
import type { PtyTable } from "./ptyTable.js";

type HandoffPhase =
  | { kind: "serving" }
  | { kind: "idle-draining"; forBuild: string }
  | { kind: "handing-off"; forBuild: string; manifest: PtyHandoffManifest }
  | { kind: "completed" };

export type HostHandoffSession = {
  assertNotDraining(): void;
  /** Successor adopt is identity-bound and only legal while still serving. */
  assertCanAdopt(): void;
  beginIdleDrain(requestingBuildVersion: string): void;
  beginHandoff(
    requestingBuildVersion: string,
    fidelity: HostHandoffFidelity,
  ): Promise<{
    manifest: PtyHandoffManifest;
    fidelity: HostHandoffFidelity;
    released: string[];
    skipped: Array<{ ptyId: string; reason: string }>;
  }>;
  completeHandoff(): { stopping: true };
  abortHandoff(): Promise<Awaited<ReturnType<PtyTable["adoptRegistry"]>>>;
};

/**
 * Drain / handoff phase ownership for one host process: idle stop-if-idle drain,
 * live handoff begin/complete/abort, and adopt gating. Park readiness lives in
 * pty release, not here.
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
      const forBuild = phase.kind === "idle-draining" || phase.kind === "handing-off"
        ? phase.forBuild
        : buildVersion;
      throw drainingSpawnBlocked(buildVersion, forBuild);
    },
    assertCanAdopt() {
      if (phase.kind !== "serving") {
        throw handoffInvalidState(
          "Registry adoption is only allowed on a serving host that is not draining or handing off.",
        );
      }
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
    async beginHandoff(requestingBuildVersion, fidelity) {
      if (phase.kind !== "serving") {
        throw handoffInvalidState("The host is already draining or handing off.");
      }
      if (ptyTable.list().length === 0) {
        throw handoffInvalidState(
          "Live handoff requires at least one live terminal; use idle stop-if-idle replacement instead.",
        );
      }
      phase = { kind: "handing-off", forBuild: requestingBuildVersion, manifest: {} };
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
    completeHandoff() {
      if (phase.kind !== "handing-off" || Object.keys(phase.manifest).length === 0) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      // Terminal phase: abort is refused; only process exit remains.
      phase = { kind: "completed" };
      return { stopping: true as const };
    },
    async abortHandoff() {
      if (phase.kind === "completed") {
        throw handoffInvalidState(
          "Handoff already completed; parked bridges must be adopted by a successor host.",
        );
      }
      if (phase.kind !== "handing-off" || Object.keys(phase.manifest).length === 0) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      const report = await ptyTable.adoptRegistry(phase.manifest);
      phase = { kind: "serving" };
      return report;
    },
  };
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
