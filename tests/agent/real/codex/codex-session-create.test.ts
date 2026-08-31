import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCodexHarnessProvider, installCodexHooks } from "@station/codex";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
  createCommandQueue,
  createLocalDiagnosticEvidenceSource,
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
import { createUnexpectedProjectConfigWriter } from "../../../../apps/observer/test/support/projectConfigWriter.js";

const execFileAsync = promisify(execFile);
const realCodexEnabled = process.env.STATION_REAL_CODEX === "1";
const describeRealCodex = realCodexEnabled ? describe : describe.skip;

const now = "2026-05-21T12:00:00.000Z";
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealCodex("real Codex session.create", () => {
  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    await Promise.allSettled(tasks.map((task) => task()));
  });

  it("launches real Codex through tmux and observes a normalized Codex harness run", async () => {
    const codexBin = process.env.STATION_CODEX_BIN ?? "codex";
    const tmuxBin = process.env.STATION_TMUX_BIN ?? "tmux";
    await execFileAsync(codexBin, ["login", "status"], { timeout: 15_000 });
    await execFileAsync(tmuxBin, ["-V"], { timeout: 10_000 });

    const root = await mkdtemp(join(tmpdir(), "station-real-codex-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    const worktreePath = join(root, "worktree");
    const codexHome = join(root, "codex-home");
    const hookScriptPath = join(stateDir, "hooks", "station-codex-hook.sh");
    const observerSocketPath = join(root, "observer.sock");
    const ingressBin = join(process.cwd(), "bin", "stn-ingress");
    const artifactOwner = {
      schemaVersion: 1 as const,
      launcher: ingressBin,
      runtimeKind: "source" as const,
      version: "0.0.0-real-test",
      buildIdentity: "a".repeat(64),
    };
    const sessionName = `station-codex-${process.pid}-${Date.now()}`;
    const shimLog = join(root, "codex-shim.log");
    const shimPath = join(root, "codex-shim");
    await mkdir(stateDir, { recursive: true });
    await mkdir(hookSpoolDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
    await linkCodexAuth(codexHome);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanupTasks.push(async () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
    await installCodexHooks({
      hookScriptPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      hookBin: ingressBin,
      artifactOwner,
    });
    await writeCodexShim({ shimPath, shimLog, realCodexBin: codexBin, codexHome });

    cleanupTasks.push(async () => {
      await execFileAsync(tmuxBin, ["kill-session", "-t", sessionName], {
        timeout: 10_000,
      }).catch(() => undefined);
    });
    if (process.env.STATION_REAL_CODEX_KEEP_TEMP !== "1") {
      cleanupTasks.push(async () => {
        await rm(root, { recursive: true, force: true });
      });
    } else {
      process.stderr.write(`Keeping real Codex temp root: ${root}\n`);
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
      terminalPlacements: [terminal.placement],
      harnesses: [
        createCodexHarnessProvider({
          command: shimPath,
          installHooks: true,
          hookBin: ingressBin,
          artifactOwner,
          noAltScreen: true,
          observerSocketPath,
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
        sessionId: () => "ses_real_codex",
      },
      commandTimeoutMs: 30_000,
    });

    try {
      const receipt = await queue.dispatch({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "codex-real",
          harness: {
            provider: "codex",
            mode: "interactive",
          },
          terminal: {
            provider: "tmux",
            layout: "agent-build-shell",
          },
          placement: { intent: "detached" },
        },
      });
      await queue.drain();
      expect(await persistence.getCommand(receipt.commandId)).toMatchObject({
        status: "succeeded",
      });
      await waitForShimLog(shimLog);

      const snapshot = await pollForCodexRow(core);

      expect(await readFile(shimLog, "utf8")).toContain("--cd");
      expect(snapshot.rows[0]?.agent).toMatchObject({
        harness: "codex",
        sessionId: "ses_real_codex",
        state: "unknown",
        confidence: "low",
      });
      expect(snapshot.sessions[0]).toMatchObject({
        id: "ses_real_codex",
        harness: {
          provider: "codex",
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

async function writeCodexShim(input: {
  shimPath: string;
  shimLog: string;
  realCodexBin: string;
  codexHome: string;
}): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
export CODEX_HOME=${JSON.stringify(input.codexHome)}
{
  printf 'cwd=%s\\n' "$PWD"
  for arg in "$@"; do
    printf 'arg=%s\\n' "$arg"
  done
} >> ${JSON.stringify(input.shimLog)}
exec ${JSON.stringify(input.realCodexBin)} --dangerously-bypass-hook-trust "$@"
`;
  await writeFile(input.shimPath, script, "utf8");
  await chmod(input.shimPath, 0o755);
}

async function linkCodexAuth(codexHome: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  await access(source);
  await symlink(source, join(codexHome, "auth.json"));
}

async function waitForShimLog(path: string): Promise<void> {
  await poll(async () => {
    const text = await readFile(path, "utf8").catch(() => "");
    return text.includes("arg=--cd");
  }, "Codex launch shim did not record argv.");
}

async function pollForCodexRow(core: ReturnType<typeof createObserverCore>) {
  return poll(async () => {
    const snapshot = await core.reconcile("codex-real-poll");
    return snapshot.rows[0]?.agent?.harness === "codex" ? snapshot : undefined;
  }, "Observer did not discover the real Codex session.");
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
    commandJournal: input.persistence,
    eventJournal: input.persistence,
    persistenceHealth: input.persistence,
    evidenceSource: createLocalDiagnosticEvidenceSource({
      stateDir: input.stateDir,
      diagnosticsDir: input.diagnosticsDir,
      logPaths: [join(input.stateDir, "logs", "observer.jsonl")],
    }),
    clock: { now: () => new Date(now) },
  });
  await writeDebugBundle({
    diagnosticsDir: input.diagnosticsDir,
    snapshot,
    now: new Date(now),
    bundleId: "diag_real_codex_failure",
  });
}

function config(root: string, stateDir: string): StationConfig {
  return {
    schemaVersion: 1,
    workspace: DEFAULT_WORKSPACE_CONFIG,
    observer: {
      stateDir,
      socketPath: join(root, "observer.sock"),
    },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "tmux",
      harness: "codex",
      layout: "agent-shell",
    },
    terminal: {
      tmux: {},
    },
    harness: {
      codex: {
        enabled: true,
      },
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "codex",
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
