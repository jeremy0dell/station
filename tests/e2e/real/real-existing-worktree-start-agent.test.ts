import type { CommandRecord, StationCommand, StationSnapshot } from "@station/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findRowByBranch } from "../../support/real-station/assertions";
import {
  createCodexSentinel,
  waitForCodexSentinel,
  writeFailureBundle,
} from "../../support/real-station/codex";
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

describeReal("real existing Worktrunk worktree start-agent", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("starts Codex on a real Worktrunk-created worktree with no prior agent", async () => {
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

    const branch = uniqueBranch("existing");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env, config, repo, branch });

    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-existing-worktree"],
      timeoutMs: 60_000,
    });
    const before = await runStationJson<StationSnapshot>(env, {
      configPath: config.configPath,
      args: ["snapshot", "--json"],
      timeoutMs: 30_000,
    });
    const row = findRowByBranch(before, branch);
    expect(row.agent).toBeUndefined();

    const sentinel = createCodexSentinel(repo, "start-agent", row.path);
    const command: StationCommand = {
      type: "session.startAgent",
      payload: {
        projectId: config.projectId,
        worktreeId: row.id,
        harness: {
          provider: "codex",
          mode: "exec",
        },
        terminal: {
          provider: "tmux",
          focus: false,
        },
        initialPrompt: sentinel.prompt,
      },
    };

    let result: CommandDispatchWaitResult | undefined;
    try {
      result = await runStationJson<CommandDispatchWaitResult>(env, {
        configPath: config.configPath,
        args: ["command", "dispatch", "--stdin", "--wait", "--timeout-ms", "180000"],
        stdin: JSON.stringify(command),
        timeoutMs: 190_000,
      });
      expect(result.status).toBe("succeeded");
      await waitForCodexSentinel(sentinel, { rootPath: row.path });
      const after = await runStationJson<StationSnapshot>(env, {
        configPath: config.configPath,
        args: ["snapshot", "--json", "--include-debug"],
        timeoutMs: 30_000,
      });
      expect(findRowByBranch(after, branch).agent).toMatchObject({
        harness: "codex",
        sessionId: expect.any(String),
      });
    } catch (error) {
      await writeFailureBundle({
        env,
        configPath: config.configPath,
        commandId: result?.receipt.commandId,
      });
      throw error;
    }
  }, 300_000);
});
