import type { SafeError } from "@station/contracts";
import type { SetupEditableIntent, SetupPlanningIntent } from "../model/intent.js";
import type { SetupOperation } from "../model/operations.js";
import type {
  SetupSessionEffect,
  SetupSessionEvent,
  SetupSessionFailedOperationOutcome,
  SetupSessionOperationOutcome,
  SetupSessionState,
} from "../model/session.js";
import type { SetupInspection, SetupOperationExecutor, SetupOperationProgress } from "../ports.js";
import { createSetupSessionState, transitionSetupSession } from "./transition.js";

/** Dependencies required to run one isolated in-memory setup session. */
type CreateSetupSessionApplicationOptions = {
  readonly intent: SetupPlanningIntent;
  readonly inspection: SetupInspection;
  readonly executeOperation: SetupOperationExecutor;
  readonly operationProgress?: SetupOperationProgress;
};

/**
 * DRIVING PORT
 *
 * Accepts serialized setup intent editing, staged preparation, review, apply, and cancellation commands for one invocation-local session.
 */
export type SetupSessionApplication = {
  readonly getState: () => SetupSessionState;
  readonly start: () => Promise<SetupSessionState>;
  readonly replaceIntent: (intent: SetupEditableIntent) => Promise<SetupSessionState>;
  readonly prepare: () => Promise<SetupSessionState>;
  readonly review: () => Promise<SetupSessionState>;
  readonly previewApply: () => Promise<SetupSessionState>;
  readonly apply: () => Promise<SetupSessionState>;
  readonly cancel: () => Promise<SetupSessionState>;
  readonly dispatch: (event: SetupSessionEvent) => Promise<SetupSessionState>;
};

/**
 * USE CASE
 *
 * Coordinates one setup session's intent-bound inspections, staged prerequisite effects, and complete apply sequence without transport or restart recovery.
 */
