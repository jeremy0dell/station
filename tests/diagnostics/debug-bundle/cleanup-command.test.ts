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
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";

const now = "2026-05-21T12:00:00.000Z";

describe("cleanup command debug bundle diagnostics", () => {
  it("includes successful cleanup events and failed cleanup SafeErrors", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cleanup-diag-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    await mkdir(stateDir, { recursive: true });
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const ids = observerIds();
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
    const eventBus = createObserverEventBus();
    const logger = createObserverLogger({ stateDir, clock });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_cleanup",
            projectId: "web",
            branch: "cleanup",
            dirty: true,
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "term_web_cleanup",
            projectId: "web",
            worktreeId: "wt_web_cleanup",
            sessionId: "ses_web_cleanup",
            harnessRunId: "run_web_cleanup",
            now,
          }),
        ],
      }),
      harnesses: [
        new FakeHarnessProvider({
          now,
          runs: [
            createFakeHarnessRun({
              id: "run_web_cleanup",
              projectId: "web",
              worktreeId: "wt_web_cleanup",
              sessionId: "ses_web_cleanup",
              state: "working",
              now,
            }),
          ],
        }),
      ],
    });
    const config = configFor(root, stateDir);
    const core = createObserverCore({ config, providers, persistence, sqlite, clock, logger });
    const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus, logger });
    registerObserverCommandHandlers({
      queue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
    });
    await core.reconcile("pre-cleanup-diag");

    const failed = await queue.dispatch({
      type: "worktree.remove",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
      },
    });
    const succeeded = await queue.dispatch({
      type: "worktree.remove",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        force: true,
      },
    });
    await queue.drain();

    const snapshot = await collectDiagnosticSnapshot(
      {
        config,
        configPath: join(root, "config.toml"),
        core,
        persistence,
        paths: {
          stateDir,
          diagnosticsDir,
          logPaths: [logger.path],
        },
        clock,
      },
      { includeLogs: true },
    );
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      snapshot,
      now: new Date(now),
      bundleId: "diag_cleanup",
    });

    expect(manifest.commandIds).toEqual(expect.arrayContaining([failed.commandId]));
    expect(manifest.commandIds).toEqual(expect.arrayContaining([succeeded.commandId]));
    expect(manifest.traceIds).toEqual(expect.arrayContaining([failed.traceId, succeeded.traceId]));
    const text = await readAllFiles(manifest.bundlePath);
    expect(text).toContain("WORKTREE_DIRTY_REQUIRES_FORCE");
    expect(text).toContain("worktree.removed");
    expect(text).toContain("session.removed");
    expect(text).toContain("fake-worktree");
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
