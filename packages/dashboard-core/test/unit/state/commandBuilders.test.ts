import {
  buildCleanupCommand,
  buildCreateSessionCommand,
  buildFocusCommand,
  buildRenameSessionCommand,
  buildResumeAgentCommand,
  buildStartAgentCommand,
  cleanupForceRequired,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot, createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("TUI command builders", () => {
  it("maps focusable rows to terminal.focus using the agent session", () => {
    const snapshot = createCommandSnapshot("idle");
    const row = snapshot.rows[0];

    expect(row).toBeDefined();
    expect(buildFocusCommand(row)).toEqual({
      type: "terminal.focus",
      payload: { sessionId: "ses_wt_web_idle" },
    });
  });

  it("adds focus origin only when transient navigation provides one", () => {
    const snapshot = createCommandSnapshot("idle");
    const row = snapshot.rows[0];

    expect(
      buildFocusCommand(row, {
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      }),
    ).toEqual({
      type: "terminal.focus",
      payload: {
        sessionId: "ses_wt_web_idle",
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      },
    });
  });

  it("maps no-agent rows to session.startAgent without forcing a harness provider", () => {
    const snapshot = createCommandSnapshot("none");
    const row = snapshot.rows[0];
    const project = snapshot.projects[0];

    expect(buildStartAgentCommand(row, project)).toEqual({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_no_agent",
        terminal: { provider: "tmux", layout: "agent-build-shell", focus: false },
      },
    });
  });

  it("maps recoverable rows to session.resumeAgent without exposing native targets", () => {
    const snapshot = createCommandSnapshot("none");
    const row = {
      ...snapshot.rows[0],
      recovery: {
        kind: "agent-resume" as const,
        handleId: "rec_codex_123",
        provider: "codex",
        targetKind: "native-session" as const,
        sessionId: "ses_wt_web_no_agent",
        lastSeenAt: "2026-06-01T12:00:00.000Z",
      },
    };
    const project = snapshot.projects[0];

    expect(buildResumeAgentCommand(row, project)).toEqual({
      type: "session.resumeAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_no_agent",
        recoveryHandleId: "rec_codex_123",
        terminal: { provider: "tmux", layout: "agent-build-shell", focus: false },
      },
    });
  });

  it("builds session.create from a prompt without leaking provider-specific details", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects[0];

    expect(
      buildCreateSessionCommand({
        project,
        branch: "feature/new-dashboard",
        harnessProvider: "codex",
        initialPrompt: "wire the dashboard",
      }),
    ).toEqual({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature/new-dashboard",
        harness: { provider: "codex", mode: "interactive" },
        terminal: { provider: "tmux", layout: "agent-build-shell", focus: false },
        initialPrompt: "wire the dashboard",
      },
    });
  });

  it("builds session.create with an explicit harness provider when selected", () => {
    const snapshot = createDashboardSnapshot();
    const project = snapshot.projects[0];

    expect(
      buildCreateSessionCommand({
        project,
        branch: "feature/new-dashboard",
        harnessProvider: "opencode",
      }),
    ).toEqual({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature/new-dashboard",
        harness: { provider: "opencode", mode: "interactive" },
        terminal: { provider: "tmux", layout: "agent-build-shell", focus: false },
      },
    });
  });

  it("builds session.rename for session title edits", () => {
    expect(
      buildRenameSessionCommand({
        sessionId: "ses_wt_web_idle",
        title: "Readable feature task",
      }),
    ).toEqual({
      type: "session.rename",
      payload: {
        sessionId: "ses_wt_web_idle",
        title: "Readable feature task",
      },
    });
  });

  it("builds cleanup commands and omits force when guards are not required", () => {
    const snapshot = createCommandSnapshot("idle");
    const row = snapshot.rows[0];

    expect(buildCleanupCommand(row, "close-harness", false)).toEqual({
      type: "session.close",
      payload: {
        sessionId: "ses_wt_web_idle",
        mode: "harness",
      },
    });
    expect(buildCleanupCommand(row, "close-terminal", false)).toEqual({
      type: "terminal.close",
      payload: {
        sessionId: "ses_wt_web_idle",
      },
    });
    expect(buildCleanupCommand(row, "close-all", false)).toEqual({
      type: "session.close",
      payload: {
        sessionId: "ses_wt_web_idle",
        mode: "all",
      },
    });
    expect(buildCleanupCommand(row, "remove-worktree", false)).toEqual({
      type: "worktree.remove",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_idle",
        expectedPath: "/tmp/station/web/worktrees/fix-nav-mobile",
        expectedBranch: "fix-nav-mobile",
        expectedRegistrationIdentity: "git-registration:wt_web_idle",
      },
    });
  });

  it("adds force only for guarded cleanup confirmations", () => {
    const snapshot = createCommandSnapshot("idle", { dirty: true });
    const row = snapshot.rows[0];

    expect(cleanupForceRequired(row, "remove-worktree")).toBe(true);
    expect(cleanupForceRequired(row, "close-terminal")).toBe(true);
    expect(buildCleanupCommand(row, "remove-worktree", true)).toEqual({
      type: "worktree.remove",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_idle",
        expectedPath: "/tmp/station/web/worktrees/fix-nav-mobile",
        expectedBranch: "fix-nav-mobile",
        expectedRegistrationIdentity: "git-registration:wt_web_idle",
        force: true,
      },
    });
    expect(buildCleanupCommand(row, "close-terminal", true)).toEqual({
      type: "terminal.close",
      payload: {
        sessionId: "ses_wt_web_idle",
        force: true,
      },
    });
  });
});
