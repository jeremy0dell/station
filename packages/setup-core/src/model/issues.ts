import type { SetupToolId, SupportedHarnessId } from "./facts.js";

export type SetupRecommendationCategory =
  | "socket-evidence"
  | "config-diagnostics"
  | "launcher-path"
  | "station-ui"
  | "worktrunk-automation"
  | "worktrunk-shell"
  | "tmux-popup"
  | "worktrunk-hooks"
  | "harness-tracking"
  | "doctor";

export type SetupIssue =
  | { readonly code: "state-directory-unwritable"; readonly tier: "required" }
  | { readonly code: "socket-evidence-unavailable"; readonly tier: "recommended" }
  | { readonly code: "xcode-tools-missing"; readonly tier: "required" }
  | {
      readonly code: "tool-missing";
      readonly tier: "required" | "recommended";
      readonly tool: SetupToolId;
    }
  | {
      readonly code: "git-unavailable";
      readonly tier: "required";
      readonly reason: "git-absent" | "git-unusable" | "repository-unusable" | "dubious-ownership";
    }
  | {
      readonly code: "harness-selection-invalid";
      readonly tier: "required";
      readonly reason:
        | "empty-explicit-selection"
        | "no-available-harness"
        | "invalid-config"
        | "unsupported-configured-default"
        | "cancelled";
    }
  | {
      readonly code: "harness-selection-ambiguous";
      readonly tier: "required";
      readonly candidateHarnessIds: readonly SupportedHarnessId[];
    }
  | {
      readonly code: "config-unready";
      readonly tier: "required";
      readonly state: "missing" | "invalid" | "write-blocked";
    }
  | {
      readonly code: "config-diagnostic";
      readonly tier: "recommended";
      readonly diagnosticCode: string;
      readonly severity: "warn" | "error";
    }
  | {
      readonly code: "launcher-unready";
      readonly tier: "recommended";
      readonly launcher: "station" | "ingress" | "tmux-popup";
      readonly state: "missing" | "checkout" | "installed";
    }
  | { readonly code: "station-ui-missing"; readonly tier: "required" }
  | {
      readonly code: "worktrunk-automation-unready";
      readonly tier: "recommended";
      readonly state: "warning" | "skipped";
    }
  | { readonly code: "worktrunk-shell-missing"; readonly tier: "recommended" }
  | {
      readonly code: "tmux-popup-unready";
      readonly tier: "recommended";
      readonly scope: "persisted" | "live";
      readonly state: "missing" | "conflict" | "unknown";
    }
  | { readonly code: "worktrunk-hooks-missing"; readonly tier: "recommended" }
  | {
      readonly code: "harness-tracking-unprepared";
      readonly tier: "required" | "recommended";
      readonly harnessId: SupportedHarnessId;
      readonly state: "probe-failed" | "disabled" | "artifact-missing-or-drifted";
    };
