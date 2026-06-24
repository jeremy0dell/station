import {
  type CommandRecord,
  ObserverEventHookInvocationSchema,
  type StationCommand,
  type StationSnapshot,
} from "@station/contracts";
import { buildWorkbenchWindowName } from "@station/tmux";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertDebugBundleContains, findRowByBranch } from "../../support/real-station/assertions";
import {
  createCodexHookEnabledWrapper,
  createCodexSentinel,
  installCodexHookProjectConfig,
  waitForCodexSentinel,
  writeFailureBundle,
} from "../../support/real-station/codex";
import { writeRealStationConfig } from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { createRealNotifyHookCapture, waitForNotifyEvent } from "../../support/real-station/notify";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import { createRealTempRepo, uniqueBranch } from "../../support/real-station/repo";
import {
  activeTmuxPane,
  captureTmuxPane,
  killTmuxSession,
  sendTmuxKeys,
} from "../../support/real-station/tmux";
import { removeRealWorktrunkWorktree } from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

type CommandDispatchWaitResult = {
  status: "succeeded" | "failed";
  receipt: { commandId: string };
  command: CommandRecord;
};

describeReal("real Codex hook ingestion", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("launches Codex in tmux and ingests actual Codex lifecycle/tool hooks through observer", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const codexCommand = await createCodexHookEnabledWrapper({ env, repo });
    const notify = await createRealNotifyHookCapture(repo.root);
    const config = await writeRealStationConfig({
      env,
      repo,
      codexCommand,
      installCodexHooks: true,
      eventHook: {
        command: notify.command,
        args: notify.args,
      },
    });
    const hooks = await installCodexHookProjectConfig({
      env,
      repo,
      configPath: config.configPath,
    });
    cleanup.defer(hooks.cleanup);
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });

    const branch = uniqueBranch("codex-hooks");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    const sentinel = createCodexSentinel(repo, "hooks");
    const createCommand: StationCommand = {
      type: "session.create",
      payload: {
        projectId: config.projectId,
        branch,
        harness: {
          provider: "codex",
          mode: "interactive",
        },
        terminal: {
          provider: "tmux",
          layout: "agent-build-shell",
          focus: true,
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

      const row = await waitForRowTerminalAttachment({
        env,
        configPath: config.configPath,
        branch,
        timeoutMs: 90_000,
      });
      await continuePastCodexStartupPrompts(env, config.tmuxSession, row);
      await waitForCodexSentinel(sentinel, { rootPath: row.path, timeoutMs: 240_000 });
      const idleRow = await waitForRowAgentState({
        env,
        configPath: config.configPath,
        branch,
        states: ["idle"],
        timeoutMs: 180_000,
      });
      expect(idleRow.agent).toMatchObject({
        harness: "codex",
        state: "idle",
        sessionId: expect.any(String),
      });
      await expect(
        waitForNotifyEvent(notify.logPath, (event) => notifyEventMatches(event, "codex"), 60_000),
      ).resolves.toMatchObject({
        hookId: "notify-agent-idle",
        event: {
          type: "worktree.agentStateChanged",
          agent: {
            harness: "codex",
            state: "idle",
          },
        },
      });

      const bundle = await runStationJson<{ bundlePath: string }>(env, {
        configPath: config.configPath,
        args: ["debug", "bundle"],
        timeoutMs: 30_000,
      });
      await assertDebugBundleContains(bundle.bundlePath, "events.jsonl", "harness.eventReported");
      await assertDebugBundleContains(bundle.bundlePath, "events.jsonl", '"provider":"codex"');
      await assertDebugBundleContains(
        bundle.bundlePath,
        "events.jsonl",
        '"eventType":"PreToolUse"',
      );
      await assertDebugBundleContains(
        bundle.bundlePath,
        "logs/observer.jsonl",
        "harness-report:codex",
      );
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

async function waitForRowAgentState(input: {
  env: RealE2eEnvironment;
  configPath: string;
  branch: string;
  states: Array<NonNullable<StationSnapshot["rows"][number]["agent"]>["state"]>;
  timeoutMs: number;
}): Promise<StationSnapshot["rows"][number]> {
  const allowed = new Set(input.states);
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await runStationJson<StationSnapshot>(input.env, {
        configPath: input.configPath,
        args: ["snapshot", "--json", "--include-debug"],
        timeoutMs: 30_000,
      });
      const row = findRowByBranch(snapshot, input.branch);
      if (row.agent !== undefined && allowed.has(row.agent.state)) {
        return row;
      }
    } catch {
      // The branch can be absent briefly while the session command settles.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Timed out waiting for Codex row ${input.branch} to enter ${input.states.join("/")}.`,
  );
}

async function waitForRowTerminalAttachment(input: {
  env: RealE2eEnvironment;
  configPath: string;
  branch: string;
  timeoutMs: number;
}): Promise<StationSnapshot["rows"][number]> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await runStationJson<StationSnapshot>(input.env, {
        configPath: input.configPath,
        args: ["snapshot", "--json", "--include-debug"],
        timeoutMs: 30_000,
      });
      const row = findRowByBranch(snapshot, input.branch);
      if (row.terminal?.hasPrimaryAgentEndpoint === true && row.terminal.focusable === true) {
        return row;
      }
      await runStationJson(input.env, {
        configPath: input.configPath,
        args: ["reconcile", "--reason", "real-codex-hooks-terminal-poll"],
        timeoutMs: 60_000,
      }).catch(() => undefined);
    } catch {
      // The branch can be absent briefly while the session command settles.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for Codex row ${input.branch} to get terminal attachment.`);
}

async function continuePastCodexStartupPrompts(
  env: RealE2eEnvironment,
  tmuxSession: string,
  row: StationSnapshot["rows"][number],
): Promise<void> {
  const target = await activeTmuxPane(
    env,
    `${tmuxSession}:${buildWorkbenchWindowName({
      projectId: row.projectId,
      branch: row.branch,
      worktreeId: row.id,
      path: row.path,
    })}.0`,
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const captured = await captureTmuxPane({ env, target });
    if (captured.includes("Do you trust the contents of this directory?")) {
      await sendTmuxKeys({ env, target, keys: ["1", "Enter"] });
    }
    if (captured.includes("hooks need review") && captured.includes("Press t to trust all")) {
      await sendTmuxKeys({ env, target, keys: ["t"] });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function notifyEventMatches(event: unknown, harness: string): boolean {
  const parsed = ObserverEventHookInvocationSchema.safeParse(event);
  if (!parsed.success) {
    return false;
  }
  const inner = parsed.data.event;
  if (inner.type !== "worktree.agentStateChanged") return false;
  const agent = inner.agent;
  return agent?.harness === harness && agent.state === "idle";
}
