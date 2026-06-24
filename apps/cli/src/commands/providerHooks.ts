import { resolveObserverPaths, type StationConfig } from "@station/config";
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
};

type ParsedHookFlags = {
  yes: boolean;
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
};

export type ProviderHooksCommandResult = unknown;

export function parseHookFlags(
  args: string[],
  provider: string,
  spec: ProviderHookFlagSpec,
): ParsedHookFlags {
  const flags: ParsedHookFlags = { yes: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
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
    const hookOptions = adapter.buildOptions(flags, options);

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

export function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
