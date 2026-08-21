import type { SafeError } from "@station/contracts";
import type { SetupEditableIntent, SetupPlanningIntent } from "../model/intent.js";
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
  SetupSessionCancelledState,
  SetupSessionFailedOperationOutcome,
  SetupSessionInspectingState,
  SetupSessionOperationOutcome,
  SetupSessionState,
} from "../model/session.js";
import { assessSetupPlan } from "../policy/assessSetupPlan.js";
import { planSetup } from "../policy/planSetup.js";
import type { SetupInspection, SetupOperationExecutor, SetupOperationProgress } from "../ports.js";

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
};

/**
 * USE CASE
 *
 * Constructs one serialized setup application whose shared methods directly enforce phase order, replay prevention, and cancellation between operations.
 */
export function createSetupSessionApplication(
  options: CreateSetupSessionApplicationOptions,
): SetupSessionApplication {
  return new SetupSessionRuntime(options);
}

class SetupSessionRuntime implements SetupSessionApplication {
  readonly #options: CreateSetupSessionApplicationOptions;
  #state: SetupSessionState;
  #serialized: Promise<SetupSessionState>;
  #cancelRequested = false;
  #progressFailure: { readonly error: unknown } | undefined;

  constructor(options: CreateSetupSessionApplicationOptions) {
    this.#options = options;
    this.#state = {
      revision: 0,
      intent: options.intent,
      operationOutcomes: [],
      status: "inspecting",
      inspectionPhase: "initial",
    };
    this.#serialized = Promise.resolve(this.#state);
  }

  getState(): SetupSessionState {
    return this.#state;
  }

  start(): Promise<SetupSessionState> {
    return this.#enqueue(() => this.#startNow());
  }

  replaceIntent(intent: SetupEditableIntent): Promise<SetupSessionState> {
    return this.#enqueue(() => this.#replaceIntentNow(intent));
  }

  prepare(): Promise<SetupSessionState> {
    return this.#enqueue(() => this.#prepareNow());
  }

  review(): Promise<SetupSessionState> {
    return this.#enqueue(() => this.#reviewNow());
  }

  previewApply(): Promise<SetupSessionState> {
    return this.#enqueue(() => this.#previewApplyNow());
  }

  apply(): Promise<SetupSessionState> {
    return this.#enqueue(() => this.#applyNow());
  }

  cancel(): Promise<SetupSessionState> {
    this.#cancelRequested = true;
    return this.#enqueue(() => this.#cancelNow());
  }

  #enqueue(command: () => Promise<SetupSessionState>): Promise<SetupSessionState> {
    const run = this.#serialized.then(async () => {
      this.#progressFailure = undefined;
      const next = await command();
      const failure = this.#takeProgressFailure();
      if (failure !== undefined) throw failure.error;
      return next;
    });
    this.#serialized = run.catch(() => this.#state);
    return run;
  }

  async #startNow(): Promise<SetupSessionState> {
    if (this.#state.status === "inspecting") await this.#inspect();
    return this.#state;
  }

  async #replaceIntentNow(intent: SetupEditableIntent): Promise<SetupSessionState> {
    await this.#startNow();
    if (this.#state.status !== "editing") return this.#state;
    this.#state = {
      revision: this.#state.revision + 1,
      intent: { ...intent, mode: this.#state.intent.mode },
      operationOutcomes: this.#state.operationOutcomes,
      status: "inspecting",
      inspectionPhase: "initial",
    };
    await this.#inspect();
    return this.#state;
  }

  async #prepareNow(): Promise<SetupSessionState> {
    await this.#startNow();
    if (this.#state.status !== "editing") return this.#state;
    this.#state = {
      ...this.#state,
      status: "applying",
      applyPhase: "preflight",
      request: "prepare",
    };
    await this.#continueApplying();
    return this.#state;
  }

  async #reviewNow(): Promise<SetupSessionState> {
    await this.#startNow();
    if (this.#state.status === "editing") {
      this.#state = {
        ...this.#state,
        status: "reviewing",
        revision: this.#state.revision + 1,
      };
    }
    return this.#state;
  }

  async #previewApplyNow(): Promise<SetupSessionState> {
    await this.#reviewNow();
    if (this.#state.status !== "reviewing") return this.#state;
    this.#state = {
      ...this.#state,
      status: "verifying",
      revision: this.#state.revision + 1,
    };
    await this.#inspect();
    return this.#state;
  }

  async #applyNow(): Promise<SetupSessionState> {
    await this.#reviewNow();
    if (this.#state.status !== "reviewing") return this.#state;
    if (this.#state.plan.selection.outcome !== "selected") {
      this.#state = {
        ...this.#state,
        status: "blocked",
        reason: "selection-unresolved",
        revision: this.#state.revision + 1,
      };
      return this.#state;
    }
    this.#state = {
      ...this.#state,
      status: "applying",
      applyPhase: "preflight",
      request: "apply",
    };
    await this.#continueApplying();
    return this.#state;
  }

  async #cancelNow(): Promise<SetupSessionState> {
    this.#cancelRequested = false;
    this.#cancelSession();
    return this.#state;
  }

  async #inspect(): Promise<void> {
    if (this.#state.status !== "inspecting" && this.#state.status !== "verifying") return;
    const inspecting = this.#state;
    const phase = inspecting.status === "verifying" ? "final" : inspecting.inspectionPhase;
    let outcome: Awaited<ReturnType<SetupInspection>>;
    try {
      outcome = await this.#options.inspection({
        phase,
        revision: inspecting.revision,
        intent: inspecting.intent,
      });
    } catch {
      outcome = { status: "failed", error: unexpectedInspectionFailure };
    }

    if (outcome.status === "failed") {
      this.#state = {
        ...inspecting,
        status: "blocked",
        reason: "inspection-failed",
        error: outcome.error,
        revision: inspecting.revision + 1,
      };
      this.#consumePendingCancellation();
      return;
    }

    const plan = planSetup(outcome.facts, inspecting.intent);
    if (inspecting.status === "verifying") {
      this.#state = {
        revision: inspecting.revision + 1,
        intent: inspecting.intent,
        operationOutcomes: inspecting.operationOutcomes,
        plan,
        status: "completed",
        result: {
          ...plan.result,
          issues: plan.issues,
          operationOutcomes: inspecting.operationOutcomes,
        },
      };
      return;
    }

    if (phase === "initial" || phase === "after-preparation") {
      this.#state = {
        revision: inspecting.revision + 1,
        intent: inspecting.intent,
        operationOutcomes: inspecting.operationOutcomes,
        plan,
        status: "editing",
      };
      this.#consumePendingCancellation();
      return;
    }
    if (phase === "after-preflight") {
      await this.#beginConfigWrite(inspecting, plan);
      return;
    }
    await this.#beginOptionalIntegrations(inspecting, plan);
  }

  async #beginConfigWrite(inspecting: SetupSessionInspectingState, plan: SetupPlan): Promise<void> {
    const applying: SetupSessionApplyingState = {
      revision: inspecting.revision,
      intent: inspecting.intent,
      operationOutcomes: inspecting.operationOutcomes,
      plan,
      status: "applying",
      applyPhase: "config-write",
      request: "apply",
    };
    if (!assessSetupPlan(plan).canApply) {
      this.#state = {
        ...applying,
        status: "blocked",
        reason: "preflight-incomplete",
        revision: inspecting.revision + 1,
      };
      this.#consumePendingCancellation();
      return;
    }
    const configOperation = plan.operations.find(
      (operation): operation is SetupConfigWriteOperation =>
        operation.kind === "write-config" && operation.selected,
    );
    if (configOperation === undefined) {
      await this.#beginTracking(inspecting, plan);
      return;
    }
    this.#state = applying;
    if (!this.#consumePendingCancellation()) await this.#continueApplying();
  }

  async #beginTracking(inspecting: SetupSessionInspectingState, plan: SetupPlan): Promise<void> {
    this.#state = {
      revision: inspecting.revision,
      intent: inspecting.intent,
      operationOutcomes: inspecting.operationOutcomes,
      plan,
      status: "applying",
      applyPhase: "tracking",
      request: "apply",
    };
    if (!this.#consumePendingCancellation()) await this.#continueApplying();
  }

  async #beginOptionalIntegrations(
    inspecting: SetupSessionInspectingState,
    plan: SetupPlan,
  ): Promise<void> {
    this.#state = {
      revision: inspecting.revision,
      intent: inspecting.intent,
      operationOutcomes: inspecting.operationOutcomes,
      plan,
      status: "applying",
      applyPhase: "optional-integrations",
      request: "apply",
    };
    if (!this.#consumePendingCancellation()) await this.#continueApplying();
  }

  async #continueApplying(): Promise<void> {
    while (this.#state.status === "applying") {
      const operation = nextOperation(this.#state);
      if (operation !== undefined) {
        await this.#runOperation(this.#state, operation);
        if (this.#consumePendingCancellation() || this.#state.status !== "applying") return;
        continue;
      }

      switch (this.#state.applyPhase) {
        case "preflight": {
          const inspectionPhase =
            this.#state.request === "prepare" ? "after-preparation" : "after-preflight";
          this.#state = {
            ...this.#state,
            status: "inspecting",
            inspectionPhase,
            revision: this.#state.revision + 1,
          };
          if (!this.#consumePendingCancellation()) await this.#inspect();
          return;
        }
        case "config-write": {
          // Tracking must observe the committed config before startup enforces that config's hook intent.
          this.#state = {
            ...this.#state,
            applyPhase: "tracking",
            revision: this.#state.revision + 1,
          };
          break;
        }
        case "tracking": {
          const activation = this.#state.plan.operations.find(
            (operation): operation is SetupObserverActivationOperation =>
              operation.kind === "activate-observer-config" && operation.selected,
          );
          if (activation === undefined || hasCompletedOperation(this.#state, activation.id)) {
            this.#state = {
              ...this.#state,
              applyPhase: "optional-integrations",
              revision: this.#state.revision + 1,
            };
            break;
          }
          this.#state = {
            ...this.#state,
            applyPhase: "observer-activation",
            revision: this.#state.revision + 1,
          };
          break;
        }
        case "observer-activation":
          this.#state = {
            ...this.#state,
            status: "inspecting",
            inspectionPhase: "after-activation",
            revision: this.#state.revision + 1,
          };
          if (!this.#consumePendingCancellation()) await this.#inspect();
          return;
        case "optional-integrations":
          this.#state = {
            ...this.#state,
            status: "verifying",
            revision: this.#state.revision + 1,
          };
          if (!this.#consumePendingCancellation()) await this.#inspect();
          return;
        default:
          assertNeverApplyPhase(this.#state.applyPhase);
      }
    }
  }

  async #runOperation(
    applying: SetupSessionApplyingState,
    operation: SetupOperation,
  ): Promise<void> {
    await this.#reportProgress(() => this.#options.operationProgress?.started?.(operation));
    const outcome = await this.#executeOperation(operation);
    const withOutcome: SetupSessionApplyingState = {
      ...applying,
      operationOutcomes: [...applying.operationOutcomes, outcome],
      revision: applying.revision + 1,
    };
    if (
      outcome.status === "failed" &&
      applying.request !== "prepare" &&
      applying.applyPhase !== "tracking" &&
      applying.applyPhase !== "optional-integrations" &&
      operation.kind !== "install-harness"
    ) {
      this.#state = {
        ...withOutcome,
        status: "blocked",
        reason: blockReasonForPhase(applying.applyPhase),
        error: outcome.error,
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
        ...(outcome.startupEvidence === undefined
          ? {}
          : { startupEvidence: outcome.startupEvidence }),
      };
    } else {
      this.#state = withOutcome;
    }
    await this.#reportProgress(() =>
      this.#options.operationProgress?.finished?.(operation, outcome),
    );
  }

  async #executeOperation(operation: SetupOperation): Promise<SetupSessionOperationOutcome> {
    try {
      const outcome = await this.#options.executeOperation(operation);
      if (outcome.operationId !== operation.id) {
        return failedSessionOutcome(operation, operationOutcomeMismatch);
      }
      return { ...outcome, operation };
    } catch {
      return failedSessionOutcome(operation, unexpectedOperationFailure);
    }
  }

  #consumePendingCancellation(): boolean {
    if (
      !this.#cancelRequested ||
      this.#state.status === "completed" ||
      this.#state.status === "cancelled"
    ) {
      return false;
    }
    this.#cancelRequested = false;
    this.#cancelSession();
    return true;
  }

  #cancelSession(): void {
    if (this.#state.status === "completed" || this.#state.status === "cancelled") return;
    const current = this.#state;
    const cancelled: MutableCancelledState = {
      revision: current.revision + 1,
      intent: current.intent,
      operationOutcomes: current.operationOutcomes,
      status: "cancelled",
    };
    if ("plan" in current && current.plan !== undefined) cancelled.plan = current.plan;
    if ("error" in current && current.error !== undefined) cancelled.error = current.error;
    this.#state = cancelled;
  }

  #takeProgressFailure(): { readonly error: unknown } | undefined {
    const failure = this.#progressFailure;
    this.#progressFailure = undefined;
    return failure;
  }

  async #reportProgress(report: () => void | Promise<void> | undefined): Promise<void> {
    try {
      await report();
    } catch (error) {
      this.#progressFailure ??= { error };
    }
  }
}

type MutableCancelledState = {
  -readonly [Key in keyof SetupSessionCancelledState]: SetupSessionCancelledState[Key];
};

function hasCompletedOperation(
  state: SetupSessionApplyingState,
  operationId: SetupOperation["id"],
): boolean {
  return state.operationOutcomes.some(
    (outcome) => outcome.status === "completed" && outcome.operationId === operationId,
  );
}

function nextOperation(state: SetupSessionApplyingState): SetupOperation | undefined {
  return state.plan.operations.find(
    (operation) =>
      operation.selected &&
      isOperationInPhase(operation, state.applyPhase) &&
      !state.operationOutcomes.some((outcome) => outcome.operationId === operation.id),
  );
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

function failedSessionOutcome(
  operation: SetupOperation,
  error: SafeError,
): SetupSessionFailedOperationOutcome {
  return { status: "failed", operationId: operation.id, operation, error };
}

function assertNeverOperation(operation: never): never {
  throw new Error(`Unsupported setup operation: ${String(operation)}`);
}

function assertNeverApplyPhase(phase: never): never {
  throw new Error(`Unsupported setup apply phase: ${String(phase)}`);
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
