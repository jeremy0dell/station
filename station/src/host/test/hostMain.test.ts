import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient } from "@station/host";
import { expect, it } from "bun:test";
import { runStationHostMain } from "../hostMain.js";

const TEST_BUILD = "host-main-test";
const TEST_BUILD_IDENTITY = "c".repeat(64);

it("releases the packaged PTY runtime when the protocol stops an idle host", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "station-host-main-"));
  const socketPath = join(stateDir, "station-host.sock");
  let disposals = 0;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const previousOverride = process.env.STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE;
  process.env.STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE = "1";
  await runStationHostMain([
    "--socket", socketPath,
    "--state-dir", stateDir,
    "--build-version", TEST_BUILD,
    "--build-identity", TEST_BUILD_IDENTITY,
  ], {
    preparePtyRuntime: async () => ({
      implementation: "bun-nocctty",
      createTerminal: () => {
        throw new Error("unexpected PTY spawn");
      },
      dispose: () => {
        disposals += 1;
      },
    }),
    exit: resolveExit,
  });

  const client = createStationHostClient({ socketPath, expectedBuildVersion: TEST_BUILD });
  try {
    await expect(client.recoveryInventory()).resolves.toMatchObject({
      buildIdentity: TEST_BUILD_IDENTITY,
    });
    await expect(client.stopIfIdle("next-build")).resolves.toEqual({ stopping: true });
    expect(await exited).toBe(0);
    expect(disposals).toBe(1);
  } finally {
    client.dispose();
    if (previousOverride === undefined) delete process.env.STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE;
    else process.env.STATION_HOST_ALLOW_BUILD_VERSION_OVERRIDE = previousOverride;
  }
});
