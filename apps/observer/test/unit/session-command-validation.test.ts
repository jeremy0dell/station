import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  assertNoCurrentAgent,
  findProjectOrThrow,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
} from "../../src/commands/session/shared";
import { buildStationSnapshot, ProviderRegistry } from "../../src/internal";
import { observerHarnessRunFromRun } from "../../src/reconcile/harnessEventStatus";

const now = "2026-05-21T12:00:00.000Z";

const project = {
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
};

describe("session command validation helpers", () => {
  it("resolves configured projects and provider ids without provider-specific leakage", () => {
    const registry = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });

    expect(findProjectOrThrow([project], "web")).toEqual(project);
    expect(resolveTerminalProviderOrThrow(registry, "fake-terminal").id).toBe("fake-terminal");
    expect(resolveHarnessProviderOrThrow(registry, "fake-harness").id).toBe("fake-harness");
  });

  it("throws safe errors for missing project, mismatched terminal, and missing harness", () => {
    const registry = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });

    expect(() => findProjectOrThrow([project], "missing")).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "PROJECT_NOT_CONFIGURED",
        projectId: "missing",
      }),
    );
    expect(() => resolveTerminalProviderOrThrow(registry, "tmux")).toThrowError(
      expect.objectContaining({
        tag: "TerminalProviderError",
        code: "TERMINAL_PROVIDER_UNAVAILABLE",
        provider: "tmux",
      }),
    );
    expect(() => resolveHarnessProviderOrThrow(registry, "codex")).toThrowError(
      expect.objectContaining({
        tag: "HarnessProviderError",
        code: "HARNESS_PROVIDER_UNAVAILABLE",
        provider: "codex",
      }),
    );
  });

  it("rejects starting a second primary agent for the same worktree", () => {
    const worktree = createFakeWorktree({ id: "wt_web_task", projectId: "web", now });
    const snapshot = buildStationSnapshot({
      generatedAt: now,
      observer: {
        pid: 4242,
        startedAt: now,
        version: "0.0.0",
      },
      projects: [project],
      worktreeProviderId: "fake-worktree",
      providerHealth: {},
      worktrees: [worktree],
      terminalTargets: [
        createFakeTerminalTarget({
          id: "term_web_task",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_web_task",
          harnessRunId: "run_web_task",
          now,
        }),
      ],
      harnessRuns: [
        observerHarnessRunFromRun(
          createFakeHarnessRun({
            id: "run_web_task",
            projectId: "web",
            worktreeId: "wt_web_task",
            sessionId: "ses_web_task",
            now,
          }),
        ),
      ],
    });

    expect(() => assertNoCurrentAgent(snapshot.rows[0])).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "SESSION_ALREADY_HAS_AGENT",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
      }),
    );
  });
});
