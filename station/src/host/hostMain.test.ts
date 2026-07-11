import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient } from "@station/host";
import { expect, it } from "bun:test";
import { runStationHostMain } from "./hostMain.js";

it("releases the packaged PTY runtime when the protocol stops an idle host", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "station-host-main-"));
  const socketPath = join(stateDir, "station-host.sock");
  let disposals = 0;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  await runStationHostMain(["--socket", socketPath, "--state-dir", stateDir], {
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

  const client = createStationHostClient({ socketPath });
  try {
    await expect(client.stopIfIdle("next-build")).resolves.toEqual({ stopping: true });
    expect(await exited).toBe(0);
    expect(disposals).toBe(1);
  } finally {
    client.dispose();
  }
});