export function createSetupSessionApplication(
  options: CreateSetupSessionApplicationOptions,
): SetupSessionApplication {
  let state = createSetupSessionState(options.intent);
  let serialized = Promise.resolve<SetupSessionState>(state);
  let cancelRequested = false;
  let progressFailure: { readonly error: unknown } | undefined;

  const enqueue = (command: () => Promise<SetupSessionState>): Promise<SetupSessionState> => {
    const run = serialized.then(async () => {
      progressFailure = undefined;
      const next = await command();
      const failure = takeProgressFailure();
      if (failure !== undefined) throw failure.error;
      return next;
    });
    serialized = run.catch(() => state);
    return run;
  };

  const dispatch = (event: SetupSessionEvent): Promise<SetupSessionState> => {
    if (event.type === "cancel-requested") cancelRequested = true;
    return enqueue(() => drive(event));
  };

  const startNow = async (): Promise<SetupSessionState> => {
    if (state.status !== "inspecting") return state;
    return drive({ type: "inspection-requested", revision: state.revision });
  };

  const replaceIntentNow = async (intent: SetupEditableIntent): Promise<SetupSessionState> => {
    await startNow();
    if (state.status !== "editing") return state;
    return drive({ type: "intent-replaced", revision: state.revision, intent });
  };

  const prepareNow = async (): Promise<SetupSessionState> => {
    await startNow();
    if (state.status !== "editing") return state;
    return drive({ type: "prepare-requested", revision: state.revision });
  };

  const reviewNow = async (): Promise<SetupSessionState> => {
    await startNow();
    if (state.status !== "editing") return state;
    return drive({ type: "review-requested", revision: state.revision });
  };

  const previewApplyNow = async (): Promise<SetupSessionState> => {
    await reviewNow();
    if (state.status !== "reviewing") return state;
    return drive({ type: "preview-requested", revision: state.revision });
  };

  const applyNow = async (): Promise<SetupSessionState> => {
    await reviewNow();
    if (state.status !== "reviewing") return state;
    return drive({ type: "apply-requested", revision: state.revision });
  };

  const cancel = (): Promise<SetupSessionState> => {
    cancelRequested = true;
    return enqueue(() => drive({ type: "cancel-requested" }));
  };

  const start = (): Promise<SetupSessionState> => enqueue(startNow);
  const replaceIntent = (intent: SetupEditableIntent): Promise<SetupSessionState> =>
    enqueue(() => replaceIntentNow(intent));
  const prepare = (): Promise<SetupSessionState> => enqueue(prepareNow);
  const review = (): Promise<SetupSessionState> => enqueue(reviewNow);
  const previewApply = (): Promise<SetupSessionState> => enqueue(previewApplyNow);
  const apply = (): Promise<SetupSessionState> => enqueue(applyNow);

  async function drive(
    event: SetupSessionEvent,
    afterTransition?: () => Promise<void>,
  ): Promise<SetupSessionState> {
    if (event.type === "cancel-requested") cancelRequested = false;
    const transition = transitionSetupSession(state, event);
    state = transition.state;
    await afterTransition?.();
    for (const effect of transition.effects) {
      if (consumePendingCancellation()) break;
      await runEffect(effect);
    }
    consumePendingCancellation();
    return state;
  }

  function consumePendingCancellation(): boolean {
    if (!cancelRequested || state.status === "completed" || state.status === "cancelled") {
      return false;
    }
    cancelRequested = false;
    state = transitionSetupSession(state, { type: "cancel-requested" }).state;
    return true;
  }

  async function runEffect(effect: SetupSessionEffect): Promise<void> {
    const revision = state.revision;
    if (effect.kind === "inspect") {
      try {
        const outcome = await options.inspection({
          phase: effect.phase,
          revision,
          intent: state.intent,
        });
        await drive(
          outcome.status === "completed"
            ? { type: "inspection-completed", revision, facts: outcome.facts }
            : { type: "inspection-failed", revision, error: outcome.error },
        );
      } catch {
        await drive({
          type: "inspection-failed",
          revision,
          error: unexpectedInspectionFailure,
        });
      }
      return;
    }

    await reportProgress(() => options.operationProgress?.started?.(effect.operation));
    const outcome = await executeOperation(effect.operation);
    await drive(
      outcome.status === "completed"
        ? { type: "operation-completed", revision, outcome }
        : { type: "operation-failed", revision, outcome },
      () => reportProgress(() => options.operationProgress?.finished?.(effect.operation, outcome)),
    );
  }

  function takeProgressFailure(): { readonly error: unknown } | undefined {
    const failure = progressFailure;
    progressFailure = undefined;
    return failure;
  }

  async function reportProgress(report: () => void | Promise<void> | undefined): Promise<void> {
    try {
      await report();
    } catch (error) {
      progressFailure ??= { error };
    }
  }

  async function executeOperation(
    operation: SetupOperation,
  ): Promise<SetupSessionOperationOutcome> {
    try {
      const outcome = await options.executeOperation(operation);
      if (outcome.operationId !== operation.id) {
        return failedSessionOutcome(operation, operationOutcomeMismatch);
      }
      return { ...outcome, operation };
    } catch {
      return failedSessionOutcome(operation, unexpectedOperationFailure);
    }
  }

  return {
    getState: () => state,
    start,
    replaceIntent,
    prepare,
    review,
    previewApply,
    apply,
    cancel,
    dispatch,
  };
}

function failedSessionOutcome(
  operation: SetupOperation,
  error: SafeError,
): SetupSessionFailedOperationOutcome {
  return { status: "failed", operationId: operation.id, operation, error };
}

const unexpectedInspectionFailure: SafeError = {
  tag: "SetupInspectionError",
  code: "SETUP_INSPECTION_FAILED",
  message: "Setup facts could not be inspected.",
};

const unexpectedOperationFailure: SafeError = {
  tag: "SetupOperationError",
  code: "SETUP_OPERATION_FAILED",
  message: "The setup operation failed unexpectedly.",
};

const operationOutcomeMismatch: SafeError = {
  tag: "SetupOperationError",
  code: "SETUP_OPERATION_OUTCOME_MISMATCH",
  message: "The setup operation returned an outcome for a different operation.",
};
