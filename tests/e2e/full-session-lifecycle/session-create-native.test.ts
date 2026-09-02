import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type { HarnessProvider } from "@station/contracts";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
  startObserverServer,
} from "@station/observer/internal";
import { ScriptedAgentHarnessProvider } from "@station/scripted-harness";
import { StationTerminalProvider } from "@station/terminal";
import { FakeHarnessProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import { FakeDiagnosticEvidenceSource } from "../../../apps/observer/test/support/diagnosticEvidenceSources.js";
import { createUnexpectedProjectConfigWriter } from "../../../apps/observer/test/support/projectConfigWriter.js";
import { createStationNativePlacementEndpoint } from "../../../station/src/nativePlacementEndpoint.js";
import { createStationStore } from "../../../station/src/state/store.js";
import { MAIN_PANE_ID } from "../../../station/src/state/types.js";
import { createPtyRegistry } from "../../../station/src/terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../../../station/src/terminal/testing/scriptedTerminal.js";
import type { StationTerminalSpawnOptions } from "../../../station/src/terminal/types.js";

const now = "2026-09-01T12:00:00.000Z";

describe("native session create product path", () => {
  it("creates an inactive native sibling through the real CLI and Observer command", async () => {
    const fixture = await createNativeFixture({ mode: "success" });
    try {
      const result = await runStn(
        fixture,
        "session",
        "create",
        "web",
        "--branch",
        "native-success",
        "--from-current",
        "--harness",
        fixture.harness.id,
        "--layout",
        "agent-only",
        "--ungrouped",
        "--timeout-ms",
        "10000",
        "--json",
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        outcome: {
          status: string;
          receipt: { commandId: string };
          result: {
            sessionId: string;
            requestedPlacement: string;
            resolvedPlacement: { provider: string; presentation: string; targetId: string };
          };
        };
      };
      expect(output).toMatchObject({
        outcome: {
          status: "succeeded",
          result: {
            sessionId: fixture.sessionId,
            requestedPlacement: "sibling",
            resolvedPlacement: { provider: "native", presentation: "presented" },
          },
        },
      });
      await expect(
        fixture.persistence.getCommand(output.outcome.receipt.commandId),
      ).resolves.toMatchObject({ status: "succeeded" });

      const created = fixture.worktree.snapshot().worktrees[0];
      if (created === undefined) throw new Error("native worktree was not created");
      expect(fixture.store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);
      expect(
        fixture.store.getState().workspace.panes.find((pane) => pane.worktreeId === created.id),
      ).toMatchObject({
        agentIdentity: {
          sessionId: fixture.sessionId,
          terminalTargetId: output.outcome.result.resolvedPlacement.targetId,
          processOwner: "ui",
        },
      });
      expect(fixture.spawnOptions[1]).toMatchObject({
        command: process.execPath,
        cwd: fixture.worktreePath,
        size: { cols: 93, rows: 31 },
      });
      expect(fixture.spawnOptions[1]?.args).toEqual([
        expect.stringMatching(/scripted-agent\.mjs$/),
        "--run-id",
        "run_native_success",
        "--state-dir",
        fixture.scriptedStateDir,
        "--scenario",
        fixture.scenarioPath,
      ]);
      expect(fixture.terminal.placement?.hasPendingBinding("binding_1")).toBe(false);
      await expect(fixture.terminal.listTargets()).resolves.toContainEqual(
        expect.objectContaining({
          provider: "native",
          sessionId: fixture.sessionId,
          worktreeId: created.id,
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("removes every native placement artifact when harness launch construction fails", async () => {
    const fixture = await createNativeFixture({ mode: "build-failure" });
    try {
      const result = await runStn(
        fixture,
        "session",
        "create",
        "web",
        "--branch",
        "native-build-failure",
        "--from-current",
        "--harness",
        fixture.harness.id,
        "--layout",
        "agent-only",
        "--ungrouped",
        "--timeout-ms",
        "10000",
        "--json",
      );

      expect(result.exitCode).toBe(1);
      const commands = await fixture.persistence.listCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        status: "failed",
        error: { code: "FAKE_NATIVE_BUILD_FAILED", provider: fixture.harness.id },
      });
      expect(fixture.worktree.snapshot()).toMatchObject({
        worktrees: [],
        removed: [
          {
            projectId: "web",
            worktreeId: "wt_web_native_build_failure",
            expectedPath: fixture.worktreePath,
            expectedBranch: "native-build-failure",
            expectedRegistrationIdentity: `fake-registration:web:native-build-failure:${fixture.worktreePath}`,
            force: true,
          },
        ],
      });
      await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
      await expect(fixture.terminal.listTargets()).resolves.toEqual([]);
      expect(fixture.terminal.placement?.hasPendingBinding("binding_1")).toBe(false);
      expect(fixture.store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);
      expect(fixture.store.getState().workspace.panes.map((pane) => pane.id)).toEqual([
        MAIN_PANE_ID,
      ]);
      expect(fixture.registry.entries().map((entry) => entry.paneId)).toEqual([MAIN_PANE_ID]);
      expect(fixture.spawnOptions).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

type NativeFixture = Awaited<ReturnType<typeof createNativeFixture>>;

async function createNativeFixture(options: { mode: "success" | "build-failure" }) {
  const root = await mkdtemp("/tmp/stn-native-e2e-");
  const stateDir = join(root, "state");
  const socketPath = join(root, "run", "observer.sock");
  const worktreePath = join(root, "worktrees", options.mode);
  const scriptedStateDir = join(stateDir, "scripted");
  const scenarioPath = join(
    process.cwd(),
    "tests",
    "agent",
    "fixtures",
    "scripted-agent",
    "complete-file-task.json",
  );
  await mkdir(stateDir, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const clock = { now: () => new Date(now) };
  const harness = createHarness(options.mode, scriptedStateDir, scenarioPath);
  const config = configFor(root, stateDir, socketPath, harness.id);
  const configPath = await writeConfig(root, config, harness.id);
  const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const worktree = new FakeWorktreeProvider({
    now,
    createPath: () => worktreePath,
  });

  const source = createScriptedTerminal({ cols: 93, rows: 31 });
  Object.assign(source.terminal, { pid: process.pid });
  const destination = createScriptedTerminal();
  const terminals = [source.terminal, destination.terminal];
  const spawnOptions: StationTerminalSpawnOptions[] = [];
  const store = createStationStore();
  const registry = createPtyRegistry({
    createTerminal: (spawnOption) => {
      spawnOptions.push(spawnOption);
      const terminal = terminals.shift();
      if (terminal === undefined) throw new Error("native E2E terminal pool was exhausted");
      return terminal;
    },
  });
  registry.resize(MAIN_PANE_ID, { cols: 93, rows: 31 });
  const endpoint = await createStationNativePlacementEndpoint({
    stateDir,
    uiRunId: `ui-${options.mode}`,
  });
  endpoint.attach({
    store,
    registry,
    createHostTerminal: () => {
      throw new Error("native E2E does not use Station Host");
    },
  });
  const terminal = new StationTerminalProvider({ clock, placement: { stateDir } });
  if (terminal.placement === undefined) throw new Error("native placement was not composed");
  const providers = new ProviderRegistry({
    worktree,
    terminal,
    terminalPlacements: [terminal.placement],
    harnesses: [harness],
  });
  const core = createObserverCore({ config, providers, persistence, clock });
  const sessionId = options.mode === "success" ? "ses_native_success" : "ses_native_failure";
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
    idFactory: {
      sessionId: () => sessionId,
      sessionGroupId: () => "grp_native_unused",
    },
  });
  const api = createObserverApi({
    core,
    persistence,
    persistenceHealth: persistence,
    commandQueue: queue,
    eventBus,
    providers,
    diagnosticEvidenceSource: new FakeDiagnosticEvidenceSource(),
    clock,
    socketPath,
    stateDir,
  });
  await core.reconcile(`native-e2e-${options.mode}`);
  const server = await startObserverServer({ socketPath, api, clock });

  return {
    root,
    configPath,
    sessionId,
    worktreePath,
    scriptedStateDir,
    scenarioPath,
    harness,
    persistence,
    worktree,
    terminal,
    store,
    registry,
    spawnOptions,
    cleanup: async () => {
      await server.close();
      await endpoint.close();
      registry.disposeAll();
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createHarness(
  mode: "success" | "build-failure",
  scriptedStateDir: string,
  scenarioPath: string,
): HarnessProvider {
  if (mode === "build-failure") {
    return new FakeHarnessProvider({
      id: "fake-native-failure",
      now,
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "FAKE_NATIVE_BUILD_FAILED",
          message: "The native E2E harness could not build a launch plan.",
          provider: "fake-native-failure",
        },
      },
    });
  }
  return new ScriptedAgentHarnessProvider({
    stateDir: scriptedStateDir,
    scenarioPath,
    runId: "run_native_success",
    now: () => new Date(now),
  });
}

function configFor(
  root: string,
  stateDir: string,
  socketPath: string,
  harness: string,
): StationConfig {
  return {
    schemaVersion: 1,
    workspace: DEFAULT_WORKSPACE_CONFIG,
    observer: { stateDir, socketPath, autoStartFromHooks: false },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "native",
      harness,
      layout: "agent-only",
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaultBranch: "main",
        defaults: { harness, terminal: "native", layout: "agent-only" },
        worktrunk: { enabled: true, base: "main" },
      },
    ],
  };
}

async function writeConfig(root: string, config: StationConfig, harness: string): Promise<string> {
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(config.observer?.socketPath)}`,
      `state_dir = ${JSON.stringify(config.observer?.stateDir)}`,
      "auto_start_from_hooks = false",
      "",
      "[defaults]",
      'worktree_provider = "fake-worktree"',
      'terminal = "native"',
      `harness = ${JSON.stringify(harness)}`,
      'layout = "agent-only"',
      "",
      "[[projects]]",
      'id = "web"',
      'label = "web"',
      `root = ${JSON.stringify(root)}`,
      'default_branch = "main"',
      "",
      "[projects.defaults]",
      `harness = ${JSON.stringify(harness)}`,
      'terminal = "native"',
      'layout = "agent-only"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

async function runStn(fixture: NativeFixture, ...args: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        join(process.cwd(), "bin", "stn"),
        ["--config", fixture.configPath, ...args],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(fixture.root, "xdg-config"),
            NO_COLOR: "1",
            STATION_PANE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    },
  );
}

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_native_${++command}`,
    eventId: () => `evt_native_${++event}`,
    errorId: () => `err_native_${++error}`,
    observationId: () => `obs_native_${++observation}`,
    breadcrumbId: () => `crumb_native_${++breadcrumb}`,
  };
}
