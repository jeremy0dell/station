import { describe, expect, it } from "vitest";
import { createObserverActivationCapabilities } from "../../../../src/state/capabilities/activation.js";
import { createCommandSnapshot } from "../../../fixtures/snapshots.js";
import { FakeClientStateSource } from "../../../support/fakeClientStateSource.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

describe("observer activation capability", () => {
  it("revalidates a stable session and builds focus at the Observer boundary", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_idle",
      projectId: "web",
      worktreeId: "wt_web_idle",
      branch: "fix-nav-mobile",
      preferredObserverAction: "focus",
    });

    expect(handle.optimistic).toBe("none");
    expect(await handle.completion).toMatchObject({ kind: "notice", notice: { kind: "success" } });
    expect(service.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_web_idle" } },
    ]);
  });

  it("keeps focus UX failed when completion belongs to another command", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    service.nextCompletion = {
      status: "succeeded",
      commandId: "cmd_tui_1",
      result: {
        type: "worktree.create",
        projectId: "web",
        worktreeId: "wt_unrelated",
      },
    };
    let focusSuccessCount = 0;
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
      waitForFocusCompletion: true,
      onFocusSuccess: async () => {
        focusSuccessCount += 1;
      },
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_idle",
      projectId: "web",
      worktreeId: "wt_web_idle",
      branch: "fix-nav-mobile",
      preferredObserverAction: "focus",
    });

    await expect(handle.completion).resolves.toMatchObject({
      kind: "failure",
      disposition: "remove-immediately",
      error: {
        code: "CLIENT_COMMAND_COMPLETION_MISMATCH",
        commandId: "cmd_tui_1",
      },
    });
    expect(focusSuccessCount).toBe(0);
  });

  it("returns a stale-target notice without dispatching", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "missing",
      projectId: "web",
      worktreeId: "wt_web_idle",
      branch: "fix-nav-mobile",
      preferredObserverAction: "focus",
    });

    expect(await handle.completion).toEqual({
      kind: "notice",
      notice: { kind: "info", message: "That dashboard item is no longer available." },
    });
    expect(service.dispatched).toEqual([]);
  });

  it("starts fresh under the exact retained session without closing it", async () => {
    const snapshot = createCommandSnapshot("none");
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      preferredObserverAction: "fresh",
    });

    expect(handle.optimistic).toBe("pending-start");
    expect(await handle.completion).toEqual({ kind: "success" });
    expect(service.dispatched).toEqual([
      {
        type: "session.startAgent",
        payload: {
          projectId: "web",
          worktreeId: "wt_web_no_agent",
          terminal: { provider: "tmux", layout: "agent-build-shell", focus: false },
          freshStart: { expectedSessionId: "ses_wt_web_no_agent" },
        },
      },
    ]);
  });

  it("rejects a stale fresh-start operation when recovery becomes available", async () => {
    const snapshot = createCommandSnapshot("none");
    const recovered = {
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === "wt_web_no_agent"
          ? {
              ...row,
              recovery: {
                kind: "agent-resume" as const,
                handleId: "rec_late",
                provider: "codex",
                targetKind: "native-session" as const,
                sessionId: "ses_wt_web_no_agent",
                lastSeenAt: "2026-06-01T12:01:00.000Z",
              },
            }
          : row,
      ),
    };
    const service = new FakeTuiObserverService(recovered);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(recovered),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      preferredObserverAction: "fresh",
    });

    expect(await handle.completion).toEqual({
      kind: "notice",
      notice: { kind: "info", message: "That dashboard item is no longer available." },
    });
    expect(service.dispatched).toEqual([]);
  });

  it("rejects a stale fresh-start operation when the agent is already live", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_idle",
      projectId: "web",
      worktreeId: "wt_web_idle",
      branch: "fix-nav-mobile",
      preferredObserverAction: "fresh",
    });

    expect(await handle.completion).toEqual({
      kind: "notice",
      notice: { kind: "info", message: "That dashboard item is no longer available." },
    });
    expect(service.dispatched).toEqual([]);
  });

  it("exposes pending-start while building start intent from canonical values", async () => {
    const retained = createCommandSnapshot("none");
    const snapshot = {
      ...retained,
      sessions: retained.sessions.map((session) => ({ ...session, origin: "external" as const })),
    };
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      preferredObserverAction: "start",
    });

    expect(handle.optimistic).toBe("pending-start");
    expect(handle.successDisposition).toBe("wait-for-canonical");
    expect(await handle.completion).toEqual({ kind: "success" });
    expect(service.dispatched[0]).toMatchObject({
      type: "session.startAgent",
      payload: { projectId: "web", worktreeId: "wt_web_no_agent" },
    });
  });

  it("requires renewed fresh-start confirmation when requested resume loses recovery", async () => {
    const snapshot = createCommandSnapshot("none");
    const service = new FakeTuiObserverService(snapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(snapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      preferredObserverAction: "resume",
    });

    expect(await handle.completion).toEqual({
      kind: "notice",
      notice: { kind: "info", message: "That dashboard item is no longer available." },
    });
    expect(service.dispatched).toEqual([]);
  });

  it("resumes when recovery appears after start intent was selected", async () => {
    const snapshot = createCommandSnapshot("none");
    const recovered = {
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === "wt_web_no_agent"
          ? {
              ...row,
              recovery: {
                kind: "agent-resume" as const,
                handleId: "rec_late",
                provider: "codex",
                targetKind: "native-session" as const,
                sessionId: "ses_wt_web_no_agent",
                lastSeenAt: "2026-06-01T12:01:00.000Z",
              },
            }
          : row,
      ),
    };
    const service = new FakeTuiObserverService(recovered);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(recovered),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      preferredObserverAction: "start",
    });

    expect(await handle.completion).toEqual({ kind: "success" });
    expect(service.dispatched[0]?.type).toBe("session.resumeAgent");
  });
});
