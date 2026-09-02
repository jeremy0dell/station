import { describe, expect, it } from "vitest";
import {
  type CreatedSessionUiCommand,
  createObserverCreatedSessionCapabilities,
} from "../../../../src/state/capabilities/createdSession.js";
import { createCommandSnapshot } from "../../../fixtures/snapshots.js";
import { FakeClientStateSource } from "../../../support/fakeClientStateSource.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

function setup(policy: CreatedSessionUiCommand["policy"]) {
  const snapshot = createCommandSnapshot("idle");
  const service = new FakeTuiObserverService(snapshot);
  const effects: string[] = [];
  const capability = createObserverCreatedSessionCapabilities({
    source: new FakeClientStateSource(snapshot),
    service,
    resolveFocusTarget: async () => ({
      origin: { provider: "tmux", clientId: "client-1" },
      onFocusSuccess: async () => {
        effects.push("target-dismiss");
      },
    }),
    dismissDashboard: async () => {
      effects.push("renderer-dismiss");
    },
  });
  const command: CreatedSessionUiCommand = {
    type: "createdSession.applyUiPolicy",
    target: {
      sessionId: "ses_wt_web_idle",
      projectId: "web",
      worktreeId: "wt_web_idle",
      branch: "fix-nav-mobile",
      terminalProvider: "tmux",
    },
    policy,
  };
  return { service, effects, capability, command };
}

describe("observer created-session capability", () => {
  it("does nothing for false/false", async () => {
    const fixture = setup({ focusCreatedSession: false, dismissDashboard: false });

    await expect(fixture.capability.applyUiPolicy(fixture.command)).resolves.toEqual({
      kind: "success",
    });
    expect(fixture.service.dispatched).toEqual([]);
    expect(fixture.effects).toEqual([]);
  });

  it("dismisses without focus for false/true", async () => {
    const fixture = setup({ focusCreatedSession: false, dismissDashboard: true });

    await fixture.capability.applyUiPolicy(fixture.command);
    expect(fixture.service.dispatched).toEqual([]);
    expect(fixture.effects).toEqual(["renderer-dismiss"]);
  });

  it("waits for exact focus and suppresses dismissal for true/false", async () => {
    const fixture = setup({ focusCreatedSession: true, dismissDashboard: false });

    await expect(fixture.capability.applyUiPolicy(fixture.command)).resolves.toEqual({
      kind: "success",
    });
    expect(fixture.service.dispatched).toEqual([
      {
        type: "terminal.focus",
        payload: {
          sessionId: "ses_wt_web_idle",
          origin: { provider: "tmux", clientId: "client-1" },
        },
      },
    ]);
    expect(fixture.service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    expect(fixture.effects).toEqual([]);
  });

  it("uses the exact focus-target callback after confirmed focus for true/true", async () => {
    const fixture = setup({ focusCreatedSession: true, dismissDashboard: true });

    await fixture.capability.applyUiPolicy(fixture.command);
    expect(fixture.effects).toEqual(["target-dismiss"]);
  });

  it("fails closed when canonical identity no longer matches", async () => {
    const fixture = setup({ focusCreatedSession: true, dismissDashboard: true });
    fixture.command.target.worktreeId = "wt_other";

    await expect(fixture.capability.applyUiPolicy(fixture.command)).resolves.toMatchObject({
      kind: "failure",
      error: { code: "CREATED_SESSION_TARGET_MISMATCH" },
    });
    expect(fixture.service.dispatched).toEqual([]);
    expect(fixture.effects).toEqual([]);
  });

  it("retains the dashboard when the exact target is not externally focusable", async () => {
    const fixture = setup({ focusCreatedSession: true, dismissDashboard: true });
    const snapshot = createCommandSnapshot("idle");
    fixture.capability = createObserverCreatedSessionCapabilities({
      source: new FakeClientStateSource({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.terminal === undefined
            ? session
            : { ...session, terminal: { ...session.terminal, externallyFocusable: false } },
        ),
      }),
      service: fixture.service,
      dismissDashboard: async () => {
        fixture.effects.push("renderer-dismiss");
      },
    });

    await expect(fixture.capability.applyUiPolicy(fixture.command)).resolves.toMatchObject({
      kind: "failure",
      error: { code: "CREATED_SESSION_NOT_EXTERNALLY_FOCUSABLE" },
    });
    expect(fixture.service.dispatched).toEqual([]);
    expect(fixture.effects).toEqual([]);
  });

  it("does not dismiss when exact focus fails", async () => {
    const fixture = setup({ focusCreatedSession: true, dismissDashboard: true });
    fixture.service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: {
        tag: "CommandExecutionError",
        code: "FOCUS_FAILED",
        message: "Focus failed.",
      },
    };

    await expect(fixture.capability.applyUiPolicy(fixture.command)).resolves.toMatchObject({
      kind: "failure",
      error: { code: "FOCUS_FAILED" },
    });
    expect(fixture.effects).toEqual([]);
  });

  it("reports renderer dismissal failure after a no-focus success", async () => {
    const fixture = setup({ focusCreatedSession: false, dismissDashboard: true });
    fixture.capability = createObserverCreatedSessionCapabilities({
      source: new FakeClientStateSource(createCommandSnapshot("idle")),
      service: fixture.service,
      dismissDashboard: async () => {
        throw new Error("IPC closed.");
      },
    });

    await expect(fixture.capability.applyUiPolicy(fixture.command)).resolves.toMatchObject({
      kind: "failure",
      error: { message: "The TUI could not complete the observer operation." },
    });
    expect(fixture.service.dispatched).toEqual([]);
  });
});
