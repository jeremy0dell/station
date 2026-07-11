import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClaudeHarnessProvider } from "@station/claude";
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
import { FakeWorktreeProvider } from "@station/testing";
import { TmuxProvider } from "@station/tmux";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const realClaudeEnabled = process.env.STATION_REAL_CLAUDE === "1";
const describeRealClaude = realClaudeEnabled ? describe : describe.skip;

const now = "2026-06-11T12:00:00.000Z";
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealClaude("real Claude session.create", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    await Promise.allSettled(tasks.map((task) => task()));
  });

  it("launches real Claude through tmux and observes a normalized Claude harness run", async () => {
    const claudeBin = process.env.STATION_CLAUDE_BIN ?? "claude";
    const tmuxBin = process.env.STATION_TMUX_BIN ?? "tmux";
    await execFileAsync(claudeBin, ["--version"], { timeout: 15_000 });
    await execFileAsync(tmuxBin, ["-V"], { timeout: 10_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-claude-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const worktreePath = join(root, "worktree");
    const sessionName = `station-claude-${process.pid}-${Date.now()}`;
    const shimLog = join(root, "claude-shim.log");
    const shimPath = join(root, "claude-shim");
    await mkdir(stateDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await writeClaudeShim({ shimPath, shimLog, realClaudeBin: claudeBin });

    cleanupTasks.push(async () => {
      await execFileAsync(tmuxBin, ["kill-session", "-t", sessionName], {
        timeout: 10_000,
      }).catch(() => undefined);
    });
    if (process.env.STATION_REAL_CLAUDE_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real Claude temp root: ${root}\n`);
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
        createClaudeHarnessProvider({
          command: shimPath,
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
        sessionId: () => "ses_real_claude",
      },
      commandTimeoutMs: 30_000,
    });

    try {
      const receipt = await queue.dispatch({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "claude-real",
          harness: {
            provider: "claude",
            mode: "interactive",
          },
          terminal: {
            provider: "tmux",
            layout: "agent-build-shell",
          },
        },
      });
      await queue.drain();
      await waitForShimLog(shimLog, worktreePath);

      const snapshot = await pollForClaudeRow(core);

      expect(await persistence.getCommand(receipt.commandId)).toMatchObject({
        status: "succeeded",
      });
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "claude",
        sessionId: "ses_real_claude",
        state: "unknown",
        confidence: "low",
      });
      expect(snapshot.sessions[0]).toMatchObject({
        id: "ses_real_claude",
        harness: {
          provider: "claude",
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

async function writeClaudeShim(input: {
  shimPath: string;
  shimLog: string;
  realClaudeBin: string;
}): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'cwd=%s\\n' "$PWD"
  for arg in "$@"; do
    printf 'arg=%s\\n' "$arg"
  done
} >> ${JSON.stringify(input.shimLog)}
exec ${JSON.stringify(input.realClaudeBin)} "$@"
`;
  await writeFile(input.shimPath, script, "utf8");
  await chmod(input.shimPath, 0o755);
}

async function waitForShimLog(path: string, worktreePath: string): Promise<void> {
  await poll(async () => {
    const text = await readFile(path, "utf8").catch(() => "");
    // Claude has no --cd flag; the worktree is selected via the launch plan cwd.
    return text.includes(`cwd=${worktreePath}`);
  }, "Claude launch shim did not record the worktree cwd.");
}

async function pollForClaudeRow(core: ReturnType<typeof createObserverCore>) {
  return poll(async () => {
    const snapshot = await core.reconcile("claude-real-poll");
    return snapshot.rows[0]?.agent?.harness === "claude" ? snapshot : undefined;
  }, "Observer did not discover the real Claude session.");
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
    bundleId: "diag_real_claude_failure",
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
      harness: "claude",
      layout: "agent-shell",
    },
    terminal: {
      tmux: {},
    },
    harness: {
      claude: {
        enabled: true,
      },
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "claude",
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
