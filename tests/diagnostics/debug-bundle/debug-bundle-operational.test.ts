import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
  createCommandQueue,
  createObserverCore,
  createObserverLogger,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
} from "@station/observer/internal";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";

const now = "2026-05-20T12:00:00.000Z";
const secretToken = "sk-diagsecret000000000";
const bearerSecret = "Bearer diagBearerSecretToken";

describe("operational debug bundle", () => {
  it("writes redacted diagnostics from fake providers and injected failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-debug-bundle-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    await mkdir(stateDir, { recursive: true });

    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const logger = createObserverLogger({ stateDir, clock });
    const queue = createCommandQueue({
      persistence,
      clock,
      idFactory: ids(),
      logger,
    });
    queue.registerHandler("observer.reconcile", async () => {
      throw new Error(`provider leaked ${secretToken} and ${bearerSecret}`);
    });

    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({
          now,
          failures: {
            listWorktrees: {
              tag: "WorktreeProviderError",
              code: "FAKE_WORKTREE_LIST_FAILED",
              message: "The fake worktree provider failed to list worktrees.",
              provider: "fake-worktree",
            },
          },
        }),
        terminal: new FakeTerminalProvider({ now }),
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      persistence,
      sqlite,
      clock,
      logger,
    });

    await core.reconcile("debug-bundle-test");
    const receipt = await queue.dispatch({
      type: "observer.reconcile",
      payload: { reason: "injected-failure" },
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
      bundleId: "diag_debug",
    });

    expect(manifest.sections).toContain("manifest.json");
    expect(manifest.sections).toContain("commands.jsonl");
    expect(manifest.traceIds).toContain(receipt.traceId);
    expect(snapshot.providerHealth["fake-worktree"]?.status).toBe("unavailable");

    const bundleText = await readAllFiles(manifest.bundlePath);
    expect(bundleText).toContain("FAKE_WORKTREE_LIST_FAILED");
    expect(bundleText).toContain(receipt.commandId);
    expect(bundleText).not.toContain(secretToken);
    expect(bundleText).not.toContain(bearerSecret);

    sqlite.close();
  });
});

const config: StationConfig = {
  schemaVersion: 1,
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
      root: "/tmp/station/web",
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

async function readAllFiles(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) {
        return readAllFiles(childPath);
      }
      return readFile(childPath, "utf8");
    }),
  );
  return contents.join("\n");
}
