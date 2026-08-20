import { describe, expect, it } from "vitest";
import {
  buildCreateSessionCommand,
  buildCreateSessionGroupCommand,
  buildDeleteSessionGroupCommand,
  buildForkSessionCommand,
  buildRenameSessionCommand,
  buildRenameSessionGroupCommand,
  buildResumeAgentCommand,
  buildStartAgentCommand,
  buildUpdateSessionGroupMembershipCommand,
  buildUpdateSessionGroupMembershipDeltaCommand,
  cleanupForceRequired,
} from "../../../src/state/commandBuilders.js";
import { createCommandSnapshot, createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("TUI command builders", () => {
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
        title: "Dashboard launch",
        branch: "feature/new-dashboard",
        harnessProvider: "codex",
        initialPrompt: "wire the dashboard",
      }),
    ).toEqual({
      type: "session.create",
      payload: {
        projectId: "web",
        title: "Dashboard launch",
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
        title: "Hexagonal PT 12",
        branch: "feature/new-dashboard",
        harnessProvider: "opencode",
      }),
    ).toEqual({
      type: "session.create",
      payload: {
        projectId: "web",
        title: "Hexagonal PT 12",
        branch: "feature/new-dashboard",
        harness: { provider: "opencode", mode: "interactive" },
        terminal: { provider: "tmux", layout: "agent-build-shell", focus: false },
      },
    });
  });

  it("builds session.fork with an independent title and branch", () => {
    const project = createDashboardSnapshot().projects[0];

    expect(
      buildForkSessionCommand({
        project,
        sourceWorktreeId: "wt_web_idle",
        title: "Hexagonal PT 12",
        branch: "fix-nav-mobile-fork",
        copyDirty: true,
        group: {
          kind: "source",
          sourceSessionId: "ses_wt_web_idle",
          groupId: "group_active",
        },
      }),
    ).toMatchObject({
      type: "session.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: "wt_web_idle",
        title: "Hexagonal PT 12",
        branch: "fix-nav-mobile-fork",
        copyDirty: true,
        group: {
          kind: "source",
          sourceSessionId: "ses_wt_web_idle",
          groupId: "group_active",
        },
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

  it("builds strict Group create and expected membership commands", () => {
    expect(buildCreateSessionGroupCommand({ projectId: "web", name: "  Launches  " })).toEqual({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Launches" },
    });
    expect(
      buildUpdateSessionGroupMembershipCommand({
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
        sessionId: "ses_launches",
      }),
    ).toEqual({
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
        add: [{ sessionId: "ses_launches", expectedGroupId: null }],
      },
    });
  });

  it("builds Group Settings rename, bulk membership, and delete commands", () => {
    expect(
      buildRenameSessionGroupCommand({
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
        name: "  Shipped  ",
      }),
    ).toEqual({
      type: "sessionGroup.rename",
      payload: {
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
        name: "Shipped",
      },
    });
    expect(
      buildUpdateSessionGroupMembershipDeltaCommand({
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
        add: [{ sessionId: "ses_add", expectedGroupId: "group_other" }],
        remove: [{ sessionId: "ses_remove", expectedGroupId: "group_launches" }],
      }),
    ).toEqual({
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
        add: [{ sessionId: "ses_add", expectedGroupId: "group_other" }],
        remove: [{ sessionId: "ses_remove", expectedGroupId: "group_launches" }],
      },
    });
    expect(
      buildDeleteSessionGroupCommand({
        projectId: "web",
        groupId: "group_launches",
        expectedVersion: 4,
      }),
    ).toEqual({
      type: "sessionGroup.delete",
      payload: { projectId: "web", groupId: "group_launches", expectedVersion: 4 },
    });
  });

  it("computes cleanup force requirements", () => {
    const snapshot = createCommandSnapshot("idle", { dirty: true });
    const row = snapshot.rows[0];

    expect(cleanupForceRequired(row, "remove-worktree")).toBe(true);
    expect(cleanupForceRequired(row, "close-terminal")).toBe(true);
  });
});
