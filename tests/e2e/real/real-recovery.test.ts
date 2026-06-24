import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRecord, StationCommand, StationSnapshot } from "@station/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertDebugBundleContains, findRowByBranch } from "../../support/real-station/assertions";
import { writeRealStationConfig } from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import { createRealTempRepo, uniqueBranch } from "../../support/real-station/repo";
import { killTmuxSession } from "../../support/real-station/tmux";
import {
  createRealWorktrunkWorktree,
  removeRealWorktrunkWorktree,
} from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

type CommandDispatchWaitResult = {
  status: "succeeded" | "failed";
  receipt: { commandId: string };
  command: CommandRecord;
};

describeReal("real observer recovery", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("recovers provider graph after observer restart and SQLite deletion", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({ env, repo });
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });

    const branch = uniqueBranch("recovery");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env, config, repo, branch });

    const first = await runStationJson<{ snapshot: StationSnapshot }>(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-recovery-before-delete"],
      timeoutMs: 60_000,
    });
    expect(findRowByBranch(first.snapshot, branch).id).toEqual(expect.any(String));

    const status = await runStationJson<{ health: { pid: number } }>(env, {
      configPath: config.configPath,
      args: ["observer", "status"],
    });
    process.kill(status.health.pid, "SIGTERM");
    await waitForObserverDown(env, config.configPath);

    await rm(join(config.stateDir, "observer.sqlite"), { force: true });
    const recovered = await runStationJson<{ snapshot: StationSnapshot }>(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-recovery-after-sqlite-delete"],
      timeoutMs: 60_000,
    });
    expect(findRowByBranch(recovered.snapshot, branch).id).toEqual(expect.any(String));
  }, 180_000);

  it("leaves debug evidence when a tmux target goes stale", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({ env, repo });
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });

    const branch = uniqueBranch("stale-tmux");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env, config, repo, branch });
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-stale-tmux-before"],
      timeoutMs: 60_000,
    });
    const snapshot = await runStationJson<StationSnapshot>(env, {
      configPath: config.configPath,
      args: ["snapshot", "--json"],
    });
    const row = findRowByBranch(snapshot, branch);
    const command: StationCommand = {
      type: "session.startAgent",
      payload: {
        projectId: config.projectId,
        worktreeId: row.id,
        harness: { provider: "codex", mode: "interactive" },
        terminal: { provider: "tmux", focus: true },
      },
    };
    const started = await runStationJson<CommandDispatchWaitResult>(env, {
      configPath: config.configPath,
      args: ["command", "dispatch", "--stdin", "--wait", "--timeout-ms", "90000"],
      stdin: JSON.stringify(command),
      timeoutMs: 100_000,
    });
    expect(started.status).toBe("succeeded");

    await killTmuxSession(env, config.tmuxSession);
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-stale-tmux-after-kill"],
      timeoutMs: 60_000,
    });
    const bundle = await runStationJson<{ bundlePath: string }>(env, {
      configPath: config.configPath,
      args: ["debug", "bundle", "--command", started.receipt.commandId],
      timeoutMs: 30_000,
    });
    await assertDebugBundleContains(bundle.bundlePath, "commands.jsonl", started.receipt.commandId);
    await assertDebugBundleContains(bundle.bundlePath, "provider-health.json", "tmux");
  }, 240_000);
});

async function waitForObserverDown(env: RealE2eEnvironment, configPath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() <= deadline) {
    const result = await runStationJson(env, {
      configPath,
      args: ["observer", "status"],
      timeoutMs: 5_000,
    }).catch(() => undefined);
    if (result === undefined || (result as { status?: string }).status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
