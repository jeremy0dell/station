import type { SafeError } from "@station/contracts";
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
  | "after-preflight"
  | "after-activation"
  | "final";

export type SetupSessionActiveInspectionPhase = Exclude<SetupSessionInspectionPhase, "final">;

/** Ordered mutation groups enforced by the setup transition policy. */
export type SetupSessionApplyPhase =
  | "preflight"
  | "config-write"
  | "observer-activation"
  | "tracking";

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

/** An invocation-local operation identity that prevents replay within the same run. */
export type SetupOperationCheckpoint = {
  readonly operationId: SetupOperation["id"];
};

export type SetupOperationCheckpoints = readonly SetupOperationCheckpoint[];

type SetupSessionBase = {
  /** Monotonically identifies the state revision that may accept an asynchronous result event. */
  readonly revision: number;
  readonly intent: SetupPlanningIntent;
  readonly checkpoints: SetupOperationCheckpoints;
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

export type SetupSessionEditingState = SetupSessionWithPlan & {
  readonly status: "editing";
};

export type SetupSessionReviewingState = SetupSessionWithPlan & {
  readonly status: "reviewing";
};

export type SetupSessionApplyingState = SetupSessionWithPlan & {
  readonly status: "applying";
  readonly applyPhase: SetupSessionApplyPhase;
};

export type SetupSessionVerifyingState = SetupSessionWithPlan & {
  readonly status: "verifying";
};

export type SetupSessionBlockedState = SetupSessionBase & {
  readonly status: "blocked";
  readonly reason: SetupSessionBlockReason;
  readonly plan?: SetupPlan;
  readonly error?: SafeError;
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

export type SetupSessionInspectionRequestedEvent = {
  readonly type: "inspection-requested";
  readonly revision: number;
};

export type SetupSessionInspectionCompletedEvent = {
  readonly type: "inspection-completed";
  readonly revision: number;
  readonly facts: SetupPlan["evidence"];
};

export type SetupSessionInspectionFailedEvent = {
  readonly type: "inspection-failed";
  readonly revision: number;
  readonly error: SafeError;
};

export type SetupSessionReviewRequestedEvent = {
  readonly type: "review-requested";
  readonly revision: number;
};

export type SetupSessionPreviewRequestedEvent = {
  readonly type: "preview-requested";
  readonly revision: number;
};

export type SetupSessionApplyRequestedEvent = {
  readonly type: "apply-requested";
  readonly revision: number;
};

export type SetupSessionOperationCompletedEvent = {
  readonly type: "operation-completed";
  readonly revision: number;
  readonly outcome: SetupSessionCompletedOperationOutcome;
};

export type SetupSessionOperationFailedEvent = {
  readonly type: "operation-failed";
  readonly revision: number;
  readonly outcome: SetupSessionFailedOperationOutcome;
};

export type SetupSessionCancelRequestedEvent = {
  readonly type: "cancel-requested";
};

/** A typed input to the pure setup transition policy; asynchronous results are revision-scoped. */
export type SetupSessionEvent =
  | SetupSessionInspectionRequestedEvent
  | SetupSessionInspectionCompletedEvent
  | SetupSessionInspectionFailedEvent
  | SetupSessionReviewRequestedEvent
  | SetupSessionPreviewRequestedEvent
  | SetupSessionApplyRequestedEvent
  | SetupSessionOperationCompletedEvent
  | SetupSessionOperationFailedEvent
  | SetupSessionCancelRequestedEvent;

export type SetupSessionInspectionEffect = {
  readonly kind: "inspect";
  readonly phase: SetupSessionInspectionPhase;
};

export type SetupSessionOperationEffect = {
  readonly kind: "perform-operation";
  readonly operation: SetupOperation;
};

/** An outward request emitted by the transition policy and serialized by the session application. */
export type SetupSessionEffect = SetupSessionInspectionEffect | SetupSessionOperationEffect;

/** Pure transition output containing the next state and outward effects to serialize. */
export type SetupSessionTransition = {
  readonly state: SetupSessionState;
  readonly effects: readonly SetupSessionEffect[];
};
