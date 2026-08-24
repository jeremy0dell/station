import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import type { ProviderProjectConfig, SafeError } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../../src/internal.js";
import { createTestIdFactory, createTestObserverCore } from "../support/testObserver.js";

const now = "2026-08-24T08:53:09.000Z";

function project(id: string): StationConfig["projects"][number] {
  return {
    id,
    label: id,
    root: `/tmp/station/${id}`,
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: { enabled: true },
  };
}

function configFor(...projectIds: string[]): StationConfig {
  return {
    schemaVersion: 1,
    defaults: {
      worktreeProvider: "fake-worktree",
      terminal: "fake-terminal",
      harness: "fake-harness",
      layout: "agent-shell",
    },
    projects: projectIds.map(project),
  };
}

function providersFor(
  sessions: Array<{ projectId: string; worktreeId: string; sessionId: string }>,
): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: sessions.map(({ projectId, worktreeId }) =>
        createFakeWorktree({ id: worktreeId, projectId, now }),
      ),
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: sessions.map(({ projectId, worktreeId, sessionId }) =>
        createFakeTerminalTarget({
          id: `term_${sessionId}`,
          projectId,
          worktreeId,
          sessionId,
          harnessRunId: `run_${sessionId}`,
          now,
        }),
      ),
    }),
    harnesses: [
      new FakeHarnessProvider({
        now,
        runs: sessions.map(({ projectId, worktreeId, sessionId }) =>
          createFakeHarnessRun({
            id: `run_${sessionId}`,
            projectId,
            worktreeId,
            sessionId,
            state: "idle",
            now,
          }),
        ),
      }),
    ],
  });
}

function providerTimeout(provider: string): SafeError {
  return {
    tag: "TimeoutError",
    code: "PROVIDER_TIMEOUT",
    message: "Provider operation timed out.",
    provider,
  };
}

describe("reconcile Session Group repair authority", () => {
  it("preserves membership through provider timeouts, SQLite reopen, and healthy recovery", async () => {
    const dbPath = join(
      await mkdtemp(join(tmpdir(), "station-group-reconcile-authority-")),
      "observer.sqlite",
    );
    const config = configFor("web");
    const idFactory = createTestIdFactory();
    const providers = providersFor([
      { projectId: "web", worktreeId: "wt_web_main", sessionId: "ses_web_main" },
    ]);
    const first = createTestObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
      idFactory,
    });
    await first.persistence.createSessionGroup({
      id: "grp_web",
      projectId: "web",
      name: "Web",
      initialMembers: [{ sessionId: "ses_web_main", projectId: "web", expectedGroupId: null }],
      createdAt: now,
    });

    const healthy = await first.core.reconcile("healthy-before-timeout");
    expect(healthy.sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_web", sessionIds: ["ses_web_main"], version: 1 }),
    ]);
    expect(first.core.getHealth().lastReconcile?.sessionGroupRepair).toEqual({
      status: "applied",
      absenceAuthorityProjectIds: ["web"],
      preservedProjectIds: [],
      blockers: [],
    });

    const worktreeRead = vi
      .spyOn(providers.worktree, "listWorktrees")
      .mockRejectedValue(providerTimeout("fake-worktree"));
    const terminalRead = vi
      .spyOn(providers.terminal, "listTargets")
      .mockRejectedValue(providerTimeout("fake-terminal"));

    const degraded = await first.core.reconcile("provider-timeouts");
    expect(degraded.sessions).toEqual([]);
    expect(degraded.sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_web", sessionIds: [], version: 1 }),
    ]);
    await expect(first.persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({ id: "grp_web", sessionIds: ["ses_web_main"], version: 1 }),
    ]);
    expect(first.core.getHealth().lastReconcile?.sessionGroupRepair).toEqual({
      status: "skipped",
      absenceAuthorityProjectIds: [],
      preservedProjectIds: ["web"],
      blockers: [
        {
          scope: "project",
          providerType: "worktree",
          providerId: "fake-worktree",
          projectId: "web",
          code: "PROVIDER_TIMEOUT",
        },
        {
          scope: "global",
          providerType: "terminal",
          providerId: "fake-terminal",
          code: "PROVIDER_TIMEOUT",
        },
      ],
    });

    worktreeRead.mockRestore();
    terminalRead.mockRestore();
    first.sqlite.close();

    const recovered = createTestObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
      sqlitePath: dbPath,
      idFactory,
    });
    const recoveredSnapshot = await recovered.core.reconcile("healthy-after-restart");
    expect(recoveredSnapshot.sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_web", sessionIds: ["ses_web_main"], version: 1 }),
    ]);
    await expect(recovered.persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({ id: "grp_web", sessionIds: ["ses_web_main"], version: 1 }),
    ]);
    recovered.sqlite.close();
  });

  it("prunes a confirmed deletion while preserving membership in a failed project", async () => {
    const config = configFor("web", "api");
    const providers = providersFor([
      { projectId: "web", worktreeId: "wt_web_main", sessionId: "ses_web_main" },
      { projectId: "api", worktreeId: "wt_api_main", sessionId: "ses_api_main" },
    ]);
    const originalListWorktrees = providers.worktree.listWorktrees.bind(providers.worktree);
    vi.spyOn(providers.worktree, "listWorktrees").mockImplementation(
      async (configuredProject: ProviderProjectConfig) => {
        if (configuredProject.id === "api") throw providerTimeout("fake-worktree");
        return originalListWorktrees(configuredProject);
      },
    );
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
    });
    await persistence.createSessionGroup({
      id: "grp_web_deleted",
      projectId: "web",
      name: "Deleted",
      initialMembers: [{ sessionId: "ses_web_deleted", projectId: "web", expectedGroupId: null }],
      createdAt: now,
    });
    await persistence.createSessionGroup({
      id: "grp_api_preserved",
      projectId: "api",
      name: "Preserved",
      initialMembers: [{ sessionId: "ses_api_main", projectId: "api", expectedGroupId: null }],
      createdAt: now,
    });

    const snapshot = await core.reconcile("partial-worktree-scan");

    expect(snapshot.sessions.map((session) => session.id)).toEqual(["ses_web_main"]);
    expect(snapshot.sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_api_preserved", sessionIds: [], version: 1 }),
      expect.objectContaining({ id: "grp_web_deleted", sessionIds: [], version: 2 }),
    ]);
    await expect(persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({
        id: "grp_api_preserved",
        sessionIds: ["ses_api_main"],
        version: 1,
      }),
      expect.objectContaining({ id: "grp_web_deleted", sessionIds: [], version: 2 }),
    ]);
    expect(core.getHealth().lastReconcile?.sessionGroupRepair).toEqual({
      status: "partially_scoped",
      absenceAuthorityProjectIds: ["web"],
      preservedProjectIds: ["api"],
      blockers: [
        {
          scope: "project",
          providerType: "worktree",
          providerId: "fake-worktree",
          projectId: "api",
          code: "PROVIDER_TIMEOUT",
        },
      ],
    });
    sqlite.close();
  });
});
