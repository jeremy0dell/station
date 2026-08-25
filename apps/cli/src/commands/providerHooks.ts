import { dirname, resolve } from "node:path";
import { resolveObserverPaths, type StationConfig } from "@station/config";
import type {
  ProviderHookArtifactOwner,
  ProviderHookReconciliationResult,
  ProviderId,
  SafeError,
} from "@station/contracts";
import { reconcileProviderHooks } from "@station/observer/internal";
import {
  ProviderHookArtifactOwnershipError,
  resolveExecutablePath,
  shellQuote,
} from "@station/runtime";
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

type ProviderHooksAdapter<
  PlanOptions extends CommonHookOptions,
  InstallResult = unknown,
  VerifiedInstallResult = unknown,
> = {
  provider: ProviderId;
  plan: (options: PlanOptions) => Promise<unknown>;
  install: (options: PlanOptions) => Promise<InstallResult>;
  verifyInstall?: (
    installResult: InstallResult,
    options: PlanOptions,
    enabled: boolean,
  ) => Promise<VerifiedInstallResult>;
  uninstall: (options: PlanOptions) => Promise<unknown>;
  doctor: (options: PlanOptions & { enabled?: boolean }) => Promise<unknown>;
  reconcile?: (options: PlanOptions) => Promise<ProviderHookReconciliationResult>;
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
  provider: ProviderId,
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
      throw new Error(`Unknown ${provider} hook option: ${arg}`);
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
  provider: ProviderId,
  action: "install" | "uninstall",
): void {
  if (!yes) {
    throw new Error(`Refusing to ${action} ${provider} hooks without --yes.`);
  }
}

/**
 * Runs the shared provider-hook command flow. Verified install and automatic reconciliation stay
 * provider-owned; the latter cannot receive takeover authority from this adapter.
 */
export function createProviderHooksRunner<
  PlanOptions extends CommonHookOptions,
  InstallResult = unknown,
  VerifiedInstallResult = unknown,
>(
  adapter: ProviderHooksAdapter<PlanOptions, InstallResult, VerifiedInstallResult>,
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
    if (action === "reconcile" && flags.takeover) {
      throw new Error("Automatic hook reconciliation never accepts --takeover.");
    }
    if (flags.takeover) hookOptions.takeover = true;

    try {
      if (action === "plan") {
        return await adapter.plan(hookOptions);
      }
      if (action === "install") {
        assertHookConfirmed(flags.yes, adapter.provider, "install");
        const installResult = await adapter.install(hookOptions);
        if (adapter.verifyInstall === undefined) {
          return installResult;
        }
        return await adapter.verifyInstall(
          installResult,
          hookOptions,
          adapter.isEnabled(options.config),
        );
      }
      if (action === "uninstall") {
        assertHookConfirmed(flags.yes, adapter.provider, "uninstall");
        return await adapter.uninstall(hookOptions);
      }
      if (action === "doctor") {
        return await adapter.doctor({
          ...hookOptions,
          enabled: adapter.isEnabled(options.config),
        });
      }
      const reconcile = adapter.reconcile;
      if (action === "reconcile" && reconcile !== undefined) {
        return await reconcileProviderHooks(adapter.provider, () => reconcile(hookOptions));
      }
    } catch (error) {
      if (error instanceof ProviderHookArtifactOwnershipError) {
        throw providerHookOwnershipSafeError(error);
      }
      throw error;
    }

    throw new Error(
      `Usage: station hooks plan|install|uninstall|doctor|reconcile ${adapter.provider} [--yes]`,
    );
  };
}

async function resolveHookBinOwnership(
  flags: ParsedHookFlags,
  context: ProviderHooksCommandOptions,
  provider: ProviderId,
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

function providerHookOwnershipSafeError(error: ProviderHookArtifactOwnershipError): SafeError {
  const requested = error.ownership.requested;
  const requestedOwner = `${requested.runtimeKind} ${requested.version} build ${requested.buildIdentity} via ${JSON.stringify(requested.launcher)}`;
  let currentOwner = "unknown because the existing ownership marker is missing or invalid";
  let reason = "has no valid Station ownership marker";
  let repair = "";
  if (error.ownership.status === "different-owner") {
    const current = error.ownership.current;
    currentOwner = `${current.runtimeKind} ${current.version} build ${current.buildIdentity} via ${JSON.stringify(current.launcher)}`;
    reason = "is owned by another Station runtime";
    repair = ` To perform this action as the current owner, run ${shellQuote(resolve(dirname(current.launcher), "stn"))} hooks ${error.action} ${error.provider} --yes.`;
  }
  return {
    tag: error.tag,
    code: error.code,
    provider: error.provider,
    message: `Refusing to ${error.action} ${error.provider} hooks because ${JSON.stringify(error.artifactPath)} ${reason}. Current owner: ${currentOwner}. Requested owner: ${requestedOwner}.`,
    hint: `Run stn hooks ${error.action} ${error.provider} --yes --takeover only to transfer ownership.${repair}`,
  };
}
