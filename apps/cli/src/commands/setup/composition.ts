import type { CliSetupPlan, SafeError } from "@station/contracts";
import {
  createSetupSessionApplication,
  type SetupEditableIntent,
  type SetupOperationExecutor,
  type SetupOperationProgress,
  type SetupSessionApplication,
  type SetupSessionState,
} from "@station/setup-core";
import {
  createSetupInspectionAdapter,
  type SetupInspectionAdapter,
  type SetupInspectionSnapshot,
} from "./adapters/inspection.js";
import type { SetupMode } from "./adapters/inspectionTypes.js";
import { createSetupOperationAdapter } from "./adapters/operations.js";
import { setupPresenter } from "./io.js";
import { projectSessionView } from "./presentation/projectSessionView.js";
import { type ProjectSetupView, projectSetupView } from "./presentation/projectSetupView.js";
import { createClackSetupPresenter } from "./presenters/clack.js";
import { createJsonSetupPresenter, type JsonSetupPresenter } from "./presenters/json.js";
import type { TextSetupPresenter } from "./presenters/text.js";
import type { SetupCommandDeps, SetupCommandOptions, SetupPromptAdapter } from "./types.js";

export type CliSetupSession = {
  readonly application: SetupSessionApplication;
  readonly inspection: SetupInspectionAdapter;
  readonly snapshot: () => SetupInspectionSnapshot | undefined;
};

export type ProjectedSetupSession = {
  readonly status: "projected";
  readonly plan: CliSetupPlan;
  readonly view: ProjectSetupView;
  readonly session: ReturnType<typeof projectSessionView>;
};

export type UnavailableSetupSessionProjection = {
  readonly status: "unavailable";
  readonly error: SafeError;
};

export type SetupSessionProjection = ProjectedSetupSession | UnavailableSetupSessionProjection;

/** Invocation-scoped setup runtime and its machine and terminal presentation adapters. */
export type SetupComposition = {
  readonly session: CliSetupSession;
  readonly guided: SetupPromptAdapter;
  readonly json: JsonSetupPresenter;
  readonly text: TextSetupPresenter;
  readonly project: (state: SetupSessionState) => SetupSessionProjection;
};

/** CLI inputs used to wire one setup composition without performing inspection or mutation. */
export type CreateSetupCompositionOptions = {
  readonly mode: SetupMode;
  readonly options: SetupCommandOptions;
  readonly deps: SetupCommandDeps;
  readonly noBrew: boolean;
  readonly planConfigWrite: boolean;
  readonly initialIntent?: SetupEditableIntent;
  readonly operationProgress?: SetupOperationProgress;
};

/**
 * COMPOSITION ROOT
 *
 * Wires one CLI invocation's semantic session, inspection and operation adapters, Clack input, and independent text and JSON presentation.
 * The lazily created operation adapter routes Observer startup progress through the guided prompt adapter's logInfo.
 */
export function createSetupComposition(options: CreateSetupCompositionOptions): SetupComposition {
  const inspection = createSetupInspectionAdapter({
    mode: options.mode,
    options: options.options,
    deps: options.deps,
    noBrew: options.noBrew,
    planConfigWrite: options.planConfigWrite,
  });
  const guided = options.deps.prompt ?? createClackSetupPresenter();
  let executor: SetupOperationExecutor | undefined;
  const executeOperation: SetupOperationExecutor = async (operation) => {
    const snapshot = inspection.current();
    const outcome =
      snapshot === undefined
        ? {
            status: "failed" as const,
            operationId: operation.id,
            error: setupInspectionRequired,
          }
        : await executeWithCurrentInspection(operation);
    inspection.recordOperationOutcome(outcome);
    return outcome;
  };
  const executeWithCurrentInspection: SetupOperationExecutor = async (operation) => {
    executor ??= createSetupOperationAdapter({
      facts: () => inspection.current()?.facts,
      deps: inspection.currentDeps,
      observerStartupProgress: (message) => guided.logInfo(message),
    });
    return executor(operation);
  };
  const initialIntent: SetupEditableIntent = options.initialIntent ?? {
    harnessSelection: { kind: "automatic" },
    installBootstrap: false,
    installHarnesses: [],
    linkStationLaunchers: false,
    harnessTrackingSelection: { kind: "automatic" },
    installWorktrunkHooks: false,
    installWorktrunkShell: false,
    configureTmuxPopup: false,
  };
  const application = createSetupSessionApplication({
    intent: { ...initialIntent, mode: options.mode },
    inspection,
    executeOperation,
    ...(options.operationProgress === undefined
      ? {}
      : { operationProgress: options.operationProgress }),
  });
  const session: CliSetupSession = {
    application,
    inspection,
    snapshot: inspection.current,
  };
  const json = createJsonSetupPresenter();
  const text = setupPresenter(options.deps);
  return {
    session,
    guided,
    json,
    text,
    project: (state) => projectCurrentSession({ state, session, json }),
  };
}

function projectCurrentSession(input: {
  readonly state: SetupSessionState;
  readonly session: CliSetupSession;
  readonly json: JsonSetupPresenter;
}): SetupSessionProjection {
  const { state, session, json } = input;
  const snapshot = session.snapshot();
  const sessionView = projectSessionView(state);
  if (snapshot === undefined || sessionView.plan === undefined) {
    return {
      status: "unavailable",
      error:
        ("error" in state ? state.error : undefined) ??
        (state.status === "cancelled" ? setupSessionCancelled : setupEvidenceUnavailable),
    };
  }
  const projectionInput =
    snapshot.configMutation === undefined
      ? { plan: sessionView.plan, facts: snapshot.facts }
      : {
          plan: sessionView.plan,
          facts: snapshot.facts,
          configMutation: snapshot.configMutation,
        };
  return {
    status: "projected",
    plan: json.project(projectionInput),
    view: projectSetupView(projectionInput),
    session: sessionView,
  };
}

const setupInspectionRequired: SafeError = {
  tag: "SetupSessionError",
  code: "SETUP_INSPECTION_REQUIRED",
  message: "Setup inspection must complete before operations can run.",
};

const setupEvidenceUnavailable: SafeError = {
  tag: "SetupSessionError",
  code: "SETUP_EVIDENCE_UNAVAILABLE",
  message: "Setup completed without inspectable semantic evidence.",
};

const setupSessionCancelled: SafeError = {
  tag: "SetupSessionError",
  code: "SETUP_SESSION_CANCELLED",
  message: "Setup was cancelled before inspectable evidence was available.",
};
