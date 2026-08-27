import type { ProviderHealth, TerminalTargetObservation } from "@station/contracts";
import { SnapshotTerminalDebugSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildTerminalSnapshotDebug } from "../../src/reconcile/terminalSnapshotDebug";

const observedAt = "2026-05-20T12:00:00.000Z";
const reconciledAt = "2026-05-20T12:00:01.000Z";

describe("terminal snapshot debug evidence", () => {
  it("projects effective controls and omits provider-private target fields", () => {
    const target: TerminalTargetObservation = {
      id: "term_native_managed",
      provider: "native",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      harnessRunId: "run_web_task",
      state: "detached",
      hasManagedAttachment: false,
      cwd: "/private/worktree",
      pid: 4242,
      title: "private terminal title",
      confidence: "high",
      reason: "Station listed the terminal target.",
      observedAt,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "fake-harness",
        worktreePath: "/private/worktree",
      },
      providerData: { ptyId: "private-pty", socketPath: "/private/socket" },
    };
    const providerHealth: ProviderHealth = {
      providerId: "native",
      providerType: "terminal",
      status: "healthy",
      lastCheckedAt: reconciledAt,
      capabilities: {
        canFocusTarget: false,
        canCloseTarget: true,
      },
    };

    const debug = buildTerminalSnapshotDebug({
      reconciledAt,
      targets: [target],
      providerReads: [
        { providerId: "native", providerType: "terminal", status: "complete" },
        {
          providerId: "tmux",
          providerType: "terminal",
          status: "indeterminate",
          failureCode: "TERMINAL_LIST_FAILED",
        },
      ],
      providerHealth: { native: providerHealth },
    });

    expect(debug).toEqual({
      reconciledAt,
      providerReads: [
        { provider: "native", status: "complete" },
        { provider: "tmux", status: "indeterminate", failureCode: "TERMINAL_LIST_FAILED" },
      ],
      targets: [
        {
          id: "term_native_managed",
          provider: "native",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_web_task",
          state: "detached",
          focusable: false,
          closeable: true,
          hasManagedAttachment: false,
          confidence: "high",
          reason: "Station listed the terminal target.",
          observedAt,
        },
      ],
    });
    expect(SnapshotTerminalDebugSchema.parse(debug)).toEqual(debug);
    expect(debug.targets[0]).not.toHaveProperty("providerData");
    expect(debug.targets[0]).not.toHaveProperty("cwd");
    expect(debug.targets[0]).not.toHaveProperty("pid");
    expect(debug.targets[0]).not.toHaveProperty("title");
    expect(debug.targets[0]).not.toHaveProperty("harnessBinding");
    expect(debug.targets[0]).not.toHaveProperty("harnessRunId");
  });
});
