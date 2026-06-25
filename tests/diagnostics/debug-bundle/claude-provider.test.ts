import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHarnessProvider } from "@station/claude";
import type { StationConfig } from "@station/config";
import { writeDebugBundle } from "@station/observability";
import {
  collectDiagnosticSnapshot,
  createObserverCore,
  createObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
} from "@station/observer/internal";
import { FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";

const now = "2026-06-11T12:00:00.000Z";

describe("Claude provider debug bundle diagnostics", () => {
  it("includes redacted Claude provider health failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-claude-debug-bundle-"));
    const stateDir = join(root, "state");
    const diagnosticsDir = join(stateDir, "diagnostics");
    await mkdir(stateDir, { recursive: true });

    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const persistence = createObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal: new FakeTerminalProvider({ now }),
        harnesses: [
          createClaudeHarnessProvider({
            command: "claude-missing",
            now: () => new Date(now),
            runner: async () => {
              throw Object.assign(new Error("ANTHROPIC_API_KEY=sk-claudeSecret000000 missing"), {
                code: "ENOENT",
                stderr: "ANTHROPIC_API_KEY=sk-claudeSecret000000 claude-missing: not found",
              });
            },
          }),
        ],
      }),
      persistence,
      sqlite,
      clock,
    });

    await core.reconcile("claude-health-failure");
    const snapshot = await collectDiagnosticSnapshot({
      config,
      configPath: join(root, "config.toml"),
      core,
      persistence,
      paths: {
        stateDir,
        diagnosticsDir,
      },
      clock,
    });
    const manifest = await writeDebugBundle({
      diagnosticsDir,
      snapshot,
      now: new Date(now),
      bundleId: "diag_claude_provider",
    });

    expect(snapshot.providerHealth.claude).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "HARNESS_CLAUDE_UNAVAILABLE",
        provider: "claude",
      },
    });
    const bundleText = await readAllFiles(manifest.bundlePath);
    expect(bundleText).toContain("HARNESS_CLAUDE_UNAVAILABLE");
    expect(bundleText).toContain("claude");
    expect(bundleText).not.toContain("sk-claudeSecret000000");

    sqlite.close();
  });
});

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "claude",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "claude",
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
