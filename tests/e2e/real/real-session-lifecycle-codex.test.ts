import type { CommandRecord, StationCommand } from "@station/contracts";
import { buildWorkbenchWindowName } from "@station/tmux";
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
import {
  createRealObserverClient,
  waitForCommandRecord,
  waitForSnapshot,
} from "../../support/real-station/protocol";
import { createRealTempRepo, uniqueBranch } from "../../support/real-station/repo";
import { killTmuxSession, listTmuxWindows } from "../../support/real-station/tmux";
import { removeRealWorktrunkWorktree } from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

type CommandDispatchWaitResult = {
  status: "succeeded" | "failed";
  receipt: { commandId: string };
  command: CommandRecord;
};

describeReal("real Codex session lifecycle", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("creates a real Worktrunk worktree, launches Codex, observes state, focuses, and removes it", async () => {
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

    const branch = uniqueBranch(
      "codex-lifecycle-customer-account-permissions-rollout-for-enterprise-alpha",
    );
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    const sentinel = createCodexSentinel(repo, "lifecycle");
    const createCommand: StationCommand = {
      type: "session.create",
      payload: {
        projectId: config.projectId,
        branch,
        harness: {
          provider: "codex",
          mode: "exec",
        },
        terminal: {
          provider: "tmux",
          layout: "agent-build-shell",
          focus: false,
        },
        initialPrompt: sentinel.prompt,
      },
    };

    let createResult: CommandDispatchWaitResult | undefined;
    try {
      createResult = await runStationJson<CommandDispatchWaitResult>(env, {
        configPath: config.configPath,
        args: ["command", "dispatch", "--stdin", "--wait", "--timeout-ms", "180000"],
        stdin: JSON.stringify(createCommand),
        timeoutMs: 190_000,
      });
      expect(createResult.status).toBe("succeeded");

      const client = createRealObserverClient(config);
      const snapshot = await waitForSnapshot(
        client,
        (candidate) => {
          try {
            const row = findRowByBranch(candidate, branch);
            return (
              row.agent?.harness === "codex" &&
              row.terminal?.hasPrimaryAgentEndpoint === true &&
              row.terminal.focusable === true
            );
          } catch {
            return false;
          }
        },
        `Timed out waiting for Codex row ${branch} to expose agent and terminal state.`,
        90_000,
      );
      const row = findRowByBranch(snapshot, branch);
      await waitForCodexSentinel(sentinel, { rootPath: row.path });
      expect(row.agent).toMatchObject({
        harness: "codex",
        sessionId: expect.any(String),
      });
      expect(row.terminal).toMatchObject({
        provider: "tmux",
        state: expect.stringMatching(/^(open|detached|unknown)$/),
        focusable: true,
        hasPrimaryAgentEndpoint: true,
      });
      await expect(listTmuxWindows(env, config.tmuxSession)).resolves.toContain(
        expectedWindowName(config.projectId, branch, row.id, row.path),
      );

      const focusCommand: StationCommand = {
        type: "terminal.focus",
        payload: { worktreeId: row.id },
      };
      const focusResult = await runStationJson<CommandDispatchWaitResult>(env, {
        configPath: config.configPath,
        args: ["command", "dispatch", "--stdin", "--wait", "--timeout-ms", "60000"],
        stdin: JSON.stringify(focusCommand),
        timeoutMs: 70_000,
      });
      expect(focusResult.status).toBe("succeeded");

      const removeCommand: StationCommand = {
        type: "worktree.remove",
        payload: {
          worktreeId: row.id,
          projectId: row.projectId,
          expectedPath: row.path,
          expectedBranch: row.branch,
          force: true,
        },
      };
      const removeReceipt = await client.dispatch(removeCommand);
      await expect(
        waitForCommandRecord(client, removeReceipt.commandId, { timeoutMs: 90_000 }),
      ).resolves.toMatchObject({
        status: "succeeded",
      });
    } catch (error) {
      await writeFailureBundle({
        env,
        configPath: config.configPath,
        commandId: createResult?.receipt.commandId,
      });
      throw error;
    }
  }, 300_000);
});

function expectedWindowName(
  projectId: string,
  branch: string,
  worktreeId: string,
  path: string,
): string {
  return buildWorkbenchWindowName({ projectId, branch, worktreeId, path });
}
