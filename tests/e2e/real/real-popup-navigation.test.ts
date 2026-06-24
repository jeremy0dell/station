import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StationSnapshot } from "@station/contracts";
import { buildWorkbenchWindowName } from "@station/tmux";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findRowByBranch } from "../../support/real-station/assertions";
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
import {
  activeTmuxPane,
  activeTmuxWindow,
  displayStationPopupAndSendKey,
  killTmuxSession,
} from "../../support/real-station/tmux";
import {
  createRealWorktrunkWorktree,
  removeRealWorktrunkWorktree,
} from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

describeReal("real tmux popup navigation", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("opens the real TUI in a tmux popup over the created agent pane and lands in that pane", async () => {
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

    const branch = uniqueBranch("popup");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env, config, repo, branch });
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-popup-preload"],
      timeoutMs: 60_000,
    });

    const client = createRealObserverClient(config, 30_000);
    const initialSnapshot = await waitForSnapshot(
      client,
      (candidate) => findMaybeRow(candidate, branch) !== undefined,
      "Observer did not discover the popup navigation worktree.",
      60_000,
    );
    const initialRow = findRowByBranch(initialSnapshot, branch);
    const receipt = await client.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: config.projectId,
        worktreeId: initialRow.id,
        harness: {
          provider: "codex",
          mode: "interactive",
        },
        terminal: {
          provider: "tmux",
          layout: "agent-build-shell",
        },
      },
    });
    await waitForCommandRecord(client, receipt.commandId, { timeoutMs: 120_000 });

    const agentSnapshot = await waitForSnapshot(
      client,
      (candidate) => findMaybeRow(candidate, branch)?.agent?.harness === "codex",
      "Observer did not attach a Codex agent before popup navigation.",
      120_000,
    );
    const agentRow = findRowByBranch(agentSnapshot, branch);
    const windowName = expectedWindowName(config.projectId, branch, agentRow.id, agentRow.path);
    const paneId = await activeTmuxPane(env, `${config.tmuxSession}:${windowName}.0`);
    const markerPath = join(repo.root, "popup-navigation.marker");

    await displayStationPopupAndSendKey({
      env,
      configPath: config.configPath,
      target: `${config.tmuxSession}:${windowName}.0`,
      key: "1",
      markerPath,
    });

    await expect(readFile(markerPath, "utf8")).resolves.toContain("popup-started");
    await expect(readFile(markerPath, "utf8")).resolves.toContain("key-sent");
    await expect(activeTmuxWindow(env, config.tmuxSession)).resolves.toBe(windowName);
    await expect(activeTmuxPane(env, config.tmuxSession)).resolves.toBe(paneId);
  }, 240_000);
});

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
