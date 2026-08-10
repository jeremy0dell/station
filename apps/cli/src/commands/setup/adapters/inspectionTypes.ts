import type { TmuxConfig } from "@station/config";
import {
  type CliSetupHarnessId,
  CliSetupHarnessIdSchema,
  ProviderHookArtifactOwnershipSchema,
} from "@station/contracts";
import { z } from "zod";

export type SetupMode = "check" | "plan" | "apply";

export const SetupHarnessTrackingFactSchema = z
  .object({
    harnessId: CliSetupHarnessIdSchema,
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

export type SetupHarnessTrackingFact = z.infer<typeof SetupHarnessTrackingFactSchema>;

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
  id: CliSetupHarnessId;
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
  status: "installed" | "missing" | "skipped";
};

export type SetupStateDirFact =
  | { status: "ok"; path: string }
  | { status: "missing"; path: string; message: string };

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
  diffViewer: SetupDependencyFact;
  brew: SetupBrewFact;
  xcode: SetupXcodeFact;
  launchers: SetupLaunchersFact;
  git: SetupGitFact;
  harnesses: readonly SetupHarnessFact[];
  harnessTracking: readonly SetupHarnessTrackingFact[];
  config: SetupConfigFact;
  tmuxBinding: SetupTmuxBindingFact;
};
