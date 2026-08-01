import type { SafeError } from "@station/contracts";
import {
  createSetupSessionApplication,
  type SetupOperationExecutor,
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
import type { SetupPlan } from "./model.js";
import { projectSessionView } from "./presentation/projectSessionView.js";
import { type ProjectSetupView, projectSetupView } from "./presentation/projectSetupView.js";
import { createJsonSetupPresenter, type JsonSetupPresenter } from "./presenters/json.js";
import type { TextSetupPresenter } from "./presenters/text.js";
import type { SetupCommandDeps, SetupCommandOptions } from "./types.js";

export type CliSetupSession = {
  readonly application: SetupSessionApplication;
  readonly inspection: SetupInspectionAdapter;
  readonly snapshot: () => SetupInspectionSnapshot | undefined;
};

export type ProjectedSetupSession = {
  readonly status: "projected";
  readonly plan: SetupPlan;
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
};

/**
 * COMPOSITION ROOT
 *
 * Wires one CLI invocation's inspection, operation, session, and presentation adapters.
 */
export function createSetupComposition(options: CreateSetupCompositionOptions): SetupComposition {
  const inspection = createSetupInspectionAdapter({
    mode: options.mode,
    options: options.options,
    deps: options.deps,
    noBrew: options.noBrew,
    planConfigWrite: options.planConfigWrite,
  });
  let executor: SetupOperationExecutor | undefined;
  const executeOperation: SetupOperationExecutor = async (operation) => {
    const snapshot = inspection.current();
    if (snapshot === undefined) {
      return {
        status: "failed",
        operationId: operation.id,
        error: setupInspectionRequired,
      };
    }
    executor ??= createSetupOperationAdapter({
      facts: () => inspection.current()?.facts,
      deps: inspection.currentDeps,
    });
    const outcome = await executor(operation);
    inspection.recordOperationOutcome(outcome);
    return outcome;
  };
  const application = createSetupSessionApplication({
    intent: {
      mode: options.mode,
      harnessSelection: { kind: "automatic" },
      installWorktrunkHooks: false,
    },
    inspection,
    executeOperation,
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
    json,
    text,
    project: (state) => projectCurrentSession(state, session, json),
  };
}

function projectCurrentSession(
  state: SetupSessionState,
  session: CliSetupSession,
  json: JsonSetupPresenter,
): SetupSessionProjection {
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
  const input =
    snapshot.configWrite === undefined
      ? { plan: sessionView.plan, facts: snapshot.facts }
      : { plan: sessionView.plan, facts: snapshot.facts, configWrite: snapshot.configWrite };
  return {
    status: "projected",
    plan: json.project(input),
    view: projectSetupView(input),
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
