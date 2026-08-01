import type { SafeError } from "@station/contracts";
import type { SetupAction } from "./model.js";
import type { ProjectSetupView } from "./presentation/projectSetupView.js";
import { createTextSetupPresenter, formatSetupCommand } from "./presenters/text.js";
import type { SetupRenderOptions } from "./theme.js";

export function renderSetupPlan(view: ProjectSetupView, options: SetupRenderOptions = {}): string {
  return createTextSetupPresenter(options).renderPlan(view);
}

export function renderSetupApplyResult(
  view: ProjectSetupView,
  options: SetupRenderOptions & { selectionRequired?: boolean } = {},
): string {
  return createTextSetupPresenter(options).renderApplyResult(view);
}

export const formatCommand = formatSetupCommand;

export function renderBoundActionStart(
  action: SetupAction,
  options: SetupRenderOptions = {},
): string {
  return createTextSetupPresenter(options).renderProgressStart(action);
}

export function renderActionStart(action: SetupAction, options: SetupRenderOptions = {}): string {
  return createTextSetupPresenter(options).renderProgressStart(action);
}

export function renderActionComplete(
  action: SetupAction,
  options: SetupRenderOptions = {},
): string {
  return createTextSetupPresenter(options).renderProgressComplete(action);
}

export function renderActionFailed(
  action: SetupAction,
  options: SetupRenderOptions = {},
  error?: SafeError,
): string {
  return createTextSetupPresenter(options).renderProgressFailure(action, error);
}
