import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CommandReceiptSchema,
  CommandRecordSchema,
  ObserverStopReceiptSchema,
} from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { waitForSocketClosed } from "../support/sockets";
import { createTempState, writeConfigToml } from "../support/temp-projects";

describe("production Observer SQLite smoke", () => {
  it("reloads a successful command after a real Observer restart", async () => {
    const fixture = await createTempState();
    const home = join(fixture.root, "home");
    const configPath = await writeConfigToml(fixture.root, {
      ...fixture.config,
      defaults: {
        worktreeProvider: "noop-worktree",
        terminal: "noop-terminal",
        harness: "noop-harness",
        layout: "agent-shell",
      },
    });
    await mkdir(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      STATION_FAST_POPUP_NO_FALLBACK: "1",
      TMUX: "",
    };
    const client = createObserverClient({ socketPath: fixture.socketPath, timeoutMs: 1_000 });
    const databasePath = join(fixture.stateDir, "observer.sqlite");

    try {
      const dispatchedOutput = jsonObject(
        runStnJson(
          ["--config", configPath, "command", "dispatch", "--stdin", "--wait"],
          env,
          JSON.stringify({
            type: "observer.reconcile",
            payload: { reason: "production-sqlite-smoke" },
          }),
        ),
      );
      expect(dispatchedOutput.status).toBe("succeeded");
      const receipt = CommandReceiptSchema.parse(dispatchedOutput.receipt);
      const command = CommandRecordSchema.parse(dispatchedOutput.command);
      expect(receipt).toMatchObject({ accepted: true, status: "accepted" });
      expect(command).toMatchObject({
        status: "succeeded",
        command: {
          type: "observer.reconcile",
          payload: { reason: "production-sqlite-smoke" },
        },
      });
      const firstHealth = await client.health();
      expect(firstHealth.sqlite).toMatchObject({
        path: databasePath,
        open: true,
        status: "healthy",
      });
      expect((await stat(databasePath)).size).toBeGreaterThan(0);

      expect(
        ObserverStopReceiptSchema.parse(
          runStnJson(["--config", configPath, "observer", "stop"], env),
        ),
      ).toMatchObject({ stopped: true });
      await waitForSocketClosed(fixture.socketPath);

      // command.get starts a new production process, so equality proves the record came from disk.
      const reloaded = jsonObject(
        runStnJson(["--config", configPath, "command", "get", receipt.commandId], env),
      );
      expect(CommandRecordSchema.parse(reloaded.command)).toEqual(command);
      const secondHealth = await client.health();
      expect(secondHealth.pid).not.toBe(firstHealth.pid);
      expect(secondHealth.sqlite).toMatchObject({
        path: databasePath,
        open: true,
        status: "healthy",
      });
    } finally {
      await client.stop().catch(() => undefined);
      await waitForSocketClosed(fixture.socketPath).catch(() => undefined);
      await fixture.cleanup();
    }
  });
});

function runStnJson(args: readonly string[], env: NodeJS.ProcessEnv, input?: string): unknown {
  const result = spawnSync(join(process.cwd(), "bin", "stn"), args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    input,
    timeout: 60_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `stn ${args.join(" ")} failed with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as unknown;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stn JSON output was not an object.");
  }
  return value as Record<string, unknown>;
}
