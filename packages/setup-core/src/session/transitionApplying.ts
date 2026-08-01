import type {
  SetupConfigWriteOperation,
  SetupObserverActivationOperation,
  SetupOperation,
} from "../model/operations.js";
import type { SetupPlan } from "../model/plan.js";
import type {
  SetupSessionApplyingState,
  SetupSessionApplyPhase,
  SetupSessionBlockReason,
  SetupSessionEditingState,
  SetupSessionEffect,
  SetupSessionEvent,
  SetupSessionInspectingState,
  SetupSessionReviewingState,
  SetupSessionTransition,
} from "../model/session.js";
import { assessSetupPlan } from "../policy/assessSetupPlan.js";
import { hasCompletedSetupOperation, recordCompletedSetupOperation } from "./checkpoints.js";

export function beginPreflight(
  state: SetupSessionReviewingState | SetupSessionEditingState,
  request: "prepare" | "apply" = "apply",
): SetupSessionTransition {
  return continueApplying({ ...state, status: "applying", applyPhase: "preflight", request });
}

export function beginConfigWrite(
  state: SetupSessionInspectingState,
  plan: SetupPlan,
): SetupSessionTransition {
  const withPlan = {
    revision: state.revision,
    intent: state.intent,
    checkpoints: state.checkpoints,
    operationOutcomes: state.operationOutcomes,
    plan,
    status: "applying" as const,
    applyPhase: "config-write" as const,
    request: "apply" as const,
  };
  if (!assessSetupPlan(plan).canApply) {
    return {
      state: {
        ...withPlan,
        status: "blocked",
        reason: "preflight-incomplete",
        revision: state.revision + 1,
      },
      effects: [],
    };
  }
  const configOperation = plan.operations.find(
    (operation): operation is SetupConfigWriteOperation =>
      operation.kind === "write-config" && operation.selected,
  );
  if (configOperation === undefined) {
    return {
      state: {
        ...withPlan,
        status: "inspecting",
        inspectionPhase: "after-activation",
        revision: state.revision + 1,
      },
      effects: [{ kind: "inspect", phase: "after-activation" }],
    };
  }
  return continueApplying(withPlan);
}

export function beginTracking(
  state: SetupSessionInspectingState,
  plan: SetupPlan,
): SetupSessionTransition {
  return continueApplying({
    revision: state.revision,
    intent: state.intent,
    checkpoints: state.checkpoints,
    operationOutcomes: state.operationOutcomes,
    plan,
    status: "applying",
    applyPhase: "tracking",
    request: "apply",
  });
}

export function transitionApplying(
  state: SetupSessionApplyingState,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type === "operation-completed") {
    if (!isExpectedOperation(state, event.outcome.operationId)) return { state, effects: [] };
    const checkpoints = recordCompletedSetupOperation(state.checkpoints, {
      operationId: event.outcome.operationId,
    });
    return continueApplying({
      ...state,
      checkpoints,
      operationOutcomes: [...state.operationOutcomes, event.outcome],
      revision: state.revision + 1,
    });
  }
  if (event.type === "operation-failed") {
    if (!isExpectedOperation(state, event.outcome.operationId)) return { state, effects: [] };
    const withFailure = {
      ...state,
      operationOutcomes: [...state.operationOutcomes, event.outcome],
      revision: state.revision + 1,
    };
    if (
      state.request === "prepare" ||
      state.applyPhase === "tracking" ||
      state.applyPhase === "optional-integrations" ||
      event.outcome.operation.kind === "install-harness"
    ) {
      return continueApplying(withFailure);
    }
    return {
      state: {
        ...withFailure,
        status: "blocked",
        reason: blockReasonForPhase(state.applyPhase),
        error: event.outcome.error,
      },
      effects: [],
    };
  }
  return { state, effects: [] };
}

