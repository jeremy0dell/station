import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessDiscoveryContext,
  HarnessEventObservation,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessProvider,
  HarnessVersionInfo,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderHookArtifactOwner,
  ProviderHookArtifactOwnership,
  ProviderHookHealth,
  ProviderHookReconciliationContext,
  ProviderHookReconciliationResult,
  ProviderId,
  SafeError,
} from "@station/contracts";
import { discoverTerminalBoundHarnessRuns } from "@station/contracts";
import {
  type ExternalCommandResult,
  type ExternalCommandRunner,
  runExternalCommand,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";

/** Options every terminal-bound harness adapter accepts; provider-specific options extend this. */
export type CommonHarnessProviderOptions = {
  command?: string;
  hookBin?: string;
  artifactOwner?: ProviderHookArtifactOwner;
  now?: () => Date | string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
};

export type HarnessHealthSpec = {
  args: string[];
  // A function (not a literal) because only providers that read command output — e.g. Claude's
  // `--version` stdout — need the result; constant-diagnostics providers ignore the argument.
  diagnostics?: (result: ExternalCommandResult) => Record<string, string>;
  unavailableError: (error: unknown) => SafeError;
};

export type HarnessVersionSpec = {
  /** CLI args that print the installed version; defaults to ["--version"]. */
  args?: string[];
  /** npm package consulted for the latest release; omit to skip the lookup. */
  latestPackage?: string;
};

export type TerminalBoundHarnessCommandDefinition = {
  id: ProviderId;
  displayName: string;
  commandEnvVar: string;
  commandFallback: string;
};

export type TerminalBoundHarnessProviderSpec<TOpts extends CommonHarnessProviderOptions> =
  TerminalBoundHarnessCommandDefinition & {
    baseCapabilities: HarnessCapabilities;
    resumeFromOptions?: (options: TOpts) => boolean;
    health: HarnessHealthSpec;
    buildLaunch: (
      options: TOpts,
      request: BuildHarnessLaunchRequest,
    ) => HarnessLaunchPlan | Promise<HarnessLaunchPlan>;
    unknownStatusReason: string;
    acceptsPersistedEvent?: (observation: HarnessEventObservation) => boolean;
    doctorChecks?: (
      options: TOpts,
      context?: ProviderDoctorContext,
    ) => Promise<ProviderDoctorCheck[]>;
    version?: HarnessVersionSpec;
    hooksStatus?: (options: TOpts, context?: ProviderDoctorContext) => Promise<HarnessHooksStatus>;
    /** Maps provider-native inspection onto strict, path-free hook-health evidence. */
    hookHealth?: (options: TOpts, context?: ProviderDoctorContext) => Promise<ProviderHookHealth>;
    /** Requests the provider's sole no-takeover writer and post-write verification path. */
    reconcileHooks?: (
      options: TOpts,
      context?: ProviderHookReconciliationContext,
    ) => Promise<ProviderHookReconciliationResult>;
  };

export function createTerminalBoundHarnessProvider<TOpts extends CommonHarnessProviderOptions>(
  spec: TerminalBoundHarnessProviderSpec<TOpts>,
  options: TOpts,
): HarnessProvider {
  const provider: HarnessProvider = {
    id: spec.id,
    capabilities: () => harnessCapabilities(spec, options),
    health: () => harnessHealth(spec, options),
    discoverRuns: (context: HarnessDiscoveryContext) =>
      Promise.resolve(
        discoverTerminalBoundHarnessRuns(context, {
          harnessProvider: spec.id,
          displayName: spec.displayName,
          role: "main-agent",
          reason: spec.unknownStatusReason,
        }),
      ),
    buildLaunch: (request) => Promise.resolve(spec.buildLaunch(options, request)),
  };
  // Optional interface methods stay absent (never `= undefined`) so `'x' in provider`
  // feature-detection holds and exactOptionalPropertyTypes is respected.
  if (spec.acceptsPersistedEvent !== undefined) {
    provider.acceptsPersistedEvent = spec.acceptsPersistedEvent;
  }
  const doctorChecks = spec.doctorChecks;
  if (doctorChecks) {
    provider.doctorChecks = (context) => doctorChecks(options, context);
  }
  const hooksStatus = spec.hooksStatus;
  if (hooksStatus) {
    provider.hooksStatus = (context) => hooksStatus(options, context);
  }
  const hookHealth = spec.hookHealth;
  if (hookHealth) {
    provider.hookHealth = (context) => hookHealth(options, context);
  }
  const reconcileHooks = spec.reconcileHooks;
  if (reconcileHooks) {
    provider.reconcileHooks = (context) => reconcileHooks(options, context);
  }
  const version = spec.version;
  if (version) {
    provider.versionInfo = () => harnessVersionInfo(spec, version, options);
  }
  return provider;
}

/**
 * Best-effort per D17: each half runs under its own timeout and a failure
 * simply omits the field — offline or missing npm yields no badge, never an
 * error. The observer caches the result; this is not called per reconcile.
 */
async function harnessVersionInfo<TOpts extends CommonHarnessProviderOptions>(
  spec: TerminalBoundHarnessProviderSpec<TOpts>,
  version: HarnessVersionSpec,
  options: TOpts,
): Promise<HarnessVersionInfo> {
  const info: HarnessVersionInfo = {};
  try {
    const result = await runExternalCommand(
      {
        command: harnessCommand(options, spec.commandEnvVar, spec.commandFallback),
        args: version.args ?? ["--version"],
        timeoutMs: options.timeoutMs ?? 5000,
        maxOutputChars: 4096,
      },
      options.runner,
    );
    const installed = parseVersionToken(result.stdout);
    if (installed !== undefined) {
      info.installedVersion = installed;
    }
  } catch {
    // Unknown stays unknown.
  }
  if (version.latestPackage !== undefined) {
    try {
      const result = await runExternalCommand(
        {
          command: "npm",
          args: ["view", version.latestPackage, "version"],
          timeoutMs: options.timeoutMs ?? 5000,
          maxOutputChars: 4096,
        },
        options.runner,
      );
      const latest = parseVersionToken(result.stdout);
      if (latest !== undefined) {
        info.latestVersion = latest;
      }
    } catch {
      // Unknown stays unknown.
    }
  }
  return info;
}

function parseVersionToken(output: string): string | undefined {
  return output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

/** Binds one provider's command definition so the provider keeps a single `command(options)`. */
export function harnessCommandResolver(
  definition: TerminalBoundHarnessCommandDefinition,
): (options: { command?: string }) => string {
  return (options) => harnessCommand(options, definition.commandEnvVar, definition.commandFallback);
}

export function harnessCommand(
  options: { command?: string },
  envVar: string,
  fallback: string,
): string {
  return options.command ?? process.env[envVar] ?? fallback;
}

export async function harnessHealth<TOpts extends CommonHarnessProviderOptions>(
  spec: TerminalBoundHarnessProviderSpec<TOpts>,
  options: TOpts,
): Promise<ProviderHealth> {
  const checkedAt = harnessCheckedAt(options);
  const capabilities = harnessCapabilities(spec, options);
  try {
    const result = await runExternalCommand(
      {
        command: harnessCommand(options, spec.commandEnvVar, spec.commandFallback),
        args: spec.health.args,
        timeoutMs: options.timeoutMs ?? 5000,
        maxOutputChars: 4096,
      },
      options.runner,
    );
    const health: ProviderHealth = {
      provider: spec.id,
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: checkedAt,
      capabilities,
    };
    if (spec.health.diagnostics !== undefined) {
      health.diagnostics = spec.health.diagnostics(result);
    }
    return health;
  } catch (error) {
    return {
      provider: spec.id,
      providerType: "harness",
      status: "unavailable",
      lastCheckedAt: checkedAt,
      lastError: spec.health.unavailableError(error),
      capabilities,
    };
  }
}

export type HarnessHookDoctorOptionsInput = {
  installHooks?: boolean;
  hookBin?: string;
  artifactOwner?: ProviderHookArtifactOwner;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
};

export type CommonHookDoctorOptions = {
  enabled: boolean;
  hookBin?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  stationConfigPath?: string;
  artifactOwner?: ProviderHookArtifactOwner;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CommonHookReconciliationOptions = CommonHookDoctorOptions & {
  beginMutation?: () => void;
};

/** Maps the whole requester hook runtime or preserves the incumbent provider options. */
export function harnessHookDoctorOptions(
  options: HarnessHookDoctorOptionsInput,
  context?: ProviderDoctorContext,
): CommonHookDoctorOptions {
  const result: CommonHookDoctorOptions = { enabled: options.installHooks === true };
  const runtime = context?.providerHookRuntime;
  if (runtime !== undefined) {
    result.hookBin = runtime.ingressLauncher;
    result.observerSocketPath = runtime.observerSocketPath;
    result.stateDir = runtime.stateDir;
    result.hookSpoolDir = runtime.hookSpoolDir;
    result.autoStartFromHooks = runtime.autoStartFromHooks;
    if (runtime.stationConfigPath !== undefined) {
      result.stationConfigPath = runtime.stationConfigPath;
    }
    if (runtime.artifactOwner !== undefined) {
      result.artifactOwner = runtime.artifactOwner;
    } else if (options.artifactOwner !== undefined) {
      result.artifactOwner = options.artifactOwner;
    }
    if (context?.signal !== undefined) {
      result.signal = context.signal;
    }
    if (context?.timeoutMs !== undefined) {
      result.timeoutMs = context.timeoutMs;
    }
    return result;
  }
  if (options.observerSocketPath !== undefined) {
    result.observerSocketPath = options.observerSocketPath;
  }
  if (options.hookBin !== undefined) {
    result.hookBin = options.hookBin;
  }
  if (options.artifactOwner !== undefined) {
    result.artifactOwner = options.artifactOwner;
  }
  if (options.stateDir !== undefined) {
    result.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    result.hookSpoolDir = options.hookSpoolDir;
  }
  if (options.autoStartFromHooks !== undefined) {
    result.autoStartFromHooks = options.autoStartFromHooks;
  }
  if (context?.stationConfigPath !== undefined) {
    result.stationConfigPath = context.stationConfigPath;
  }
  if (context?.signal !== undefined) {
    result.signal = context.signal;
  }
  if (context?.timeoutMs !== undefined) {
    result.timeoutMs = context.timeoutMs;
  }
  return result;
}

/** Maps provider reconciliation context without exposing commit authority to read-only probes. */
export function harnessHookReconciliationOptions(
  options: HarnessHookDoctorOptionsInput,
  context?: ProviderHookReconciliationContext,
): CommonHookReconciliationOptions {
  const result: CommonHookReconciliationOptions = harnessHookDoctorOptions(options, context);
  if (context?.beginMutation !== undefined) {
    result.beginMutation = context.beginMutation;
  }
  return result;
}

export function harnessHooksStatusFrom(
  provider: ProviderId,
  requested: boolean,
  result: {
    installed: boolean;
    missing: readonly unknown[];
    message: string;
    ownership?: ProviderHookArtifactOwnership;
  },
): HarnessHooksStatus {
  const status: HarnessHooksStatus = {
    provider,
    installed: result.installed,
    requested,
    missing: result.missing.map((name) => String(name)),
    message: result.message,
  };
  if (result.ownership !== undefined) status.ownership = result.ownership;
  return status;
}

function harnessCapabilities<TOpts extends CommonHarnessProviderOptions>(
  spec: TerminalBoundHarnessProviderSpec<TOpts>,
  options: TOpts,
): HarnessCapabilities {
  return { ...spec.baseCapabilities, canResume: spec.resumeFromOptions?.(options) ?? false };
}

function harnessCheckedAt(options: { now?: () => Date | string }): string {
  const value = options.now?.() ?? systemClock.now();
  return toIsoTimestamp(value instanceof Date ? value : new Date(value));
}
