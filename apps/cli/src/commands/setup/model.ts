import type { TmuxConfig } from "@station/config";
import {
  type CliSetupAction,
  CliSetupActionSchema,
  type CliSetupCheck,
  CliSetupCheckSchema,
  CliSetupHarnessIdSchema,
  type CliSetupPlan,
  CliSetupPlanSchema,
  CliSetupSummarySchema,
  ProviderHookArtifactOwnershipSchema,
} from "@station/contracts";
import type { SupportedHarnessId } from "@station/setup-core";
import { z } from "zod";

export type { SupportedHarnessId } from "@station/setup-core";
export { supportedHarnessIds } from "@station/setup-core";

export const setupTiers = ["required", "recommended", "optional"] as const;
export const setupStatuses = ["ok", "missing", "warning", "skipped"] as const;
export const setupModes = ["check", "plan", "apply"] as const;
export const setupActionKinds = [
  "brew-install",
  "run-command",
  "write-config",
  "append-file",
  "mkdir",
  "noop",
] as const;
export const setupActionStatuses = ["pending", "completed", "failed", "skipped"] as const;
export const setupHarnessSelectionSources = [
  "configured",
  "explicit",
  "inferred",
  "unresolved",
] as const;

export const SetupTierSchema = z.enum(setupTiers);
export const SetupStatusSchema = z.enum(setupStatuses);
export const SetupModeSchema = z.enum(setupModes);
export const SetupActionKindSchema = z.enum(setupActionKinds);
export const SetupActionStatusSchema = z.enum(setupActionStatuses);
export const SupportedHarnessIdSchema = CliSetupHarnessIdSchema;
export const SetupHarnessSelectionSourceSchema = z.enum(setupHarnessSelectionSources);
export const SetupHarnessTrackingFactSchema = z
  .object({
    harnessId: SupportedHarnessIdSchema,
    capability: z.enum(["supported", "unsupported"]),
    requested: z.boolean().optional(),
    installed: z.boolean().optional(),
    ownership: ProviderHookArtifactOwnershipSchema.optional(),
    detail: z.string().min(1).optional(),
    probeFailed: z.boolean().optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (
      fact.capability === "unsupported" &&
      (fact.requested !== undefined ||
        fact.installed !== undefined ||
        fact.ownership !== undefined ||
        fact.probeFailed !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Unsupported tracking facts cannot include status fields.",
      });
    }
  });

export type SetupTier = z.infer<typeof SetupTierSchema>;
export type SetupMode = z.infer<typeof SetupModeSchema>;
export type SetupHarnessSelectionSource = z.infer<typeof SetupHarnessSelectionSourceSchema>;
export type SetupHarnessTrackingFact = z.infer<typeof SetupHarnessTrackingFactSchema>;

export const SetupCheckSchema = CliSetupCheckSchema;
export const SetupActionSchema = CliSetupActionSchema;
export const SetupSummarySchema = CliSetupSummarySchema;
export const SetupPlanSchema = CliSetupPlanSchema;

export type SetupCheck = CliSetupCheck;
export type SetupAction = CliSetupAction;
export type SetupPlan = CliSetupPlan;

export type SetupDependencyFact = {
  status: "ok" | "missing";
  command: string;
  version?: string;
  rawVersion?: string;
  resolvedPath?: string;
  message?: string;
};

export type SetupWorktrunkAutomationFact = {
  status: "ok" | "warning" | "skipped";
  automationMode: "skip-hooks" | "preapprove-hooks" | "worktrunk-default";
  message: string;
  flag?: "--no-hooks" | "--yes";
  missingSubcommands?: readonly string[];
};

export type SetupWorktrunkShellIntegrationFact = {
  status: "ok" | "warning" | "skipped";
  message: string;
  shell?: "bash" | "zsh";
  rcPath?: string;
};

export type SetupBrewFact = {
  status: "ok" | "missing" | "skipped";
  command: string;
  version?: string;
  message?: string;
};

export type SetupXcodeFact =
  | {
      status: "ok";
      // false on non-macOS hosts, where Command Line Tools do not apply.
      applicable: boolean;
      path?: string;
    }
  | {
      status: "missing";
      applicable: true;
      message: string;
    };

type SetupGitRepositoryFact = {
  status: "ok";
  repository: "present";
  root: string;
  defaultBranch: string;
  repoName: string;
};

type SetupGitOutsideRepositoryFact = {
  status: "ok";
  repository: "absent";
  defaultBranch: string;
  message: string;
};

type SetupGitCapabilityFailureFact = {
  status: "missing";
  reason: "git-absent" | "git-unusable";
  defaultBranch: string;
  message: string;
};

type SetupGitRepositoryFailureFact = {
  status: "missing";
  reason: "repository-unusable" | "dubious-ownership";
  defaultBranch: string;
  message: string;
};

