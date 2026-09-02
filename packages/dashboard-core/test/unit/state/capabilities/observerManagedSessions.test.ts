import { describe, expect, it } from "vitest";
import { createObserverManagedSessionCapabilities } from "../../../../src/state/capabilities/managedSessions.js";
import { createCommandSnapshot } from "../../../fixtures/snapshots.js";
import { FakeClientStateSource } from "../../../support/fakeClientStateSource.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

function createCapability(snapshot: ReturnType<typeof createCommandSnapshot>) {
  const service = new FakeTuiObserverService(snapshot);
  const capability = createObserverManagedSessionCapabilities({
    service,
    source: new FakeClientStateSource(snapshot),
    policyForTerminalProvider: () => ({
      focusCreatedSession: true,
      dismissDashboard: false,
    }),
  });
  return { service, capability };
}

describe("observer managed-session capability", () => {
  it("creates from product values without an optimistic row and returns the bounded failure", async () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const { service, capability } = createCapability(snapshot);
    service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "CommandExecutionError",
        code: "CREATE_FAILED",
        message: "Create failed.",
      },
    };
    const handle = capability.create({
      project,
      title: "Feature session",
      hiddenBranch: "feature-session-123",
      harness: "codex",
      group: { kind: "create", name: "Release" },
    });

    expect(handle.optimistic).toBe("none");
    expect(await handle.completion).toMatchObject({
      kind: "failure",
      disposition: "remove-immediately",
    });
    expect(service.dispatched[0]).toMatchObject({
      type: "session.create",
      payload: {
        projectId: project.id,
        title: "Feature session",
        branch: "feature-session-123",
        harness: { provider: "codex" },
        placement: { intent: "detached" },
        group: { kind: "create", name: "Release" },
      },
    });
  });

  it("preserves Quick Session optimistic and failed-row behavior", async () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const { service, capability } = createCapability(snapshot);
    service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_quick",
      error: { tag: "CommandExecutionError", code: "CREATE_FAILED", message: "Create failed." },
    };
    const handle = capability.quickCreate({
      project,
      title: "Quick session",
      hiddenBranch: "quick-session-123",
      harness: "codex",
    });

    expect(handle.optimistic).toBe("pending-create");
    expect(await handle.completion).toMatchObject({
      kind: "failure",
      disposition: "retain-failed",
    });
  });

  it("forks without optimistic state and includes the resolved inherited harness", async () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const { service, capability } = createCapability(snapshot);

    const handle = capability.fork({
      project,
      sourceWorktreeId: "wt_web_idle",
      title: "Forked session",
      hiddenBranch: "forked-session-123",
      copyDirty: true,
      group: {
        kind: "source",
        sourceSessionId: "ses_wt_web_idle",
        groupId: "group_active",
      },
      inheritedHarness: "codex",
    });

    expect(handle.optimistic).toBe("none");
    expect(await handle.completion).toEqual({ kind: "success" });
    expect(service.dispatched[0]).toMatchObject({
      type: "session.fork",
      payload: {
        projectId: project.id,
        sourceWorktreeId: "wt_web_idle",
        copyDirty: true,
        group: {
          kind: "source",
          sourceSessionId: "ses_wt_web_idle",
          groupId: "group_active",
        },
        harness: { provider: "codex" },
        placement: { intent: "detached" },
      },
    });
  });

  it("returns one exact data-only UI command from the durable create result", async () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const { service, capability } = createCapability(snapshot);
    service.nextCompletion = {
      status: "succeeded",
      commandId: "cmd_tui_1",
      result: {
        type: "session.create",
        projectId: "web",
        worktreeId: "wt_web_idle",
        sessionId: "ses_wt_web_idle",
        requestedPlacement: "detached",
        resolvedPlacement: {
          provider: "tmux",
          targetId: "tmux:web:fix-nav-mobile",
          generation: "1",
          presentation: "detached",
        },
      },
    };

    await expect(
      capability.quickCreate({
        project,
        title: "Quick session",
        hiddenBranch: "fix-nav-mobile",
        harness: "codex",
      }).completion,
    ).resolves.toEqual({
      kind: "success",
      createdSessionCommand: {
        type: "createdSession.applyUiPolicy",
        target: {
          sessionId: "ses_wt_web_idle",
          projectId: "web",
          worktreeId: "wt_web_idle",
          branch: "fix-nav-mobile",
          terminalProvider: "tmux",
        },
        policy: { focusCreatedSession: true, dismissDashboard: false },
      },
    });
  });

  it.each([
    ["missing", undefined],
    [
      "provider-mismatched",
      {
        type: "session.create" as const,
        projectId: "web",
        worktreeId: "wt_web_idle",
        sessionId: "ses_wt_web_idle",
        requestedPlacement: "detached" as const,
        resolvedPlacement: {
          provider: "native",
          targetId: "native:wt_web_idle",
          generation: "1",
          presentation: "detached" as const,
        },
      },
    ],
  ])("returns a non-retryable notice for a %s durable result", async (_case, result) => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const { service, capability } = createCapability(snapshot);
    service.nextCompletion = {
      status: "succeeded",
      commandId: "cmd_tui_1",
      ...(result === undefined ? {} : { result }),
    };

    await expect(
      capability.create({
        project,
        title: "Quick session",
        hiddenBranch: "fix-nav-mobile",
        harness: "codex",
      }).completion,
    ).resolves.toMatchObject({
      kind: "success",
      notice: { kind: "error" },
    });
  });
});
