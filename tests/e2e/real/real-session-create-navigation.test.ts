import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionView, StationSnapshot, WorktreeRow } from "@station/contracts";
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
  activeTmuxPane,
  captureTmuxPane,
  closeRealTmuxEndpoint,
  displayStationPopupAndSendKey,
  inspectTmuxClient,
  launchNativeStationInTmux,
  startAttachedTmuxPtyClient,
} from "../../support/real-station/tmux";
import {
  createRealWorktrunkWorktree,
  removeRealWorktrunkWorktree,
} from "../../support/real-station/worktrunk";

const describeReal = realE2eEnabled() ? describe : describe.skip;

describeReal("real dashboard session-create navigation", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("lands native New Session on the exact created native pane", async () => {
    cleanup = new CleanupStack();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const config = await writeRealStationConfig({
      env,
      repo,
      harnessProvider: "scripted",
      scriptedCommand: process.execPath,
      sessionCreatePolicy: {
        focusCreatedSession: true,
        dismissDashboard: true,
        terminals: {
          native: { focusCreatedSession: true, dismissDashboard: true },
        },
      },
    });
    cleanup.defer(() => closeRealTmuxEndpoint(config.tmuxEndpoint));
    cleanup.defer(() =>
      runStationJson(env, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      }),
    );
    await runStationJson(env, {
      configPath: config.configPath,
      args: ["reconcile", "--reason", "real-native-create-navigation"],
      timeoutMs: 60_000,
    });
    const observer = createRealObserverClient(config, 30_000);
    const baseline = await observer.getSnapshot({ includeDebug: true });
    const nativeSession = uniqueTmuxSession("station-real-native-create");
    const launched = await launchNativeStationInTmux({
      env,
      endpoint: config.tmuxEndpoint,
      configPath: config.configPath,
      observerSocketPath: config.socketPath,
      stateDir: config.stateDir,
      sessionName: nativeSession,
      cwd: repo.repoPath,
    });
    const terminal = await startAttachedTmuxPtyClient({
      endpoint: config.tmuxEndpoint,
      sessionName: nativeSession,
    });
    cleanup.defer(terminal.close);

    await waitForPaneText(config.tmuxEndpoint, launched.target, "station real E2E");
    await terminal.write(Buffer.from("N", "utf8"));
    await waitForPaneText(config.tmuxEndpoint, launched.target, "New Session");
    await terminal.write(Buffer.from("C", "utf8"));

    const created = await waitForSnapshot(
      observer,
      (snapshot) => exactNewSession(snapshot, baseline)?.terminal?.provider === "native",
      "Native New Session did not expose one exact new native session.",
      90_000,
    );
    const session = exactNewSession(created, baseline);
    if (session === undefined) throw new Error("Native created-session identity was ambiguous.");
    const row = created.rows.find((candidate) => candidate.id === session.worktreeId);
    if (row === undefined) throw new Error("Native created worktree row was missing.");
    cleanup.defer(() => removeRealWorktrunkWorktree({ env, config, repo, branch: row.branch }));

    await waitForPaneText(config.tmuxEndpoint, launched.target, row.branch);
    expect(
      await captureTmuxPane({ endpoint: config.tmuxEndpoint, target: launched.target }),
    ).not.toContain("New Session");
  }, 180_000);

  it.each([
    [false, false],
    [true, true],
  ] as const)(
    "applies tmux Quick Group focus=%s dismiss=%s to the exact durable target",
    async (focusCreatedSession, dismissDashboard) => {
      cleanup = new CleanupStack();
      const fixture = await createTmuxPopupFixture({
        env,
        cleanup,
        focusCreatedSession,
        dismissDashboard,
      });
      const markerPath = join(
        fixture.repo.root,
        `session-create-${focusCreatedSession}-${dismissDashboard}.marker`,
      );
      const popup = await displayStationPopupAndSendKey({
        env,
        endpoint: fixture.config.tmuxEndpoint,
        client: fixture.terminal,
        configPath: fixture.config.configPath,
        target: fixture.initialTarget,
        expectedWindowName: fixture.initialWindowName,
        expectedPaneId: fixture.initialPaneId,
        key: "G",
        markerPath,
      });
      cleanup.defer(() => popup.release(false));

      const created = await waitForSnapshot(
        fixture.observer,
        (snapshot) => createdQuickGroupTarget(snapshot, fixture.baseline) !== undefined,
        "Quick Group did not converge through create, session launch, and membership.",
        90_000,
      );
      const target = createdQuickGroupTarget(created, fixture.baseline);
      if (target === undefined)
        throw new Error("Quick Group target was not exact after convergence.");
      cleanup.defer(() =>
        removeRealWorktrunkWorktree({
          env,
          config: fixture.config,
          repo: fixture.repo,
          branch: target.row.branch,
        }),
      );
      const finalWindowName = workbenchWindowName(target.row);
      const finalTarget = `${fixture.config.tmuxSession}:${finalWindowName}.0`;
      const finalPaneId = await activeTmuxPane(fixture.config.tmuxEndpoint, finalTarget);

      if (!focusCreatedSession) {
        expect(
          await inspectTmuxClient(fixture.config.tmuxEndpoint, fixture.terminal.clientName),
        ).toBe(
          `${fixture.terminal.clientName}\t${fixture.terminal.clientPid}\t${fixture.config.tmuxSession}\t${fixture.initialWindowName}\t${fixture.initialPaneId}`,
        );
        expect(await readFile(markerPath, "utf8")).not.toContain("child-exit");
        await popup.release(false);
        return;
      }

      const expectedView = `${fixture.terminal.clientName}\t${fixture.terminal.clientPid}\t${fixture.config.tmuxSession}\t${finalWindowName}\t${finalPaneId}`;
      await waitForTmuxClientView(
        fixture.config.tmuxEndpoint,
        fixture.terminal.clientName,
        expectedView,
      );
      await popup.release(true, { windowName: finalWindowName, paneId: finalPaneId });
      expect(target.group.sessionIds).toContain(target.session.id);
    },
    180_000,
  );
});

