import type { SetupPlan as CoreSetupPlan, SetupOperation } from "@station/setup-core";
import type { SetupMessageRef } from "@station/setup-messages";
import type { SetupHarnessSelection } from "../harnessSelection.js";
import type { SetupAction, SetupCheck, SetupMode, SupportedHarnessId } from "../model.js";

export type SetupDisplayDetail = {
  readonly label: SetupMessageRef;
  readonly value: string;
};

export type SetupViewCheck = {
  readonly id: string;
  readonly tier: SetupCheck["tier"];
  readonly status: SetupCheck["status"];
  readonly label: SetupMessageRef;
  readonly explanation: SetupMessageRef;
  readonly details: readonly SetupDisplayDetail[];
};

export type SetupViewAction = {
  readonly id: string;
  readonly operationId?: SetupOperation["id"];
  readonly kind: SetupOperation["kind"] | "mkdir";
  readonly tier: SetupAction["tier"];
  readonly selected: boolean;
  readonly status?: SetupAction["status"];
  readonly label: SetupMessageRef;
  readonly explanation: SetupMessageRef;
};

export type SetupRecoveryInstruction =
  | { readonly kind: "command"; readonly command: readonly string[] }
  | {
      readonly kind: "instruction";
      readonly message: SetupMessageRef;
      readonly command?: readonly string[];
    };

export type SetupViewLauncherWarning = {
  readonly check: SetupViewCheck;
  readonly stationExecutable: string;
  readonly pathDirectory?: string;
  readonly linkAction?: SetupViewAction;
  readonly linkCommand?: readonly string[];
};

export type SetupApplyPresentation =
  | {
      readonly kind: "complete";
      readonly preparedHarnesses: readonly {
        readonly id: SupportedHarnessId;
        readonly label: string;
      }[];
      readonly showCodexReview: boolean;
      readonly launcherWarning?: SetupViewLauncherWarning;
      readonly nextCommands: readonly (readonly string[])[];
    }
  | {
      readonly kind: "blocked";
      readonly title: SetupMessageRef;
      readonly detail: SetupMessageRef;
      readonly commands: readonly (readonly string[])[];
    }
  | { readonly kind: "message"; readonly message: SetupMessageRef }
  | { readonly kind: "config-write-failed"; readonly message: SetupMessageRef };

export type SetupViewResult = CoreSetupPlan["result"] & {
  readonly apply: SetupApplyPresentation;
};

export type ProjectSetupView = {
  readonly generatedAt: string;
  readonly mode: SetupMode;
  readonly title: SetupMessageRef;
  readonly selection: {
    readonly source: SetupHarnessSelection["source"];
    readonly summary: SetupMessageRef;
    readonly defaultHarness?: SupportedHarnessId;
  };
  readonly checks: readonly SetupViewCheck[];
  readonly actions: readonly SetupViewAction[];
  readonly result: SetupViewResult;
  readonly configPath: string;
  readonly recovery: readonly SetupRecoveryInstruction[];
};
