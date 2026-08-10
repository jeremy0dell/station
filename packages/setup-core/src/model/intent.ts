import type { CliSetupHarnessId } from "@station/contracts";

export type HarnessSelectionIntent =
  | { readonly kind: "automatic" }
  | {
      readonly kind: "explicit";
      readonly harnessIds: readonly CliSetupHarnessId[];
    }
  | { readonly kind: "cancelled" };

export type HarnessTrackingSelectionIntent =
  | { readonly kind: "automatic" }
  | {
      readonly kind: "explicit";
      readonly harnessIds: readonly CliSetupHarnessId[];
    };

export type SetupPlanningIntent = {
  readonly mode: "check" | "plan" | "apply";
  readonly harnessSelection: HarnessSelectionIntent;
  readonly installBootstrap: boolean;
  readonly installHarnesses: readonly CliSetupHarnessId[];
  readonly linkStationLaunchers: boolean;
  readonly harnessTrackingSelection: HarnessTrackingSelectionIntent;
  readonly installWorktrunkHooks: boolean;
  readonly installWorktrunkShell: boolean;
  readonly configureTmuxPopup: boolean;
};

/** Complete desired setup state whose invocation mode remains fixed for the session lifetime. */
export type SetupEditableIntent = Omit<SetupPlanningIntent, "mode">;
