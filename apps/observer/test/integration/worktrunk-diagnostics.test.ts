import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { FakeHarnessProvider, FakeTerminalProvider } from "@station/testing";
import { WorktrunkProvider } from "@station/worktrunk";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, runDoctor } from "../../src/internal";
import { createTestObserverCore } from "../support/testObserver";

const now = "2026-05-21T12:00:00.000Z";

describe("Worktrunk diagnostics", () => {
  it("reports provider failures and missing hook setup in doctor data", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-wt-diag-"));
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "missing-wt",
        clock,
        runner: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config: config(stateDir),
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });

    await core.reconcile("diagnostics");
    const report = await runDoctor({
      config: config(stateDir),
      core,
      persistence,
      persistenceHealth: persistence,
      providers,
      paths: { stateDir },
      clock,
    });

    expect(report.status).toBe("degraded");
    expect(report.providers.worktrunk).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "WORKTRUNK_UNAVAILABLE",
        hint: expect.stringContaining("brew install worktrunk"),
      },
      diagnostics: {
        attemptedCommand: "missing-wt",
        installHint: expect.stringContaining("brew install worktrunk"),
      },
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worktrunk-hooks",
          status: "warn",
          error: expect.objectContaining({
            code: "WORKTRUNK_HOOKS_MISSING",
          }),
        }),
      ]),
    );
    sqlite.close();
  });
});

function config(stateDir: string): StationConfig {
  return {
    schemaVersion: 1,
    observer: {
      stateDir,
    },
    defaults: {
      worktreeProvider: "worktrunk",
      terminal: "fake-terminal",
      harness: "fake-harness",
      layout: "agent-shell",
    },
    worktree: {
      worktrunk: {
        configPath: join(stateDir, "worktrunk", "config.toml"),
      },
    },
    projects: [],
  };
}
