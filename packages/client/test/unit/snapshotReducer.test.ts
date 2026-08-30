import { applyStationEvent } from "@station/client";
import type { AgentState, StationEvent, WorktreeRow } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot, fixtureNow, row, sessionGroup } from "../support/snapshots.js";

describe("client snapshot reducer", () => {
  it("applies direct worktree row updates without requesting a snapshot refresh", () => {
    const snapshot = createCommandSnapshot("idle");
    const firstRow = snapshot.rows[0];
    if (firstRow === undefined) throw new Error("Expected an idle fixture row.");
    snapshot.rows[0] = { ...firstRow, title: "Durable workspace" };
    const event: StationEvent = {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        display: {
          statusLabel: "working",
          sortPriority: 30,
          alert: false,
          reason: "Harness reported active generation.",
        },
      },
    };

    const result = applyStationEvent(snapshot, event);
    expect(result.needsSnapshotRefresh).toBe(false);
    expect(result.snapshot.rows[0]?.display.statusLabel).toBe("working");
    expect(result.snapshot.rows[0]?.title).toBe("Durable workspace");
  });

  it("retains partial display merge behavior for ordinary worktree updates", () => {
    const snapshot = createCommandSnapshot("idle");
    const source = snapshot.rows[0];
    if (source === undefined) throw new Error("Expected an idle fixture row.");
    snapshot.rows[0] = {
      ...source,
      display: { ...source.display, warning: true, reason: "Retained context." },
    };

    const result = applyStationEvent(snapshot, {
      type: "worktree.updated",
      worktreeId: source.id,
      patch: {
        display: { statusLabel: "working", sortPriority: 30, alert: false },
      },
    });

    expect(result.snapshot.rows[0]?.display).toEqual({
      statusLabel: "working",
      sortPriority: 30,
      alert: false,
      warning: true,
      reason: "Retained context.",
    });
  });

  it("applies direct title patches without dropping row state", () => {
    const snapshot = createCommandSnapshot("idle");
    const before = snapshot.rows[0];
    if (before === undefined) throw new Error("Expected an idle fixture row.");

    const result = applyStationEvent(snapshot, {
      type: "worktree.updated",
      worktreeId: before.id,
      patch: { title: "Renamed workspace" },
    });

    expect(result.needsSnapshotRefresh).toBe(false);
    expect(result.snapshot.rows[0]).toMatchObject({
      title: "Renamed workspace",
      branch: before.branch,
      agent: before.agent,
      display: before.display,
    });
  });

  it("applies readiness-only worktree row updates", () => {
    const snapshot = createCommandSnapshot("idle");
    const rowAgent = snapshot.rows[0]?.agent;
    if (rowAgent === undefined) {
      throw new Error("Expected idle fixture row to have an agent.");
    }
    const added = applyStationEvent(snapshot, {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        agent: {
          ...rowAgent,
          turnReadiness: {
            state: "ready_to_read",
            token: "report_ready",
            completedAt: fixtureNow,
          },
        },
      },
    });

    expect(added.needsSnapshotRefresh).toBe(false);
    expect(added.snapshot.rows[0]?.agent?.turnReadiness).toEqual({
      state: "ready_to_read",
      token: "report_ready",
      completedAt: fixtureNow,
    });

    const removedAgent = { ...rowAgent };
    const removed = applyStationEvent(added.snapshot, {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        agent: removedAgent,
      },
    });

    expect(removed.needsSnapshotRefresh).toBe(false);
    expect(removed.snapshot.rows[0]?.agent).not.toHaveProperty("turnReadiness");
  });

  it("adds and removes worktree rows from normalized events", () => {
    const snapshot = createCommandSnapshot("none");
    const added = applyStationEvent(snapshot, {
      type: "worktree.added",
      row: row({ id: "wt_web_added", projectId: "web", branch: "new-row", state: "none" }),
    });

    expect(added.snapshot.rows.map((candidate) => candidate.id)).toContain("wt_web_added");

    const removed = applyStationEvent(added.snapshot, {
      type: "worktree.removed",
      worktreeId: "wt_web_added",
    });
    expect(removed.snapshot.rows.map((candidate) => candidate.id)).not.toContain("wt_web_added");
  });

  it("waits for canonical relationship-complete state after session creation", () => {
    const snapshot = createCommandSnapshot("idle");
    const existingSession = snapshot.sessions[0];
    if (existingSession === undefined) {
      throw new Error("Expected idle fixture snapshot to have a session.");
    }

    const created = applyStationEvent(snapshot, {
      type: "session.created",
      session: {
        ...existingSession,
        id: "ses_web_second",
      },
    });

    expect(created.snapshot).toBe(snapshot);
    expect(created.snapshot.sessions).toHaveLength(1);
    expect(created.snapshot.counts.sessions).toBe(1);
    expect(created.needsSnapshotRefresh).toBe(true);

    const canonical = {
      ...created.snapshot,
      sessions: [...created.snapshot.sessions, { ...existingSession, id: "ses_web_second" }],
    };
    const removed = applyStationEvent(canonical, {
      type: "session.removed",
      sessionId: "ses_web_second",
    });

    expect(removed.snapshot.sessions).toHaveLength(1);
    expect(removed.needsSnapshotRefresh).toBe(true);
  });

  it("requests canonical totals after session status changes", () => {
    const idleSnapshot = createCommandSnapshot("idle");
    const existingSession = idleSnapshot.sessions[0];
    if (existingSession === undefined) {
      throw new Error("Expected idle fixture snapshot to have a session.");
    }
    const snapshot = {
      ...idleSnapshot,
      sessions: [
        {
          ...existingSession,
          status: {
            ...existingSession.status,
            value: "working" as const,
          },
        },
      ],
      counts: {
        ...idleSnapshot.counts,
        working: 1,
        idle: 0,
      },
    };

    const updated = applyStationEvent(snapshot, {
      type: "session.updated",
      sessionId: existingSession.id,
      patch: {
        status: {
          ...existingSession.status,
          value: "idle",
        },
      },
    });

    expect(updated.snapshot.sessions[0]?.status.value).toBe("idle");
    expect(updated.snapshot.counts).toMatchObject({ working: 1, idle: 0 });
    expect(updated.needsSnapshotRefresh).toBe(true);
  });

  it("applies monotonic Group renames and ignores duplicate or older events", () => {
    const snapshot = createCommandSnapshot("idle");
    const memberId = snapshot.sessions[0]?.id;
    if (memberId === undefined) throw new Error("Expected an idle fixture session.");
    const current = sessionGroup({ sessionIds: [memberId] });
    snapshot.sessionGroups = [current];
    const renamed = sessionGroup({
      name: "Renamed work",
      sessionIds: [memberId],
      version: 2,
      updatedAt: "2026-05-20T12:01:00.000Z",
    });

    const applied = applyStationEvent(snapshot, groupUpdatedEvent(renamed));
    expect(applied.needsSnapshotRefresh).toBe(false);
    expect(applied.snapshot.sessionGroups).toEqual([renamed]);

    const duplicate = applyStationEvent(applied.snapshot, groupUpdatedEvent(renamed));
    expect(duplicate).toEqual({
      snapshot: applied.snapshot,
      needsSnapshotRefresh: false,
      notices: [],
    });

    const older = applyStationEvent(
      applied.snapshot,
      groupUpdatedEvent(sessionGroup({ name: "Stale", sessionIds: [memberId] })),
    );
    expect(older.snapshot).toBe(applied.snapshot);
    expect(older.needsSnapshotRefresh).toBe(false);
  });

  it("refreshes without partial Group state for creates, divergence, and structural updates", () => {
    const snapshot = createCommandSnapshot("idle");
    const memberId = snapshot.sessions[0]?.id;
    if (memberId === undefined) throw new Error("Expected an idle fixture session.");
    const current = sessionGroup({ sessionIds: [memberId] });
    const destination = sessionGroup({ id: "grp_web_2", name: "Destination" });
    snapshot.sessionGroups = [current, destination];

    const events: StationEvent[] = [
      groupUpdatedEvent(sessionGroup({ id: "grp_web_new", name: "Created" })),
      groupUpdatedEvent(sessionGroup({ name: "Divergent", sessionIds: [memberId] })),
      groupUpdatedEvent(
        sessionGroup({
          id: destination.id,
          name: destination.name,
          sessionIds: [memberId],
          version: 2,
          updatedAt: "2026-05-20T12:01:00.000Z",
        }),
      ),
      groupUpdatedEvent(
        sessionGroup({
          sessionIds: [memberId],
          parentGroupId: destination.id,
          version: 2,
          updatedAt: "2026-05-20T12:01:00.000Z",
        }),
      ),
    ];

    for (const event of events) {
      const result = applyStationEvent(snapshot, event);
      expect(result.snapshot).toBe(snapshot);
      expect(result.needsSnapshotRefresh).toBe(true);
    }
  });

  it("refreshes when an otherwise safe Group replacement fails snapshot validation", () => {
    const snapshot = createCommandSnapshot("idle");
    snapshot.sessionGroups = [sessionGroup()];

    const result = applyStationEvent(
      snapshot,
      groupUpdatedEvent(
        sessionGroup({
          name: "Invalid timestamp",
          version: 2,
          updatedAt: "2026-05-20T11:59:00.000Z",
        }),
      ),
    );

    expect(result.snapshot).toBe(snapshot);
    expect(result.needsSnapshotRefresh).toBe(true);
  });

  it("removes Groups only when the resulting graph remains valid", () => {
    const snapshot = createCommandSnapshot("idle");
    const parent = sessionGroup({ id: "grp_parent", name: "Parent" });
    const child = sessionGroup({ id: "grp_child", name: "Child", parentGroupId: parent.id });
    snapshot.sessionGroups = [parent, child];

    const blocked = applyStationEvent(snapshot, groupRemovedEvent(parent.id));
    expect(blocked.snapshot).toBe(snapshot);
    expect(blocked.needsSnapshotRefresh).toBe(true);

    const removedChild = applyStationEvent(snapshot, groupRemovedEvent(child.id));
    expect(removedChild.needsSnapshotRefresh).toBe(false);
    expect(removedChild.snapshot.sessionGroups).toEqual([parent]);

    const duplicate = applyStationEvent(removedChild.snapshot, groupRemovedEvent(child.id));
    expect(duplicate.snapshot).toBe(removedChild.snapshot);
    expect(duplicate.needsSnapshotRefresh).toBe(false);
  });

  it("removes deleted sessions from Groups before requesting canonical state", () => {
    const snapshot = createCommandSnapshot("idle");
    const memberId = snapshot.sessions[0]?.id;
    if (memberId === undefined) throw new Error("Expected an idle fixture session.");
    snapshot.sessionGroups = [sessionGroup({ sessionIds: [memberId] })];

    const result = applyStationEvent(snapshot, { type: "session.removed", sessionId: memberId });

    expect(result.snapshot.sessions).toEqual([]);
    expect(result.snapshot.sessionGroups[0]?.sessionIds).toEqual([]);
    expect(result.needsSnapshotRefresh).toBe(true);
  });

  it("removes worktree sessions from Groups and refreshes only when membership changed", () => {
    const snapshot = createCommandSnapshot("idle");
    const worktreeId = snapshot.rows[0]?.id;
    const memberId = snapshot.sessions[0]?.id;
    if (worktreeId === undefined || memberId === undefined) {
      throw new Error("Expected an idle fixture worktree and session.");
    }
    snapshot.sessionGroups = [sessionGroup({ sessionIds: [memberId] })];

    const result = applyStationEvent(snapshot, { type: "worktree.removed", worktreeId });

    expect(result.snapshot.rows).toEqual([]);
    expect(result.snapshot.sessions).toEqual([]);
    expect(result.snapshot.sessionGroups[0]?.sessionIds).toEqual([]);
    expect(result.needsSnapshotRefresh).toBe(true);
  });

  it.each([
    ["needs_attention", "Codex requested permission.", false],
    ["stuck", "Codex stopped making progress.", true],
  ] as const)("projects %s display from live agent state events", (state, reason, warning) => {
    const snapshot = createCommandSnapshot("idle");
    const result = applyStationEvent(snapshot, {
      type: "worktree.agentStateChanged",
      worktreeId: "wt_web_idle",
      agent: agentForState(state, reason),
    });

    expect(result.needsSnapshotRefresh).toBe(false);
    expect(result.snapshot.rows[0]?.agent?.state).toBe(state);
    expect(result.snapshot.rows[0]?.display).toEqual({
      statusLabel: state === "stuck" ? "stuck" : "needs attention",
      sortPriority: state === "stuck" ? 20 : 10,
      alert: true,
      ...(warning ? { warning: true } : {}),
      reason,
    });
  });

  it.each([
    ["stuck", "working"],
    ["needs_attention", "idle"],
  ] as const)("atomically clears stale display fields on %s to %s", (from, to) => {
    const snapshot = createCommandSnapshot("idle");
    const source = snapshot.rows[0];
    if (source === undefined) throw new Error("Expected an idle fixture row.");
    snapshot.rows[0] = {
      ...source,
      agent: agentForState(from, "Stale reason."),
      display: {
        statusLabel: from === "stuck" ? "stuck" : "needs attention",
        sortPriority: from === "stuck" ? 20 : 10,
        alert: true,
        warning: true,
        reason: "Stale reason.",
      },
    };

    const result = applyStationEvent(snapshot, {
      type: "worktree.agentStateChanged",
      worktreeId: source.id,
      agent: agentForState(to, "Calm reason."),
    });

    expect(result.snapshot.rows[0]?.display).toEqual(
      to === "working"
        ? { statusLabel: "working", sortPriority: 30, alert: false }
        : { statusLabel: "idle", sortPriority: 40, alert: false },
    );
  });

  it("distinguishes explicit none from an absent agent", () => {
    const snapshot = createCommandSnapshot("idle");
    const explicitNone = applyStationEvent(snapshot, {
      type: "worktree.agentStateChanged",
      worktreeId: "wt_web_idle",
      agent: agentForState("none", "No active run."),
    });
    const absent = applyStationEvent(snapshot, {
      type: "worktree.agentStateChanged",
      worktreeId: "wt_web_idle",
    });

    expect(explicitNone.snapshot.rows[0]?.display).toEqual({
      statusLabel: "no agent",
      sortPriority: 70,
      alert: false,
    });
    expect(absent.snapshot.rows[0]?.display).toEqual({
      statusLabel: "no agent",
      sortPriority: 70,
      alert: false,
      reason: "No harness run is associated with this worktree.",
    });
    expect(absent.snapshot.rows[0]?.agent).toBeUndefined();
  });

  it("turns command failures into safe diagnostic notices", () => {
    const snapshot = createCommandSnapshot("idle");
    const result = applyStationEvent(snapshot, {
      type: "command.failed",
      commandId: "cmd_focus_1",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_MISSING",
        message: "The terminal target for this worktree no longer exists.",
        hint: "Refresh the dashboard or reopen the worktree.",
        diagnosticId: "diag_terminal_missing",
        traceId: "trc_terminal_missing",
      },
    });

    expect(result.notices).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "The terminal target for this worktree no longer exists.",
        diagnosticId: "diag_terminal_missing",
        traceId: "trc_terminal_missing",
      }),
    ]);
  });

  it.each([
    "SESSION_GROUP_VERSION_CONFLICT",
    "SESSION_GROUP_ASSIGNMENT_CONFLICT",
  ])("refreshes without an event-path notice for %s", (code) => {
    const snapshot = createCommandSnapshot("idle");
    const result = applyStationEvent(snapshot, {
      type: "command.failed",
      commandId: "cmd_group_conflict",
      error: {
        tag: "CommandConflictError",
        code,
        message: "The Group changed.",
      },
    });

    expect(result).toEqual({ snapshot, needsSnapshotRefresh: true, notices: [] });
  });

  it("requests snapshot refresh after reconcile and provider health events", () => {
    const snapshot = createCommandSnapshot("idle");
    const reconciled = applyStationEvent(snapshot, {
      type: "observer.reconciled",
      at: fixtureNow,
      changed: 1,
    });
    const provider = applyStationEvent(snapshot, {
      type: "provider.healthChanged",
      provider: "tmux",
      health: {
        provider: "tmux",
        providerType: "terminal",
        status: "healthy",
        lastCheckedAt: fixtureNow,
      },
    });

    expect(reconciled.needsSnapshotRefresh).toBe(true);
    expect(provider.needsSnapshotRefresh).toBe(true);
  });
});

function agentForState(state: AgentState, reason: string): NonNullable<WorktreeRow["agent"]> {
  return {
    harness: "codex",
    state,
    runId: "run_wt_web_idle",
    sessionId: "ses_wt_web_idle",
    confidence: "high",
    reason,
    updatedAt: fixtureNow,
  };
}

function groupUpdatedEvent(
  group: ReturnType<typeof sessionGroup>,
): Extract<StationEvent, { type: "sessionGroup.updated" }> {
  return {
    type: "sessionGroup.updated",
    at: fixtureNow,
    commandId: "cmd_group_updated",
    group,
  };
}

function groupRemovedEvent(
  groupId: ReturnType<typeof sessionGroup>["id"],
): Extract<StationEvent, { type: "sessionGroup.removed" }> {
  return {
    type: "sessionGroup.removed",
    at: fixtureNow,
    commandId: "cmd_group_removed",
    projectId: "web",
    groupId,
  };
}
