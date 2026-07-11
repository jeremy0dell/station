import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { ObserverEventHookInvocationSchema } from "@station/contracts";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createObserverEventHookRuntime,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
  startObserverServer,
} from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";
import type { ExternalCommandInput } from "@station/runtime";
import { ScriptedAgentHarnessProvider } from "@station/scripted-harness";
import { FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import { runScriptedAgentLaunchPlan } from "../../support/fake-agent";
import { createTempSocketPath } from "../../support/sockets";

const now = "2026-05-21T12:00:00.000Z";

describe("full session lifecycle e2e", () => {
  it("creates a scripted session through protocol command dispatch and updates the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-session-e2e-"));
    const stateDir = join(root, "state");
    const worktreePath = join(root, "worktrees", "task");
    await mkdir(stateDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    const { socketPath } = await createTempSocketPath();
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const eventHookCalls: ExternalCommandInput[] = [];
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        await runScriptedAgentLaunchPlan(launchPlan);
      },
    });
    const harness = new ScriptedAgentHarnessProvider({
      stateDir: join(stateDir, "scripted"),
      scenarioPath: join(
        process.cwd(),
        "tests",
        "agent",
        "fixtures",
        "scripted-agent",
        "complete-file-task.json",
      ),
      runId: "run_web_task",
      now: () => new Date(now),
    });
    const config = configFor(root, stateDir, socketPath);
    const eventHooks = createObserverEventHookRuntime({
      hooks: config.hooks?.event ?? [],
      eventBus,
      clock,
      commandRunner: async (input) => {
        eventHookCalls.push(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        createPath: () => worktreePath,
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
        sessionId: () => "ses_web_task",
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
      const receipt = await client.dispatch({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "task",
          harness: { provider: "scripted", mode: "interactive" },
          terminal: { provider: "fake-terminal", layout: "agent-build-shell", focus: false },
          initialPrompt: "Complete the file task.",
        },
      });
      const command = await client.waitForCommand(receipt.commandId, { timeoutMs: 1000 });

      expect(command.status).toBe("succeeded");
      await expect(readFile(join(worktreePath, "task.txt"), "utf8")).resolves.toBe(
        "scripted agent completed the file task\n",
      );
      await expect(client.getSnapshot()).resolves.toMatchObject({
        rows: [
          {
            id: "wt_web_task",
            agent: {
              harness: "scripted",
              state: "exited",
              sessionId: "ses_web_task",
            },
          },
        ],
        sessions: [
          {
            id: "ses_web_task",
            worktreeId: "wt_web_task",
          },
        ],
      });
      expect(terminal.snapshot().focused).toEqual([]);
      await waitFor(() => eventHookCalls.length === 1);
      const invocation = ObserverEventHookInvocationSchema.parse(
        JSON.parse(eventHookCalls[0]?.stdin ?? "{}"),
      );
      expect(invocation).toMatchObject({
        hookId: "notify-command-succeeded",
        event: {
          type: "command.succeeded",
          commandId: "cmd_1",
        },
      });
    } finally {
      await eventHooks.shutdown();
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
      harness: "scripted",
      layout: "agent-shell",
    },
    hooks: {
      event: [
        {
          id: "notify-command-succeeded",
          events: ["command.succeeded"],
          command: "notify-bin",
          args: ["command-succeeded"],
          timeoutMs: 1000,
        },
      ],
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "scripted",
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
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
