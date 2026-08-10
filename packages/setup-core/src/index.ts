export { performSetupOperation } from "./execution/performOperation.js";
export type {
  HarnessSelectionFacts,
  HarnessSelectionResolution,
  HarnessTrackingAssessment,
  HarnessTrackingFacts,
  SetupPlanningFacts,
} from "./model/facts.js";
export type { SetupEditableIntent, SetupPlanningIntent } from "./model/intent.js";
export type {
  SetupConfigWriteOperation,
  SetupHarnessInstallOperation,
  SetupOperation,
  SetupOperationCommit,
  SetupOperationOutcome,
  SetupPackageInstallerCommit,
  SetupPackageInstallOperation,
  SetupTmuxPopupOperation,
  SetupToolInstallOperation,
  SetupWorktrunkTrackingOperation,
} from "./model/operations.js";
export type { SetupPlan } from "./model/plan.js";
export type {
  SetupSessionBlockedState,
  SetupSessionFailedOperationOutcome,
  SetupSessionOperationOutcome,
  SetupSessionResult,
  SetupSessionState,
  SetupSessionStatus,
} from "./model/session.js";
export { assessHarnessTracking } from "./policy/assessHarnessTracking.js";
export { assessSetupPlan } from "./policy/assessSetupPlan.js";
export { planSetup } from "./policy/planSetup.js";
export { resolveHarnessSelection } from "./policy/resolveHarnessSelection.js";
export type {
  SetupConfigMutationPort,
  SetupHarnessTrackingPort,
  SetupInspection,
  SetupObserverActivationPort,
  SetupOperationExecutor,
  SetupOperationPorts,
  SetupOperationProgress,
  SetupPackageInstallationPort,
} from "./ports.js";
export {
  createSetupSessionApplication,
  type SetupSessionApplication,
} from "./session/application.js";
export {
  emptySetupOperationCheckpoints,
  hasCompletedSetupOperation,
  recordCompletedSetupOperation,
} from "./session/checkpoints.js";
export { createSetupSessionState, transitionSetupSession } from "./session/transition.js";
