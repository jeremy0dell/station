import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, runDoctor } from "../../src/internal.js";
import { FakeDiagnosticEvidenceSource } from "../support/diagnosticEvidenceSources.js";
import { createTestObserverCore } from "../support/testObserver.js";

const now = "2026-05-20T12:00:00.000Z";
const config: StationConfig = {
  schemaVersion: 1,
  workspace: DEFAULT_WORKSPACE_CONFIG,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [],
};

describe("observer singleton Doctor check", () => {
  it("reports clear and report-only outcomes without mutating Observer state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-singleton-doctor-"));
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });
    const deps = {
      config,
      core,
      commandJournal: persistence,
      eventJournal: persistence,
      persistenceHealth: persistence,
      evidenceSource: new FakeDiagnosticEvidenceSource(),
      providers,
      clock,
    };

    try {
      await providers.healthCache.refreshAll();
      await core.reconcile("singleton-doctor-test");
      const beforeDoctor = core.getSnapshot();
      const clear = await runDoctor(deps);
      expect(clear.checks).toContainEqual(
        expect.objectContaining({ name: "observer-singleton", status: "ok" }),
      );

      const reportOnly = await runDoctor({
        ...deps,
        duplicateInspection: async () => ({
          socketPath: join(stateDir, "observer.sock"),
          keeper: 100,
          duplicates: 1,
          refusals: [],
          targets: [
            {
              pid: 200,
              startToken: "candidate-start",
              process: {
                pid: 200,
                argv: [],
                executablePath: "/opt/station/stn",
                startToken: "candidate-start",
                socketPath: join(stateDir, "observer.sock"),
              },
              automaticEligibility: {
                eligible: true,
                quarantineMs: 10_000,
                refusalReasons: [],
              },
            },
          ],
        }),
      });
      expect(reportOnly).toMatchObject({ status: "degraded" });
      expect(reportOnly.checks).toContainEqual(
        expect.objectContaining({
          name: "observer-singleton",
          status: "warn",
          message: expect.stringContaining("stn observer reap"),
        }),
      );
      expect(core.getSnapshot()).toEqual(beforeDoctor);
    } finally {
      sqlite.close();
    }
  });

  it("warns when duplicate evidence cannot authorize an action", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-singleton-outcomes-"));
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers,
      clock,
      sqlitePath: join(stateDir, "observer.sqlite"),
    });
    const deps = {
      config,
      core,
      commandJournal: persistence,
      eventJournal: persistence,
      persistenceHealth: persistence,
      evidenceSource: new FakeDiagnosticEvidenceSource(),
      providers,
      clock,
    };
    try {
      await providers.healthCache.refreshAll();
      await core.reconcile("singleton-outcomes-test");
      const refused = await runDoctor({
        ...deps,
        duplicateInspection: async () => ({
          socketPath: join(stateDir, "observer.sock"),
          keeper: 100,
          duplicates: 1,
          refusals: [{ pid: 200, reason: "unconfirmed socket holder" }],
          targets: [],
        }),
      });
      expect(refused.checks).toContainEqual(
        expect.objectContaining({
          name: "observer-singleton",
          status: "warn",
          message: expect.stringContaining("refusal evidence"),
        }),
      );
    } finally {
      sqlite.close();
    }
  });
});
