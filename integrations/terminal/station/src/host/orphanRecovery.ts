import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PtyBridgeParkStateSchema,
  PtyBridgeProtocolVersion,
  PtyHandoffEntrySchema,
  type PtyHandoffManifest,
  PtyHandoffManifestSchema,
  type StationHostTerminalLifetime,
} from "@station/contracts";
import {
  type StationHostClient,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "@station/host";

const PARK_SUFFIX = ".park.json";

export type ParkedOrphanRecoveryEvidence = {
  manifest: PtyHandoffManifest;
  payloadPids: Record<string, number>;
};

/** Requires every durable park identity fact to describe the same live Host terminal. */
export function stationHostTerminalMatchesParkedOrphan(
  terminal: StationHostTerminalLifetime,
  ptyId: string,
  entry: PtyHandoffManifest[string],
  payloadPid: number | undefined,
): boolean {
  return (
    terminal.ptyId === ptyId &&
    terminal.ptyInstanceId === entry.ptyInstanceId &&
    terminal.kind === entry.identity.kind &&
    terminal.terminalTargetId === entry.identity.terminalTargetId &&
    terminal.worktreeId === entry.identity.worktreeId &&
    terminal.projectId === entry.identity.projectId &&
    terminal.sessionId === entry.identity.sessionId &&
    terminal.worktreePath === entry.identity.worktreePath &&
    terminal.harnessProvider === entry.identity.harnessProvider &&
    terminal.pid === payloadPid &&
    terminal.cols === entry.cols &&
    terminal.rows === entry.rows &&
    terminal.alive &&
    terminal.handoffSupport.kind === "bridge-releasable"
  );
}

/** Detects an unowned park that cannot join the Host's independently unique lifetime namespace. */
export function stationHostTerminalConflictsWithUnownedPark(
  terminal: StationHostTerminalLifetime,
  ptyId: string,
  entry: PtyHandoffManifest[string],
): boolean {
  return (
    terminal.ptyId === ptyId ||
    terminal.terminalTargetId === entry.identity.terminalTargetId ||
    terminal.ptyInstanceId === entry.ptyInstanceId
  );
}

/** Builds adoption candidates from strict, non-exited park records at their expected local socket. */
export async function loadParkedOrphanManifest(stateDir: string): Promise<PtyHandoffManifest> {
  return (await loadParkedOrphanRecoveryEvidence(stateDir)).manifest;
}

/** Retains the strict park-state payload PID beside the protocol-v8-compatible manifest. */
export async function loadParkedOrphanRecoveryEvidence(
  stateDir: string,
): Promise<ParkedOrphanRecoveryEvidence> {
  const directory = path.join(stateDir, "run", "pty-bridges");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { manifest: {}, payloadPids: {} };
    }
    throw invalidParkEvidenceError();
  }

  const manifest: PtyHandoffManifest = {};
  const payloadPids: Record<string, number> = {};
  for (const name of names) {
    if (!name.endsWith(PARK_SUFFIX)) {
      continue;
    }
    const ptyId = name.slice(0, -PARK_SUFFIX.length);
    const expectedSocket = path.join(directory, `${ptyId}.sock`);
    try {
      const park = PtyBridgeParkStateSchema.parse(
        JSON.parse(await readFile(path.join(directory, name), "utf8")),
      );
      if (park.exited) {
        continue;
      }
      if (park.controlSocket !== expectedSocket) {
        throw invalidParkEvidenceError();
      }
      manifest[ptyId] = PtyHandoffEntrySchema.parse({
        bridgeProtocolVersion: PtyBridgeProtocolVersion,
        bridgePid: park.bridgePid,
        controlSocket: park.controlSocket,
        command: park.command,
        cols: park.cols,
        rows: park.rows,
        ptyInstanceId: park.ptyInstanceId,
        identity: park.identity,
      });
      payloadPids[ptyId] = park.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw invalidParkEvidenceError();
    }
  }
  const parsed = PtyHandoffManifestSchema.safeParse(manifest);
  if (!parsed.success) throw invalidParkEvidenceError();
  return { manifest: parsed.data, payloadPids };
}

/**
 * ADAPTER
 *
 * Adopts exactly the unique parked PTY set; acknowledgements never authorize less.
 */
export async function adoptParkedOrphanManifest(
  client: Pick<StationHostClient, "adoptRegistry">,
  manifest: PtyHandoffManifest,
): Promise<void> {
  const expected = Object.keys(manifest).sort();
  try {
    const report = await client.adoptRegistry(manifest);
    const adopted = [...new Set(report.adopted)].sort();
    if (
      report.failed.length > 0 ||
      adopted.length !== expected.length ||
      adopted.some((ptyId, index) => ptyId !== expected[index])
    )
      throw invalidAdoptionError();
  } catch (error) {
    throw stationHostErrorFromUnknown(error, {
      code: "HOST_HANDOFF_MANIFEST_INVALID",
      message: "Successor host could not adopt every expected parked terminal.",
      hint: "Parked bridges remain under the state dir until TTL reap or a retry.",
    });
  }
}

function invalidParkEvidenceError() {
  return stationHostSafeError(
    "HOST_HANDOFF_MANIFEST_INVALID",
    "Parked terminal recovery evidence could not be validated.",
    {
      hint: "Inspect the parked bridge files before launching a replacement agent.",
    },
  );
}

function invalidAdoptionError() {
  return stationHostSafeError(
    "HOST_HANDOFF_MANIFEST_INVALID",
    "Successor host returned incomplete parked-terminal adoption evidence.",
  );
}
