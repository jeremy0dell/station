import {
  createSetupSessionApplication,
  type SetupOperationExecutor,
  type SetupPlanningFacts,
  type SetupPlanningIntent,
} from "@station/setup-core";
import { describe, expect, it, vi } from "vitest";

describe("setup operation replay", () => {
  it("uses recorded operation outcomes to avoid replaying completed preparation during apply", async () => {
    let available = false;
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => {
      available = true;
      return {
        status: "completed",
        operationId: operation.id,
        commit: { kind: "package-installer", target: { kind: "tool", id: "worktrunk" } },
      };
    });
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async () => ({
        status: "completed",
        facts: available ? readyFacts() : missingWorktrunkFacts(),
      }),
      executeOperation,
    });

    expect((await application.prepare()).status).toBe("editing");
    const completed = await application.apply();

    expect(completed.status).toBe("completed");
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(completed.operationOutcomes.map((outcome) => outcome.operationId)).toEqual([
      "install:worktrunk",
    ]);
  });
});

function intent(): SetupPlanningIntent {
  return {
    mode: "apply",
    harnessSelection: { kind: "automatic" },
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
  const ready = readyFacts();
  return {
    ...ready,
    tools: ready.tools.map((tool) =>
      tool.id === "worktrunk" ? { ...tool, available: false } : tool,
    ),
  };
}

function readyFacts(): SetupPlanningFacts {
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
      { id: "diff-viewer", available: true, installerAvailable: true },
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
