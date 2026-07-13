import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "@station/observer/internal";
import { createOpenCodeHarnessProvider, installOpenCodePlugin } from "@station/opencode";
import { FakeWorktreeProvider } from "@station/testing";
import { TmuxProvider } from "@station/tmux";
import { afterEach, describe, expect, it } from "vitest";
import { createUnexpectedProjectConfigWriter } from "../../../../apps/observer/test/support/projectConfigWriter.js";
import { requireRealE2eEnvironment, requireToolPath } from "../../../support/real-station/env";

const execFileAsync = promisify(execFile);
const realOpenCodeEnabled = process.env.STATION_REAL_OPENCODE === "1";
const describeRealOpenCode = realOpenCodeEnabled ? describe : describe.skip;

const now = "2026-05-20T12:00:00.000Z";
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealOpenCode("real OpenCode session.create", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    for (const task of tasks.reverse()) {
      await task().catch(() => undefined);
    }
  });

  it("launches real OpenCode through tmux and observes a normalized OpenCode harness run", async () => {
    const env = await requireRealE2eEnvironment({ tmux: true, opencode: true });
    const opencodeBin = requireToolPath(env, "opencode");
    const tmuxBin = requireToolPath(env, "tmux");
    const root = await mkdtemp(join(tmpdir(), "station-real-opencode-session-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const opencodeConfigDir = join(root, "opencode-config");
    const worktreePath = join(root, "worktree");
    const configPath = join(root, "station.config.toml");
    const sessionName = `station-opencode-${process.pid}-${Date.now()}`;
    const shimLog = join(root, "opencode-shim.log");
    const shimPath = join(root, "opencode-shim");
    await mkdir(stateDir, { recursive: true });
    await mkdir(hookSpoolDir, { recursive: true });
    await mkdir(opencodeConfigDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await writeFile(configPath, "# real OpenCode launch test config placeholder\n", "utf8");
    await installOpenCodePlugin({
      opencodeConfigDir,
      observerSocketPath: join(root, "observer.sock"),
      stateDir,
      hookSpoolDir,
    });
    await writeOpenCodeShim({
      shimPath,
      shimLog,
      realOpenCodeBin: opencodeBin,
      opencodeConfigDir,
    });

    cleanupTasks.push(async () => {
      await execFileAsync(tmuxBin, ["kill-session", "-t", sessionName], {
        timeout: 10_000,
      }).catch(() => undefined);
    });
    if (process.env.STATION_REAL_OPENCODE_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real OpenCode session temp root: ${root}\n`);
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
        createOpenCodeHarnessProvider({
          command: shimPath,
          configPath,
          observerSocketPath: join(root, "observer.sock"),
          stateDir,
          hookSpoolDir,
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
        sessionId: () => "ses_real_opencode_session",
      },
      commandTimeoutMs: 30_000,
    });

    try {
      const receipt = await queue.dispatch({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "opencode-real",
          harness: {
            provider: "opencode",
            mode: "interactive",
          },
          terminal: {
            provider: "tmux",
            layout: "agent-build-shell",
          },
        },
      });
      await queue.drain();
      const launchLog = await waitForOpenCodeLaunchLog(shimLog);
      const snapshot = await pollForOpenCodeRow(core);

      expect(await persistence.getCommand(receipt.commandId)).toMatchObject({
        status: "succeeded",
      });
      expect(launchLog).toContain("env.STATION_HARNESS_PROVIDER=opencode");
      expect(launchLog).toContain("env.STATION_SESSION_ID=ses_real_opencode_session");
      expect(launchLog).toContain("env.STATION_OBSERVER_SOCKET_PATH=");
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "opencode",
        sessionId: "ses_real_opencode_session",
        state: "unknown",
        confidence: "low",
      });
      expect(snapshot.sessions[0]).toMatchObject({
        id: "ses_real_opencode_session",
        harness: {
          provider: "opencode",
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
});

async function writeOpenCodeShim(input: {
  shimPath: string;
  shimLog: string;
  realOpenCodeBin: string;
  opencodeConfigDir: string;
}): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
export OPENCODE_CONFIG_DIR=${JSON.stringify(input.opencodeConfigDir)}
{
  printf 'cwd=%s\\n' "$PWD"
  for name in OPENCODE_CONFIG_DIR STATION_CONFIG_PATH STATION_HARNESS_PROVIDER STATION_SESSION_ID STATION_OBSERVER_SOCKET_PATH STATION_OBSERVER_STATE_DIR STATION_HOOK_SPOOL_DIR; do
    printf 'env.%s=%s\\n' "$name" "\${!name-}"
  done
  for arg in "$@"; do
    printf 'arg=%s\\n' "$arg"
  done
} >> ${JSON.stringify(input.shimLog)}
exec ${JSON.stringify(input.realOpenCodeBin)} "$@"
`;
  await writeFile(input.shimPath, script, "utf8");
  await chmod(input.shimPath, 0o755);
}

async function waitForOpenCodeLaunchLog(path: string): Promise<string> {
  return poll(async () => {
    const text = await readFile(path, "utf8").catch(() => "");
    return text.includes("env.STATION_HARNESS_PROVIDER=opencode") ? text : undefined;
  }, "OpenCode launch shim did not record env/argv.");
}

async function pollForOpenCodeRow(core: ReturnType<typeof createObserverCore>) {
  return poll(async () => {
    const snapshot = await core.reconcile("opencode-real-session-poll");
    return snapshot.rows[0]?.agent?.harness === "opencode" ? snapshot : undefined;
  }, "Observer did not discover the real OpenCode session.");
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
    bundleId: "diag_real_opencode_session_failure",
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
      harness: "opencode",
      layout: "agent-shell",
    },
    terminal: {
      tmux: {},
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
        root,
        defaults: {
          harness: "opencode",
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
