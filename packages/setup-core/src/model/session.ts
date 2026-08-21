import type { ObserverStartupEvidence, SafeError } from "@station/contracts";
import type { SetupPlanningIntent } from "./intent.js";
import type { SetupIssue } from "./issues.js";
import type {
  SetupOperation,
  SetupOperationCompletedOutcome,
  SetupOperationFailedOutcome,
} from "./operations.js";
import type { SetupPlan } from "./plan.js";
import type { SetupResult } from "./result.js";

/** Lifecycle states visible to a driving setup adapter. */
export type SetupSessionStatus =
  | "inspecting"
  | "editing"
  | "reviewing"
  | "applying"
  | "verifying"
  | "blocked"
  | "completed"
  | "cancelled";

/** Inspection points at which setup evidence is refreshed during one application cascade. */
export type SetupSessionInspectionPhase =
  | "initial"
  | "after-preparation"
  | "after-preflight"
  | "after-activation"
  | "final";

export type SetupSessionActiveInspectionPhase = Exclude<SetupSessionInspectionPhase, "final">;

/** Ordered mutation groups enforced by the setup application. */
export type SetupSessionApplyPhase =
  | "preflight"
  | "config-write"
  | "observer-activation"
  | "tracking"
  | "optional-integrations";

/** Stable reason categories for setup sessions that cannot continue automatically. */
export type SetupSessionBlockReason =
  | "inspection-failed"
  | "selection-unresolved"
  | "preflight-failed"
  | "preflight-incomplete"
  | "config-write-failed"
  | "observer-activation-failed";

export type SetupSessionCompletedOperationOutcome = SetupOperationCompletedOutcome & {
  readonly operation: SetupOperation;
};

export type SetupSessionFailedOperationOutcome = SetupOperationFailedOutcome & {
  readonly operation: SetupOperation;
};

/** Operation outcome enriched with the semantic operation needed by presenters and diagnostics. */
export type SetupSessionOperationOutcome =
  | SetupSessionCompletedOperationOutcome
  | SetupSessionFailedOperationOutcome;

/** Final semantic result plus all issue and operation evidence retained by the session. */
export type SetupSessionResult = SetupResult & {
  readonly issues: readonly SetupIssue[];
  readonly operationOutcomes: readonly SetupSessionOperationOutcome[];
};

type SetupSessionBase = {
  /** Monotonically identifies presentation and inspection progress within one serialized run. */
  readonly revision: number;
  readonly intent: SetupPlanningIntent;
  readonly operationOutcomes: readonly SetupSessionOperationOutcome[];
};

type SetupSessionWithPlan = SetupSessionBase & {
  readonly plan: SetupPlan;
};

export type SetupSessionInspectingState = SetupSessionBase & {
  readonly status: "inspecting";
  readonly inspectionPhase: SetupSessionActiveInspectionPhase;
  readonly plan?: SetupPlan;
};

export type SetupSessionEditingState = SetupSessionWithPlan & { readonly status: "editing" };
export type SetupSessionReviewingState = SetupSessionWithPlan & { readonly status: "reviewing" };

export type SetupSessionApplyingState = SetupSessionWithPlan & {
  readonly status: "applying";
  readonly applyPhase: SetupSessionApplyPhase;
  readonly request: "prepare" | "apply";
};

export type SetupSessionVerifyingState = SetupSessionWithPlan & { readonly status: "verifying" };

export type SetupSessionBlockedState = SetupSessionBase & {
  readonly status: "blocked";
  readonly reason: SetupSessionBlockReason;
  readonly plan?: SetupPlan;
  readonly error?: SafeError;
  readonly cause?: SafeError;
  readonly startupEvidence?: ObserverStartupEvidence;
};

export type SetupSessionCompletedState = SetupSessionWithPlan & {
  readonly status: "completed";
  readonly result: SetupSessionResult;
};

export type SetupSessionCancelledState = SetupSessionBase & {
  readonly status: "cancelled";
  readonly plan?: SetupPlan;
  readonly error?: SafeError;
};

/** Invocation-local setup state; no member is durable across CLI invocations. */
export type SetupSessionState =
  | SetupSessionInspectingState
  | SetupSessionEditingState
  | SetupSessionReviewingState
  | SetupSessionApplyingState
  | SetupSessionVerifyingState
  | SetupSessionBlockedState
  | SetupSessionCompletedState
  | SetupSessionCancelledState;
