import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PtyBridgeParkStateSchema,
  PtyBridgeProtocolVersion,
  PtyHandoffEntrySchema,
  type PtyHandoffManifest,
} from "@station/contracts";
import {
  type StationHostClient,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "@station/host";

const PARK_SUFFIX = ".park.json";

/** Builds adoption candidates from strict, non-exited park records at their expected local socket. */
export async function loadParkedOrphanManifest(stateDir: string): Promise<PtyHandoffManifest> {
  const directory = path.join(stateDir, "run", "pty-bridges");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw invalidParkEvidenceError();
  }

  const manifest: PtyHandoffManifest = {};
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw invalidParkEvidenceError();
    }
  }
  return manifest;
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
    { hint: "Inspect the parked bridge files before launching a replacement agent." },
  );
}

function invalidAdoptionError() {
  return stationHostSafeError(
    "HOST_HANDOFF_MANIFEST_INVALID",
    "Successor host returned incomplete parked-terminal adoption evidence.",
  );
}
