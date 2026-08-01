import type { CliSetupPlan } from "@station/contracts";
import { createJsonSetupPresenter, type JsonSetupPresenterInput } from "../presenters/json.js";

export type ProjectCliSetupPlanInput = JsonSetupPresenterInput;

/**
 * Compatibility bridge retained for the guided setup path until the legacy projector is removed.
 */
export function projectCliSetupPlan(input: ProjectCliSetupPlanInput): CliSetupPlan {
  return createJsonSetupPresenter().project(input);
}
