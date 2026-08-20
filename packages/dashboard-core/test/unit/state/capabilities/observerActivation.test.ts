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

  it("starts fresh only after the retained session closes successfully", async () => {
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
    expect(service.dispatched.map((command) => command.type)).toEqual([
      "session.close",
      "session.startAgent",
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

  it.each([
    {
      description: "starts when requested resume intent has lost its recovery target",
      hasRecovery: false,
      preferredObserverAction: "resume" as const,
      expectedCommandType: "session.startAgent",
    },
    {
      description: "resumes when recovery appears after start intent was selected",
      hasRecovery: true,
      preferredObserverAction: "start" as const,
      expectedCommandType: "session.resumeAgent",
    },
  ])("$description", async ({ hasRecovery, preferredObserverAction, expectedCommandType }) => {
    const snapshot = createCommandSnapshot("none");
    const canonicalSnapshot = hasRecovery
      ? {
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
        }
      : snapshot;
    const service = new FakeTuiObserverService(canonicalSnapshot);
    const capability = createObserverActivationCapabilities({
      source: new FakeClientStateSource(canonicalSnapshot),
      service,
    });

    const handle = capability.activate({
      sessionId: "ses_wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      preferredObserverAction,
    });

    expect(await handle.completion).toEqual({ kind: "success" });
    expect(service.dispatched[0]?.type).toBe(expectedCommandType);
  });
});
