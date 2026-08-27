import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StationEvent, StationSnapshot } from "@station/contracts";
import { buildWorkbenchWindowName } from "@station/tmux";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findRowByBranch } from "../../support/real-station/assertions";
import { createRealCodexFixture } from "../../support/real-station/codex";
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
  closeRealTmuxEndpoint,
  displayStationPopupAndSendKey,
  inspectTmuxClient,
  startAttachedTmuxPtyClient,
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
    const codex = await createRealCodexFixture({ env, repo });
    const testEnv = codex.env;
    const config = await writeRealStationConfig({
      env: testEnv,
      repo,
      codexCommand: codex.codexCommand,
      installCodexHooks: true,
    });
    cleanup.defer(() => closeRealTmuxEndpoint(config.tmuxEndpoint));
    await codex.installHooks(config);
    cleanup.defer(async () => {
      await runStationJson(testEnv, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      });
    });
    const branch = uniqueBranch("popup");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env: testEnv, config, repo, branch });
    });
    await createRealWorktrunkWorktree({ env: testEnv, config, repo, branch });
    await runStationJson(testEnv, {
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
    const sessionId = agentRow.agent?.sessionId;
    if (sessionId === undefined) throw new Error("Popup agent did not expose a session id.");
    const windowName = expectedWindowName(config.projectId, branch, agentRow.id, agentRow.path);
    const target = `${config.tmuxSession}:${windowName}.0`;
    const paneId = await activeTmuxPane(config.tmuxEndpoint, target);
    const markerPath = join(repo.root, "popup-navigation.marker");
    const tmuxClient = await startAttachedTmuxPtyClient({
      endpoint: config.tmuxEndpoint,
      sessionName: config.tmuxSession,
    });
    cleanup.defer(tmuxClient.close);
    const events = client.subscribe({ type: ["command.accepted"] })[Symbol.asyncIterator]();
    const startRead = (): Promise<IteratorResult<StationEvent>> => {
      const read = events.next();
      // Attach a handler immediately while preserving the original rejecting promise for the waiter.
      void read.catch(() => undefined);
      return read;
    };
    let pendingRead = startRead();
    const waitForAccepted = async (
      matches: (event: AcceptedEvent) => boolean,
      timeoutMs: number,
    ): Promise<AcceptedEvent | undefined> => {
      const deadline = Date.now() + timeoutMs;
      for (let seen = 0; seen < 32; seen += 1) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          pendingRead,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          }),
        ]).finally(() => clearTimeout(timer));
        if (next === undefined) return undefined;
        pendingRead = startRead();
        if (next.done) throw new Error("Popup accepted-event stream ended.");
        if (next.value.type === "command.accepted" && matches(next.value)) return next.value;
        if (Date.now() >= deadline) return undefined;
      }
      return undefined;
    };
    cleanup.defer(async () => {
      const returning = events.return?.();
      if (returning === undefined) return;
      void returning.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        returning,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Popup event iterator did not close.")), 5_000);
        }),
      ]).finally(() => clearTimeout(timer));
    });
    const correlation = `${process.pid}-${Date.now().toString(36)}`;
    const readinessDeadline = Date.now() + 15_000;
    let subscriptionReady = false;
    for (let attempt = 1; attempt <= 3 && !subscriptionReady; attempt += 1) {
      const reason = `real-popup-subscription-ready-${correlation}-${attempt}`;
      const readiness = await client.dispatch({
        type: "observer.reconcile",
        payload: { reason },
      });
      subscriptionReady =
        (await waitForAccepted(
          (event) =>
            event.commandId === readiness.commandId &&
            event.command.type === "observer.reconcile" &&
            event.command.payload.reason === reason,
          Math.min(5_000, Math.max(1, readinessDeadline - Date.now())),
        )) !== undefined;
    }
    if (!subscriptionReady) throw new Error("Popup subscription missed three readiness commands.");
    const focusAccepted = waitForAccepted(
      (event) =>
        event.command.type === "terminal.focus" &&
        event.command.payload.sessionId === sessionId &&
        event.command.payload.origin?.provider === "tmux" &&
        event.command.payload.origin.clientId === tmuxClient.clientName,
      60_000,
    ).then((event) => {
      if (event === undefined) {
        throw new Error("Popup did not emit the correlated terminal.focus acceptance event.");
      }
      return event;
    });
    void focusAccepted.catch(() => undefined);

    const popup = await displayStationPopupAndSendKey({
      env: testEnv,
      endpoint: config.tmuxEndpoint,
      client: tmuxClient,
      configPath: config.configPath,
      target,
      expectedWindowName: windowName,
      expectedPaneId: paneId,
      key: "1",
      markerPath,
    });
    cleanup.defer(() => popup.release(false));

    let causalSuccess = false;
    let primaryFailure: unknown;
    try {
      const accepted = await focusAccepted;
      await expect(
        waitForCommandRecord(client, accepted.commandId, { timeoutMs: 60_000 }),
      ).resolves.toMatchObject({ status: "succeeded" });
      await expect(inspectTmuxClient(config.tmuxEndpoint, tmuxClient.clientName)).resolves.toBe(
        `${tmuxClient.clientName}\t${tmuxClient.clientPid}\t${config.tmuxSession}\t${windowName}\t${paneId}`,
      );
      causalSuccess = true;
    } catch (error) {
      primaryFailure = error;
    }
    try {
      await popup.release(causalSuccess);
    } catch (cleanupFailure) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, cleanupFailure],
          "popup proof and release failed",
        );
      }
      throw cleanupFailure;
    }
    if (primaryFailure !== undefined) throw primaryFailure;

    const marker = await readFile(markerPath, "utf8");
    expect(marker).toContain("popup-started");
    expect(marker).toContain("key-sent");
    expect(marker).toContain("child-exit:0");
  }, 240_000);
});

function findMaybeRow(snapshot: StationSnapshot, branch: string) {
  return snapshot.rows.find((row) => row.branch === branch);
}

type AcceptedEvent = Extract<StationEvent, { type: "command.accepted" }>;

function expectedWindowName(
  projectId: string,
  branch: string,
  worktreeId: string,
  path: string,
): string {
  return buildWorkbenchWindowName({ projectId, branch, worktreeId, path });
}
