import type { SetupMode } from "./adapters/inspectionTypes.js";
import { createJsonSetupPresenter, type JsonSetupPresenter } from "./presenters/json.js";
import { type CliSetupSession, createCliSetupSession } from "./session/createCliSetupSession.js";
import type { SetupCommandDeps, SetupCommandOptions } from "./types.js";

export type SetupComposition = {
  readonly session: CliSetupSession;
  readonly json: JsonSetupPresenter;
};

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
 * Wires one CLI invocation's inspection adapter, semantic operation executor, session application, and JSON presenter.
 */
export function createSetupComposition(options: CreateSetupCompositionOptions): SetupComposition {
  return {
    session: createCliSetupSession(options),
    json: createJsonSetupPresenter(),
  };
}
