import { describe, expect, it } from "vitest";
import { createObserverManagedSessionCapabilities } from "../../../../src/state/capabilities/managedSessions.js";
import { createCommandSnapshot } from "../../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

describe("observer managed-session capability", () => {
  it("creates from product values without an optimistic row and returns the bounded failure", async () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "CommandExecutionError",
        code: "CREATE_FAILED",
        message: "Create failed.",
      },
    };
    const capability = createObserverManagedSessionCapabilities({ service });

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
        group: { kind: "create", name: "Release" },
      },
    });
  });

  it("preserves Quick Session optimistic and failed-row behavior", async () => {
    const snapshot = createCommandSnapshot("idle");
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("project fixture missing");
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_quick",
      error: { tag: "CommandExecutionError", code: "CREATE_FAILED", message: "Create failed." },
    };
    const capability = createObserverManagedSessionCapabilities({ service });

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
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverManagedSessionCapabilities({ service });

    const handle = capability.fork({
      project,
      sourceWorktreeId: "wt_web_idle",
      title: "Forked session",
      hiddenBranch: "forked-session-123",
      copyDirty: true,
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
        harness: { provider: "codex" },
      },
    });
  });
});
