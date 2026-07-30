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
export type { SetupOperation } from "./model/operations.js";
export type { SetupPlan } from "./model/plan.js";
export type { SetupResult } from "./model/result.js";
export { assessHarnessTracking } from "./policy/assessHarnessTracking.js";
export { deriveSetupReadiness } from "./policy/deriveReadiness.js";
export { type DeriveSetupResultInput, deriveSetupResult } from "./policy/deriveSetupResult.js";
export { planSetup } from "./policy/planSetup.js";
export { resolveHarnessSelection } from "./policy/resolveHarnessSelection.js";
export { selectHarnessTrackingRepairTargets } from "./policy/selectRepairTargets.js";
export type {
  SetupConfigMutationPort,
  SetupHarnessTrackingPort,
  SetupLauncherLinkPort,
  SetupObserverActivationPort,
  SetupOperationCommit,
  SetupOperationExecutor,
  SetupOperationOutcome,
  SetupOperationPorts,
  SetupPackageInstallationPort,
  SetupPackageTarget,
  SetupTmuxConfigurationPort,
  SetupWorktrunkIntegrationPort,
} from "./ports.js";
