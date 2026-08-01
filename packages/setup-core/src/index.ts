export { performSetupOperation } from "./execution/performOperation.js";
export {
  type HarnessSelectionFacts,
  type HarnessSelectionResolution,
  type HarnessTrackingAssessment,
  type HarnessTrackingFacts,
  type HarnessTrackingRepairFact,
  type SetupPlanningFacts,
  type SetupReadiness,
  type SetupReadinessFacts,
  type SetupToolId,
  type SupportedHarnessId,
  supportedHarnessIds,
} from "./model/facts.js";
export type { HarnessSelectionIntent, SetupPlanningIntent } from "./model/intent.js";
export type { SetupIssue } from "./model/issues.js";
export type {
  SetupConfigWriteOperation,
  SetupHarnessInstallOperation,
  SetupHomebrewInstallOperation,
  SetupOperation,
  SetupOperationCommit,
  SetupOperationFailedOutcome,
  SetupOperationOutcome,
  SetupPackageInstallerCommit,
  SetupPackageInstallOperation,
  SetupPackageTarget,
  SetupTmuxPopupOperation,
  SetupToolInstallOperation,
  SetupWorktrunkTrackingOperation,
  SetupXcodeToolsInstallOperation,
} from "./model/operations.js";
export type { SetupPlan } from "./model/plan.js";
export type { SetupResult } from "./model/result.js";
export type {
  SetupOperationCheckpoint,
  SetupOperationCheckpoints,
  SetupSessionActiveInspectionPhase,
  SetupSessionApplyPhase,
  SetupSessionBlockedState,
  SetupSessionBlockReason,
  SetupSessionEffect,
  SetupSessionEvent,
  SetupSessionFailedOperationOutcome,
  SetupSessionInspectionPhase,
  SetupSessionOperationOutcome,
  SetupSessionResult,
  SetupSessionState,
  SetupSessionStatus,
  SetupSessionTransition,
} from "./model/session.js";
export { assessHarnessTracking } from "./policy/assessHarnessTracking.js";
export { deriveSetupReadiness } from "./policy/deriveReadiness.js";
export { type DeriveSetupResultInput, deriveSetupResult } from "./policy/deriveSetupResult.js";
export { planSetup } from "./policy/planSetup.js";
export { resolveHarnessSelection } from "./policy/resolveHarnessSelection.js";
export { selectHarnessTrackingRepairTargets } from "./policy/selectRepairTargets.js";
export type {
  SetupConfigMutationPort,
  SetupHarnessTrackingPort,
  SetupInspection,
  SetupInspectionOutcome,
  SetupInspectionRequest,
  SetupLauncherLinkPort,
  SetupObserverActivationPort,
  SetupOperationExecutor,
  SetupOperationPorts,
  SetupPackageInstallationPort,
  SetupTmuxConfigurationPort,
  SetupWorktrunkIntegrationPort,
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