export type SetupGitFact =
  | SetupGitRepositoryFact
  | SetupGitOutsideRepositoryFact
  | SetupGitCapabilityFailureFact
  | SetupGitRepositoryFailureFact;

export type SetupHarnessFact = {
  id: SupportedHarnessId;
  label: string;
  status: "ok" | "missing";
  command: string;
  version?: string;
  rawVersion?: string;
  message?: string;
};

export type SetupConfigProjectFact = {
  id: string;
  worktreeProvider: string;
  worktrunkEnabled: boolean;
  terminal: string;
  harness: string;
};

export type SetupConfigDefaultsFact = {
  worktreeProvider: string;
  terminal: string;
  harness: string;
};

export type SetupLauncherFact = {
  status: "ok" | "missing";
  source: "path" | "installed" | "checkout" | "missing";
  command: string;
  checkoutPath: string;
  resolvedPath?: string;
  message?: string;
};

export type SetupLaunchersFact = {
  packageRoot: string;
  station: SetupLauncherFact;
  ingress: SetupLauncherFact;
  tmuxPopup: SetupLauncherFact;
};

export type SetupConfigDiagnosticFact = {
  code: string;
  message: string;
  severity: "warn" | "error";
};

export type SetupConfigFact =
  | {
      status: "missing";
      path: string;
      message: string;
    }
  | {
      status: "valid";
      path: string;
      source: string;
      observerStateDir: string;
      hasProjectForRoot: boolean;
      configuredHarnesses: readonly string[];
      configuredHarnessCommands?: Readonly<Record<string, string>>;
      configuredHookHarnesses: readonly string[];
      defaults: SetupConfigDefaultsFact;
      tmux?: TmuxConfig;
      worktrunkCommand?: string;
      worktrunkUseLifecycleHooks?: boolean;
      matchedProject?: SetupConfigProjectFact;
      // Non-fatal load diagnostics (broken project-local file, bad
      // [tui]/[workspace]). Present only when non-empty.
      diagnostics?: readonly SetupConfigDiagnosticFact[];
    }
  | {
      status: "invalid";
      path: string;
      source: string;
      message: string;
    };

export type SetupTmuxBindingFact =
  | {
      status: "ok";
      path: string;
      marker: string;
      launcherCommand: string;
      runShellCommand: string;
      bindingKey: string;
      insideTmux: boolean;
      liveStatus: "loaded" | "missing" | "unknown";
    }
  | {
      status: "missing";
      path: string;
      marker: string;
      launcherCommand: string;
      runShellCommand: string;
      bindingKey: string;
      insideTmux: boolean;
      liveStatus: "loaded" | "missing" | "unknown";
      message: string;
    }
  | {
      status: "conflict";
      path: string;
      marker: string;
      launcherCommand: string;
      runShellCommand: string;
      insideTmux: boolean;
      liveStatus: "unknown";
      message: string;
    };

export type SetupStationUiFact = {
  // "missing": Bun works but station/ was never `bun install`ed, so bare stn cannot
  // render. "skipped": a renderer override is set or Bun itself is unavailable (its
  // own required row already covers that), so the station/ Bun lane is not relevant.
  status: "installed" | "missing" | "skipped";
};

export type SetupStateDirFact =
  | {
      status: "ok";
      path: string;
    }
  | {
      status: "missing";
      path: string;
      message: string;
    };

export type SetupFacts = {
  generatedAt: string;
  mode: SetupMode;
  configPath: string;
  homeDir: string;
  compiled: boolean;
  stateDir: SetupStateDirFact;
  socketEvidence: SetupDependencyFact;
  worktrunk: SetupDependencyFact;
  worktrunkAutomation: SetupWorktrunkAutomationFact;
  worktrunkShellIntegration: SetupWorktrunkShellIntegrationFact;
  tmux: SetupDependencyFact;
  bun: SetupDependencyFact;
  stationUi: SetupStationUiFact;
  diffnav: SetupDependencyFact;
  gitDelta: SetupDependencyFact;
  brew: SetupBrewFact;
  xcode: SetupXcodeFact;
  launchers: SetupLaunchersFact;
  git: SetupGitFact;
  harnesses: readonly SetupHarnessFact[];
  harnessTracking: readonly SetupHarnessTrackingFact[];
  config: SetupConfigFact;
  tmuxBinding: SetupTmuxBindingFact;
};

export type ConfigWritePlan =
  | {
      operation: "none";
      reason: string;
    }
  | {
      operation: "create";
      path: string;
      content: string;
      backupPath?: string;
    }
  | {
      operation: "update";
      path: string;
      content: string;
      backupPath?: string;
    }
  | {
      operation: "blocked";
      path: string;
      reason: string;
    };
