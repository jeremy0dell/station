import type { SafeError } from "@station/contracts";
import type { SetupToolId, SupportedHarnessId } from "./model/facts.js";
import type { SetupOperation } from "./model/operations.js";

export type SetupPackageTarget =
  | { readonly kind: "tool"; readonly id: SetupToolId }
  | { readonly kind: "harness"; readonly id: SupportedHarnessId }
  | {
      readonly kind: "bootstrap";
      readonly id: "homebrew" | "xcode-command-line-tools";
    };

export type SetupOperationCommit =
  | {
      readonly kind: "config";
      readonly configPath: string;
      readonly change: "created" | "updated" | "unchanged";
      readonly backupPath?: string;
    }
  | {
      readonly kind: "observer-activation";
      readonly configPath: string;
    }
  | {
      readonly kind: "package-installer";
      readonly target: SetupPackageTarget;
    }
  | {
      readonly kind: "provider-tracking";
      readonly provider: "worktrunk" | SupportedHarnessId;
      readonly changed: boolean;
      readonly backupPaths?: readonly string[];
    }
  | { readonly kind: "launcher-link" }
  | { readonly kind: "worktrunk-shell" }
  | {
      readonly kind: "tmux-popup";
      readonly scope: "persisted" | "live";
      readonly changed: boolean;
    };

export type SetupOperationOutcome =
  | {
      readonly status: "completed";
      readonly operationId: SetupOperation["id"];
      readonly commit: SetupOperationCommit;
    }
  | {
      readonly status: "failed";
      readonly operationId: SetupOperation["id"];
      readonly error: SafeError;
    };

/**
 * DRIVEN PORT
 *
 * Commits the desired Station setup configuration without exposing its representation to setup policy.
 */
export type SetupConfigMutationPort = (
  operation: Extract<SetupOperation, { kind: "write-config" }>,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Activates a committed setup configuration and confirms Observer health.
 */
export type SetupObserverActivationPort = (
  operation: Extract<SetupOperation, { kind: "activate-observer-config" }>,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Prepares one selected harness's Station-owned tracking artifacts.
 */
export type SetupHarnessTrackingPort = (
  operation: Extract<SetupOperation, { kind: "prepare-harness-tracking" }>,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Applies Worktrunk tracking or shell integration requested by setup.
 */
export type SetupWorktrunkIntegrationPort = (
  operation: Extract<
    SetupOperation,
    { kind: "prepare-worktrunk-tracking" | "configure-worktrunk-shell" }
  >,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Persists or live-loads the selected tmux popup configuration.
 */
export type SetupTmuxConfigurationPort = (
  operation: Extract<SetupOperation, { kind: "configure-tmux-popup" }>,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Runs the installer selected for a setup package target.
 */
export type SetupPackageInstallationPort = (
  operation: Extract<
    SetupOperation,
    {
      kind:
        | "install-tool"
        | "install-harness"
        | "install-homebrew"
        | "install-xcode-command-line-tools";
    }
  >,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Links the Station launchers required for bare terminal commands.
 */
export type SetupLauncherLinkPort = (
  operation: Extract<SetupOperation, { kind: "link-launchers" }>,
) => Promise<SetupOperationOutcome>;

/**
 * DRIVEN PORT
 *
 * Executes one semantic setup operation through its assigned outward capability.
 */
export type SetupOperationExecutor = (operation: SetupOperation) => Promise<SetupOperationOutcome>;

export type SetupOperationPorts = {
  readonly config: SetupConfigMutationPort;
  readonly observer: SetupObserverActivationPort;
  readonly harnessTracking: SetupHarnessTrackingPort;
  readonly worktrunk: SetupWorktrunkIntegrationPort;
  readonly tmux: SetupTmuxConfigurationPort;
  readonly packages: SetupPackageInstallationPort;
  readonly launchers: SetupLauncherLinkPort;
};
