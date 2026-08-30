import type { CliSetupHarnessId } from "@station/contracts";
import type { SetupToolId } from "./facts.js";

type SetupIssueBase<Code extends string, Tier extends "required" | "recommended"> = {
  readonly code: Code;
  readonly tier: Tier;
};

export type SetupStateDirectoryUnwritableIssue = SetupIssueBase<
  "state-directory-unwritable",
  "required"
>;

export type SetupSocketEvidenceUnavailableIssue = SetupIssueBase<
  "socket-evidence-unavailable",
  "recommended"
>;

export type SetupXcodeToolsMissingIssue = SetupIssueBase<"xcode-tools-missing", "required">;

export type SetupToolMissingIssue = SetupIssueBase<"tool-missing", "required" | "recommended"> & {
  readonly tool: SetupToolId;
};

export type SetupGitUnavailableIssue = SetupIssueBase<"git-unavailable", "required"> & {
  readonly reason: "git-absent" | "git-unusable" | "repository-unusable" | "dubious-ownership";
};

export type SetupHarnessSelectionInvalidIssue = SetupIssueBase<
  "harness-selection-invalid",
  "required"
> & {
  readonly reason:
    | "empty-explicit-selection"
    | "no-available-harness"
    | "invalid-config"
    | "unsupported-configured-default"
    | "cancelled";
};

export type SetupHarnessSelectionAmbiguousIssue = SetupIssueBase<
  "harness-selection-ambiguous",
  "required"
> & {
  readonly candidateHarnessIds: readonly CliSetupHarnessId[];
};

export type SetupConfigUnreadyIssue = SetupIssueBase<"config-unready", "required"> & {
  readonly state: "missing" | "invalid" | "write-blocked";
};

export type SetupConfigDiagnosticIssue = SetupIssueBase<"config-diagnostic", "recommended"> & {
  readonly diagnosticCode: string;
  readonly severity: "warn" | "error";
};

export type SetupLauncherUnreadyIssue = SetupIssueBase<"launcher-unready", "recommended"> & {
  readonly launcher: "station" | "ingress" | "tmux-popup";
  readonly state: "missing" | "checkout" | "installed";
};

export type SetupStationUiMissingIssue = SetupIssueBase<"station-ui-missing", "required">;

export type SetupWorktrunkAutomationUnreadyIssue = SetupIssueBase<
  "worktrunk-automation-unready",
  "recommended"
> & {
  readonly state: "warn" | "skipped";
};

export type SetupWorktrunkShellMissingIssue = SetupIssueBase<
  "worktrunk-shell-missing",
  "recommended"
>;

export type SetupTmuxPopupUnreadyIssue = SetupIssueBase<"tmux-popup-unready", "recommended"> & {
  readonly scope: "persisted" | "live";
  readonly state: "missing" | "conflict" | "unknown";
};

export type SetupWorktrunkHooksMissingIssue = SetupIssueBase<
  "worktrunk-hooks-missing",
  "recommended"
>;

export type SetupHarnessTrackingUnpreparedIssue = SetupIssueBase<
  "harness-tracking-unprepared",
  "required" | "recommended"
> & {
  readonly harnessId: CliSetupHarnessId;
  readonly state: "probe-failed" | "disabled" | "artifact-missing-or-drifted";
};

/** A semantic setup problem derived from normalized planning evidence. */
export type SetupIssue =
  | SetupStateDirectoryUnwritableIssue
  | SetupSocketEvidenceUnavailableIssue
  | SetupXcodeToolsMissingIssue
  | SetupToolMissingIssue
  | SetupGitUnavailableIssue
  | SetupHarnessSelectionInvalidIssue
  | SetupHarnessSelectionAmbiguousIssue
  | SetupConfigUnreadyIssue
  | SetupConfigDiagnosticIssue
  | SetupLauncherUnreadyIssue
  | SetupStationUiMissingIssue
  | SetupWorktrunkAutomationUnreadyIssue
  | SetupWorktrunkShellMissingIssue
  | SetupTmuxPopupUnreadyIssue
  | SetupWorktrunkHooksMissingIssue
  | SetupHarnessTrackingUnpreparedIssue;
