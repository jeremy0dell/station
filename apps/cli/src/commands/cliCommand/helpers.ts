import type { StationConfig } from "@station/config";
import {
  type ProviderHookArtifactOwner,
  ProviderHookReconciliationResultSchema,
  type SafeError,
} from "@station/contracts";
import type { CliCommandRunContext } from "./types.js";

export type LoadedCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  providerHookIngressLauncher?: string;
  providerHookArtifactOwner?: ProviderHookArtifactOwner;
};

type LoadedConfigCommandOptions = LoadedCommandOptions & {
  config: StationConfig;
};

export function loadedCommandOptions(context: CliCommandRunContext): LoadedCommandOptions {
  const options: LoadedCommandOptions = {};
  if (context.config !== undefined) {
    options.config = context.config;
  }
  if (context.resolvedConfigPath !== undefined) {
    options.configPath = context.resolvedConfigPath;
  }
  if (context.options.providerHookIngressLauncher !== undefined) {
    options.providerHookIngressLauncher = context.options.providerHookIngressLauncher;
  }
  if (context.options.providerHookArtifactOwner !== undefined) {
    options.providerHookArtifactOwner = context.options.providerHookArtifactOwner;
  }
  return options;
}

export function loadedConfigCommandOptions(
  context: CliCommandRunContext,
): LoadedConfigCommandOptions {
  if (context.config === undefined) {
    throw {
      tag: "CliCommandError",
      code: "CLI_CONFIG_NOT_LOADED",
      message: `Station config was not loaded for the ${context.path.join(" ")} command.`,
    } satisfies SafeError;
  }
  return { ...loadedCommandOptions(context), config: context.config };
}

export function hookCommandExitCode(result: object): number {
  const reconciliation = ProviderHookReconciliationResultSchema.safeParse(result);
  if (reconciliation.success) {
    return reconciliation.data.status === "ownership-conflict" ||
      reconciliation.data.status === "write-failed" ||
      reconciliation.data.status === "post-write-doctor-failed" ||
      reconciliation.data.status === "inspection-failed"
      ? 1
      : 0;
  }
  return "status" in result && result.status === "warn" ? 1 : 0;
}

export function actionNeedsYes(action: string): boolean {
  return action === "install" || action === "uninstall";
}