function continueApplying(state: SetupSessionApplyingState): SetupSessionTransition {
  const operation = nextOperation(state);
  if (operation !== undefined) {
    const effect: SetupSessionEffect = { kind: "perform-operation", operation };
    return { state, effects: [effect] };
  }
  switch (state.applyPhase) {
    case "preflight": {
      const inspectionPhase = state.request === "prepare" ? "after-preparation" : "after-preflight";
      return {
        state: {
          ...state,
          status: "inspecting",
          inspectionPhase,
          revision: state.revision + 1,
        },
        effects: [{ kind: "inspect", phase: inspectionPhase }],
      };
    }
    case "config-write": {
      const activation = state.plan.operations.find(
        (operation): operation is SetupObserverActivationOperation =>
          operation.kind === "activate-observer-config" && operation.selected,
      );
      if (
        activation === undefined ||
        hasCompletedSetupOperation(state.checkpoints, activation.id)
      ) {
        return {
          state: {
            ...state,
            status: "inspecting",
            inspectionPhase: "after-activation",
            revision: state.revision + 1,
          },
          effects: [{ kind: "inspect", phase: "after-activation" }],
        };
      }
      return {
        state: { ...state, applyPhase: "observer-activation", revision: state.revision + 1 },
        effects: [{ kind: "perform-operation", operation: activation }],
      };
    }
    case "observer-activation":
      return {
        state: {
          ...state,
          status: "inspecting",
          inspectionPhase: "after-activation",
          revision: state.revision + 1,
        },
        effects: [{ kind: "inspect", phase: "after-activation" }],
      };
    case "tracking":
      return continueApplying({
        ...state,
        applyPhase: "optional-integrations",
        revision: state.revision + 1,
      });
    case "optional-integrations":
      return {
        state: { ...state, status: "verifying", revision: state.revision + 1 },
        effects: [{ kind: "inspect", phase: "final" }],
      };
    default:
      return assertNeverApplyPhase(state.applyPhase);
  }
}

function blockReasonForPhase(
  phase: SetupSessionApplyPhase,
): Extract<
  SetupSessionBlockReason,
  "preflight-failed" | "config-write-failed" | "observer-activation-failed"
> {
  switch (phase) {
    case "preflight":
      return "preflight-failed";
    case "config-write":
      return "config-write-failed";
    case "observer-activation":
      return "observer-activation-failed";
    case "tracking":
    case "optional-integrations":
      throw new Error("Independent setup operation failures do not block the session.");
    default:
      return assertNeverApplyPhase(phase);
  }
}

function nextOperation(state: SetupSessionApplyingState): SetupOperation | undefined {
  return state.plan.operations.find(
    (operation) =>
      operation.selected &&
      isOperationInPhase(operation, state.applyPhase) &&
      !hasCompletedSetupOperation(state.checkpoints, operation.id) &&
      !state.operationOutcomes.some((outcome) => outcome.operationId === operation.id),
  );
}

function isExpectedOperation(
  state: SetupSessionApplyingState,
  operationId: SetupOperation["id"],
): boolean {
  return nextOperation(state)?.id === operationId;
}

function isOperationInPhase(operation: SetupOperation, phase: SetupSessionApplyPhase): boolean {
  switch (operation.kind) {
    case "install-tool":
    case "install-harness":
    case "install-homebrew":
    case "install-xcode-command-line-tools":
      return phase === "preflight";
    case "write-config":
      return phase === "config-write";
    case "activate-observer-config":
      return phase === "observer-activation";
    case "prepare-harness-tracking":
    case "prepare-worktrunk-tracking":
      return phase === "tracking";
    case "link-launchers":
    case "configure-worktrunk-shell":
    case "configure-tmux-popup":
      return phase === "optional-integrations";
    default:
      return assertNeverOperation(operation);
  }
}

function assertNeverOperation(operation: never): never {
  throw new Error(`Unsupported setup operation: ${String(operation)}`);
}

function assertNeverApplyPhase(phase: never): never {
  throw new Error(`Unsupported setup apply phase: ${String(phase)}`);
}
