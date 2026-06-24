import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "@station/observer/internal";
import { ScriptedAgentHarnessProvider } from "@station/scripted-harness";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { runScriptedAgentLaunchPlan } from "../../support/fake-agent";

const now = "2026-05-20T12:00:00.000Z";

describe("scripted agent lifecycle", () => {
  it("launches a deterministic agent-like process and produces debug-bundle evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-scripted-agent-"));
    const stateDir = join(root, "state");
    const worktreePath = join(root, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const provider = new ScriptedAgentHarnessProvider({
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
      sessionId: "ses_web_task",
      now: () => new Date(now),
    });
    const plan = await provider.buildLaunch({
      project: project(root),
      worktree: worktree(worktreePath),
      mode: "interactive",
    });

    await runScriptedAgentLaunchPlan(plan);

    await expect(readFile(join(worktreePath, "task.txt"), "utf8")).resolves.toBe(
      "scripted agent completed the file task\n",
    );

    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite") });
    const persistence = createObserverPersistence({ sqlite, idFactory: ids() });
    const core = createObserverCore({
      config: config(root, stateDir),
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ worktrees: [worktree(worktreePath)] }),
        terminal: new FakeTerminalProvider({
          targets: [
            createFakeTerminalTarget({
              id: "term_web_task",
              projectId: "web",
              worktreeId: "wt_web_task",
              sessionId: "ses_web_task",
              harnessRunId: "run_web_task",
              now,
            }),
          ],
        }),
        harnesses: [provider],
      }),
      persistence,
      sqlite,
      clock: { now: () => new Date(now) },
    });
    const queue = createCommandQueue({
      persistence,
      idFactory: ids(),
      clock: { now: () => new Date(now) },
      handlers: {
        "observer.reconcile": async () => {
          await core.reconcile("scripted-agent-command");
        },
      },
    });

    const receipt = await queue.dispatch({
      type: "observer.reconcile",
      payload: { reason: "scripted-agent-test" },
    });
    await queue.drain();
    const snapshot = core.getSnapshot();

    expect(snapshot.rows[0]?.agent).toMatchObject({
      harness: "scripted",
      state: "exited",
      confidence: "high",
      reason: "Scripted agent exited with code 0.",
    });

    const diagnostics = await collectDiagnosticSnapshot({
      config: config(root, stateDir),
      core,
      persistence,
      paths: { stateDir, diagnosticsDir: join(stateDir, "diagnostics") },
      clock: { now: () => new Date(now) },
    });
    const manifest = await writeDebugBundle({
      diagnosticsDir: join(stateDir, "diagnostics"),
      snapshot: diagnostics,
      now: new Date(now),
      bundleId: "diag_scripted_agent",
    });

    expect(manifest.commandIds).toContain(receipt.commandId);
    expect(manifest.traceIds).toContain(receipt.traceId);
    expect(JSON.stringify(diagnostics.providerHealth)).toContain("scripted");
    sqlite.close();
  });

  it("launches the deterministic agent through the session.create command path", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-scripted-session-"));
    const stateDir = join(root, "state");
    const worktreePath = join(root, "worktree");
    await mkdir(stateDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    const provider = new ScriptedAgentHarnessProvider({
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
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        await runScriptedAgentLaunchPlan(launchPlan);
      },
    });
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite") });
    const idFactory = ids();
    const persistence = createObserverPersistence({ sqlite, idFactory });
    const eventBus = createObserverEventBus();
    const queue = createCommandQueue({
      persistence,
      idFactory,
      clock: { now: () => new Date(now) },
      eventBus,
    });
    const testConfig = config(root, stateDir);
    const worktreeProvider = new FakeWorktreeProvider({
      createPath: () => worktreePath,
    });
    const providers = new ProviderRegistry({
      worktree: worktreeProvider,
      terminal,
      harnesses: [provider],
    });
    const core = createObserverCore({
      config: testConfig,
      providers,
      persistence,
      sqlite,
      clock: { now: () => new Date(now) },
    });
    registerObserverCommandHandlers({
      queue,
      core,
      providers,
      projects: testConfig.projects,
      persistence,
      eventBus,
      clock: { now: () => new Date(now) },
      idFactory: {
        sessionId: () => "ses_web_task",
      },
    });

    const receipt = await queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "task",
        harness: { provider: "scripted", mode: "interactive" },
        terminal: { provider: "fake-terminal", layout: "agent-build-shell" },
      },
    });
    await queue.drain();

    await expect(readFile(join(worktreePath, "task.txt"), "utf8")).resolves.toBe(
      "scripted agent completed the file task\n",
    );
    expect(core.getSnapshot().rows[0]?.agent).toMatchObject({
      harness: "scripted",
      sessionId: "ses_web_task",
      state: "exited",
    });
    await expect(persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    sqlite.close();
  });
});

function project(root: string) {
  return {
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
  };
}

function worktree(path: string) {
  return createFakeWorktree({
    id: "wt_web_task",
    projectId: "web",
    branch: "task",
    path,
    now,
  });
}

function config(root: string, stateDir: string): StationConfig {
  return {
    schemaVersion: 1,
    observer: {
      stateDir,
      socketPath: join(root, "run", "observer.sock"),
    },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "fake-terminal",
      harness: "scripted",
      layout: "agent-shell",
    },
    projects: [project(root)],
  };
}

function ids() {
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
