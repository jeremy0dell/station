import { builtInHarnessIds } from "@station/harness-shared";
import { z } from "zod";

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
export const supportedHarnessIds = builtInHarnessIds;

export const SetupTierSchema = z.enum(setupTiers);
export const SetupStatusSchema = z.enum(setupStatuses);
export const SetupModeSchema = z.enum(setupModes);
export const SetupActionKindSchema = z.enum(setupActionKinds);
export const SetupActionStatusSchema = z.enum(setupActionStatuses);
export const SupportedHarnessIdSchema = z.enum(supportedHarnessIds);

export type SetupTier = z.infer<typeof SetupTierSchema>;
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type SetupMode = z.infer<typeof SetupModeSchema>;
export type SetupActionKind = z.infer<typeof SetupActionKindSchema>;
export type SetupActionStatus = z.infer<typeof SetupActionStatusSchema>;
export type SupportedHarnessId = z.infer<typeof SupportedHarnessIdSchema>;

export const SetupCheckSchema = z
  .object({
    id: z.string().min(1),
    tier: SetupTierSchema,
    status: SetupStatusSchema,
    label: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const SetupActionSchema = z
  .object({
    id: z.string().min(1),
    kind: SetupActionKindSchema,
    tier: SetupTierSchema,
    selected: z.boolean(),
    label: z.string().min(1),
    message: z.string().min(1),
    command: z.array(z.string()).optional(),
    path: z.string().optional(),
    status: SetupActionStatusSchema.optional(),
    data: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const SetupSummarySchema = z
  .object({
    launchReady: z.boolean(),
    workflowReady: z.boolean(),
    requiredOk: z.boolean(),
    requiredMissing: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    selectedActions: z.number().int().nonnegative(),
    selectedHarness: SupportedHarnessIdSchema.optional(),
    configPath: z.string(),
  })
  .strict()
  .refine((summary) => summary.requiredOk === summary.workflowReady, {
    message: "requiredOk must match workflowReady",
    path: ["requiredOk"],
  });

export const SetupPlanSchema = z
  .object({
    generatedAt: z.string().min(1),
    mode: SetupModeSchema,
    checks: z.array(SetupCheckSchema),
    actions: z.array(SetupActionSchema),
    summary: SetupSummarySchema,
    nextSteps: z.array(z.string()),
  })
  .strict();

export type SetupCheck = z.infer<typeof SetupCheckSchema>;
export type SetupAction = z.infer<typeof SetupActionSchema>;
export type SetupSummary = z.infer<typeof SetupSummarySchema>;
export type SetupPlan = z.infer<typeof SetupPlanSchema>;

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

export type SetupGitFact =
  | {
      status: "ok";
      root: string;
      defaultBranch: string;
      repoName: string;
    }
  | {
      status: "missing";
      // "git-absent": the git binary is not installed (bare-machine case).
      // "not-a-repo": git works but the cwd is not inside a repository.
      reason: "git-absent" | "not-a-repo";
      defaultBranch: string;
      message: string;
    };

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
  source: "path" | "checkout" | "missing";
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
      configuredHookHarnesses: readonly string[];
      defaults: SetupConfigDefaultsFact;
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
      insideTmux: boolean;
      liveStatus: "loaded" | "missing" | "unknown";
    }
  | {
      status: "missing";
      path: string;
      marker: string;
      launcherCommand: string;
      runShellCommand: string;
      insideTmux: boolean;
      liveStatus: "loaded" | "missing" | "unknown";
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
  worktrunk: SetupDependencyFact;
  worktrunkAutomation: SetupWorktrunkAutomationFact;
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
  config: SetupConfigFact;
  tmuxBinding: SetupTmuxBindingFact;
  selectedHarness?: SupportedHarnessId;
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
      operation: "append";
      path: string;
      content: string;
      appendedText: string;
      backupPath?: string;
    }
  | {
      operation: "blocked";
      path: string;
      reason: string;
    };
