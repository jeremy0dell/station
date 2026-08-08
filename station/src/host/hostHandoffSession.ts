import { existsSync } from "node:fs";
import type { HostHandoffFidelity, PtyHandoffManifest } from "@station/contracts";
import { StationHostProviderError } from "@station/host";
import { waitForParkedBridge } from "./orphanBridges.js";
import type { PtyTable } from "./ptyTable.js";

export type HostHandoffSession = {
  assertNotDraining(): void;
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
 * Drain / handoff ownership for one host process: idle stop-if-idle drain,
 * negotiated park readiness, and abort restore.
 */
export function createHostHandoffSession(input: {
  ptyTable: PtyTable;
  buildVersion: string;
}): HostHandoffSession {
  const { ptyTable, buildVersion } = input;
  let drainingForBuild: string | undefined;
  let handoffManifest: PtyHandoffManifest | undefined;

  const assertNotDraining = (): void => {
    if (drainingForBuild !== undefined) {
      throw drainingSpawnBlocked(buildVersion, drainingForBuild);
    }
  };

  const abortHandoff = async () => {
    if (handoffManifest === undefined) {
      throw handoffInvalidState("No handoff is in progress.");
    }
    const report = await ptyTable.adoptRegistry(handoffManifest);
    handoffManifest = undefined;
    drainingForBuild = undefined;
    return report;
  };

  return {
    assertNotDraining,
    beginIdleDrain(requestingBuildVersion) {
      if (handoffManifest !== undefined) {
        throw handoffInvalidState("A live handoff is already in progress.");
      }
      const livePtyCount = ptyTable.list().length;
      if (livePtyCount !== 0) {
        throw livePtyUpgradeBlocked(buildVersion, requestingBuildVersion, livePtyCount);
      }
      // Set before returning so no spawn can race the successful acknowledgement.
      drainingForBuild = requestingBuildVersion;
    },
    async beginHandoff(requestingBuildVersion, fidelity) {
      if (drainingForBuild !== undefined || handoffManifest !== undefined) {
        throw handoffInvalidState("The host is already draining or handing off.");
      }
      if (ptyTable.list().length === 0) {
        throw handoffInvalidState(
          "Live handoff requires at least one live terminal; use idle stop-if-idle replacement instead.",
        );
      }
      drainingForBuild = requestingBuildVersion;
      try {
        const report = await ptyTable.releaseRegistryForHandoff(fidelity);
        if (report.released.length === 0) {
          drainingForBuild = undefined;
          throw handoffInvalidState(emptyReleaseMessage(report.skipped.length));
        }
        handoffManifest = report.manifest;
        await ensureReleasedParksReady({
          released: report.released,
          manifest: report.manifest,
          abortHandoff,
        });
        return report;
      } catch (error) {
        if (handoffManifest === undefined) {
          drainingForBuild = undefined;
        }
        throw error;
      }
    },
    completeHandoff() {
      if (handoffManifest === undefined) {
        throw handoffInvalidState("No handoff is in progress.");
      }
      return { stopping: true as const };
    },
    abortHandoff,
  };
}

async function ensureReleasedParksReady(input: {
  released: string[];
  manifest: PtyHandoffManifest;
  abortHandoff: () => Promise<unknown>;
}): Promise<void> {
  // Real bridges write park.json and listen on the control socket. Scripted
  // releases create neither. A park file without a socket is a hard failure
  // (common when the unix socket path exceeds the OS sun_path limit).
  for (const ptyId of input.released) {
    const controlSocket = input.manifest[ptyId]?.controlSocket;
    if (controlSocket === undefined) {
      continue;
    }
    const readiness = await waitForReleasedPark(controlSocket);
    if (readiness === "scripted-or-absent") {
      continue;
    }
    if (readiness === "ready") {
      continue;
    }
    await input.abortHandoff();
    throw handoffInvalidState(parkFailureMessage(ptyId, readiness));
  }
}

async function waitForReleasedPark(
  controlSocket: string,
): Promise<"ready" | "scripted-or-absent" | "park-only" | "probe-timeout"> {
  const parkStatePath = parkStatePathForControlSocket(controlSocket);
  const artifact = await waitForParkArtifact(controlSocket, parkStatePath, 500);
  if (artifact === "none") {
    return "scripted-or-absent";
  }
  if (artifact === "park-only") {
    return "park-only";
  }
  const ready = await waitForParkedBridge(controlSocket, { timeoutMs: 3_000 });
  return ready ? "ready" : "probe-timeout";
}

function parkStatePathForControlSocket(controlSocket: string): string {
  return controlSocket.endsWith(".sock")
    ? `${controlSocket.slice(0, -".sock".length)}.park.json`
    : `${controlSocket}.park.json`;
}

function emptyReleaseMessage(skippedCount: number): string {
  return skippedCount > 0
    ? "Live handoff requires every live terminal to be bridge-backed and releasable."
    : "No bridge-backed terminals could be released for handoff.";
}

function parkFailureMessage(
  ptyId: string,
  readiness: "park-only" | "probe-timeout",
): string {
  if (readiness === "park-only") {
    return `Released terminal "${ptyId}" wrote park state but never opened its control socket.`;
  }
  return `Released terminal "${ptyId}" did not park in time for live handoff.`;
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

async function waitForParkArtifact(
  controlSocket: string,
  parkStatePath: string,
  timeoutMs: number,
): Promise<"socket" | "park-only" | "none"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(controlSocket)) {
      return "socket";
    }
    if (existsSync(parkStatePath)) {
      // Give listen() a brief chance after park.json is written.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (existsSync(controlSocket)) {
        return "socket";
      }
      return "park-only";
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (existsSync(controlSocket)) {
    return "socket";
  }
  if (existsSync(parkStatePath)) {
    return "park-only";
  }
  return "none";
}
