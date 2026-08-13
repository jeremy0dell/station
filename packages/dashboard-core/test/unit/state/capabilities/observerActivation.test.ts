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
});
