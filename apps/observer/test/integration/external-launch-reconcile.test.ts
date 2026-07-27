import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type { HarnessHooksStatus } from "@station/contracts";
import { StationTerminalProvider } from "@station/terminal";
import {
  createFakeHarnessRun,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { fileExists, writeHookSpoolRecordFixture } from "../../../../tests/support/spool";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  providerIngressSpoolDir,
} from "../../src/internal";
import type { StationLogger } from "../../src/stationLogger";

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
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaultBranch: "main",
      defaults: { harness: "fake-harness", terminal: "fake-terminal", layout: "agent-shell" },
      worktrunk: { enabled: true },
    },
  ],
};

// A scheduled/api reconcile drains the hook spool; before this fix the
// external-launch reconcile path was wired with a no-op drain, so a hook event
// spooled during an agent launch was never flushed. Prove the launch-triggered
// reconcile drains the spool, the same as api.reconcile does.
describe("observer external-launch reconcile", () => {
  it("publishes the custom title and drains the hook spool after external launch", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const fixture = createFixture(spoolDir);

    // Seed the snapshot first (no spool record yet) so prepareExternalLaunch can
    // find the worktree without this reconcile draining the record under test.
    await fixture.api.reconcile("seed");

    const spoolPath = await writeHookSpoolRecordFixture({ spoolDir, spoolId: "spool_ext" });
    expect(await fileExists(spoolPath)).toBe(true);

    const result = await fixture.api.prepareExternalLaunch({
      projectId: "web",
      worktreeId: "wt_web_feature",
      title: "Hexagonal PT 12",
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error("expected prepared launch");
    fixture.harness.addRun(
      createFakeHarnessRun({
        id: "run_web_feature",
        projectId: "web",
        worktreeId: "wt_web_feature",
        sessionId: result.sessionId,
        state: "working",
        now,
      }),
    );

    // The post-launch reconcile is fire-and-forget; wait for the drain to delete
    // the spooled record.
    await waitFor(async () => !(await fileExists(spoolPath)));
    expect(await fileExists(spoolPath)).toBe(false);
    await fixture.api.reconcile("verify-external-title");
    expect((await fixture.api.getSnapshot()).sessions).toEqual([
      expect.objectContaining({
        worktreeId: "wt_web_feature",
        title: "Hexagonal PT 12",
      }),
    ]);

    fixture.sqlite.close();
  });

  it("logs hook readiness rejections with their diagnostic code", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-ext-"));
    const records: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    const logger: StationLogger = {
      info: async () => {},
      warn: async (message, attributes) => {
        records.push({ message, ...(attributes === undefined ? {} : { attributes }) });
      },
      error: async () => {},
    };
    const fixture = createFixture(providerIngressSpoolDir(stateDir), {
      harness: new MissingHooksHarness(),
      logger,
    });
    await fixture.api.reconcile("seed");

    await expect(
      fixture.api.prepareExternalLaunch({ projectId: "web", worktreeId: "wt_web_feature" }),
    ).rejects.toMatchObject({ code: "HARNESS_HOOKS_NOT_INSTALLED" });
    expect(records).toContainEqual({
      message: "External agent launch rejected because harness hooks are unavailable.",
      attributes: {
        error: expect.objectContaining({ code: "HARNESS_HOOKS_NOT_INSTALLED" }),
        projectId: "web",
        worktreeId: "wt_web_feature",
      },
    });

    fixture.sqlite.close();
  });
});

function createFixture(
  spoolDir: string,
  options: { harness?: FakeHarnessProvider; logger?: StationLogger } = {},
) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids() });
  const eventBus = createObserverEventBus();
  const station = new StationTerminalProvider({ clock });
  const harness = options.harness ?? new FakeHarnessProvider({ now });
  const providers = new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_feature",
          projectId: "web",
          branch: "feature",
          path: "/tmp/station/web/feature",
          remote: { host: "github.com", owner: "example", repo: "web" },
          headSha: "2222222222222222222222222222222222222222",
          now,
        }),
      ],
    }),
    terminal: new FakeTerminalProvider({ now }),
    managedTerminal: station,
    harnesses: [harness],
  });
  const core = createObserverCore({ config, providers, persistence, clock });
  const queue = createCommandQueue({ persistence, clock, idFactory: ids(), eventBus });
  const api = createObserverApi({
    core,
    providers,
    persistence,
    persistenceHealth: persistence,
    commandQueue: queue,
    eventBus,
    hookSpoolDir: spoolDir,
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { api, harness, sqlite };
}

class MissingHooksHarness extends FakeHarnessProvider {
  async hooksStatus(): Promise<HarnessHooksStatus> {
    return {
      provider: this.id,
      installed: false,
      requested: true,
      missing: ["SessionStart"],
      message: "Hooks are not installed.",
    };
  }
}

function ids() {
  let command = 0;
  let event = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for predicate.");
}
