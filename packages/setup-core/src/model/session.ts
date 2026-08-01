import type { SafeError } from "@station/contracts";
import type { SetupOperationOutcome } from "../ports.js";
import type { SetupOperationCheckpoints } from "../session/checkpoints.js";
import type { SetupPlanningIntent } from "./intent.js";
import type { SetupIssue } from "./issues.js";
import type { SetupOperation } from "./operations.js";
import type { SetupPlan } from "./plan.js";
import type { SetupResult } from "./result.js";

export type SetupSessionStatus =
  | "inspecting"
  | "editing"
  | "reviewing"
  | "applying"
  | "verifying"
  | "blocked"
  | "completed"
  | "cancelled";

export type SetupSessionInspectionPhase =
  | "initial"
  | "after-preflight"
  | "after-activation"
  | "final";

export type SetupSessionApplyPhase =
  | "preflight"
  | "config-write"
  | "observer-activation"
  | "tracking";

export type SetupSessionBlockReason =
  | "inspection-failed"
  | "selection-unresolved"
  | "preflight-failed"
  | "preflight-incomplete"
  | "config-write-failed"
  | "observer-activation-failed";

export type SetupSessionResult = SetupResult & {
  readonly issues: readonly SetupIssue[];
  readonly operationOutcomes: readonly SetupOperationOutcome[];
};

type SetupSessionBase = {
  readonly revision: number;
  readonly intent: SetupPlanningIntent;
  readonly checkpoints: SetupOperationCheckpoints;
  readonly operationOutcomes: readonly SetupOperationOutcome[];
};

type SetupSessionWithPlan = SetupSessionBase & {
  readonly plan: SetupPlan;
};

export type SetupSessionState =
  | (SetupSessionBase & {
      readonly status: "inspecting";
      readonly inspectionPhase: SetupSessionInspectionPhase;
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
  | (SetupSessionBase & { readonly status: "cancelled" });

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
      readonly outcome: Extract<SetupOperationOutcome, { readonly status: "completed" }>;
    }
  | {
      readonly type: "operation-failed";
      readonly revision: number;
      readonly outcome: Extract<SetupOperationOutcome, { readonly status: "failed" }>;
    }
  | { readonly type: "cancel-requested"; readonly revision: number };

export type SetupSessionEffect =
  | { readonly kind: "inspect"; readonly phase: SetupSessionInspectionPhase }
  | { readonly kind: "perform-operation"; readonly operation: SetupOperation };

export type SetupSessionTransition = {
  readonly state: SetupSessionState;
  readonly effects: readonly SetupSessionEffect[];
};

/**
 * DRIVING PORT
 *
 * Offers one in-memory setup run to a driving CLI flow without defining transport or persistence.
 */
export type SetupSessionApplication = {
  readonly getState: () => SetupSessionState;
  readonly start: () => Promise<SetupSessionState>;
  readonly review: () => Promise<SetupSessionState>;
  readonly previewApply: () => Promise<SetupSessionState>;
  readonly apply: () => Promise<SetupSessionState>;
  readonly cancel: () => Promise<SetupSessionState>;
  readonly dispatch: (event: SetupSessionEvent) => Promise<SetupSessionState>;
};
