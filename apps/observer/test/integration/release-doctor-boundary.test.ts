import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import type { ProviderDoctorCheck } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createObserverCore,
  createObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  runDoctor,
} from "../../src/internal";

const now = "2026-05-22T12:00:00.000Z";

describe("release doctor boundaries", () => {
  it("bounds provider doctor checks and returns typed diagnostic evidence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-release-doctor-"));
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite"), clock });
    const persistence = createObserverPersistence({ sqlite, clock, idFactory: ids() });
    const providers = new ProviderRegistry({
      worktree: new SlowDoctorWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const core = createObserverCore({
      config,
      providers,
      persistence,
      sqlite,
      clock,
    });

    const report = await runDoctor({
      config,
      core,
      persistence,
      providers,
      paths: { stateDir },
      clock,
      providerDoctorTimeoutMs: 5,
    });

    expect(report.status).toBe("unavailable");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "fake-worktree-diagnostics",
          status: "error",
          error: expect.objectContaining({
            tag: "TimeoutError",
            code: "PROVIDER_DOCTOR_CHECK_TIMEOUT",
            provider: "fake-worktree",
          }),
        }),
      ]),
    );
    sqlite.close();
  });
});

class SlowDoctorWorktreeProvider extends FakeWorktreeProvider {
  async doctorChecks(): Promise<ProviderDoctorCheck[]> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [
      {
        name: "slow-check",
        status: "ok",
        message: "Slow provider diagnostics eventually succeeded.",
      },
    ];
  }
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [],
};

function ids() {
  let event = 0;
  let observation = 0;
  return {
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
  };
}
