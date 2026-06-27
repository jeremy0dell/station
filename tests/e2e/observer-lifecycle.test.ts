import { startObserver } from "@station/cli";
import { createObserverClient } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { waitForSocketClosed } from "../support/sockets";
import { createTempState, writeConfigToml } from "../support/temp-projects";

describe("observer lifecycle e2e", () => {
  it("starts a real observer process, serves protocol requests, and stops cleanly", async () => {
    const fixture = await createTempState();
    const config = {
      ...fixture.config,
      defaults: {
        worktreeProvider: "noop-worktree",
        terminal: "noop-terminal",
        harness: "noop-harness",
        layout: "agent-shell",
      },
    };
    const configPath = await writeConfigToml(fixture.root, config);
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1000 });
    let started = false;

    try {
      const status = await startObserver({
        config,
        configPath,
        timeoutMs: 30_000,
      });
      expect(status).toMatchObject({
        status: "running",
        paths: {
          socketPath: fixture.socketPath,
        },
      });
      started = true;

      await expect(client.health()).resolves.toMatchObject({
        status: "healthy",
        socketPath: fixture.socketPath,
        stateDir: fixture.stateDir,
      });
      await expect(client.getSnapshot()).resolves.toMatchObject({
        schemaVersion: "0.6.0",
        counts: { projects: 0 },
      });
    } finally {
      if (started) {
        await client.stop();
        await waitForSocketClosed(fixture.socketPath);
      }
    }

    await expect(client.health()).rejects.toBeDefined();
  });
});
