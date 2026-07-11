import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createObserverLogger,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "@station/observer/internal";
import {
  createFakeHarnessRun,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";

const now = "2026-05-21T12:00:00.000Z";

describe("session.create debug bundle diagnostics", () => {
  it("includes successful session.create command evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-session-diag-success-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    await mkdir(stateDir, { recursive: true });
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const logger = createObserverLogger({ stateDir, clock });
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus, logger });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [
        new FakeHarnessProvider({
          now,
          runs: [
            createFakeHarnessRun({
              id: "run_diag_success",
              projectId: "web",
              worktreeId: "wt_web_success",
              sessionId: "ses_diag_success",
              state: "idle",
              now,
            }),
          ],
        }),
      ],
    });
    const config = configFor(root, stateDir);
    const core = createObserverCore({ config, providers, persistence, clock, logger });
    registerObserverCommandHandlers({
      queue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
      idFactory: {
        sessionId: () => "ses_diag_success",
      },
    });

    const receipt = await queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "success",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await queue.drain();

    const snapshot = await collectDiagnosticSnapshot(
      {
        config,
        configPath: join(root, "config.toml"),
        core,
        persistence,
        persistenceHealth: persistence,
        paths: {
          stateDir,
          diagnosticsDir,
          logPaths: [logger.path],
        },
        clock,
      },
      { includeLogs: true, commandId: receipt.commandId },
    );
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      snapshot,
      now: new Date(now),
      bundleId: "diag_session_create_success",
    });

    expect(manifest.commandIds).toContain(receipt.commandId);
    expect(manifest.traceIds).toContain(receipt.traceId);
    const text = await readAllFiles(manifest.bundlePath);
    expect(text).toContain("command.succeeded");
    expect(text).toContain("session.created");
    expect(text).toContain("ses_diag_success");
    sqlite.close();
  });

  it("includes command, trace, provider failure, events, and redaction evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-session-diag-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    await mkdir(stateDir, { recursive: true });
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const logger = createObserverLogger({ stateDir, clock });
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus, logger });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        failures: {
          createWorktree: {
            tag: "WorktreeProviderError",
            code: "FAKE_WORKTREE_CREATE_FAILED",
            message: "The fake worktree provider could not create TOKEN=sk-sessionsecret0000.",
            provider: "fake-worktree",
          },
        },
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const config = configFor(root, stateDir);
    const core = createObserverCore({ config, providers, persistence, clock, logger });
    registerObserverCommandHandlers({
      queue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
      idFactory: {
        sessionId: () => "ses_diag",
      },
    });

    const receipt = await queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "broken",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await queue.drain();

    const snapshot = await collectDiagnosticSnapshot(
      {
        config,
        configPath: join(root, "config.toml"),
        core,
        persistence,
        persistenceHealth: persistence,
        paths: {
          stateDir,
          diagnosticsDir,
          logPaths: [logger.path],
        },
        clock,
      },
      { includeLogs: true, commandId: receipt.commandId },
    );
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      snapshot,
      now: new Date(now),
      bundleId: "diag_session_create",
    });

    expect(manifest.commandIds).toContain(receipt.commandId);
    expect(manifest.traceIds).toContain(receipt.traceId);
    const text = await readAllFiles(manifest.bundlePath);
    expect(text).toContain("FAKE_WORKTREE_CREATE_FAILED");
    expect(text).toContain("fake-worktree");
    expect(text).toContain(receipt.commandId);
    expect(text).not.toContain("sk-sessionsecret0000");
    sqlite.close();
  });
});

function configFor(root: string, stateDir: string): StationConfig {
  return {
    schemaVersion: 1,
    observer: { stateDir },
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "fake-terminal",
      harness: "fake-harness",
      layout: "agent-shell",
    },
    projects: [
      {
        id: "web",
        label: "web",
        root,
        defaults: {
          harness: "fake-harness",
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

async function readAllFiles(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const childPath = join(path, entry.name);
      return entry.isDirectory() ? readAllFiles(childPath) : readFile(childPath, "utf8");
    }),
  );
  return contents.join("\n");
}
