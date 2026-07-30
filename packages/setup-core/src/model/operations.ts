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
    };
