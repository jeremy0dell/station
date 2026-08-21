import {
  createSetupSessionApplication,
  type SetupInspection,
  type SetupOperationExecutor,
  type SetupPlanningFacts,
  type SetupPlanningIntent,
} from "@station/setup-core";
import { describe, expect, it, vi } from "vitest";

describe("setup session transitions", () => {
  it("moves a reviewed session through the explicit inspection phases without public event dispatch", async () => {
    const phases: string[] = [];
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async (request) => {
        phases.push(request.phase);
        return { status: "completed", facts: facts() };
      },
      executeOperation: async (operation) => ({
        status: "failed",
        operationId: operation.id,
        error: {
          tag: "UnexpectedOperationError",
          code: "UNEXPECTED_OPERATION",
          message: "The ready fixture has no selected operations.",
        },
      }),
    });

    expect((await application.review()).status).toBe("reviewing");
    expect((await application.apply()).status).toBe("completed");
    expect(phases).toEqual(["initial", "after-preflight", "final"]);
    expect(Reflect.get(application, "dispatch")).toBeUndefined();
  });

  it("keeps the invocation mode while replacement and staged preparation return to editing", async () => {
    let worktrunkAvailable = false;
    const requests: Parameters<SetupInspection>[0][] = [];
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => {
      worktrunkAvailable = true;
      return {
        status: "completed",
        operationId: operation.id,
        commit: { kind: "package-installer", target: { kind: "tool", id: "worktrunk" } },
      };
    });
    const application = createSetupSessionApplication({
      intent: intent(),
      inspection: async (request) => {
        requests.push(request);
        return {
          status: "completed",
          facts: worktrunkAvailable ? facts() : missingWorktrunkFacts(),
        };
      },
      executeOperation,
    });

    await application.start();
    await application.replaceIntent({ ...intent(), mode: "check", linkStationLaunchers: true });
    const prepared = await application.prepare();

    expect(prepared).toMatchObject({
      status: "editing",
      intent: { mode: "apply", linkStationLaunchers: true },
    });
    expect(requests.slice(1).map((request) => request.intent.mode)).toEqual(["apply", "apply"]);
    expect(executeOperation.mock.calls.map(([operation]) => operation.id)).toEqual([
      "install:worktrunk",
    ]);
  });

  it("serializes duplicate apply requests so one asynchronous outcome is recorded once", async () => {
    let available = false;
    let releaseOperation: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const executeOperation = vi.fn<SetupOperationExecutor>(async (operation) => {
      markStarted?.();
      await blocked;
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
        facts: available ? facts() : missingWorktrunkFacts(),
      }),
      executeOperation,
    });

    const first = application.apply();
    await started;
    const second = application.apply();
    releaseOperation?.();
    const states = await Promise.all([first, second]);

    expect(states.map((state) => state.status)).toEqual(["completed", "completed"]);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(states[1]?.operationOutcomes).toHaveLength(1);
  });

  it("preserves blocked inspection diagnostics when the session is cancelled", async () => {
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

    expect(await application.review()).toMatchObject({
      status: "blocked",
      reason: "inspection-failed",
      error,
    });
    expect(await application.cancel()).toMatchObject({ status: "cancelled", error });
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
