import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
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
import { createPiHarnessProvider } from "@station/pi";
import { stationObserverBuildVersion } from "@station/runtime";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { TmuxProvider } from "@station/tmux";
import { afterEach, describe, expect, it } from "vitest";
import { createUnexpectedProjectConfigWriter } from "../../../../apps/observer/test/support/projectConfigWriter.js";
import type { RealE2eEnvironment } from "../../../support/real-station/env";
import { createPiLaunchLoggingWrapper, waitForPiLaunchLog } from "../../../support/real-station/pi";

const execFileAsync = promisify(execFile);
const realPiEnabled = process.env.STATION_REAL_PI === "1";
const describeRealPi = realPiEnabled ? describe : describe.skip;

const now = "2026-05-27T12:00:00.000Z";
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealPi("real Pi session.create launch lane", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    for (const task of tasks.toReversed()) {
      await task().catch(() => undefined);
    }
  });

  it("launches Pi through tmux with the standalone STATION extension", async () => {
    const piBin = process.env.STATION_PI_BIN ?? "pi";
    const tmuxBin = process.env.STATION_TMUX_BIN ?? "tmux";
    await execFileAsync(piBin, ["--version"], { timeout: 15_000 });
    await execFileAsync(tmuxBin, ["-V"], { timeout: 10_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-pi-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const worktreePath = join(root, "worktree");
    const configPath = join(root, "station.config.toml");
    const sessionName = `station-pi-${process.pid}-${Date.now()}`;
    await mkdir(stateDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await writeFile(configPath, "# real Pi launch test config placeholder\n", "utf8");

    const env: RealE2eEnvironment = {
      repoRoot: process.cwd(),
      stationBin: join(process.cwd(), "bin", "stn"),
      stationIngressBin: join(process.cwd(), "bin", "stn-ingress"),
      tmuxBin,
      piBin,
    };
    const piWrapper = await createPiLaunchLoggingWrapper({
      env,
      root,
      execRealPi: false,
    });

    cleanupTasks.push(async () => {
      await execFileAsync(tmuxBin, ["kill-session", "-t", sessionName], {
        timeout: 10_000,
      }).catch(() => undefined);
    });
    if (process.env.STATION_REAL_PI_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real Pi temp root: ${root}\n`);
    }

    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    cleanupTasks.push(async () => sqlite.close());
    const idFactory = ids();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory });
    const eventBus = createObserverEventBus();
    const queue = createCommandQueue({
      persistence,
      idFactory,
      clock,
      eventBus,
    });
    const testConfig = config(root, stateDir);
    const terminal = new TmuxProvider({
      command: tmuxBin,
      clock,
      config: {
        workbenchSession: sessionName,
      },
    });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        createPath: () => worktreePath,
      }),
      terminal,
      harnesses: [
        createPiHarnessProvider({
          command: piWrapper.wrapperPath,
          configPath,
          now: () => new Date(now),
        }),
      ],
    });
    const core = createObserverCore({
      config: testConfig,
      providers,
      persistence,
      clock,
      providerTimeoutMs: 20_000,
    });
    registerObserverCommandHandlers({
      projectConfigWriter: createUnexpectedProjectConfigWriter(),
      queue,
      core,
      providers,
      projects: testConfig.projects,
      persistence,
      eventBus,
      clock,
      idFactory: {
        sessionId: () => "ses_real_pi",
      },
      commandTimeoutMs: 30_000,
    });

    try {
      const receipt = await queue.dispatch({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "pi-real",
          harness: {
            provider: "pi",
            mode: "interactive",
          },
          terminal: {
            provider: "tmux",
            layout: "agent-build-shell",
          },
        },
      });
      await queue.drain();
      const launchLog = await waitForPiLaunchLog(piWrapper, "arg=--extension");
      const snapshot = await pollForPiRow(core);

      expect(await persistence.getCommand(receipt.commandId)).toMatchObject({
        status: "succeeded",
      });
      expect(launchLog).toContain("env.STATION_CONFIG_PATH=");
      expect(launchLog).toContain(configPath);
      expect(launchLog).toContain("env.STATION_HARNESS_PROVIDER=pi");
      expect(launchLog).toContain("env.STATION_SESSION_ID=ses_real_pi");
      const extensionPath = extensionPathFromLaunchLog(launchLog);
      expect(extensionPath).toMatch(/\/integrations\/harness\/pi\/dist\/piExtension\.js$/);
      await expect(access(extensionPath)).resolves.toBeUndefined();
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "pi",
        sessionId: "ses_real_pi",
        state: "unknown",
        confidence: "low",
      });
      expect(snapshot.sessions[0]).toMatchObject({
        id: "ses_real_pi",
        harness: {
          provider: "pi",
        },
      });
    } catch (error) {
      await writeFailureBundle({
        config: testConfig,
        core,
        persistence,
        stateDir,
        diagnosticsDir,
      });
      throw error;
    }
  }, 180_000);

  it("runs real Pi and persists settled-turn evidence before print shutdown", async () => {
    const piBin = process.env.STATION_PI_BIN ?? "pi";
    await execFileAsync(piBin, ["--version"], { timeout: 15_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-pi-callback-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const worktreePath = join(root, "worktree");
    const sessionDir = join(root, "pi-sessions");
    const piHome = join(root, "pi-home");
    const runDir = join(root, "run");
    const socketPath = join(runDir, "observer.sock");
    const extensionPath = join(
      process.cwd(),
      "integrations",
      "harness",
      "pi",
      "dist",
      "piExtension.js",
    );
    const fauxExtensionPath = join(root, "faux-provider.mjs");
    await mkdir(stateDir, { recursive: true });
    await mkdir(hookSpoolDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(piHome, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await access(extensionPath);
    await writeFauxTextProvider(fauxExtensionPath, await resolvePiFauxModulePath(piBin));
    const ingressPath = join(process.cwd(), "bin", "stn-ingress");

    if (process.env.STATION_REAL_PI_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real Pi callback temp root: ${root}\n`);
    }

    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    cleanupTasks.push(async () => sqlite.close());
    const idFactory = ids();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory });
    const eventBus = createObserverEventBus();
    const queue = createCommandQueue({ persistence, idFactory, clock, eventBus });
    const testConfig = config(root, stateDir);
    testConfig.observer = {
      ...testConfig.observer,
      socketPath,
    };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_real_pi_callback",
            projectId: "web",
            branch: "pi-callback-real",
            path: worktreePath,
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "real-pi-callback-target",
            provider: "tmux",
            projectId: "web",
            worktreeId: "wt_real_pi_callback",
            sessionId: "ses_real_pi_callback",
            now,
            harnessBinding: {
              role: "main-agent",
              harnessProvider: "pi",
              currentCommand: "pi",
            },
          }),
        ],
      }),
      harnesses: [createPiHarnessProvider({ command: piBin, now: () => new Date(now) })],
    });
    const core = createObserverCore({
      config: testConfig,
      providers,
      persistence,
      clock,
      providerTimeoutMs: 20_000,
    });
    const api = createObserverApi({
      core,
      providers,
      persistence,
      persistenceHealth: persistence,
      commandQueue: queue,
      eventBus,
      clock,
      config: testConfig,
      socketPath,
      observerBuildVersion: stationObserverBuildVersion(),
      stateDir,
      hookSpoolDir,
      hookReconcileDebounceMs: 0,
    });
    const server = await startObserverServer({ socketPath, api, clock });
    cleanupTasks.push(async () => {
      await server.close();
    });

    try {
      await core.reconcile("real-pi-callback-initial");
      const run = await runPi({
        piBin,
        cwd: worktreePath,
        extensionPath,
        fauxExtensionPath,
        sessionDir,
        env: {
          PI_CODING_AGENT_DIR: piHome,
          STATION_PROJECT_ID: "web",
          STATION_WORKTREE_ID: "wt_real_pi_callback",
          STATION_WORKTREE_PATH: worktreePath,
          STATION_SESSION_ID: "ses_real_pi_callback",
          STATION_HARNESS_PROVIDER: "pi",
          STATION_TERMINAL_PROVIDER: "tmux",
          STATION_TERMINAL_TARGET_ID: "real-pi-callback-target",
          STATION_INGRESS_BIN: ingressPath,
          STATION_OBSERVER_SOCKET_PATH: socketPath,
          STATION_OBSERVER_STATE_DIR: stateDir,
          STATION_HOOK_SPOOL_DIR: hookSpoolDir,
        },
      });

      expect(run.exitCode, run.stderr).toBe(0);
      const settledObservation = await pollForPiSettlement(persistence);
      const observations = await persistence.listProviderObservations();
      const piObservations = observations.filter(
        (observation) =>
          observation.provider === "pi" &&
          observation.entityKind === "harness_event" &&
          observation.payload.sessionId === "ses_real_pi_callback",
      );
      const piEventTypes = piObservations.map((observation) =>
        observation.entityKind === "harness_event" ? observation.payload.rawEventType : undefined,
      );
      const agentEndObservation = piObservations.find(
        (observation) =>
          observation.entityKind === "harness_event" &&
          observation.payload.rawEventType === "agent_end",
      );
      const snapshot = await core.reconcile("real-pi-callback-observed");
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "pi",
        sessionId: "ses_real_pi_callback",
        state: "exited",
      });
      expect(
        agentEndObservation?.entityKind === "harness_event"
          ? agentEndObservation.payload
          : undefined,
      ).toMatchObject({
        rawEventType: "agent_end",
        status: {
          value: "working",
        },
      });
      if (agentEndObservation?.entityKind === "harness_event") {
        expect(agentEndObservation.payload.turn).toBeUndefined();
      }
      expect(settledObservation.payload).toMatchObject({
        rawEventType: "agent_settled",
        status: {
          value: "idle",
        },
        turn: {
          kind: "turn_completed",
        },
      });
      expect(piEventTypes.indexOf("agent_end")).toBeGreaterThanOrEqual(0);
      expect(piEventTypes.indexOf("agent_settled")).toBeGreaterThan(
        piEventTypes.indexOf("agent_end"),
      );
      expect(piEventTypes.indexOf("session_shutdown")).toBeGreaterThan(
        piEventTypes.indexOf("agent_settled"),
      );
    } catch (error) {
      await writeFailureBundle({
        config: testConfig,
        core,
        persistence,
        stateDir,
        diagnosticsDir,
      });
      throw error;
    }
  }, 240_000);
});

