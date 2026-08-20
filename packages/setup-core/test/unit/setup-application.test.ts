import {
  createSetupSessionApplication,
  type SetupInspection,
  type SetupOperationExecutor,
  type SetupPlanningFacts,
  type SetupPlanningIntent,
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
        installBootstrap: false,
        installHarnesses: [],
        linkStationLaunchers: false,
        harnessTrackingSelection: { kind: "automatic" },
        installWorktrunkHooks: false,
        installWorktrunkShell: false,
        configureTmuxPopup: false,
      },
      inspection,
      executeOperation,
    });

    const state = await application.apply();

    expect(state.status).toBe("completed");
    expect(inspection).toHaveBeenCalledTimes(4);
    expect(executeOperation).toHaveBeenCalledTimes(2);
    expect(inspection.mock.calls.map(([request]) => request.phase)).toEqual([
      "initial",
      "after-preflight",
      "after-activation",
      "final",
    ]);
    expect(executeOperation.mock.calls.map(([operation]) => operation.id)).toEqual([
      "write-config",
      "activate-observer-config",
    ]);
    expect(state.operationOutcomes.map((outcome) => outcome.operationId)).toEqual([
      "write-config",
      "activate-observer-config",
    ]);
  });

  it("keeps the session mode fixed, passes replaced intent to inspection, and does not replay preparation", async () => {
    const inspections = [
      missingWorktrunkFacts(),
      missingWorktrunkFacts(),
      readyFacts(),
      readyFacts(),
      readyFacts(),
      readyFacts(),
    ];
    const inspection = vi.fn<SetupInspection>(async () => {
      const next = inspections.shift();
      if (next === undefined) throw new Error("unexpected inspection");
      return { status: "completed", facts: next };
    });
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => ({
      status: "completed",
      operationId: operation.id,
      commit: { kind: "package-installer", target: { kind: "tool", id: "worktrunk" } },
    }));
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection,
      executeOperation,
    });
    const desired = { ...intent(), mode: "check" as const, linkStationLaunchers: true };
    const appliedDesired = { ...desired, mode: "apply" as const };

    await application.start();
    await application.replaceIntent(desired);
    const prepared = await application.prepare();
    const completed = await application.apply();

    expect(prepared.status).toBe("editing");
    expect(completed.status).toBe("completed");
    expect(inspection.mock.calls.slice(1).map(([request]) => request.intent)).toEqual(
      Array.from({ length: inspection.mock.calls.length - 1 }, () => appliedDesired),
    );
    expect(executeOperation.mock.calls.map(([operation]) => operation.id)).toEqual([
      "install:worktrunk",
    ]);
  });

  it("coalesces concurrent apply requests through one serialized effect cascade", async () => {
    const inspections = [missingConfigFacts(), missingConfigFacts(), readyFacts(), readyFacts()];
    const inspection = vi.fn<SetupInspection>(async () => {
      const next = inspections.shift();
      if (next === undefined) throw new Error("unexpected inspection");
      return { status: "completed", facts: next };
    });
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => ({
      status: "completed",
      operationId: operation.id,
      commit:
        operation.kind === "write-config"
          ? { kind: "config", configPath: "/tmp/config.toml", change: "created" }
          : { kind: "observer-activation", configPath: "/tmp/config.toml" },
    }));
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection,
      executeOperation,
    });

    const states = await Promise.all([application.apply(), application.apply()]);

    expect(states.map((state) => state.status)).toEqual(["completed", "completed"]);
    expect(inspection).toHaveBeenCalledTimes(4);
    expect(executeOperation.mock.calls.map(([operation]) => operation.id)).toEqual([
      "write-config",
      "activate-observer-config",
    ]);
  });

  it("preserves typed inspection failures without requiring a snapshot", async () => {
    const error = {
      tag: "SyntheticInspectionError",
      code: "SYNTHETIC_INSPECTION_FAILED",
      message: "Synthetic inspection failed.",
      hint: "Repair the synthetic fixture.",
    };
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async () => ({ status: "failed", error }),
      executeOperation: async () => {
        throw new Error("operation must not run");
      },
    });

    const state = await application.review();

    expect(state).toMatchObject({
      status: "blocked",
      reason: "inspection-failed",
      error,
    });
    expect("plan" in state).toBe(false);
  });

  it("blocks required tracking evidence when no selected repair can satisfy it", async () => {
    const executeOperation = vi.fn<SetupOperationExecutor>();
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async () => ({ status: "completed", facts: unrepairableTrackingFacts() }),
      executeOperation,
    });

    const state = await application.apply();

    expect(state).toMatchObject({
      status: "blocked",
      reason: "preflight-incomplete",
    });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("converts thrown operation failures into a typed blocked result", async () => {
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async () => ({ status: "completed", facts: missingWorktrunkFacts() }),
      executeOperation: async () => {
        throw new Error("synthetic adapter throw");
      },
    });

    const state = await application.apply();

    expect(state).toMatchObject({
      status: "blocked",
      reason: "preflight-failed",
      error: { code: "SETUP_OPERATION_FAILED" },
      operationOutcomes: [
        expect.objectContaining({
          status: "failed",
          operationId: "install:worktrunk",
          operation: expect.objectContaining({ kind: "install-tool", tool: "worktrunk" }),
        }),
      ],
    });
  });

  it("cancels an active cascade after its in-flight operation and keeps failure evidence", async () => {
    let releaseOperation: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operationError = {
      tag: "SyntheticOperationError",
      code: "SYNTHETIC_OPERATION_FAILED",
      message: "The in-flight operation failed while cancellation was pending.",
      hint: "Inspect the synthetic operation.",
    };
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => {
      markStarted?.();
      await blocked;
      return { status: "failed", operationId: operation.id, error: operationError };
    });
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async () => ({ status: "completed", facts: missingWorktrunkFacts() }),
      executeOperation,
    });

    const applying = application.apply();
    await started;
    const cancelling = application.cancel();
    releaseOperation?.();
    const [applyState, cancelState] = await Promise.all([applying, cancelling]);

    expect(applyState).toMatchObject({
      status: "cancelled",
      error: operationError,
      operationOutcomes: [expect.objectContaining({ operationId: "install:worktrunk" })],
    });
    expect(cancelState).toEqual(applyState);
    expect(executeOperation).toHaveBeenCalledTimes(1);
  });

  it.each([
    "started",
    "finished",
  ] as const)("records committed operation truth before surfacing a %s progress failure", async (callback) => {
    const inspections = [missingConfigFacts(), missingConfigFacts(), readyFacts(), readyFacts()];
    const inspection = vi.fn<SetupInspection>(async () => {
      const facts = inspections.shift();
      if (facts === undefined) throw new Error("unexpected inspection");
      return { status: "completed", facts };
    });
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => ({
      status: "completed",
      operationId: operation.id,
      commit:
        operation.kind === "write-config"
          ? { kind: "config", configPath: "/tmp/config.toml", change: "created" }
          : { kind: "observer-activation", configPath: "/tmp/config.toml" },
    }));
    const report = vi.fn(async () => {
      throw new Error(`synthetic ${callback} progress failure`);
    });
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection,
      executeOperation,
      operationProgress: callback === "started" ? { started: report } : { finished: report },
    });

    await expect(application.apply()).rejects.toThrow(`synthetic ${callback} progress failure`);

    expect(application.getState()).toMatchObject({
      status: "completed",
      operationOutcomes: [
        { operationId: "write-config" },
        { operationId: "activate-observer-config" },
      ],
    });
    expect(executeOperation).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("rejects an outcome whose operation identity does not match the requested effect", async () => {
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async () => ({ status: "completed", facts: missingWorktrunkFacts() }),
      executeOperation: async () => ({
        status: "completed",
        operationId: "link-station-launchers",
        commit: { kind: "launcher-link" },
      }),
    });

    const state = await application.apply();

    expect(state).toMatchObject({
      status: "blocked",
      reason: "preflight-failed",
      error: { code: "SETUP_OPERATION_OUTCOME_MISMATCH" },
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
  const ready = readyFacts();
  return {
    ...ready,
    tools: ready.tools.map((tool) =>
      tool.id === "worktrunk" ? { ...tool, available: false } : tool,
    ),
  };
}

function unrepairableTrackingFacts(): SetupPlanningFacts {
  const ready = readyFacts();
  return {
    ...ready,
    launchers: { ...ready.launchers, ingress: "missing" },
    harnessTracking: [
      {
        harnessId: "codex",
        assessment: { state: "artifact-missing-or-drifted", requested: true, installed: false },
        required: true,
        persistedIntent: true,
      },
    ],
  };
}

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
      config: { status: config.state === "missing" ? "missing" : "valid", defaultHarness: "codex" },
      harnesses: [{ id: "codex", availability: "available" }],
    },
    installableHarnessIds: ["codex"],
    config,
    launchers: { station: "available", ingress: "available", tmuxPopup: "available" },
    worktrunkAutomation: "ready",
    worktrunkShell: "ready",
    tmuxPopup: { persisted: "ready", live: "not-applicable" },
    worktrunkHooks: "ready",
    harnessTracking,
  };
}
