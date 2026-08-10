import type {
  CliSetupAction,
  CliSetupCheck,
  CliSetupHarnessId,
  CliSetupPlan,
} from "@station/contracts";
import type { SetupOperation, SetupPlan } from "@station/setup-core";
import type { SetupMessageRef } from "@station/setup-messages";

export type SetupDisplayDetail = {
  readonly label: SetupMessageRef;
  readonly value: string;
};

export type SetupViewCheck = {
  readonly id: string;
  readonly tier: CliSetupCheck["tier"];
  readonly status: CliSetupCheck["status"];
  readonly label: SetupMessageRef;
  readonly explanation: SetupMessageRef;
  readonly details: readonly SetupDisplayDetail[];
};

export type SetupViewAction = {
  readonly id: string;
  readonly operationId?: SetupOperation["id"];
  readonly kind: SetupOperation["kind"] | "mkdir";
  readonly tier: CliSetupAction["tier"];
  readonly selected: boolean;
  readonly status?: CliSetupAction["status"];
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
        readonly id: CliSetupHarnessId;
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

export type SetupViewResult = SetupPlan["result"] & {
  readonly apply: SetupApplyPresentation;
};

export type SetupPresentationHarnessSelection = {
  readonly source: CliSetupPlan["summary"]["selectionSource"];
  readonly requiredHarnessIds: readonly CliSetupHarnessId[];
  readonly defaultHarness?: CliSetupHarnessId;
};

export type ProjectSetupView = {
  readonly generatedAt: string;
  readonly mode: SetupPlan["mode"];
  readonly title: SetupMessageRef;
  readonly selection: {
    readonly source: SetupPresentationHarnessSelection["source"];
    readonly summary: SetupMessageRef;
    readonly defaultHarness?: CliSetupHarnessId;
  };
  readonly checks: readonly SetupViewCheck[];
  readonly actions: readonly SetupViewAction[];
  readonly result: SetupViewResult;
  readonly configPath: string;
  readonly recovery: readonly SetupRecoveryInstruction[];
};
