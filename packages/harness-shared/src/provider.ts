import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  HarnessVersionInfo,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderId,
  RawHarnessEvent,
  SafeError,
} from "@station/contracts";
import { discoverTerminalBoundHarnessRuns } from "@station/contracts";
import {
  type ExternalCommandResult,
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundary,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";

/** Options every terminal-bound harness adapter accepts; provider-specific options extend this. */
export type CommonHarnessProviderOptions = {
  command?: string;
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

export type HarnessIngestSpec = {
  operation: string;
  errorCode: string;
  errorMessage: string;
  normalize: (
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ) => HarnessEventObservation[] | Promise<HarnessEventObservation[]>;
};

export type TerminalBoundHarnessProviderSpec<TOpts extends CommonHarnessProviderOptions> = {
  id: ProviderId;
  displayName: string;
  commandEnvVar: string;
  commandFallback: string;
  baseCapabilities: HarnessCapabilities;
  resumeFromOptions?: (options: TOpts) => boolean;
  health: HarnessHealthSpec;
  buildLaunch: (
    options: TOpts,
    request: BuildHarnessLaunchRequest,
  ) => HarnessLaunchPlan | Promise<HarnessLaunchPlan>;
  classifyRun: (run: HarnessRunObservation) => HarnessStatusObservation;
  ingestEvent?: HarnessIngestSpec;
  acceptsPersistedEvent?: (observation: HarnessEventObservation) => boolean;
  doctorChecks?: (
    options: TOpts,
    context?: ProviderDoctorContext,
  ) => Promise<ProviderDoctorCheck[]>;
  version?: HarnessVersionSpec;
  hooksStatus?: (options: TOpts, context?: ProviderDoctorContext) => Promise<HarnessHooksStatus>;
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
        }),
      ),
    classifyRun: (run) => Promise.resolve(spec.classifyRun(run)),
    buildLaunch: (request) => Promise.resolve(spec.buildLaunch(options, request)),
  };
  // Optional interface methods stay absent (never `= undefined`) so `'x' in provider`
  // feature-detection holds and exactOptionalPropertyTypes is respected.
  const ingest = spec.ingestEvent;
  if (ingest) {
    provider.ingestEvent = (event, context) => harnessIngest(ingest, spec.id, event, context);
  }
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
      providerId: spec.id,
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
      providerId: spec.id,
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
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
};

export type CommonHookDoctorOptions = {
  enabled: boolean;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  stationConfigPath?: string;
};

/** The hook-doctor option subset shared by claude/codex/cursor; adapters spread-and-extend. */
export function harnessHookDoctorOptions(
  options: HarnessHookDoctorOptionsInput,
  context?: ProviderDoctorContext,
): CommonHookDoctorOptions {
  const result: CommonHookDoctorOptions = { enabled: options.installHooks === true };
  if (options.observerSocketPath !== undefined) {
    result.observerSocketPath = options.observerSocketPath;
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
  return result;
}

export function harnessHooksStatusFrom(
  provider: ProviderId,
  requested: boolean,
  result: { installed: boolean; missing: readonly unknown[]; message: string },
): HarnessHooksStatus {
  return {
    provider,
    installed: result.installed,
    requested,
    missing: result.missing.map((name) => String(name)),
    message: result.message,
  };
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

async function harnessIngest(
  spec: HarnessIngestSpec,
  provider: ProviderId,
  event: RawHarnessEvent,
  context: HarnessEventContext,
): Promise<HarnessEventObservation[]> {
  const result = await runRuntimeBoundary(
    {
      operation: spec.operation,
      error: {
        tag: "HarnessProviderError",
        code: spec.errorCode,
        message: spec.errorMessage,
        provider,
      },
    },
    async () => spec.normalize(event, context),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
