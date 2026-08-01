import {
  type CliSetupAction,
  CliSetupActionSchema,
  type CliSetupCheck,
  CliSetupCheckSchema,
  type CliSetupPlan,
  CliSetupPlanSchema,
  CliSetupSummarySchema,
} from "@station/contracts";
import { z } from "zod";

export type { SupportedHarnessId } from "@station/setup-core";
export { supportedHarnessIds } from "@station/setup-core";
export {
  type SetupBrewFact,
  type SetupConfigDefaultsFact,
  type SetupConfigDiagnosticFact,
  type SetupConfigFact,
  type SetupConfigProjectFact,
  type SetupDependencyFact,
  type SetupFacts,
  type SetupGitFact,
  type SetupHarnessFact,
  type SetupHarnessTrackingFact,
  SetupHarnessTrackingFactSchema,
  type SetupLauncherFact,
  type SetupLaunchersFact,
  type SetupMode,
  type SetupStateDirFact,
  type SetupStationUiFact,
  type SetupTmuxBindingFact,
  type SetupWorktrunkAutomationFact,
  type SetupWorktrunkShellIntegrationFact,
  type SetupXcodeFact,
} from "./adapters/inspectionTypes.js";

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
export const SetupHarnessSelectionSourceSchema = z.enum(setupHarnessSelectionSources);

export type SetupTier = z.infer<typeof SetupTierSchema>;
export type SetupHarnessSelectionSource = z.infer<typeof SetupHarnessSelectionSourceSchema>;

export const SetupCheckSchema = CliSetupCheckSchema;
export const SetupActionSchema = CliSetupActionSchema;
export const SetupSummarySchema = CliSetupSummarySchema;
export const SetupPlanSchema = CliSetupPlanSchema;

export type SetupCheck = CliSetupCheck;
export type SetupAction = CliSetupAction;
export type SetupPlan = CliSetupPlan;

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
