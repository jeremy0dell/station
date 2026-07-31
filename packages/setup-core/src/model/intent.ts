import type { SupportedHarnessId } from "./facts.js";

export type HarnessSelectionIntent =
  | { readonly kind: "automatic" }
  | {
      readonly kind: "explicit";
      readonly harnessIds: readonly SupportedHarnessId[];
    }
  | { readonly kind: "cancelled" };

export type SetupPlanningIntent = {
  readonly mode: "check" | "plan" | "apply";
  readonly harnessSelection: HarnessSelectionIntent;
  readonly installWorktrunkHooks: boolean;
};