async function createTmuxPopupFixture(input: {
  env: RealE2eEnvironment;
  cleanup: CleanupStack;
  focusCreatedSession: boolean;
  dismissDashboard: boolean;
}) {
  const repo = await createRealTempRepo(input.env);
  input.cleanup.defer(repo.cleanup);
  const config = await writeRealStationConfig({
    env: input.env,
    repo,
    harnessProvider: "scripted",
    scriptedCommand: process.execPath,
    sessionCreatePolicy: {
      focusCreatedSession: input.focusCreatedSession,
      dismissDashboard: input.dismissDashboard,
      terminals: {
        tmux: {
          focusCreatedSession: input.focusCreatedSession,
          dismissDashboard: input.dismissDashboard,
        },
      },
    },
  });
  input.cleanup.defer(() => closeRealTmuxEndpoint(config.tmuxEndpoint));
  input.cleanup.defer(() =>
    runStationJson(input.env, {
      configPath: config.configPath,
      args: ["observer", "stop"],
    }),
  );
  const branch = uniqueBranch("create-nav-base");
  input.cleanup.defer(() => removeRealWorktrunkWorktree({ env: input.env, config, repo, branch }));
  await createRealWorktrunkWorktree({ env: input.env, config, repo, branch });
  await runStationJson(input.env, {
    configPath: config.configPath,
    args: ["reconcile", "--reason", "real-session-create-navigation-baseline"],
    timeoutMs: 60_000,
  });
  const observer = createRealObserverClient(config, 30_000);
  const discovered = await waitForSnapshot(
    observer,
    (snapshot) => snapshot.rows.some((row) => row.branch === branch),
    "Observer did not discover the popup baseline worktree.",
    60_000,
  );
  const initialRow = findRowByBranch(discovered, branch);
  const receipt = await observer.dispatch({
    type: "session.startAgent",
    payload: {
      projectId: config.projectId,
      worktreeId: initialRow.id,
      harness: { provider: "scripted", mode: "interactive" },
      terminal: { provider: "tmux", focus: false },
    },
  });
  await expect(
    waitForCommandRecord(observer, receipt.commandId, { timeoutMs: 60_000 }),
  ).resolves.toMatchObject({
    status: "succeeded",
  });
  const baseline = await waitForSnapshot(
    observer,
    (snapshot) =>
      snapshot.sessions.some(
        (session) => session.worktreeId === initialRow.id && session.terminal?.provider === "tmux",
      ),
    "Popup baseline session did not expose its tmux target.",
    60_000,
  );
  const initialWindowName = workbenchWindowName(initialRow);
  const initialTarget = `${config.tmuxSession}:${initialWindowName}.0`;
  const initialPaneId = await activeTmuxPane(config.tmuxEndpoint, initialTarget);
  const terminal = await startAttachedTmuxPtyClient({
    endpoint: config.tmuxEndpoint,
    sessionName: config.tmuxSession,
  });
  input.cleanup.defer(terminal.close);
  return {
    repo,
    config,
    observer,
    baseline,
    terminal,
    initialTarget,
    initialWindowName,
    initialPaneId,
  };
}

function exactNewSession(
  snapshot: StationSnapshot,
  baseline: StationSnapshot,
): SessionView | undefined {
  const baselineIds = new Set(baseline.sessions.map((session) => session.id));
  const created = snapshot.sessions.filter((session) => !baselineIds.has(session.id));
  return created.length === 1 ? created[0] : undefined;
}

function createdQuickGroupTarget(snapshot: StationSnapshot, baseline: StationSnapshot) {
  const baselineGroupIds = new Set(baseline.sessionGroups.map((group) => group.id));
  const baselineSessionIds = new Set(baseline.sessions.map((session) => session.id));
  const groups = snapshot.sessionGroups.filter((group) => !baselineGroupIds.has(group.id));
  if (groups.length !== 1) return undefined;
  const group = groups[0];
  if (group === undefined) return undefined;
  const sessions = snapshot.sessions.filter(
    (session) => !baselineSessionIds.has(session.id) && group.sessionIds.includes(session.id),
  );
  const session = sessions.length === 1 ? sessions[0] : undefined;
  if (session?.terminal?.provider !== "tmux") return undefined;
  const row = snapshot.rows.find(
    (candidate) => candidate.id === session.worktreeId && candidate.projectId === session.projectId,
  );
  return row === undefined ? undefined : { group, session, row };
}

function workbenchWindowName(row: WorktreeRow): string {
  return buildWorkbenchWindowName({
    projectId: row.projectId,
    branch: row.branch,
    worktreeId: row.id,
    path: row.path,
  });
}

async function waitForPaneText(
  endpoint: Parameters<typeof captureTmuxPane>[0]["endpoint"],
  target: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let frame = "";
  while (Date.now() <= deadline) {
    frame = await captureTmuxPane({ endpoint, target });
    if (frame.includes(expected)) return;
    await delay(250);
  }
  throw new Error(`Station pane did not render ${expected}.\nLast frame:\n${frame}`);
}

async function waitForTmuxClientView(
  endpoint: Parameters<typeof inspectTmuxClient>[0],
  clientName: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let view = "";
  while (Date.now() <= deadline) {
    view = await inspectTmuxClient(endpoint, clientName);
    if (view === expected) return;
    await delay(250);
  }
  throw new Error(`tmux client did not reach ${expected}; last view was ${view}.`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
