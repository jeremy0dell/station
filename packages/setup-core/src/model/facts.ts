export const supportedHarnessIds = ["codex", "cursor", "opencode", "pi", "claude"] as const;

export type SupportedHarnessId = (typeof supportedHarnessIds)[number];

export type HarnessSelectionFacts = {
  readonly config:
    | { readonly status: "missing" }
    | { readonly status: "invalid" }
    | { readonly status: "valid"; readonly defaultHarness: string };
  readonly harnesses: readonly {
    readonly id: SupportedHarnessId;
    readonly availability: "available" | "unavailable";
  }[];
};

export type HarnessSelectionResolution =
  | {
      readonly outcome: "selected";
      readonly source: "configured" | "explicit" | "inferred";
      readonly requiredHarnessIds: readonly SupportedHarnessId[];
      readonly defaultHarness: SupportedHarnessId;
    }
  | {
      readonly outcome: "invalid";
      readonly reason:
        | "empty-explicit-selection"
        | "no-available-harness"
        | "invalid-config"
        | "unsupported-configured-default";
    }
  | {
      readonly outcome: "ambiguous";
      readonly candidateHarnessIds: readonly SupportedHarnessId[];
    }
  | { readonly outcome: "cancelled" };

export type HarnessTrackingFacts = {
  readonly capability: "supported" | "unsupported";
  readonly configRequested: boolean;
  readonly evidence:
    | { readonly availability: "unavailable" }
    | {
        readonly availability: "available";
        readonly requested?: boolean;
        readonly installed?: boolean;
        readonly probeFailed: boolean;
      };
};

export type HarnessTrackingAssessment =
  | { readonly state: "not-applicable" }
  | {
      readonly state: "probe-failed" | "disabled" | "artifact-missing-or-drifted";
      readonly requested?: boolean;
      readonly installed?: boolean;
    }
  | {
      readonly state: "prepared";
      readonly requested: true;
      readonly installed: true;
    };

export type SetupReadiness = {
  readonly launchReady: boolean;
  readonly workflowReady: boolean;
  readonly requiredMissing: number;
};

export type SetupToolId = "worktrunk" | "tmux" | "bun" | "diff-viewer";

export type SetupPlanningFacts = {
  readonly generatedAt: string;
  readonly compiled: boolean;
  readonly stateDirectoryWritable: boolean;
  readonly socketEvidenceAvailable: boolean;
  readonly xcodeTools: "available" | "missing" | "not-applicable";
  readonly homebrew: "available" | "missing" | "skipped";
  readonly tools: readonly {
    readonly id: SetupToolId;
    readonly available: boolean;
    readonly installerAvailable: boolean;
  }[];
  readonly runtimeUi: "available" | "missing" | "not-applicable";
  readonly git:
    | { readonly state: "usable"; readonly repository: "present" | "absent" }
    | {
        readonly state: "unusable";
        readonly reason:
          | "git-absent"
          | "git-unusable"
          | "repository-unusable"
          | "dubious-ownership";
      };
  readonly harnessSelection: HarnessSelectionFacts;
  readonly installableHarnessIds: readonly SupportedHarnessId[];
  readonly config: {
    readonly state: "missing" | "valid" | "invalid";
    readonly write: "none" | "create" | "update" | "blocked";
    readonly diagnostics: readonly {
      readonly code: string;
      readonly severity: "warn" | "error";
    }[];
  };
  readonly launchers: {
    readonly station: "available" | "missing" | "checkout" | "installed";
    readonly ingress: "available" | "missing" | "checkout" | "installed";
    readonly tmuxPopup: "available" | "missing" | "checkout" | "installed";
  };
  readonly worktrunkAutomation: "ready" | "warning" | "skipped";
  readonly worktrunkShell: "ready" | "missing" | "skipped";
  readonly tmuxPopup: {
    readonly persisted: "ready" | "missing" | "conflict";
    readonly live: "ready" | "missing" | "not-applicable" | "unknown";
  };
  readonly worktrunkHooks: "ready" | "missing" | "not-applicable";
  readonly harnessTracking: readonly {
    readonly harnessId: SupportedHarnessId;
    readonly assessment: HarnessTrackingAssessment;
    readonly required: boolean;
    readonly persistedIntent: boolean;
  }[];
};
