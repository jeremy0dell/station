import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyConfig } from "@station/config";
import { describe, expect, it, vi } from "vitest";
import { runSnapshotCommand } from "../../src/commands/snapshot.js";

describe("snapshot command", () => {
  it("does not spawn an Observer when --require-running finds no runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-snapshot-require-running-"));
    const spawnObserver = vi.fn();
    const config = {
      ...emptyConfig(),
      observer: {
        stateDir: join(root, "state"),
        socketPath: join(root, "observer.sock"),
      },
    };

    try {
      await expect(
        runSnapshotCommand(
          ["--json", "--require-running"],
          { config, timeoutMs: 50 },
          {
            spawnObserver,
            clientFactory: () =>
              ({
                health: async () => {
                  throw new Error("not running");
                },
              }) as never,
          },
        ),
      ).rejects.toThrow("not running");
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
