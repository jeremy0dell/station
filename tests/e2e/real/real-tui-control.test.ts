import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StationSnapshot } from "@station/contracts";
import { ScriptedAgentEventSchema } from "@station/scripted-harness";
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
import {
  createRealObserverClient,
  waitForCommandRecord,
  waitForSnapshot,
} from "../../support/real-station/protocol";
import { createRealTempRepo, uniqueBranch } from "../../support/real-station/repo";
import {
  captureTmuxPane,
  closeRealTmuxEndpoint,
  killTmuxWindow,
  listTmuxWindows,
  type RealTmuxEndpoint,
  sendTmuxKeys,
  startStationTuiInTmux,
} from "../../support/real-station/tmux";
import {
  createRealWorktrunkWorktree,
  removeRealWorktrunkWorktree,
} from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

describeReal("real TUI stale-terminal recovery", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("starts fresh in place from a retained dead tmux pane and closes after the terminal disappears", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({
      env,
      repo,
      harnessProvider: "scripted",
      scriptedCommand: process.execPath,
    });
    const endpoint = config.tmuxEndpoint;
    cleanup.defer(() => closeRealTmuxEndpoint(endpoint));
    const tuiSession = uniqueTmuxSession("station-real-stale-tui");
    cleanup.defer(async () => {
      await runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      });
    });
    const branch = uniqueBranch("stale-tui");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env, config, repo, branch });
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-stale-tui-preload"],
      timeoutMs: 60_000,
    });

    const client = createRealObserverClient(config, 30_000);
    const initial = await waitForSnapshot(
      client,
      (snapshot) => findMaybeRow(snapshot, branch) !== undefined,
      "Observer did not discover the scripted stale-terminal worktree.",
      60_000,
    );
    const initialRow = findRowByBranch(initial, branch);
    const startReceipt = await client.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: config.projectId,
        worktreeId: initialRow.id,
        harness: { provider: "scripted", mode: "interactive" },
        terminal: { provider: "tmux", focus: false },
      },
    });
    await expect(
      waitForCommandRecord(client, startReceipt.commandId, { timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await waitForScriptedLaunchCount(config.stateDir, 1);

    const stale = await waitForSnapshot(
      client,
      (snapshot) => {
        const row = findMaybeRow(snapshot, branch);
        return (
          row?.terminal?.state === "stale" &&
          snapshot.sessions.some(
            (session) => session.origin === "station" && session.worktreeId === row.id,
          )
        );
      },
      "The scripted process exited without leaving a retained stale tmux target.",
      60_000,
    );
    const staleRow = findRowByBranch(stale, branch);
    const retainedSession = stale.sessions.find(
      (session) => session.origin === "station" && session.worktreeId === staleRow.id,
    );
    if (retainedSession === undefined) {
      throw new Error("Observer did not retain the scripted Station session.");
    }

    const groupReceipt = await client.dispatch({
      type: "sessionGroup.create",
      payload: {
        projectId: config.projectId,
        name: "Stale recovery",
        initialSessionIds: [retainedSession.id],
      },
    });
    await expect(
      waitForCommandRecord(client, groupReceipt.commandId, { timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const grouped = await waitForSnapshot(
      client,
      (snapshot) =>
        snapshot.sessionGroups.some((group) => group.sessionIds.includes(retainedSession.id)),
      "Observer did not Group the retained scripted session.",
      30_000,
    );
    const sessionBefore = grouped.sessions.find((session) => session.id === retainedSession.id);
    const groupBefore = grouped.sessionGroups.find((group) =>
      group.sessionIds.includes(retainedSession.id),
    );
    if (sessionBefore === undefined || groupBefore === undefined) {
      throw new Error("Grouped stale-session baseline was incomplete.");
    }
    const windowName = expectedWindowName(config.projectId, branch, staleRow.id, staleRow.path);
    await expect(listTmuxWindows(endpoint, config.tmuxSession)).resolves.toEqual([windowName]);

    await startStationTuiInTmux({
      env,
      endpoint,
      configPath: config.configPath,
      sessionName: tuiSession,
    });
    await waitForTuiText(endpoint, tuiSession, "Stale recovery");
    await sendTmuxKeys({ endpoint, target: tuiSession, keys: ["1"] });
    await waitForTuiText(endpoint, tuiSession, "Start fresh (Y)");
    await sendTmuxKeys({ endpoint, target: tuiSession, keys: ["y"] });
    await waitForScriptedLaunchCount(config.stateDir, 2);

    const restarted = await waitForSnapshot(
      client,
      (snapshot) => {
        const sessions = snapshot.sessions.filter(
          (session) => session.worktreeId === staleRow.id && session.origin === "station",
        );
        const group = snapshot.sessionGroups.find((candidate) => candidate.id === groupBefore.id);
        return (
          sessions.length === 1 &&
          sessions[0]?.id === retainedSession.id &&
          group?.version === groupBefore.version &&
          group.sessionIds.length === 1 &&
          group.sessionIds[0] === retainedSession.id
        );
      },
      "Fresh start did not converge under the retained session and Group identity.",
      60_000,
    );
    const sessionAfter = restarted.sessions.find((session) => session.id === retainedSession.id);
    const groupAfter = restarted.sessionGroups.find((group) => group.id === groupBefore.id);
    expect(sessionAfter).toMatchObject({
      id: sessionBefore.id,
      projectId: sessionBefore.projectId,
      worktreeId: sessionBefore.worktreeId,
      origin: sessionBefore.origin,
      createdAt: sessionBefore.createdAt,
      title: sessionBefore.title,
    });
    expect(groupAfter).toEqual(groupBefore);
    expect(restarted.sessions.filter((session) => session.worktreeId === staleRow.id)).toHaveLength(
      1,
    );
    await expect(listTmuxWindows(endpoint, config.tmuxSession)).resolves.toEqual([windowName]);
    await expect(scriptedLaunchCount(config.stateDir)).resolves.toBe(2);

    await killTmuxWindow(endpoint, `${config.tmuxSession}:${windowName}`);
    await waitForSnapshot(
      client,
      (snapshot) => findMaybeRow(snapshot, branch)?.terminal === undefined,
      "Observer still projected a terminal after the workbench window was removed.",
      30_000,
    );
    const closeReceipt = await client.dispatch({
      type: "session.close",
      payload: { sessionId: retainedSession.id, mode: "all" },
    });
    await expect(
      waitForCommandRecord(client, closeReceipt.commandId, { timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await waitForSnapshot(
      client,
      (snapshot) => !snapshot.sessions.some((session) => session.id === retainedSession.id),
      "Session close did not remove durable Station membership.",
      30_000,
    );

    await runStationJson(env, {
      configPath: config.configPath,
      args: ["observer", "stop"],
    });
    const afterRestart = await runStationJson<StationSnapshot>(env, {
      configPath: config.configPath,
      args: ["snapshot", "--json"],
      timeoutMs: 30_000,
    });
    expect(afterRestart.sessions.some((session) => session.id === retainedSession.id)).toBe(false);
    expect(
      afterRestart.sessionGroups.find((group) => group.id === groupBefore.id)?.sessionIds,
    ).toEqual([]);
  }, 180_000);
});

async function waitForTuiText(
  endpoint: RealTmuxEndpoint,
  target: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let captured = "";
  while (Date.now() <= deadline) {
    captured = await captureTmuxPane({ endpoint, target });
    if (captured.includes(expected)) {
      return;
    }
    await delay(500);
  }
  throw new Error(`TUI did not render ${expected}.\nLast captured frame:\n${captured}`);
}

async function waitForScriptedLaunchCount(stateDir: string, expected: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const count = await scriptedLaunchCount(stateDir);
    if (count === expected) return;
    if (count > expected) {
      throw new Error(`Scripted harness launched ${count} times; expected ${expected}.`);
    }
    await delay(250);
  }
  throw new Error(`Scripted harness did not reach ${expected} launches.`);
}

async function scriptedLaunchCount(stateDir: string): Promise<number> {
  const runsDir = join(stateDir, "scripted", "runs");
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  let launches = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const contents = await readFile(join(runsDir, entry.name), "utf8");
    for (const line of contents.split(/\r?\n/).filter(Boolean)) {
      if (ScriptedAgentEventSchema.parse(JSON.parse(line)).type === "started") {
        launches += 1;
      }
    }
  }
  return launches;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
