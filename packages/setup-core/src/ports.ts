import type { SafeError } from "@station/contracts";
import type { SetupPlanningFacts } from "./model/facts.js";
import type {
  SetupConfigWriteOperation,
  SetupHarnessTrackingOperation,
  SetupLauncherLinkOperation,
  SetupObserverActivationOperation,
  SetupOperation,
  SetupOperationOutcome,
  SetupPackageInstallOperation,
  SetupTmuxPopupOperation,
  SetupWorktrunkIntegrationOperation,
} from "./model/operations.js";
import type { SetupSessionInspectionPhase } from "./model/session.js";

export type {
  SetupOperationCommit,
  SetupOperationOutcome,
  SetupPackageTarget,
} from "./model/operations.js";

/** Requests normalized evidence for one revision and lifecycle inspection point. */
export type SetupInspectionRequest = {
  readonly phase: SetupSessionInspectionPhase;
  readonly revision: number;
};

/** Typed inspection result that keeps boundary failures available to the driving adapter. */
export type SetupInspectionOutcome =
  | { readonly status: "completed"; readonly facts: SetupPlanningFacts }
  | { readonly status: "failed"; readonly error: SafeError };

/**
 * DRIVEN PORT
 *
 * Reads and normalizes current setup evidence while keeping filesystem, TOML, and provider representations outside core.
 */
export type SetupInspection = (request: SetupInspectionRequest) => Promise<SetupInspectionOutcome>;

/**
 * DRIVEN PORT
 *
 * Commits the desired Station setup configuration without exposing its representation to setup policy.
 */
export type SetupConfigMutationPort = (
  operation: SetupConfigWriteOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Activates a committed setup configuration and confirms Observer health.
 */
export type SetupObserverActivationPort = (
  operation: SetupObserverActivationOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Prepares one selected harness's Station-owned tracking artifacts.
 */
export type SetupHarnessTrackingPort = (
  operation: SetupHarnessTrackingOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Applies Worktrunk tracking or shell integration requested by setup.
 */
export type SetupWorktrunkIntegrationPort = (
  operation: SetupWorktrunkIntegrationOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Persists or live-loads the selected tmux popup configuration.
 */
export type SetupTmuxConfigurationPort = (
  operation: SetupTmuxPopupOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Runs the installer selected for a setup package target.
 */
export type SetupPackageInstallationPort = (
  operation: SetupPackageInstallOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Links the Station launchers required for bare terminal commands.
 */
export type SetupLauncherLinkPort = (
  operation: SetupLauncherLinkOperation,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Executes one semantic setup operation through its assigned outward capability.
 */
export type SetupOperationExecutor = (operation: SetupOperation) => Promise<SetupOperationOutcome>;

/** Outward capabilities used by the operation dispatcher, grouped for adapter composition. */
export type SetupOperationPorts = {
  readonly config: SetupConfigMutationPort;
  readonly observer: SetupObserverActivationPort;
  readonly harnessTracking: SetupHarnessTrackingPort;
  readonly worktrunk: SetupWorktrunkIntegrationPort;
  readonly tmux: SetupTmuxConfigurationPort;
  readonly packages: SetupPackageInstallationPort;
  readonly launchers: SetupLauncherLinkPort;
};
