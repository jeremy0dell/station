import {
  createSetupSessionState,
  type SetupPlanningFacts,
  type SetupPlanningIntent,
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

  it("replaces intent revision-safely and returns staged preparation to editing", () => {
    const initial = createSetupSessionState(intent());
    const inspecting = transitionSetupSession(initial, {
      type: "inspection-requested",
      revision: initial.revision,
    });
    const editing = transitionSetupSession(inspecting.state, {
      type: "inspection-completed",
      revision: inspecting.state.revision,
      facts: missingWorktrunkFacts(),
    });
    const desired = { ...intent(), linkStationLaunchers: true };

    const stale = transitionSetupSession(editing.state, {
      type: "intent-replaced",
      revision: editing.state.revision - 1,
      intent: desired,
    });
    expect(stale).toEqual({ state: editing.state, effects: [] });

    const replacing = transitionSetupSession(editing.state, {
      type: "intent-replaced",
      revision: editing.state.revision,
      intent: desired,
    });
    expect(replacing.effects).toEqual([{ kind: "inspect", phase: "initial" }]);
    const refreshed = transitionSetupSession(replacing.state, {
      type: "inspection-completed",
      revision: replacing.state.revision,
      facts: missingWorktrunkFacts(),
    });
    expect(refreshed.state).toMatchObject({ status: "editing", intent: desired });

    const preparing = transitionSetupSession(refreshed.state, {
      type: "prepare-requested",
      revision: refreshed.state.revision,
    });
    const effect = preparing.effects[0];
    if (effect?.kind !== "perform-operation") throw new Error("expected preparation effect");
    const completed = transitionSetupSession(preparing.state, {
      type: "operation-completed",
      revision: preparing.state.revision,
      outcome: {
        status: "completed",
        operationId: effect.operation.id,
        operation: effect.operation,
        commit: { kind: "package-installer", target: { kind: "tool", id: "worktrunk" } },
      },
    });
    expect(completed.state).toMatchObject({
      status: "inspecting",
      inspectionPhase: "after-preparation",
    });
    const prepared = transitionSetupSession(completed.state, {
      type: "inspection-completed",
      revision: completed.state.revision,
      facts: facts(),
    });
    expect(prepared.state).toMatchObject({
      status: "editing",
      checkpoints: [{ operationId: "install:worktrunk" }],
    });
  });

  it("rejects stale asynchronous operation outcomes without recording a checkpoint", () => {
    const initial = createSetupSessionState(intent());
    const inspecting = transitionSetupSession(initial, {
      type: "inspection-requested",
      revision: initial.revision,
    });
    const editing = transitionSetupSession(inspecting.state, {
      type: "inspection-completed",
      revision: inspecting.state.revision,
      facts: missingWorktrunkFacts(),
    });
    const reviewing = transitionSetupSession(editing.state, {
      type: "review-requested",
      revision: editing.state.revision,
    });
    const applying = transitionSetupSession(reviewing.state, {
      type: "apply-requested",
      revision: reviewing.state.revision,
    });
    const effect = applying.effects[0];
    if (effect?.kind !== "perform-operation") throw new Error("expected operation effect");

    const stale = transitionSetupSession(applying.state, {
      type: "operation-completed",
      revision: applying.state.revision - 1,
      outcome: {
        status: "completed",
        operationId: effect.operation.id,
        operation: effect.operation,
        commit: {
          kind: "package-installer",
          target: { kind: "tool", id: "worktrunk" },
        },
      },
    });

    expect(stale).toEqual({ state: applying.state, effects: [] });
    expect(stale.state.checkpoints).toEqual([]);
  });

  it("accepts cancellation independently of revision and preserves blocked diagnostics", () => {
    const error = {
      tag: "SyntheticInspectionError",
      code: "SYNTHETIC_INSPECTION_FAILED",
      message: "Synthetic inspection failed.",
      hint: "Repair the synthetic fixture.",
    };
    const initial = createSetupSessionState(intent());
    const inspecting = transitionSetupSession(initial, {
      type: "inspection-requested",
      revision: initial.revision,
    });
    const blocked = transitionSetupSession(inspecting.state, {
      type: "inspection-failed",
      revision: inspecting.state.revision,
      error,
    });

    const cancelled = transitionSetupSession(blocked.state, {
      type: "cancel-requested",
    });

    expect(cancelled).toMatchObject({
      state: { status: "cancelled", error },
      effects: [],
    });
  });
});

function intent(): SetupPlanningIntent {
  return {
    mode: "apply" as const,
    harnessSelection: { kind: "automatic" as const },
    installBootstrap: false,
    installHarnesses: [],
    linkStationLaunchers: false,
    harnessTrackingSelection: { kind: "automatic" },
    installWorktrunkHooks: false,
    installWorktrunkShell: false,
    configureTmuxPopup: false,
  };
}

function missingWorktrunkFacts(): SetupPlanningFacts {
  const ready = facts();
  return {
    ...ready,
    tools: ready.tools.map((tool) =>
      tool.id === "worktrunk" ? { ...tool, available: false } : tool,
    ),
  };
}

function facts(): SetupPlanningFacts {
  return {
    generatedAt: "2026-08-01T00:00:00.000Z",
    compiled: true,
    stateDirectoryWritable: true,
    socketEvidenceAvailable: true,
    xcodeTools: "not-applicable",
    homebrew: "available",
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
    installableHarnessIds: ["codex"],
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
