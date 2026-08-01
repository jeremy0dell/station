import {
  createSetupSessionApplication,
  type SetupInspection,
  type SetupOperationExecutor,
  type SetupPlanningFacts,
} from "@station/setup-core";
import { describe, expect, it, vi } from "vitest";

describe("createSetupSessionApplication", () => {
  it("serializes the config, activation, reinspection, and final verification sequence", async () => {
    const inspections = [missingConfigFacts(), missingConfigFacts(), readyFacts(), readyFacts()];
    const inspection = vi.fn<SetupInspection>(async () => {
      const facts = inspections.shift();
      if (facts === undefined) throw new Error("unexpected inspection");
      return { status: "completed", facts } as const;
    });
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => ({
      status: "completed" as const,
      operationId: operation.id,
      commit:
        operation.kind === "write-config"
          ? { kind: "config" as const, configPath: "/tmp/config.toml", change: "created" as const }
          : { kind: "observer-activation" as const, configPath: "/tmp/config.toml" },
    }));
    const application = createSetupSessionApplication({
      intent: {
        mode: "apply",
        harnessSelection: { kind: "automatic" },
        installWorktrunkHooks: false,
      },
      inspection,
      executeOperation,
    });

    const state = await application.apply();

    expect(state.status).toBe("completed");
    expect(inspection).toHaveBeenCalledTimes(4);
    expect(executeOperation).toHaveBeenCalledTimes(2);
    expect(state.checkpoints.map((checkpoint) => checkpoint.operationId)).toEqual([
      "write-config",
      "activate-observer-config",
    ]);
  });
});

function missingConfigFacts(): SetupPlanningFacts {
  return facts({ state: "missing", write: "create", diagnostics: [] }, []);
}

function readyFacts(): SetupPlanningFacts {
  return facts({ state: "valid", write: "none", diagnostics: [] }, [
    {
      harnessId: "codex",
      assessment: { state: "prepared", requested: true, installed: true },
      required: true,
      persistedIntent: true,
    },
  ]);
}

function facts(
  config: SetupPlanningFacts["config"],
  harnessTracking: SetupPlanningFacts["harnessTracking"],
): SetupPlanningFacts {
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
      config: { status: config.state === "missing" ? "missing" : "valid", defaultHarness: "codex" },
      harnesses: [{ id: "codex", availability: "available" }],
    },
    config,
    launchers: { station: "available", ingress: "available", tmuxPopup: "available" },
    worktrunkAutomation: "ready",
    worktrunkShell: "ready",
    tmuxPopup: { persisted: "ready", live: "not-applicable" },
    worktrunkHooks: "ready",
    harnessTracking,
  };
}
