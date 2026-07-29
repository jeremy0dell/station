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

export type HarnessTrackingRepairFact = {
  readonly id: SupportedHarnessId;
  readonly available: boolean;
  readonly capability: "supported" | "unsupported";
  readonly prepared: boolean;
};

export type SetupReadinessFacts = {
  readonly stateDirectoryWritable: boolean;
  readonly runtime:
    | { readonly kind: "compiled" }
    | {
        readonly kind: "source";
        readonly bunAvailable: boolean;
        readonly stationUiUsable: boolean;
      };
  readonly requirements: readonly ("satisfied" | "unsatisfied")[];
};

export type SetupReadiness = {
  readonly launchReady: boolean;
  readonly workflowReady: boolean;
  readonly requiredMissing: number;
};
