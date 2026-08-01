import {
  createSetupSessionState,
  type SetupPlanningFacts,
  transitionSetupSession,
} from "@station/setup-core";
import { describe, expect, it } from "vitest";

describe("transitionSetupSession", () => {
  it("rejects stale events and moves a reviewed session into its explicit apply phases", () => {
    const initial = createSetupSessionState(intent());
    const inspecting = transitionSetupSession(initial, {
      type: "inspection-requested",
      revision: initial.revision,
    });
    expect(inspecting.effects).toEqual([{ kind: "inspect", phase: "initial" }]);

    const editing = transitionSetupSession(inspecting.state, {
      type: "inspection-completed",
      revision: inspecting.state.revision,
      facts: facts(),
    });
    expect(editing.state.status).toBe("editing");

    const stale = transitionSetupSession(editing.state, {
      type: "review-requested",
      revision: editing.state.revision - 1,
    });
    expect(stale).toEqual({ state: editing.state, effects: [] });

    const reviewing = transitionSetupSession(editing.state, {
      type: "review-requested",
      revision: editing.state.revision,
    });
    const applying = transitionSetupSession(reviewing.state, {
      type: "apply-requested",
      revision: reviewing.state.revision,
    });
    expect(applying.state).toMatchObject({
      status: "inspecting",
      inspectionPhase: "after-preflight",
    });
    expect(applying.effects).toEqual([{ kind: "inspect", phase: "after-preflight" }]);
  });
});

function intent() {
  return {
    mode: "apply" as const,
    harnessSelection: { kind: "automatic" as const },
    installWorktrunkHooks: false,
  };
}

function facts(): SetupPlanningFacts {
  return {
    generatedAt: "2026-08-01T00:00:00.000Z",
    compiled: true,
    stateDirectoryWritable: true,
    socketEvidenceAvailable: true,
    xcodeTools: "not-applicable",
    tools: [
      { id: "worktrunk", available: true, installerAvailable: true },
      { id: "tmux", available: true, installerAvailable: true },
      { id: "bun", available: true, installerAvailable: true },
      { id: "diffnav", available: true, installerAvailable: true },
      { id: "git-delta", available: true, installerAvailable: true },
    ],
    runtimeUi: "not-applicable",
    git: { state: "usable", repository: "absent" },
    harnessSelection: {
      config: { status: "valid", defaultHarness: "codex" },
      harnesses: [{ id: "codex", availability: "available" }],
    },
    config: { state: "valid", write: "none", diagnostics: [] },
    launchers: { station: "available", ingress: "available", tmuxPopup: "available" },
    worktrunkAutomation: "ready",
    worktrunkShell: "ready",
    tmuxPopup: { persisted: "ready", live: "not-applicable" },
    worktrunkHooks: "ready",
    harnessTracking: [
      {
        harnessId: "codex",
        assessment: { state: "prepared", requested: true, installed: true },
        required: true,
        persistedIntent: true,
      },
    ],
  };
}
