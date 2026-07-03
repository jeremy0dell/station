import type { StationConfig } from "@station/config";
import { FakeHarnessProvider, FakeTerminalProvider } from "@station/testing";
import { WorktrunkProvider } from "@station/worktrunk";
import { describe, expect, it } from "vitest";
import { createFakeWorktrunkRunner } from "../../../../tests/support/fake-external-tools/worktrunk";
import { createObserverCore, ProviderRegistry } from "../../src/internal";

const now = "2026-05-21T12:00:00.000Z";

describe("observer reconcile with Worktrunk provider", () => {
  it("reconciles Worktrunk observations into provider-neutral rows", async () => {
    const calls: string[][] = [];
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "wt",
        clock: { now: () => new Date(now) },
        runner: createFakeWorktrunkRunner({
          listJson: [
            {
              path: "/tmp/station/web/feature-auth",
              branch: "feature/auth",
              worktree: { modified: 1 },
              main: { ahead: 1, behind: 0 },
            },
          ],
          onCall: (input) => calls.push(input.args ?? []),
        }),
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const core = createObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
    });

    await providers.healthCache.refreshAll();
    const snapshot = await core.reconcile("worktrunk-provider");

    expect(snapshot.rows).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wt_web_feature-auth_[a-f0-9]{10}$/),
        projectId: "web",
        branch: "feature/auth",
        worktree: expect.objectContaining({
          source: "worktrunk",
          dirty: true,
          ahead: 1,
        }),
      }),
    ]);
    expect(snapshot.providerHealth.worktrunk?.status).toBe("healthy");
    expect(calls).toContainEqual(["list", "--format=json"]);
  });

  it("keeps the same Worktrunk-derived row id when the same path changes branches", async () => {
    let branch = "original-title";
    const providers = new ProviderRegistry({
      worktree: new WorktrunkProvider({
        command: "wt",
        clock: { now: () => new Date(now) },
        runner: createFakeWorktrunkRunner({
          get listJson() {
            return [
              {
                path: "/tmp/station/web/worktrees/original_title",
                branch,
              },
            ];
          },
        }),
      }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const core = createObserverCore({
      config,
      providers,
      clock: { now: () => new Date(now) },
    });

    const before = await core.reconcile("worktrunk-branch-before");
    branch = "agent-created-branch";
    const after = await core.reconcile("worktrunk-branch-after");

    expect(before.rows).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wt_web_original_title_[a-f0-9]{10}$/),
        branch: "original-title",
        path: "/tmp/station/web/worktrees/original_title",
      }),
    ]);
    expect(after.rows).toEqual([
      expect.objectContaining({
        id: before.rows[0]?.id,
        branch: "agent-created-branch",
        path: "/tmp/station/web/worktrees/original_title",
      }),
    ]);
  });
});

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "worktrunk",
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
        base: "main",
      },
    },
  ],
};
