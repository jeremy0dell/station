import { resolve } from "node:path";
import { resolveObserverPaths, type StationConfig } from "@station/config";
import type { ProviderHookArtifactOwner } from "@station/contracts";
import { resolveExecutablePath } from "@station/runtime";
import type { CliEnv } from "../env.js";

type CommonHookOptions = {
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  stationConfigPath?: string;
  env?: CliEnv;
  hookBin?: string;
  hookScriptPath?: string;
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
};

type ProviderHooksAdapter<PlanOptions extends CommonHookOptions> = {
  provider: string;
  plan: (options: PlanOptions) => Promise<unknown>;
  install: (options: PlanOptions) => Promise<unknown>;
  uninstall: (options: PlanOptions) => Promise<unknown>;
  doctor: (options: PlanOptions & { enabled?: boolean }) => Promise<unknown>;
  buildOptions: (flags: ParsedHookFlags, context: HookCommandContext) => PlanOptions;
  // Receives the possibly-absent config so each provider owns its no-config
  // default (worktrunk lifecycle hooks are default-on; others default-off).
  isEnabled: (config: StationConfig | undefined) => boolean;
};

type HookCommandContext = {
  config?: StationConfig;
  configPath?: string;
  env?: CliEnv;
  providerHookIngressLauncher?: string;
  providerHookArtifactOwner?: ProviderHookArtifactOwner;
};

type ParsedHookFlags = {
  yes: boolean;
  takeover: boolean;
  providerConfig?: string;
  hookScriptPath?: string;
  hookBin?: string;
};

type ProviderHookFlagSpec = {
  providerConfigFlag: string;
  supportsHookScript: boolean;
  supportsHookBin: boolean;
  // Public flag name for the hook-script path. Defaults to "--hook-script";
  // opencode keeps its historical "--plugin-path" spelling.
  hookScriptFlag?: string;
};

export type ProviderHooksCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  env?: CliEnv;
  providerHookIngressLauncher?: string;
  providerHookArtifactOwner?: ProviderHookArtifactOwner;
};

export type ProviderHooksCommandResult = unknown;

export function parseHookFlags(
  args: string[],
  provider: string,
  spec: ProviderHookFlagSpec,
): ParsedHookFlags {
  const flags: ParsedHookFlags = { yes: false, takeover: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--takeover") {
      flags.takeover = true;
      continue;
    }
    const value = args[index + 1];
    if (arg === spec.providerConfigFlag && value !== undefined) {
      flags.providerConfig = value;
      index += 1;
      continue;
    }
    if (
      spec.supportsHookScript &&
      arg === (spec.hookScriptFlag ?? "--hook-script") &&
      value !== undefined
    ) {
      flags.hookScriptPath = value;
      index += 1;
      continue;
    }
    if (spec.supportsHookBin && arg === "--hook-bin" && value !== undefined) {
      flags.hookBin = value;
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      throw new Error(`Unknown ${capitalize(provider)} hook option: ${arg}`);
    }
  }

  return flags;
}

export function buildCommonHookOptions(context: HookCommandContext): CommonHookOptions {
  const options: CommonHookOptions = {};
  if (context.config !== undefined) {
    const paths = resolveObserverPaths(context.config);
    options.observerSocketPath = paths.socketPath;
    options.stateDir = paths.stateDir;
    options.hookSpoolDir = paths.hookSpoolDir;
    options.autoStartFromHooks = context.config.observer?.autoStartFromHooks !== false;
  }
  if (context.configPath !== undefined) {
    options.stationConfigPath = context.configPath;
  }
  if (context.env !== undefined) {
    options.env = context.env;
  }
  if (context.providerHookIngressLauncher !== undefined) {
    options.hookBin = context.providerHookIngressLauncher;
  }
  if (context.providerHookArtifactOwner !== undefined) {
    options.artifactOwner = context.providerHookArtifactOwner;
  }
  return options;
}

export function assertHookConfirmed(
  yes: boolean,
  provider: string,
  action: "install" | "uninstall",
): void {
  if (!yes) {
    throw new Error(`Refusing to ${action} ${capitalize(provider)} hooks without --yes.`);
  }
}

export function createProviderHooksRunner<PlanOptions extends CommonHookOptions>(
  adapter: ProviderHooksAdapter<PlanOptions>,
  flagSpec: ProviderHookFlagSpec,
) {
  return async function runProviderHooksCommand(
    args: string[],
    options: ProviderHooksCommandOptions = {},
  ): Promise<ProviderHooksCommandResult> {
    const [action] = args;
    const flags = parseHookFlags(args.slice(1), adapter.provider, flagSpec);
    const context = await resolveHookBinOwnership(flags, options, adapter.provider);
    const hookOptions = adapter.buildOptions(flags, context);
    if (flags.takeover) hookOptions.takeover = true;

    if (action === "plan") {
      return adapter.plan(hookOptions);
    }
    if (action === "install") {
      assertHookConfirmed(flags.yes, adapter.provider, "install");
      return adapter.install(hookOptions);
    }
    if (action === "uninstall") {
      assertHookConfirmed(flags.yes, adapter.provider, "uninstall");
      return adapter.uninstall(hookOptions);
    }
    if (action === "doctor") {
      return adapter.doctor({
        ...hookOptions,
        enabled: adapter.isEnabled(options.config),
      });
    }

    throw new Error(
      `Usage: station hooks plan|install|uninstall|doctor ${adapter.provider} [--yes]`,
    );
  };
}

async function resolveHookBinOwnership(
  flags: ParsedHookFlags,
  context: ProviderHooksCommandOptions,
  provider: string,
): Promise<ProviderHooksCommandOptions> {
  if (flags.hookBin === undefined || context.providerHookArtifactOwner === undefined) {
    return context;
  }
  const resolveOptions = context.env?.PATH === undefined ? {} : { pathEnv: context.env.PATH };
  const launcher = await resolveExecutablePath(flags.hookBin, resolveOptions);
  if (launcher === undefined) {
    throw new Error(
      `Refusing ${provider} --hook-bin ${flags.hookBin}: the executable could not be resolved.`,
    );
  }
  flags.hookBin = resolve(launcher);
  return {
    ...context,
    providerHookArtifactOwner: {
      ...context.providerHookArtifactOwner,
      launcher: flags.hookBin,
    },
  };
}

export function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
