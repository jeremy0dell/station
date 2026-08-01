import type { SafeError } from "@station/contracts";
import type {
  SetupPlan,
  SetupSessionBlockedState,
  SetupSessionOperationOutcome,
  SetupSessionResult,
  SetupSessionState,
  SetupSessionStatus,
} from "@station/setup-core";

export type ProjectSetupSessionProgress =
  | {
      readonly kind: "inspection";
      readonly phase: "initial" | "after-preparation" | "after-preflight" | "after-activation";
    }
  | {
      readonly kind: "operation";
      readonly phase:
        | "preflight"
        | "config-write"
        | "observer-activation"
        | "tracking"
        | "optional-integrations";
    }
  | { readonly kind: "verification" }
  | { readonly kind: "idle" };

export type ProjectSetupSessionView = {
  readonly status: SetupSessionStatus;
  readonly revision: number;
  readonly progress: ProjectSetupSessionProgress;
  readonly plan?: SetupPlan;
  readonly result?: SetupSessionResult;
  readonly operationOutcomes: readonly SetupSessionOperationOutcome[];
  readonly blockReason?: SetupSessionBlockedState["reason"];
  readonly error?: SafeError;
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
      return {
        ...base,
        blockReason: state.reason,
        ...(state.plan === undefined ? {} : { plan: state.plan }),
        ...(state.error === undefined ? {} : { error: state.error }),
      };
    case "completed":
      return { ...base, plan: state.plan, result: state.result };
    case "editing":
    case "reviewing":
    case "applying":
    case "verifying":
      return { ...base, plan: state.plan };
    case "inspecting":
      return {
        ...base,
        ...(state.plan === undefined ? {} : { plan: state.plan }),
      };
    case "cancelled":
      return {
        ...base,
        ...(state.plan === undefined ? {} : { plan: state.plan }),
        ...(state.error === undefined ? {} : { error: state.error }),
      };
    default:
      return assertNeverState(state);
  }
}

function projectProgress(state: SetupSessionState): ProjectSetupSessionProgress {
  switch (state.status) {
    case "inspecting":
      return { kind: "inspection", phase: state.inspectionPhase };
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
    default:
      return assertNeverState(state);
  }
}

function assertNeverState(state: never): never {
  throw new Error(`Unsupported setup session state: ${String(state)}`);
}
