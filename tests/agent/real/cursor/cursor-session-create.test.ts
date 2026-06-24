import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StationConfig } from "@station/config";
import { CursorHarnessProvider } from "@station/cursor";
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
import { FakeWorktreeProvider } from "@station/testing";
import { TmuxProvider } from "@station/tmux";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const realCursorEnabled = process.env.STATION_REAL_CURSOR === "1";
const describeRealCursor = realCursorEnabled ? describe : describe.skip;

const now = "2026-06-03T12:00:00.000Z";
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealCursor("real Cursor session.create launch lane", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    for (const task of tasks.reverse()) {
      await task().catch(() => undefined);
    }
  });

  it("launches Cursor through tmux and observes a low-confidence Cursor harness run", async () => {
    const cursorBin = process.env.STATION_CURSOR_AGENT_BIN ?? "agent";
    const tmuxBin = process.env.STATION_TMUX_BIN ?? "tmux";
    await execFileAsync(cursorBin, ["--version"], { timeout: 15_000 });
    await execFileAsync(tmuxBin, ["-V"], { timeout: 10_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-cursor-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const worktreePath = join(root, "worktree");
    const sessionName = `station-cursor-${process.pid}-${Date.now()}`;
    const shimLog = join(root, "cursor-shim.log");
    const shimPath = join(root, "cursor-shim");
    await mkdir(stateDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await writeCursorShim({ shimPath, shimLog, realCursorBin: cursorBin });

    cleanupTasks.push(async () => {
      await execFileAsync(tmuxBin, ["kill-session", "-t", sessionName], {
        timeout: 10_000,
      }).catch(() => undefined);
    });
    if (process.env.STATION_REAL_CURSOR_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real Cursor temp root: ${root}\n`);
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
        new CursorHarnessProvider({
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
        sessionId: () => "ses_real_cursor",
      },
      commandTimeoutMs: 30_000,
    });

    try {
      const receipt = await queue.dispatch({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "cursor-real",
          harness: {
            provider: "cursor",
            mode: "interactive",
          },
          terminal: {
            provider: "tmux",
            layout: "agent-build-shell",
          },
        },
      });
      await queue.drain();
      const launchLog = await waitForCursorLaunchLog(shimLog);
      const snapshot = await pollForCursorRow(core);
      const pane = await inspectTmuxPane({
        tmuxBin,
        targetId: await cursorTargetId(terminal),
      });

      expect(await persistence.getCommand(receipt.commandId)).toMatchObject({
        status: "succeeded",
      });
      expect(launchLog).toContain("arg=--workspace");
      expect(launchLog).toContain(`arg=${worktreePath}`);
      expect(launchLog).toContain("env.STATION_HARNESS_PROVIDER=cursor");
      expect(launchLog).toContain("env.STATION_SESSION_ID=ses_real_cursor");
      expect(pane.dead).toBe("0");
      expect(pane.command.length).toBeGreaterThan(0);
      expect(pane.pid).toMatch(/^\d+$/);
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "cursor",
        sessionId: "ses_real_cursor",
        state: "unknown",
        confidence: "low",
      });
      expect(snapshot.sessions[0]).toMatchObject({
        id: "ses_real_cursor",
        harness: {
          provider: "cursor",
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

async function writeCursorShim(input: {
  shimPath: string;
  shimLog: string;
  realCursorBin: string;
}): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'cwd=%s\\n' "$PWD"
  for name in STATION_PROJECT_ID STATION_WORKTREE_ID STATION_WORKTREE_PATH STATION_HARNESS_PROVIDER STATION_SESSION_ID STATION_TERMINAL_PROVIDER STATION_TERMINAL_TARGET_ID; do
    printf 'env.%s=%s\\n' "$name" "\${!name-}"
  done
  for arg in "$@"; do
    printf 'arg=%s\\n' "$arg"
  done
} >> ${JSON.stringify(input.shimLog)}
exec ${JSON.stringify(input.realCursorBin)} "$@"
`;
  await writeFile(input.shimPath, script, "utf8");
  await chmod(input.shimPath, 0o755);
}

async function waitForCursorLaunchLog(path: string): Promise<string> {
  return poll(async () => {
    const text = await readFile(path, "utf8").catch(() => "");
    return text.includes("env.STATION_HARNESS_PROVIDER=cursor") && text.includes("arg=--workspace")
      ? text
      : undefined;
  }, "Cursor launch shim did not record env/argv.");
}

async function pollForCursorRow(core: ReturnType<typeof createObserverCore>) {
  return poll(async () => {
    const snapshot = await core.reconcile("cursor-real-poll");
    return snapshot.rows[0]?.agent?.harness === "cursor" ? snapshot : undefined;
  }, "Observer did not discover the real Cursor session.");
}

async function inspectTmuxPane(input: {
  tmuxBin: string;
  targetId: string;
}): Promise<{ dead: string; command: string; pid: string }> {
  const paneId = tmuxPaneId(input.targetId);
  const output = await execFileAsync(
    input.tmuxBin,
    ["display-message", "-p", "-t", paneId, "#{pane_dead}\t#{pane_current_command}\t#{pane_pid}"],
    { timeout: 10_000 },
  );
  const [dead = "", command = "", pid = ""] = output.stdout.trim().split("\t");
  return { dead, command, pid };
}

async function cursorTargetId(terminal: TmuxProvider): Promise<string> {
  const target = (await terminal.listTargets()).find(
    (candidate) =>
      candidate.sessionId === "ses_real_cursor" &&
      candidate.harnessBinding?.role === "main-agent" &&
      candidate.state !== "stale",
  );
  if (target === undefined) {
    throw new Error("Tmux provider did not report a primary Cursor target id.");
  }
  return target.id;
}

function tmuxPaneId(targetId: string): string {
  const [provider, _sessionId, _windowId, paneId, ...extra] = targetId.split(":");
  if (provider !== "tmux" || paneId === undefined || extra.length > 0) {
    throw new Error(`Invalid tmux target id: ${targetId}`);
  }
  return paneId;
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
    bundleId: "diag_real_cursor_failure",
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
      harness: "cursor",
      layout: "agent-shell",
    },
    terminal: {
      tmux: {},
    },
    harness: {
      cursor: {
        enabled: true,
      },
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "cursor",
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
