import type { SupportedHarnessId } from "./facts.js";

export type HarnessSelectionIntent =
  | { readonly kind: "automatic" }
  | {
      readonly kind: "explicit";
      readonly harnessIds: readonly SupportedHarnessId[];
    }
  | { readonly kind: "cancelled" };
