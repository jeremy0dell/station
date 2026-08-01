import type { SafeError } from "@station/contracts";
import type { SetupToolId, SupportedHarnessId } from "./facts.js";

/** A semantic setup mutation selected by policy and assigned a stable invocation-local identity. */
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

/** Identifies the tool, harness, or bootstrap dependency changed by a package installer. */
export type SetupPackageTarget =
  | { readonly kind: "tool"; readonly id: SetupToolId }
  | { readonly kind: "harness"; readonly id: SupportedHarnessId }
  | {
      readonly kind: "bootstrap";
      readonly id: "homebrew" | "xcode-command-line-tools";
    };

/** Typed evidence emitted after a setup operation commits its outward mutation. */
export type SetupOperationCommit =
  | {
      readonly kind: "config";
      readonly configPath: string;
      readonly change: "created" | "updated" | "unchanged";
      readonly backupPath?: string;
    }
  | {
      readonly kind: "observer-activation";
      readonly configPath: string;
    }
  | {
      readonly kind: "package-installer";
      readonly target: SetupPackageTarget;
    }
  | {
      readonly kind: "provider-tracking";
      readonly provider: "worktrunk" | SupportedHarnessId;
      readonly changed: boolean;
      readonly backupPaths?: readonly string[];
    }
  | { readonly kind: "launcher-link" }
  | { readonly kind: "worktrunk-shell" }
  | {
      readonly kind: "tmux-popup";
      readonly scope: "persisted" | "live";
      readonly changed: boolean;
      readonly backupPath?: string;
    };

/** Boundary result for one requested semantic operation, correlated by operation identity. */
export type SetupOperationOutcome =
  | {
      readonly status: "completed";
      readonly operationId: SetupOperation["id"];
      readonly commit: SetupOperationCommit;
    }
  | {
      readonly status: "failed";
      readonly operationId: SetupOperation["id"];
      readonly error: SafeError;
    };
