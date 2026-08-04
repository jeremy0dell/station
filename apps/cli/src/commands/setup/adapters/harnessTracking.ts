import type { ClaudeHookInstallResult } from "@station/claude";
import type { CodexHookInstallResult } from "@station/codex";
import { type LoadedStationConfig, loadConfig } from "@station/config";
import type { ProviderHookArtifactOwner } from "@station/contracts";
import type { CursorHookInstallResult } from "@station/cursor";
import type { OpenCodePluginInstallResult } from "@station/opencode";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { SetupHarnessTrackingPort, SupportedHarnessId } from "@station/setup-core";
import type { CliEnv } from "../../../env.js";
import {
  type ProviderHooksCommandOptions,
  runClaudeHooksCommand,
  runCodexHooksCommand,
  runCursorHooksCommand,
  runOpenCodeHooksCommand,
} from "../../providerHookAdapters.js";

export type SetupHarnessTrackingRunners = {
  readonly claude: (
    args: ["install", ...string[]],
    options?: ProviderHooksCommandOptions,
  ) => Promise<ClaudeHookInstallResult>;
  readonly codex: (
    args: ["install", ...string[]],
    options?: ProviderHooksCommandOptions,
  ) => Promise<CodexHookInstallResult>;
  readonly cursor: (
    args: ["install", ...string[]],
    options?: ProviderHooksCommandOptions,
  ) => Promise<CursorHookInstallResult>;
  readonly opencode: (
    args: ["install", ...string[]],
    options?: ProviderHooksCommandOptions,
  ) => Promise<OpenCodePluginInstallResult>;
};

export type SetupHarnessTrackingAdapterOptions = {
  readonly configPath: () => string | undefined;
  readonly homeDir: string;
  readonly env?: CliEnv;
  readonly providerHookIngressLauncher?: string;
  readonly providerHookArtifactOwner?: ProviderHookArtifactOwner;
  readonly loadConfig?: (options: {
    configPath: string;
    homeDir: string;
  }) => Promise<LoadedStationConfig>;
  readonly runners?: SetupHarnessTrackingRunners;
};

/**
 * ADAPTER
 *
 * Translates harness tracking preparation into an in-process provider installer and sanitized commit evidence.
 */
export function createHarnessTrackingAdapter(
  options: SetupHarnessTrackingAdapterOptions,
): SetupHarnessTrackingPort {
  const runners = options.runners ?? defaultRunners;
  return async (operation) => {
    try {
      if (operation.harnessId === "pi") {
        return {
          status: "completed",
          operationId: operation.id,
          commit: { kind: "provider-tracking", provider: "pi", changed: false },
        };
      }
      const configPath = options.configPath();
      if (configPath === undefined) throw providerTrackingError(operation.harnessId);
      const loaded = await (options.loadConfig ?? loadConfig)({
        configPath,
        homeDir: options.homeDir,
      });
      const commandOptions = providerCommandOptions(options, loaded);
      switch (operation.harnessId) {
        case "claude":
          return installResultOutcome(
            operation,
            await runners.claude(["install", "--yes"], commandOptions),
            claudeBackupPaths,
          );
        case "codex":
          return installResultOutcome(
            operation,
            await runners.codex(["install", "--yes"], commandOptions),
            codexBackupPaths,
          );
        case "cursor":
          return installResultOutcome(
            operation,
            await runners.cursor(["install", "--yes"], commandOptions),
            cursorBackupPaths,
          );
        case "opencode":
          return installResultOutcome(
            operation,
            await runners.opencode(["install", "--yes"], commandOptions),
            openCodeBackupPaths,
          );
      }
    } catch (error) {
      return {
        status: "failed",
        operationId: operation.id,
        error: publicSafeErrorFromUnknown(error, providerTrackingError(operation.harnessId)),
      };
    }
  };
}

const defaultRunners: SetupHarnessTrackingRunners = {
  claude: runClaudeHooksCommand,
  codex: runCodexHooksCommand,
  cursor: runCursorHooksCommand,
  opencode: runOpenCodeHooksCommand,
};

type HarnessInstallResult =
  | ClaudeHookInstallResult
  | CodexHookInstallResult
  | CursorHookInstallResult
  | OpenCodePluginInstallResult;

function installResultOutcome<Result extends HarnessInstallResult>(
  operation: Parameters<SetupHarnessTrackingPort>[0],
  result: Result,
  backupPaths: (result: Result) => readonly string[],
) {
  if (!result.installed) throw providerTrackingError(operation.harnessId);
  const paths = backupPaths(result);
  return {
    status: "completed" as const,
    operationId: operation.id,
    commit:
      paths.length === 0
        ? {
            kind: "provider-tracking" as const,
            provider: operation.harnessId,
            changed: result.changed,
          }
        : {
            kind: "provider-tracking" as const,
            provider: operation.harnessId,
            changed: result.changed,
            backupPaths: paths,
          },
  };
}

function providerCommandOptions(
  options: SetupHarnessTrackingAdapterOptions,
  loaded: LoadedStationConfig,
): ProviderHooksCommandOptions {
  const result: ProviderHooksCommandOptions = {
    config: loaded.config,
    configPath: loaded.configPath,
  };
  if (options.env !== undefined) result.env = options.env;
  if (options.providerHookIngressLauncher !== undefined) {
    result.providerHookIngressLauncher = options.providerHookIngressLauncher;
  }
  if (options.providerHookArtifactOwner !== undefined) {
    result.providerHookArtifactOwner = options.providerHookArtifactOwner;
  }
  return result;
}

function claudeBackupPaths(result: ClaudeHookInstallResult): readonly string[] {
  return result.backupPaths ?? singleBackupPath(result.backupPath);
}

function codexBackupPaths(result: CodexHookInstallResult): readonly string[] {
  return result.backupPaths ?? singleBackupPath(result.backupPath);
}

function cursorBackupPaths(result: CursorHookInstallResult): readonly string[] {
  return result.backupPaths ?? singleBackupPath(result.backupPath);
}

function openCodeBackupPaths(result: OpenCodePluginInstallResult): readonly string[] {
  return singleBackupPath(result.backupPath);
}

function singleBackupPath(path: string | undefined): readonly string[] {
  return path === undefined ? [] : [path];
}

function providerTrackingError(provider: SupportedHarnessId) {
  return {
    tag: "SetupProviderTrackingError",
    code: "SETUP_PROVIDER_TRACKING_FAILED",
    message: `Station tracking could not be prepared for ${provider}.`,
    provider,
  };
}
