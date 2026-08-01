import type { SetupPlanningIntent } from "../model/intent.js";
import type { SetupSessionEffect, SetupSessionEvent, SetupSessionState } from "../model/session.js";
import type { SetupInspection, SetupOperationExecutor } from "../ports.js";
import { createSetupSessionState, transitionSetupSession } from "./transition.js";

export type CreateSetupSessionApplicationOptions = {
  readonly intent: SetupPlanningIntent;
  readonly inspection: SetupInspection;
  readonly executeOperation: SetupOperationExecutor;
};

/**
 * USE CASE
 *
 * Drives one setup session through serialized inspection and mutation effects without adding transport or restart recovery.
 */
export function createSetupSessionApplication(options: CreateSetupSessionApplicationOptions) {
  let state = createSetupSessionState(options.intent);
  let serialized = Promise.resolve<SetupSessionState>(state);

  const dispatch = (event: SetupSessionEvent): Promise<SetupSessionState> => {
    const run = serialized.then(() => drive(event));
    serialized = run.catch(() => state);
    return run;
  };

  const start = async (): Promise<SetupSessionState> => {
    if (state.status !== "inspecting") return state;
    return dispatch({ type: "inspection-requested", revision: state.revision });
  };

  const review = async (): Promise<SetupSessionState> => {
    await start();
    if (state.status !== "editing") return state;
    return dispatch({ type: "review-requested", revision: state.revision });
  };

  const previewApply = async (): Promise<SetupSessionState> => {
    await review();
    if (state.status !== "reviewing") return state;
    return dispatch({ type: "preview-requested", revision: state.revision });
  };

  const apply = async (): Promise<SetupSessionState> => {
    await review();
    if (state.status !== "reviewing") return state;
    return dispatch({ type: "apply-requested", revision: state.revision });
  };

  const cancel = (): Promise<SetupSessionState> =>
    dispatch({ type: "cancel-requested", revision: state.revision });

  async function drive(event: SetupSessionEvent): Promise<SetupSessionState> {
    const transition = transitionSetupSession(state, event);
    state = transition.state;
    for (const effect of transition.effects) {
      await runEffect(effect);
    }
    return state;
  }

  async function runEffect(effect: SetupSessionEffect): Promise<void> {
    switch (effect.kind) {
      case "inspect": {
        const outcome = await options.inspection({ phase: effect.phase, revision: state.revision });
        await drive(
          outcome.status === "completed"
            ? { type: "inspection-completed", revision: state.revision, facts: outcome.facts }
            : { type: "inspection-failed", revision: state.revision, error: outcome.error },
        );
        return;
      }
      case "perform-operation": {
        const outcome = await options.executeOperation(effect.operation);
        await drive(
          outcome.status === "completed"
            ? { type: "operation-completed", revision: state.revision, outcome }
            : { type: "operation-failed", revision: state.revision, outcome },
        );
      }
    }
  }

  return { getState: () => state, start, review, previewApply, apply, cancel, dispatch };
}
