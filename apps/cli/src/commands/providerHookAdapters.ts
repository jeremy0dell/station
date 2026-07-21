import {
  type ClaudeHookDoctorResult,
  type ClaudeHookInstallResult,
  type ClaudeHookPlan,
  type ClaudeHookPlanOptions,
  doctorClaudeHooks,
  installClaudeHooks,
  planClaudeHooks,
  uninstallClaudeHooks,
} from "@station/claude";
import {
  type CodexHookDoctorResult,
  type CodexHookInstallResult,
  type CodexHookPlan,
  type CodexHookPlanOptions,
  doctorCodexHooks,
  installCodexHooks,
  planCodexHooks,
  uninstallCodexHooks,
} from "@station/codex";
import type { StationConfig } from "@station/config";
import {
  type CursorHookDoctorResult,
  type CursorHookInstallResult,
  type CursorHookPlan,
  type CursorHookPlanOptions,
  doctorCursorHooks,
  installCursorHooks,
  planCursorHooks,
  uninstallCursorHooks,
} from "@station/cursor";
import {
  doctorOpenCodePlugin,
  installOpenCodePlugin,
  type OpenCodePluginDoctorResult,
  type OpenCodePluginInstallResult,
  type OpenCodePluginPlan,
  type OpenCodePluginPlanOptions,
  planOpenCodePlugin,
  uninstallOpenCodePlugin,
} from "@station/opencode";
import {
  doctorWorktrunkHooks,
  installWorktrunkHooks,
  planWorktrunkHooks,
  uninstallWorktrunkHooks,
  type WorktrunkHookDoctorResult,
  type WorktrunkHookInstallResult,
  type WorktrunkHookPlan,
  type WorktrunkHookPlanOptions,
} from "@station/worktrunk";
import { createWorktrunkHookExpectation } from "../worktrunkHookExpectation.js";
import {
  buildCommonHookOptions,
  createProviderHooksRunner,
  type ProviderHooksCommandOptions,
} from "./providerHooks.js";

export type { ProviderHooksCommandOptions } from "./providerHooks.js";

export type ClaudeHooksCommandResult =
  | ClaudeHookPlan
  | ClaudeHookInstallResult
  | ClaudeHookDoctorResult;

export type CodexHooksCommandResult =
  | CodexHookPlan
  | CodexHookInstallResult
  | CodexHookDoctorResult;

export type CursorHooksCommandResult =
  | CursorHookPlan
  | CursorHookInstallResult
  | CursorHookDoctorResult;

export type OpenCodeHooksCommandResult =
  | OpenCodePluginPlan
  | OpenCodePluginInstallResult
  | OpenCodePluginDoctorResult;

export type WorktrunkHooksCommandOptions = ProviderHooksCommandOptions & {
  config: StationConfig;
};

export type WorktrunkHooksCommandResult =
  | WorktrunkHookPlan
  | WorktrunkHookInstallResult
  | WorktrunkHookDoctorResult;

function isClaudeEnabled(config: StationConfig | undefined): boolean {
  return config?.harness?.claude?.installHooks === true;
}

function isCodexEnabled(config: StationConfig | undefined): boolean {
  return config?.harness?.codex?.installHooks === true;
}

function isCursorEnabled(config: StationConfig | undefined): boolean {
  return config?.harness?.cursor?.installHooks === true;
}

function isOpenCodeEnabled(config: StationConfig | undefined): boolean {
  return config?.harness?.opencode?.installHooks === true;
}

// Worktrunk lifecycle hooks are default-on, so an absent config stays enabled.
function isWorktrunkEnabled(config: StationConfig | undefined): boolean {
  return config?.worktree?.worktrunk?.useLifecycleHooks !== false;
}

export function runClaudeHooksCommand(
  args: string[],
  options: ProviderHooksCommandOptions = {},
): Promise<ClaudeHooksCommandResult> {
  const runner = createProviderHooksRunner<ClaudeHookPlanOptions>(
    {
      provider: "claude",
      plan: planClaudeHooks,
      install: installClaudeHooks,
      uninstall: uninstallClaudeHooks,
      doctor: doctorClaudeHooks,
      buildOptions: (flags, context) => {
        const options: ClaudeHookPlanOptions = buildCommonHookOptions(context);
        if (flags.providerConfig !== undefined) {
          options.claudeSettingsPath = flags.providerConfig;
        }
        if (flags.hookScriptPath !== undefined) {
          options.hookScriptPath = flags.hookScriptPath;
        }
        if (flags.hookBin !== undefined) {
          options.hookBin = flags.hookBin;
        }
        return options;
      },
      isEnabled: isClaudeEnabled,
    },
    { providerConfigFlag: "--claude-settings", supportsHookScript: true, supportsHookBin: true },
  );
  return runner(args, options) as Promise<ClaudeHooksCommandResult>;
}

