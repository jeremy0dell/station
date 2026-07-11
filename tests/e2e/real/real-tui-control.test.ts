import type { StationSnapshot } from "@station/contracts";
import { buildWorkbenchWindowName } from "@station/tmux";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findRowByBranch } from "../../support/real-station/assertions";
import { uniqueTmuxSession, writeRealStationConfig } from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import { createRealObserverClient, waitForSnapshot } from "../../support/real-station/protocol";
import { createRealTempRepo, uniqueBranch } from "../../support/real-station/repo";
import {
  activeTmuxWindow,
  captureTmuxPane,
  killTmuxSession,
  sendTmuxKeys,
  startStationTuiInTmux,
} from "../../support/real-station/tmux";
import {
  createRealWorktrunkWorktree,
  removeRealWorktrunkWorktree,
} from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

describeReal("real TUI control", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("starts an agent and focuses the real tmux workbench through TUI key input", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({ env, repo });
    const tuiSession = uniqueTmuxSession("station-real-tui");
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }).catch(() => undefined);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, tuiSession);
    });
    cleanup.defer(async () => {
      await killTmuxSession(env, config.tmuxSession);
    });

    const branch = uniqueBranch("tui");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env, config, repo, branch });
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-tui-preload"],
      timeoutMs: 60_000,
    });

    await startStationTuiInTmux({
      env,
      configPath: config.configPath,
      sessionName: tuiSession,
    });
    await waitForTuiText(env, tuiSession, branch);
    await sendTmuxKeys({ env, target: tuiSession, keys: ["1"] });

    const client = createRealObserverClient(config, 30_000);
    const snapshot = await waitForSnapshot(
      client,
      (candidate) => findMaybeRow(candidate, branch)?.agent?.harness === "codex",
      "TUI did not start a Codex agent for the selected row.",
      120_000,
    );
    const row = findRowByBranch(snapshot, branch);
    expect(row.agent).toMatchObject({ harness: "codex" });

    await expect(activeTmuxWindow(env, config.tmuxSession)).resolves.toBe(
      expectedWindowName(config.projectId, branch, row.id, row.path),
    );
  }, 240_000);
});

async function waitForTuiText(
  env: RealE2eEnvironment,
  target: string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const captured = await captureTmuxPane({ env, target });
    if (captured.includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`TUI did not render ${text}.`);
}

function findMaybeRow(snapshot: StationSnapshot, branch: string) {
  return snapshot.rows.find((row) => row.branch === branch);
}

function expectedWindowName(
  projectId: string,
  branch: string,
  worktreeId: string,
  path: string,
): string {
  return buildWorkbenchWindowName({ projectId, branch, worktreeId, path });
}
