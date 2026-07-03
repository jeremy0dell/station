import type { StationConfig } from "@station/config";
import { StationSnapshotSchema } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createObserverCore, ProviderRegistry } from "../../src/internal";
import { createTestObserverCore } from "../support/testObserver";

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
      defaults: {
        harness: "fake-harness",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
    {
      id: "api",
      label: "api",
      root: "/tmp/station/api",
      defaults: {
        harness: "fake-harness",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
    {
      id: "mobile",
      label: "mobile",
      root: "/tmp/station/mobile",
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

describe("observer reconcile with fake providers", () => {
  it("correlates configured projects, fake observations, provider health, and timing", async () => {
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({ id: "wt_web_idle", projectId: "web", branch: "idle", now }),
          createFakeWorktree({ id: "wt_api_working", projectId: "api", branch: "working", now }),
          createFakeWorktree({
            id: "wt_api_unknown",
            projectId: "api",
            branch: "unknown",
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "term_web_idle",
            projectId: "web",
            worktreeId: "wt_web_idle",
            sessionId: "ses_web_idle",
            harnessRunId: "run_web_idle",
            now,
          }),
          createFakeTerminalTarget({
            id: "term_api_working",
            projectId: "api",
            worktreeId: "wt_api_working",
            sessionId: "ses_api_working",
            harnessRunId: "run_api_working",
            now,
          }),
          createFakeTerminalTarget({
            id: "term_api_unknown",
            projectId: "api",
            worktreeId: "wt_api_unknown",
            sessionId: "ses_api_unknown",
            harnessRunId: "run_api_unknown",
            state: "unknown",
            confidence: "low",
            reason: "Conflicting provider observations.",
            now,
          }),
          createFakeTerminalTarget({
            id: "term_orphan",
            state: "open",
            confidence: "low",
            reason: "No matching configured project.",
            now,
          }),
        ],
      }),
      harnesses: [
        new FakeHarnessProvider({
          now,
          runs: [
            createFakeHarnessRun({
              id: "run_web_idle",
              projectId: "web",
              worktreeId: "wt_web_idle",
              sessionId: "ses_web_idle",
              state: "idle",
              now,
            }),
            createFakeHarnessRun({
              id: "run_api_working",
              projectId: "api",
              worktreeId: "wt_api_working",
              sessionId: "ses_api_working",
              state: "working",
              now,
            }),
            createFakeHarnessRun({
              id: "run_api_unknown",
              projectId: "api",
              worktreeId: "wt_api_unknown",
              sessionId: "ses_api_unknown",
              state: "unknown",
              confidence: "low",
              reason: "Conflicting provider observations.",
              now,
            }),
          ],
        }),
      ],
    });

    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    await providers.healthCache.refreshAll();
    const snapshot = await core.reconcile("integration-test");
    const health = core.getHealth();

    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.projects.map((project) => project.id)).toEqual(["web", "api", "mobile"]);
    expect(snapshot.projects.find((project) => project.id === "mobile")?.counts.worktrees).toBe(0);
    expect(snapshot.rows.map((row) => row.id)).toEqual([
      "wt_web_idle",
      "wt_api_working",
      "wt_api_unknown",
    ]);
    expect(snapshot.rows.find((row) => row.id === "wt_api_unknown")?.display).toMatchObject({
      statusLabel: "unknown",
      alert: false,
      warning: true,
    });
    expect(snapshot.orphans).toEqual([
      expect.objectContaining({
        kind: "terminal_target",
        terminalTargetId: "term_orphan",
      }),
    ]);
    expect(snapshot.providerHealth["fake-worktree"]?.status).toBe("healthy");
    expect(snapshot.providerHealth["fake-terminal"]?.status).toBe("healthy");
    expect(snapshot.providerHealth["fake-harness"]?.status).toBe("healthy");
    expect(snapshot.harnesses).toEqual([{ id: "fake-harness", label: "fake-harness" }]);
    expect(health.lastReconcile).toMatchObject({
      reason: "integration-test",
      projectsScanned: 3,
      worktreesObserved: 3,
      terminalTargetsObserved: 4,
      harnessRunsObserved: 3,
    });
    expect(health.lastReconcile?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps same-branch home-level worktrees separated by configured project", async () => {
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_feature",
            projectId: "web",
            branch: "feature",
            path: "/tmp/home/.worktrees/web/feature",
            now,
          }),
          createFakeWorktree({
            id: "wt_api_feature",
            projectId: "api",
            branch: "feature",
            path: "/tmp/home/.worktrees/api/feature",
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });

    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("home-level-worktrees");

    expect(snapshot.projects.find((project) => project.id === "web")?.counts.worktrees).toBe(1);
    expect(snapshot.projects.find((project) => project.id === "api")?.counts.worktrees).toBe(1);
    expect(snapshot.rows.map((row) => [row.projectId, row.branch, row.path])).toEqual([
      ["web", "feature", "/tmp/home/.worktrees/web/feature"],
      ["api", "feature", "/tmp/home/.worktrees/api/feature"],
    ]);
  });

  it("reattaches old branch-derived session bindings to the current path-stable worktree", async () => {
    const currentWorktreeId = "wt_web_branch_fix_too_path";
    const oldWorktreeId = "wt_web_branch_fix_too_branch";
    const sessionId = "ses_branch_fix_too";
    const worktreePath = "/tmp/station/web/worktrees/branch-fix-too";
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: currentWorktreeId,
            projectId: "web",
            branch: "agent-created-branch",
            path: worktreePath,
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "term_branch_fix_too",
            projectId: "web",
            worktreeId: oldWorktreeId,
            sessionId,
            cwd: worktreePath,
            now,
          }),
        ],
      }),
      harnesses: [
        new FakeHarnessProvider({
          now,
          runs: [
            createFakeHarnessRun({
              id: "run_branch_fix_too",
              projectId: "web",
              worktreeId: oldWorktreeId,
              sessionId,
              cwd: worktreePath,
              state: "idle",
              now,
            }),
          ],
        }),
      ],
    });
    const { sqlite, persistence, core } = createTestObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
    });
    await persistence.seedSessionTitle({
      sessionId,
      projectId: "web",
      worktreeId: oldWorktreeId,
      title: "Branch Fix too",
      createdAt: now,
      lastSeenAt: now,
    });

    const snapshot = await core.reconcile("old-branch-id-path-reattach");

    expect(snapshot.rows).toEqual([
      expect.objectContaining({
        id: currentWorktreeId,
        branch: "agent-created-branch",
        agent: expect.objectContaining({
          sessionId,
          state: "idle",
        }),
      }),
    ]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        worktreeId: currentWorktreeId,
        title: "Branch Fix too",
      }),
    ]);
    await expect(persistence.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: sessionId,
        worktreeId: currentWorktreeId,
        title: "Branch Fix too",
      }),
    ]);
    sqlite.close();
  });

  it("prefers terminal cwd over stale claimed worktree IDs that still exist", async () => {
    const staleWorktreeId = "wt_web_original_branch";
    const currentWorktreeId = "wt_web_agent_branch";
    const sessionId = "ses_branch_fix_existing_claim";
    const currentPath = "/tmp/station/web/worktrees/original-branch";
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: staleWorktreeId,
            projectId: "web",
            branch: "original-branch",
            path: "/tmp/station/web/worktrees/original-branch-old",
            now,
          }),
          createFakeWorktree({
            id: currentWorktreeId,
            projectId: "web",
            branch: "agent-created-branch",
            path: currentPath,
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "term_branch_fix_existing_claim",
            projectId: "web",
            worktreeId: staleWorktreeId,
            sessionId,
            cwd: currentPath,
            now,
          }),
        ],
      }),
      harnesses: [
        new FakeHarnessProvider({
          now,
          runs: [
            createFakeHarnessRun({
              id: "run_branch_fix_existing_claim",
              projectId: "web",
              worktreeId: staleWorktreeId,
              sessionId,
              cwd: currentPath,
              state: "working",
              now,
            }),
          ],
        }),
      ],
    });
    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("stale-claimed-id-with-current-cwd");

    expect(snapshot.rows.find((row) => row.id === staleWorktreeId)?.agent).toBeUndefined();
    expect(snapshot.rows.find((row) => row.id === currentWorktreeId)?.agent).toMatchObject({
      sessionId,
      state: "working",
    });
  });

  it("maps provider failures into health and keeps a valid snapshot", async () => {
    const providers = new ProviderRegistry({
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
    });
    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("provider-failure");

    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.observer.healthy).toBe(false);
    expect(snapshot.providerHealth["fake-worktree"]).toMatchObject({
      status: "unavailable",
      lastError: {
        code: "FAKE_WORKTREE_LIST_FAILED",
      },
    });
    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "FAKE_WORKTREE_LIST_FAILED",
        provider: "fake-worktree",
      }),
    ]);
  });

  it("times out hung provider reads and records degraded provider health", async () => {
    const terminal = new FakeTerminalProvider({ now });
    terminal.listTargets = async () => new Promise(() => undefined);
    const core = createObserverCore({
      config,
      providerTimeoutMs: 5,
      providerReadRetries: 0,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal,
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("provider-timeout");

    expect(snapshot.providerHealth["fake-terminal"]).toMatchObject({
      status: "unavailable",
      lastError: {
        tag: "TimeoutError",
        code: "PROVIDER_TIMEOUT",
        provider: "fake-terminal",
      },
    });
  });

  it("retries safe provider reads and serializes concurrent reconciles", async () => {
    const worktree = new FakeWorktreeProvider({
      now,
      worktrees: [createFakeWorktree({ id: "wt_web_retry", projectId: "web", now })],
    });
    let attempts = 0;
    let active = 0;
    let maxActive = 0;
    const originalList = worktree.listWorktrees.bind(worktree);
    worktree.listWorktrees = async (project) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      attempts += 1;
      try {
        if (attempts === 1) {
          throw {
            tag: "WorktreeProviderError",
            code: "TRANSIENT_LIST_FAILED",
            message: "Transient list failure.",
            provider: "fake-worktree",
          };
        }
        await new Promise((resolve) => setImmediate(resolve));
        return originalList(project);
      } finally {
        active -= 1;
      }
    };
    const providers = new ProviderRegistry({
      worktree,
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const core = createObserverCore({
      config,
      providerTimeoutMs: 100,
      providerReadRetries: 1,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    await providers.healthCache.refreshAll();
    const [first, second] = await Promise.all([
      core.reconcile("concurrent-a"),
      core.reconcile("concurrent-b"),
    ]);

    expect(first.providerHealth["fake-worktree"]?.status).toBe("healthy");
    expect(second.providerHealth["fake-worktree"]?.status).toBe("healthy");
    expect(attempts).toBeGreaterThan(config.projects.length);
    // Serialized reconciles: concurrent listWorktrees stay within one
    // reconcile's per-project fan-out instead of doubling across both.
    expect(maxActive).toBeLessThanOrEqual(config.projects.length);
  });

  it("reads provider health from the cache without awaiting probes", async () => {
    const worktree = new FakeWorktreeProvider({
      now,
      worktrees: [createFakeWorktree({ id: "wt_web_idle", projectId: "web", now })],
    });
    worktree.health = () => new Promise<never>(() => undefined);
    const providers = new ProviderRegistry({
      worktree,
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
      healthCache: { timeoutMs: 20 },
    });
    const core = createObserverCore({
      config,
      providers,
      clock: {
        now: () => new Date(now),
      },
    });

    const snapshot = await core.reconcile("hung-health-probe");

    expect(StationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.providerHealth["fake-worktree"]?.status).toBe("unknown");
    expect(snapshot.rows.map((row) => row.id)).toEqual(["wt_web_idle"]);

    // The hung probe times out in the background; live reads keep degrading it.
    await providers.healthCache.refreshAll();
    const after = await core.reconcile("after-probes");
    expect(after.providerHealth["fake-terminal"]?.status).toBe("healthy");
    expect(after.providerHealth["fake-harness"]?.status).toBe("healthy");
    expect(after.providerHealth["fake-worktree"]).toMatchObject({
      status: "unavailable",
      lastError: { code: "PROVIDER_TIMEOUT" },
    });
  });
});
