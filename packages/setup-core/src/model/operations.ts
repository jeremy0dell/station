import type { SetupToolId, SupportedHarnessId } from "./facts.js";

export type SetupOperation =
  | {
      readonly id: `install:${SetupToolId}`;
      readonly kind: "install-tool";
      readonly tier: "required" | "recommended";
      readonly selected: boolean;
      readonly tool: SetupToolId;
    }
  | {
      readonly id: `install-harness:${SupportedHarnessId}`;
      readonly kind: "install-harness";
      readonly tier: "required";
      readonly selected: boolean;
      readonly harnessId: SupportedHarnessId;
    }
  | {
      readonly id: "install:homebrew";
      readonly kind: "install-homebrew";
      readonly tier: "required";
      readonly selected: boolean;
    }
  | {
      readonly id: "install:xcode-command-line-tools";
      readonly kind: "install-xcode-command-line-tools";
      readonly tier: "required";
      readonly selected: boolean;
    }
  | {
      readonly id: "link-station-launchers";
      readonly kind: "link-launchers";
      readonly tier: "recommended";
      readonly selected: false;
    }
  | {
      readonly id: "configure-worktrunk-shell";
      readonly kind: "configure-worktrunk-shell";
      readonly tier: "recommended";
      readonly selected: false;
    }
  | {
      readonly id: "persist-tmux-popup" | "load-tmux-popup";
      readonly kind: "configure-tmux-popup";
      readonly tier: "recommended";
      readonly selected: false;
      readonly scope: "persisted" | "live";
    }
  | {
      readonly id: "prepare-worktrunk-tracking";
      readonly kind: "prepare-worktrunk-tracking";
      readonly tier: "recommended";
      readonly selected: boolean;
    }
  | {
      readonly id: `prepare-harness-tracking:${SupportedHarnessId}`;
      readonly kind: "prepare-harness-tracking";
      readonly tier: "required" | "recommended";
      readonly selected: true;
      readonly harnessId: SupportedHarnessId;
    }
  | {
      readonly id: "write-config";
      readonly kind: "write-config";
      readonly tier: "required";
      readonly selected: true;
      readonly change: "create" | "update";
      readonly defaultHarnessId: SupportedHarnessId;
      readonly harnessIds: readonly SupportedHarnessId[];
      readonly trackingHarnessIds: readonly SupportedHarnessId[];
      readonly installWorktrunkTracking: boolean;
    }
  | {
      readonly id: "activate-observer-config";
      readonly kind: "activate-observer-config";
      readonly tier: "required";
      readonly selected: true;
    };
