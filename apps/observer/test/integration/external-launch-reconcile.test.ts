import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { StationTerminalProvider } from "@station/terminal";
import {
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
  createObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  providerIngressSpoolDir,
} from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";

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
  it("drains the hook spool when an external launch triggers a reconcile", async () => {
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
    });
    expect(result.kind).toBe("prepared");

    // The post-launch reconcile is fire-and-forget; wait for the drain to delete
    // the spooled record.
    await waitFor(async () => !(await fileExists(spoolPath)));
    expect(await fileExists(spoolPath)).toBe(false);

    fixture.sqlite.close();
  });
});

function createFixture(spoolDir: string) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const persistence = createObserverPersistence({ sqlite, clock, idFactory: ids() });
  const eventBus = createObserverEventBus();
  const station = new StationTerminalProvider({ clock });
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
    terminals: [station],
    harnesses: [new FakeHarnessProvider({ now })],
  });
  const core = createObserverCore({ config, providers, persistence, sqlite, clock });
  const queue = createCommandQueue({ persistence, clock, idFactory: ids(), eventBus });
  const api = createObserverApi({
    core,
    providers,
    persistence,
    commandQueue: queue,
    eventBus,
    hookSpoolDir: spoolDir,
    clock,
  });
  return { api, sqlite };
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
