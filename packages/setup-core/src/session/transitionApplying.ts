import type { SetupOperation } from "../model/operations.js";
import type {
  SetupSessionApplyPhase,
  SetupSessionEffect,
  SetupSessionEvent,
  SetupSessionState,
  SetupSessionTransition,
} from "../model/session.js";
import { hasCompletedSetupOperation, recordCompletedSetupOperation } from "./checkpoints.js";

export function beginPreflight(
  state: Extract<SetupSessionState, { readonly status: "reviewing" }>,
): SetupSessionTransition {
  return continueApplying({ ...state, status: "applying", applyPhase: "preflight" });
}

export function beginConfigWrite(
  state: Extract<SetupSessionState, { readonly status: "inspecting" }>,
  plan: Extract<SetupSessionState, { readonly status: "editing" }>["plan"],
): SetupSessionTransition {
  const withPlan = {
    revision: state.revision,
    intent: state.intent,
    checkpoints: state.checkpoints,
    operationOutcomes: state.operationOutcomes,
    plan,
    status: "applying" as const,
    applyPhase: "config-write" as const,
  };
  if (hasBlockingPreflightIssue(plan)) {
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
    (operation): operation is Extract<SetupOperation, { readonly kind: "write-config" }> =>
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
  state: Extract<SetupSessionState, { readonly status: "inspecting" }>,
  plan: Extract<SetupSessionState, { readonly status: "editing" }>["plan"],
): SetupSessionTransition {
  return continueApplying({
    revision: state.revision,
    intent: state.intent,
    checkpoints: state.checkpoints,
    operationOutcomes: state.operationOutcomes,
    plan,
    status: "applying",
    applyPhase: "tracking",
  });
}

export function transitionApplying(
  state: Extract<SetupSessionState, { readonly status: "applying" }>,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type === "operation-completed") {
    if (!isExpectedOperation(state, event.outcome.operationId)) return { state, effects: [] };
    const checkpoints = recordCompletedSetupOperation(state.checkpoints, {
      operationId: event.outcome.operationId,
      commit: event.outcome.commit,
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
    if (state.applyPhase === "tracking") return continueApplying(withFailure);
    return {
      state: {
        ...withFailure,
        status: "blocked",
        reason:
          state.applyPhase === "config-write"
            ? "config-write-failed"
            : state.applyPhase === "observer-activation"
              ? "observer-activation-failed"
              : "preflight-failed",
        error: event.outcome.error,
      },
      effects: [],
    };
  }
  return { state, effects: [] };
}

function continueApplying(
  state: Extract<SetupSessionState, { readonly status: "applying" }>,
): SetupSessionTransition {
  const operation = nextOperation(state);
  if (operation !== undefined) {
    const effect: SetupSessionEffect = { kind: "perform-operation", operation };
    return { state, effects: [effect] };
  }
  switch (state.applyPhase) {
    case "preflight":
      return {
        state: {
          ...state,
          status: "inspecting",
          inspectionPhase: "after-preflight",
          revision: state.revision + 1,
        },
        effects: [{ kind: "inspect", phase: "after-preflight" }],
      };
    case "config-write": {
      const activation = state.plan.operations.find(
        (
          operation,
        ): operation is Extract<SetupOperation, { readonly kind: "activate-observer-config" }> =>
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
      return {
        state: { ...state, status: "verifying", revision: state.revision + 1 },
        effects: [{ kind: "inspect", phase: "final" }],
      };
  }
}

function nextOperation(
  state: Extract<SetupSessionState, { readonly status: "applying" }>,
): SetupOperation | undefined {
  return state.plan.operations.find(
    (operation) =>
      operation.selected &&
      isOperationInPhase(operation, state.applyPhase) &&
      !hasCompletedSetupOperation(state.checkpoints, operation.id) &&
      !state.operationOutcomes.some((outcome) => outcome.operationId === operation.id),
  );
}

function isExpectedOperation(
  state: Extract<SetupSessionState, { readonly status: "applying" }>,
  operationId: SetupOperation["id"],
): boolean {
  return nextOperation(state)?.id === operationId;
}

function isOperationInPhase(operation: SetupOperation, phase: SetupSessionApplyPhase): boolean {
  switch (phase) {
    case "preflight":
      return operation.kind.startsWith("install-");
    case "config-write":
      return operation.kind === "write-config";
    case "observer-activation":
      return operation.kind === "activate-observer-config";
    case "tracking":
      return (
        operation.kind === "prepare-harness-tracking" ||
        operation.kind === "prepare-worktrunk-tracking"
      );
  }
}

function hasBlockingPreflightIssue(
  plan: Extract<SetupSessionState, { readonly status: "editing" }>["plan"],
): boolean {
  return plan.issues.some(
    (issue) =>
      issue.tier === "required" &&
      !(issue.code === "config-unready" && issue.state === "missing") &&
      issue.code !== "harness-tracking-unprepared" &&
      issue.code !== "station-ui-missing",
  );
}
