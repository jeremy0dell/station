import type {
  SetupOperationOutcome,
  SetupPlan,
  SetupSessionResult,
  SetupSessionState,
  SetupSessionStatus,
} from "@station/setup-core";

export type ProjectSetupSessionProgress =
  | {
      readonly kind: "inspection";
      readonly phase: "initial" | "after-preflight" | "after-activation";
    }
  | {
      readonly kind: "operation";
      readonly phase: "preflight" | "config-write" | "observer-activation" | "tracking";
    }
  | { readonly kind: "verification" }
  | { readonly kind: "idle" };

export type ProjectSetupSessionView = {
  readonly status: SetupSessionStatus;
  readonly revision: number;
  readonly progress: ProjectSetupSessionProgress;
  readonly plan?: SetupPlan;
  readonly result?: SetupSessionResult;
  readonly operationOutcomes: readonly SetupOperationOutcome[];
  readonly blockReason?: Extract<SetupSessionState, { readonly status: "blocked" }>["reason"];
};

export function projectSessionView(state: SetupSessionState): ProjectSetupSessionView {
  const base = {
    status: state.status,
    revision: state.revision,
    progress: projectProgress(state),
    operationOutcomes: state.operationOutcomes,
  } as const;
  switch (state.status) {
    case "blocked":
      return state.plan === undefined
        ? { ...base, blockReason: state.reason }
        : { ...base, plan: state.plan, blockReason: state.reason };
    case "completed":
      return { ...base, plan: state.plan, result: state.result };
    case "editing":
    case "reviewing":
    case "applying":
    case "verifying":
      return { ...base, plan: state.plan };
    case "inspecting":
    case "cancelled":
      return base;
  }
}

function projectProgress(state: SetupSessionState): ProjectSetupSessionProgress {
  switch (state.status) {
    case "inspecting":
      return state.inspectionPhase === "final"
        ? { kind: "verification" }
        : { kind: "inspection", phase: state.inspectionPhase };
    case "applying":
      return { kind: "operation", phase: state.applyPhase };
    case "verifying":
      return { kind: "verification" };
    case "editing":
    case "reviewing":
    case "blocked":
    case "completed":
    case "cancelled":
      return { kind: "idle" };
  }
}