export function runCodexHooksCommand(
  args: string[],
  options: ProviderHooksCommandOptions = {},
): Promise<CodexHooksCommandResult> {
  const runner = createProviderHooksRunner<CodexHookPlanOptions>(
    {
      provider: "codex",
      plan: planCodexHooks,
      install: installCodexHooks,
      uninstall: uninstallCodexHooks,
      doctor: doctorCodexHooks,
      buildOptions: (flags, context) => {
        const options: CodexHookPlanOptions = buildCommonHookOptions(context);
        if (flags.providerConfig !== undefined) {
          options.codexConfigPath = flags.providerConfig;
        }
        if (flags.hookScriptPath !== undefined) {
          options.hookScriptPath = flags.hookScriptPath;
        }
        if (flags.hookBin !== undefined) {
          options.hookBin = flags.hookBin;
        }
        return options;
      },
      isEnabled: isCodexEnabled,
    },
    { providerConfigFlag: "--codex-config", supportsHookScript: true, supportsHookBin: true },
  );
  return runner(args, options) as Promise<CodexHooksCommandResult>;
}

export function runCursorHooksCommand(
  args: string[],
  options: ProviderHooksCommandOptions = {},
): Promise<CursorHooksCommandResult> {
  const runner = createProviderHooksRunner<CursorHookPlanOptions>(
    {
      provider: "cursor",
      plan: planCursorHooks,
      install: installCursorHooks,
      uninstall: uninstallCursorHooks,
      doctor: doctorCursorHooks,
      buildOptions: (flags, context) => {
        const options: CursorHookPlanOptions = buildCommonHookOptions(context);
        if (flags.providerConfig !== undefined) {
          options.cursorHooksPath = flags.providerConfig;
        }
        if (flags.hookScriptPath !== undefined) {
          options.hookScriptPath = flags.hookScriptPath;
        }
        if (flags.hookBin !== undefined) {
          options.hookBin = flags.hookBin;
        }
        return options;
      },
      isEnabled: isCursorEnabled,
    },
    { providerConfigFlag: "--cursor-hooks", supportsHookScript: true, supportsHookBin: true },
  );
  return runner(args, options) as Promise<CursorHooksCommandResult>;
}

export function runOpenCodeHooksCommand(
  args: string[],
  options: ProviderHooksCommandOptions = {},
): Promise<OpenCodeHooksCommandResult> {
  const runner = createProviderHooksRunner<OpenCodePluginPlanOptions>(
    {
      provider: "opencode",
      plan: planOpenCodePlugin,
      install: installOpenCodePlugin,
      uninstall: uninstallOpenCodePlugin,
      doctor: doctorOpenCodePlugin,
      buildOptions: (flags, context) => {
        const options: OpenCodePluginPlanOptions = buildCommonHookOptions(context);
        if (flags.providerConfig !== undefined) {
          options.opencodeConfigDir = flags.providerConfig;
        }
        if (flags.hookScriptPath !== undefined) {
          options.pluginPath = flags.hookScriptPath;
        }
        return options;
      },
      isEnabled: isOpenCodeEnabled,
    },
    {
      providerConfigFlag: "--opencode-config-dir",
      supportsHookScript: true,
      supportsHookBin: false,
      hookScriptFlag: "--plugin-path",
    },
  );
  return runner(args, options) as Promise<OpenCodeHooksCommandResult>;
}

export function runWorktrunkHooksCommand(
  args: string[],
  options: WorktrunkHooksCommandOptions,
): Promise<WorktrunkHooksCommandResult> {
  const config = options.config;
  const runner = createProviderHooksRunner<WorktrunkHookPlanOptions>(
    {
      provider: "worktrunk",
      plan: planWorktrunkHooks,
      install: installWorktrunkHooks,
      uninstall: uninstallWorktrunkHooks,
      doctor: doctorWorktrunkHooks,
      buildOptions: (flags, context) => {
        const expectation = createWorktrunkHookExpectation(config, {
          stationConfigPath: context.configPath,
          ingressLauncher: context.providerHookIngressLauncher,
        });
        if (flags.hookBin !== undefined) {
          expectation.hookBin = flags.hookBin;
        }
        const planOptions: WorktrunkHookPlanOptions = { expectation };
        // Fall back to the station-config worktrunk config_path when --worktrunk-config is absent.
        const worktrunkConfigPath = flags.providerConfig ?? config.worktree?.worktrunk?.configPath;
        if (worktrunkConfigPath !== undefined) {
          planOptions.worktrunkConfigPath = worktrunkConfigPath;
        }
        if (context.env !== undefined) {
          planOptions.env = context.env;
        }
        return planOptions;
      },
      isEnabled: isWorktrunkEnabled,
    },
    { providerConfigFlag: "--worktrunk-config", supportsHookScript: false, supportsHookBin: true },
  );
  return runner(args, options) as Promise<WorktrunkHooksCommandResult>;
}
