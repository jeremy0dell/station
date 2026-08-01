import type { SafeError } from "@station/contracts";
import type { SetupPlanningIntent } from "./intent.js";
import type { SetupIssue } from "./issues.js";
import type { SetupOperation, SetupOperationOutcome } from "./operations.js";
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

/** Operation outcome enriched with the semantic operation needed by presenters and diagnostics. */
export type SetupSessionOperationOutcome = SetupOperationOutcome & {
  readonly operation: SetupOperation;
};

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

/** Invocation-local setup state; no member is durable across CLI invocations. */
export type SetupSessionState =
  | (SetupSessionBase & {
      readonly status: "inspecting";
      readonly inspectionPhase: SetupSessionActiveInspectionPhase;
      readonly plan?: SetupPlan;
    })
  | (SetupSessionWithPlan & { readonly status: "editing" })
  | (SetupSessionWithPlan & { readonly status: "reviewing" })
  | (SetupSessionWithPlan & {
      readonly status: "applying";
      readonly applyPhase: SetupSessionApplyPhase;
    })
  | (SetupSessionWithPlan & { readonly status: "verifying" })
  | (SetupSessionBase & {
      readonly status: "blocked";
      readonly reason: SetupSessionBlockReason;
      readonly plan?: SetupPlan;
      readonly error?: SafeError;
    })
  | (SetupSessionWithPlan & {
      readonly status: "completed";
      readonly result: SetupSessionResult;
    })
  | (SetupSessionBase & {
      readonly status: "cancelled";
      readonly plan?: SetupPlan;
      readonly error?: SafeError;
    });

/** A typed input to the pure setup transition policy; asynchronous results are revision-scoped. */
export type SetupSessionEvent =
  | { readonly type: "inspection-requested"; readonly revision: number }
  | {
      readonly type: "inspection-completed";
      readonly revision: number;
      readonly facts: SetupPlan["evidence"];
    }
  | { readonly type: "inspection-failed"; readonly revision: number; readonly error: SafeError }
  | { readonly type: "review-requested"; readonly revision: number }
  | { readonly type: "preview-requested"; readonly revision: number }
  | { readonly type: "apply-requested"; readonly revision: number }
  | {
      readonly type: "operation-completed";
      readonly revision: number;
      readonly outcome: Extract<SetupSessionOperationOutcome, { readonly status: "completed" }>;
    }
  | {
      readonly type: "operation-failed";
      readonly revision: number;
      readonly outcome: Extract<SetupSessionOperationOutcome, { readonly status: "failed" }>;
    }
  | { readonly type: "cancel-requested" };

/** An outward request emitted by the transition policy and serialized by the session application. */
export type SetupSessionEffect =
  | { readonly kind: "inspect"; readonly phase: SetupSessionInspectionPhase }
  | { readonly kind: "perform-operation"; readonly operation: SetupOperation };

/** Pure transition output containing the next state and outward effects to serialize. */
export type SetupSessionTransition = {
  readonly state: SetupSessionState;
  readonly effects: readonly SetupSessionEffect[];
};
