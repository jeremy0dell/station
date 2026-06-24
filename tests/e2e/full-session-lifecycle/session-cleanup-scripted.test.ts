import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
  startObserverServer,
} from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";
import {
  createFakeHarnessRun,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createTempSocketPath } from "../../support/sockets";

const now = "2026-05-21T12:00:00.000Z";

describe("full session cleanup e2e", () => {
  it("starts and removes a fake session through protocol commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-session-cleanup-e2e-"));
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    const { socketPath } = await createTempSocketPath();
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
    const harness = new FakeHarnessProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        harness.addRun(
          createFakeHarnessRun({
            id: "run_web_cleanup",
            projectId: "web",
            worktreeId: "wt_web_cleanup",
            sessionId: launchPlan.env?.STATION_SESSION_ID,
            state: "working",
            now,
          }),
        );
      },
    });
    const config = configFor(root, stateDir, socketPath);
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_cleanup",
            projectId: "web",
            branch: "cleanup",
            now,
          }),
        ],
      }),
      terminal,
      harnesses: [harness],
    });
    const core = createObserverCore({ config, providers, persistence, sqlite, clock });
    registerObserverCommandHandlers({
      queue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
      idFactory: {
        sessionId: () => "ses_web_cleanup",
      },
    });
    const api = createObserverApi({
      core,
      persistence,
      commandQueue: queue,
      eventBus,
      clock,
      socketPath,
      stateDir,
    });
    const server = await startObserverServer({ socketPath, api, clock, drainOnStart: false });
    const client = createObserverClient({ socketPath, requestId: requestIds() });

    try {
      await client.reconcile("pre-cleanup-e2e");
      const startReceipt = await client.dispatch({
        type: "session.startAgent",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_cleanup",
          harness: { provider: "fake-harness", mode: "interactive" },
          terminal: { provider: "fake-terminal", focus: true },
        },
      });
      await client.waitForCommand(startReceipt.commandId, { timeoutMs: 1000 });

      await expect(client.getSnapshot()).resolves.toMatchObject({
        rows: [
          {
            id: "wt_web_cleanup",
            agent: {
              state: "working",
              sessionId: "ses_web_cleanup",
            },
          },
        ],
      });

      const removeReceipt = await client.dispatch({
        type: "worktree.remove",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_cleanup",
          force: true,
        },
      });
      await client.waitForCommand(removeReceipt.commandId, { timeoutMs: 1000 });

      await expect(client.getSnapshot()).resolves.toMatchObject({
        rows: [],
        sessions: [],
      });
      expect((await persistence.listEvents()).map((event) => event.type)).toEqual(
        expect.arrayContaining(["session.removed", "worktree.removed"]),
      );
    } finally {
      await server.close();
      sqlite.close();
    }
  });
});

function configFor(root: string, stateDir: string, socketPath: string): StationConfig {
  return {
    schemaVersion: 1,
    observer: { stateDir, socketPath },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "fake-terminal",
      harness: "fake-harness",
      layout: "agent-shell",
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "fake-harness",
          terminal: "fake-terminal",
          layout: "agent-shell",
        },
        worktrunk: {
          enabled: true,
        },
      },
    ],
  };
}

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    errorId: () => `err_${++error}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

function requestIds(): () => string {
  let id = 0;
  return () => `req_${++id}`;
}
