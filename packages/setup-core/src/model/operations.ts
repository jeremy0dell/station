import type { SafeError } from "@station/contracts";
import type { SetupToolId, SupportedHarnessId } from "./facts.js";

type SetupOperationBase<
  Id extends string,
  Kind extends string,
  Tier extends "required" | "recommended",
  Selected extends boolean,
> = {
  readonly id: Id;
  readonly kind: Kind;
  readonly tier: Tier;
  readonly selected: Selected;
};

export type SetupToolInstallOperation = SetupOperationBase<
  `install:${SetupToolId}`,
  "install-tool",
  "required" | "recommended",
  boolean
> & {
  readonly tool: SetupToolId;
};

export type SetupHarnessInstallOperation = SetupOperationBase<
  `install-harness:${SupportedHarnessId}`,
  "install-harness",
  "required",
  boolean
> & {
  readonly harnessId: SupportedHarnessId;
};

export type SetupHomebrewInstallOperation = SetupOperationBase<
  "install:homebrew",
  "install-homebrew",
  "required",
  boolean
>;

export type SetupXcodeToolsInstallOperation = SetupOperationBase<
  "install:xcode-command-line-tools",
  "install-xcode-command-line-tools",
  "required",
  boolean
>;

export type SetupLauncherLinkOperation = SetupOperationBase<
  "link-station-launchers",
  "link-launchers",
  "recommended",
  boolean
>;

export type SetupWorktrunkShellOperation = SetupOperationBase<
  "configure-worktrunk-shell",
  "configure-worktrunk-shell",
  "recommended",
  boolean
>;

export type SetupTmuxPopupOperation = SetupOperationBase<
  "persist-tmux-popup" | "load-tmux-popup",
  "configure-tmux-popup",
  "recommended",
  boolean
> & {
  readonly scope: "persisted" | "live";
};

export type SetupWorktrunkTrackingOperation = SetupOperationBase<
  "prepare-worktrunk-tracking",
  "prepare-worktrunk-tracking",
  "recommended",
  boolean
>;

export type SetupHarnessTrackingOperation = SetupOperationBase<
  `prepare-harness-tracking:${SupportedHarnessId}`,
  "prepare-harness-tracking",
  "required" | "recommended",
  boolean
> & {
  readonly harnessId: SupportedHarnessId;
};

export type SetupConfigWriteOperation = SetupOperationBase<
  "write-config",
  "write-config",
  "required",
  true
> & {
  readonly change: "create" | "update";
  readonly defaultHarnessId: SupportedHarnessId;
  readonly harnessIds: readonly SupportedHarnessId[];
  readonly trackingHarnessIds: readonly SupportedHarnessId[];
  readonly installWorktrunkTracking: boolean;
};

export type SetupObserverActivationOperation = SetupOperationBase<
  "activate-observer-config",
  "activate-observer-config",
  "required",
  true
>;

export type SetupPackageInstallOperation =
  | SetupToolInstallOperation
  | SetupHarnessInstallOperation
  | SetupHomebrewInstallOperation
  | SetupXcodeToolsInstallOperation;

export type SetupWorktrunkIntegrationOperation =
  | SetupWorktrunkShellOperation
  | SetupWorktrunkTrackingOperation;

/** A semantic setup mutation selected by policy and assigned a stable invocation-local identity. */
export type SetupOperation =
  | SetupPackageInstallOperation
  | SetupLauncherLinkOperation
  | SetupWorktrunkIntegrationOperation
  | SetupTmuxPopupOperation
  | SetupHarnessTrackingOperation
  | SetupConfigWriteOperation
  | SetupObserverActivationOperation;

export type SetupToolPackageTarget = {
  readonly kind: "tool";
  readonly id: SetupToolId;
};

export type SetupHarnessPackageTarget = {
  readonly kind: "harness";
  readonly id: SupportedHarnessId;
};

export type SetupBootstrapPackageTarget = {
  readonly kind: "bootstrap";
  readonly id: "homebrew" | "xcode-command-line-tools";
};

/** Identifies the tool, harness, or bootstrap dependency changed by a package installer. */
export type SetupPackageTarget =
  | SetupToolPackageTarget
  | SetupHarnessPackageTarget
  | SetupBootstrapPackageTarget;

export type SetupConfigCommit = {
  readonly kind: "config";
  readonly configPath: string;
  readonly change: "created" | "updated" | "unchanged";
  readonly backupPath?: string;
};

export type SetupObserverActivationCommit = {
  readonly kind: "observer-activation";
  readonly configPath: string;
};

export type SetupPackageInstallerCommit = {
  readonly kind: "package-installer";
  readonly target: SetupPackageTarget;
};

export type SetupProviderTrackingCommit = {
  readonly kind: "provider-tracking";
  readonly provider: "worktrunk" | SupportedHarnessId;
  readonly changed: boolean;
  readonly backupPaths?: readonly string[];
};

export type SetupLauncherLinkCommit = {
  readonly kind: "launcher-link";
};

export type SetupWorktrunkShellCommit = {
  readonly kind: "worktrunk-shell";
};

export type SetupTmuxPopupCommit = {
  readonly kind: "tmux-popup";
  readonly scope: "persisted" | "live";
  readonly changed: boolean;
  readonly backupPath?: string;
};

/** Typed evidence emitted after a setup operation commits its outward mutation. */
export type SetupOperationCommit =
  | SetupConfigCommit
  | SetupObserverActivationCommit
  | SetupPackageInstallerCommit
  | SetupProviderTrackingCommit
  | SetupLauncherLinkCommit
  | SetupWorktrunkShellCommit
  | SetupTmuxPopupCommit;

export type SetupOperationCompletedOutcome = {
  readonly status: "completed";
  readonly operationId: SetupOperation["id"];
  readonly commit: SetupOperationCommit;
};

export type SetupOperationFailedOutcome = {
  readonly status: "failed";
  readonly operationId: SetupOperation["id"];
  readonly error: SafeError;
};

/** Boundary result for one requested semantic operation, correlated by operation identity. */
export type SetupOperationOutcome = SetupOperationCompletedOutcome | SetupOperationFailedOutcome;
