import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  startObserverServer,
} from "@station/observer/internal";
import { installOpenCodePlugin, OpenCodeHarnessProvider } from "@station/opencode";
import {
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { afterEach, describe, expect, it } from "vitest";
import { requireRealE2eEnvironment, requireToolPath } from "../../../support/real-station/env";

const realOpenCodeEnabled = process.env.STATION_REAL_OPENCODE === "1";
const describeRealOpenCode = realOpenCodeEnabled ? describe : describe.skip;
const now = "2026-05-20T12:00:00.000Z";

let cleanupTasks: Array<() => Promise<void>> = [];

describeRealOpenCode("real OpenCode event capture", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    await Promise.allSettled(tasks.map((task) => task()));
  });

  it("runs real OpenCode and ingests plugin events through the observer socket", async () => {
    const env = await requireRealE2eEnvironment({ opencode: true });
    const opencodeBin = requireToolPath(env, "opencode");
    const root = await mkdtemp(join(tmpdir(), "station-real-opencode-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const opencodeConfigDir = join(root, "opencode-config");
    const worktreePath = join(root, "worktree");
    const socketPath = join(root, "run", "observer.sock");
    await mkdir(stateDir, { recursive: true });
    await mkdir(hookSpoolDir, { recursive: true });
    await mkdir(opencodeConfigDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(join(root, "run"), { recursive: true });
    await installOpenCodePlugin({
      opencodeConfigDir,
      observerSocketPath: socketPath,
      stateDir,
      hookSpoolDir,
    });

    if (process.env.STATION_REAL_OPENCODE_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real OpenCode temp root: ${root}\n`);
    }

    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    cleanupTasks.push(async () => sqlite.close());
    const idFactory = ids();
    const persistence = createObserverPersistence({ sqlite, clock, idFactory });
    const eventBus = createObserverEventBus();
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_real_opencode",
            projectId: "web",
            branch: "opencode-real",
            path: worktreePath,
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "real-opencode-target",
            provider: "tmux",
            projectId: "web",
            worktreeId: "wt_real_opencode",
            sessionId: "ses_real_opencode",
            now,
            harnessBinding: {
              role: "main-agent",
              harnessProvider: "opencode",
              currentCommand: "opencode",
            },
          }),
        ],
      }),
      harnesses: [new OpenCodeHarnessProvider({ command: opencodeBin, now: () => new Date(now) })],
    });
    const testConfig = config({ root, stateDir, socketPath, worktreePath });
    const core = createObserverCore({
      config: testConfig,
      providers,
      persistence,
      sqlite,
      clock,
      providerTimeoutMs: 20_000,
    });
    const queue = createCommandQueue({ persistence, clock, idFactory, eventBus });
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
    const server = await startObserverServer({
      socketPath,
      api,
      clock,
      drainOnStart: false,
    });
    cleanupTasks.push(async () => {
      await server.close();
    });

    try {
      await core.reconcile("real-opencode-initial");
      const run = await runOpenCode({
        opencodeBin,
        cwd: worktreePath,
        env: {
          STATION_PROJECT_ID: "web",
          STATION_WORKTREE_ID: "wt_real_opencode",
          STATION_WORKTREE_PATH: worktreePath,
          STATION_SESSION_ID: "ses_real_opencode",
          STATION_HARNESS_PROVIDER: "opencode",
          STATION_TERMINAL_PROVIDER: "tmux",
          STATION_TERMINAL_TARGET_ID: "real-opencode-target",
          STATION_OBSERVER_SOCKET_PATH: socketPath,
          STATION_OBSERVER_STATE_DIR: stateDir,
          STATION_HOOK_SPOOL_DIR: hookSpoolDir,
          OPENCODE_CONFIG_DIR: opencodeConfigDir,
        },
      });

      expect(run.exitCode, run.stderr).toBe(0);
      const observation = await pollForOpenCodeStatusObservation(persistence);
      expect(observation.payload).toMatchObject({
        provider: "opencode",
        worktreeId: "wt_real_opencode",
        sessionId: "ses_real_opencode",
        status: expect.objectContaining({
          source: "harness_event",
        }),
      });
      const snapshot = await core.reconcile("real-opencode-observed");
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "opencode",
        sessionId: "ses_real_opencode",
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

type RunOpenCodeResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

async function runOpenCode(input: {
  opencodeBin: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<RunOpenCodeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      input.opencodeBin,
      [
        "run",
        "--format",
        "json",
        "--dangerously-skip-permissions",
        "Reply with exactly STATION_REAL_OPENCODE_OK.",
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

async function pollForOpenCodeStatusObservation(
  persistence: ReturnType<typeof createObserverPersistence>,
) {
  return poll(async () => {
    const observations = await persistence.listProviderObservations();
    return observations.find((observation) => {
      if (observation.provider !== "opencode" || observation.entityKind !== "harness_event") {
        return false;
      }
      const payload = observation.payload as { status?: unknown };
      return payload.status !== undefined;
    });
  }, "Observer did not ingest a status-bearing OpenCode plugin event.");
}

async function poll<T>(probe: () => Promise<T | false | undefined>, message: string): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 45_000) {
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
    bundleId: "diag_real_opencode_failure",
  });
}

function config(input: {
  root: string;
  stateDir: string;
  socketPath: string;
  worktreePath: string;
}): StationConfig {
  return {
    schemaVersion: 1,
    observer: {
      stateDir: input.stateDir,
      socketPath: input.socketPath,
    },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "fake-terminal",
      harness: "opencode",
      layout: "agent-shell",
    },
    harness: {
      opencode: {
        enabled: true,
      },
    },
    projects: [
      {
        id: "web",
        label: "web",
        root: input.worktreePath,
        defaults: {
          harness: "opencode",
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

function ids() {
  let command = 0;
  let event = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}