function extensionPathFromLaunchLog(launchLog: string): string {
  const line = launchLog
    .split(/\r?\n/)
    .find((candidate) => candidate.endsWith("/integrations/harness/pi/dist/piExtension.js"));
  if (line === undefined) {
    throw new Error("Pi launch log did not include a dist/piExtension.js argument.");
  }
  return line.replace(/^arg=/, "");
}

async function pollForPiRow(core: ReturnType<typeof createObserverCore>) {
  return poll(async () => {
    const snapshot = await core.reconcile("pi-real-poll");
    return snapshot.rows[0]?.agent?.harness === "pi" ? snapshot : undefined;
  }, "Observer did not discover the real Pi session.");
}

type RunPiResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

async function runPi(input: {
  piBin: string;
  cwd: string;
  extensionPath: string;
  fauxExtensionPath: string;
  sessionDir: string;
  env: Record<string, string>;
}): Promise<RunPiResult> {
  return new Promise((resolve) => {
    const child = spawn(
      input.piBin,
      [
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--approve",
        "--extension",
        input.extensionPath,
        "--extension",
        input.fauxExtensionPath,
        "--provider",
        "station-real-faux",
        "--model",
        "station-real-faux-1",
        "--session-dir",
        input.sessionDir,
        "--no-tools",
        "--print",
        "Run the deterministic Station settlement scenario.",
      ],
      {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...input.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 180_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function resolvePiFauxModulePath(piBin: string): Promise<string> {
  const configuredRoot = process.env.STATION_REAL_PI_PACKAGE_ROOT;
  const packageRoot =
    configuredRoot === undefined
      ? resolve(dirname(await resolveExecutablePath(piBin)), "..")
      : resolve(configuredRoot);
  const path = join(
    packageRoot,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "faux.js",
  );
  await access(path);
  return path;
}

async function resolveExecutablePath(command: string): Promise<string> {
  if (command.includes("/")) return realpath(command);
  const result = await execFileAsync("which", [command], { encoding: "utf8", timeout: 10_000 });
  return realpath(result.stdout.trim());
}

async function writeFauxTextProvider(path: string, fauxModulePath: string): Promise<void> {
  await writeFile(
    path,
    `import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxModulePath)};\n` +
      `export default function registerStationRealFaux(pi) {\n` +
      `  const faux = createFauxCore({\n` +
      `    api: "station-real-faux-api", provider: "station-real-faux",\n` +
      `    models: [{ id: "station-real-faux-1", name: "Station Real Faux", input: ["text"] }],\n` +
      `  });\n` +
      `  faux.setResponses([fauxAssistantMessage("STATION_REAL_PI_OK")]);\n` +
      `  pi.registerProvider("station-real-faux", {\n` +
      `    baseUrl: "http://localhost:0", apiKey: "station-real-test", api: faux.api,\n` +
      `    models: [{\n` +
      `      id: "station-real-faux-1", name: "Station Real Faux", reasoning: false, input: ["text"],\n` +
      `      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },\n` +
      `      contextWindow: 128000, maxTokens: 4096,\n` +
      `    }],\n` +
      `    streamSimple: faux.streamSimple,\n` +
      `  });\n` +
      `}\n`,
    "utf8",
  );
}

async function pollForPiSettlement(
  persistence: ReturnType<typeof createSqliteObserverPersistence>,
) {
  return poll(async () => {
    const observations = await persistence.listProviderObservations();
    return observations.find((observation) => {
      if (observation.provider !== "pi" || observation.entityKind !== "harness_event") {
        return false;
      }
      const payload = observation.payload;
      return (
        payload.rawEventType === "agent_settled" &&
        payload.status?.value === "idle" &&
        payload.turn?.kind === "turn_completed"
      );
    });
  }, "Observer did not ingest settled-turn evidence from the Pi extension.");
}

async function poll<T>(probe: () => Promise<T | false | undefined>, message: string): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const value = await probe();
    if (value !== false && value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

async function writeFailureBundle(input: {
  config: StationConfig;
  core: ReturnType<typeof createObserverCore>;
  persistence: ReturnType<typeof createSqliteObserverPersistence>;
  stateDir: string;
  diagnosticsDir: string;
}): Promise<void> {
  const snapshot = await collectDiagnosticSnapshot({
    config: input.config,
    core: input.core,
    persistence: input.persistence,
    persistenceHealth: input.persistence,
    paths: {
      stateDir: input.stateDir,
      diagnosticsDir: input.diagnosticsDir,
    },
    clock: { now: () => new Date(now) },
  });
  await writeDebugBundle({
    diagnosticsDir: input.diagnosticsDir,
    snapshot,
    now: new Date(now),
    bundleId: "diag_real_pi_failure",
  });
}

function config(root: string, stateDir: string): StationConfig {
  return {
    schemaVersion: 1,
    observer: {
      stateDir,
      socketPath: join(root, "observer.sock"),
    },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "tmux",
      harness: "pi",
      layout: "agent-shell",
    },
    terminal: {
      tmux: {},
    },
    harness: {
      pi: {
        enabled: true,
      },
    },
    workspace: DEFAULT_WORKSPACE_CONFIG,
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "pi",
          terminal: "tmux",
          layout: "agent-shell",
        },
        worktrunk: {
          enabled: true,
        },
      },
    ],
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
