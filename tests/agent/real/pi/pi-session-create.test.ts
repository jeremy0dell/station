import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
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
import { createPiHarnessProvider } from "@station/pi";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { TmuxProvider } from "@station/tmux";
import { afterEach, describe, expect, it } from "vitest";
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
    for (const task of tasks.reverse()) {
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
    const persistence = createObserverPersistence({ sqlite, clock, idFactory });
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
      sqlite,
      clock,
      providerTimeoutMs: 20_000,
    });
    registerObserverCommandHandlers({
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

  it("runs real Pi with the STATION extension and persists completed-turn readiness before print shutdown", async () => {
    const piBin = process.env.STATION_PI_BIN ?? "pi";
    await execFileAsync(piBin, ["--version"], { timeout: 15_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-pi-callback-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const worktreePath = join(root, "worktree");
    const sessionDir = join(root, "pi-sessions");
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
    await mkdir(stateDir, { recursive: true });
    await mkdir(hookSpoolDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await access(extensionPath);

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
    const persistence = createObserverPersistence({ sqlite, clock, idFactory });
    const eventBus = createObserverEventBus();
    const queue = createCommandQueue({ persistence, idFactory, clock, eventBus });
    const testConfig = config(root, stateDir);
    testConfig.observer.socketPath = socketPath;
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
      sqlite,
      clock,
      providerTimeoutMs: 20_000,
    });
    const api = createObserverApi({
      core,
      providers,
      persistence,
      commandQueue: queue,
      eventBus,
      clock,
      config: testConfig,
      socketPath,
      stateDir,
      hookSpoolDir,
      hookReconcileDebounceMs: 0,
    });
    const server = await startObserverServer({ socketPath, api, clock, drainOnStart: false });
    cleanupTasks.push(async () => {
      await server.close();
    });

    try {
      await core.reconcile("real-pi-callback-initial");
      const run = await runPi({
        piBin,
        cwd: worktreePath,
        extensionPath,
        sessionDir,
        env: {
          STATION_PROJECT_ID: "web",
          STATION_WORKTREE_ID: "wt_real_pi_callback",
          STATION_WORKTREE_PATH: worktreePath,
          STATION_SESSION_ID: "ses_real_pi_callback",
          STATION_HARNESS_PROVIDER: "pi",
          STATION_TERMINAL_PROVIDER: "tmux",
          STATION_TERMINAL_TARGET_ID: "real-pi-callback-target",
          STATION_OBSERVER_SOCKET_PATH: socketPath,
          STATION_OBSERVER_STATE_DIR: stateDir,
          STATION_HOOK_SPOOL_DIR: hookSpoolDir,
        },
      });

      expect(run.exitCode, run.stderr).toBe(0);
      await pollForPiReadiness(persistence);
      const snapshot = await core.reconcile("real-pi-callback-observed");
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "pi",
        sessionId: "ses_real_pi_callback",
        state: "exited",
      });
      await expect(
        persistence.getSessionTurnReadiness("ses_real_pi_callback"),
      ).resolves.toMatchObject({
        worktreeId: "wt_real_pi_callback",
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
  sessionDir: string;
  env: Record<string, string>;
}): Promise<RunPiResult> {
  return new Promise((resolve) => {
    const child = spawn(
      input.piBin,
      [
        "--extension",
        input.extensionPath,
        "--session-dir",
        input.sessionDir,
        "--no-context-files",
        "--no-tools",
        "--print",
        "Reply with exactly STATION_REAL_PI_OK.",
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

async function pollForPiReadiness(persistence: ReturnType<typeof createObserverPersistence>) {
  return poll(async () => {
    const observations = await persistence.listProviderObservations();
    return observations.find((observation) => {
      if (observation.provider !== "pi" || observation.entityKind !== "harness_event") {
        return false;
      }
      const payload = observation.payload as {
        status?: { value?: unknown };
        turn?: { kind?: unknown };
      };
      return payload.status?.value === "idle" && payload.turn?.kind === "turn_completed";
    });
  }, "Observer did not ingest a completed idle Pi extension event.");
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
  persistence: ReturnType<typeof createObserverPersistence>;
  stateDir: string;
  diagnosticsDir: string;
}): Promise<void> {
  const snapshot = await collectDiagnosticSnapshot({
    config: input.config,
    core: input.core,
    persistence: input.persistence,
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
