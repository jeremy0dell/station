import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessClassificationContext,
  HarnessDiscoveryContext,
  HarnessEventContext,
  HarnessEventObservation,
  HarnessHooksStatus,
  HarnessLaunchPlan,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderDoctorCheck,
  ProviderDoctorContext,
  ProviderHealth,
  ProviderId,
  RawHarnessEvent,
} from "@station/contracts";
import { discoverTerminalBoundHarnessRuns } from "@station/contracts";
import {
  type ExternalCommandResult,
  type ExternalCommandRunner,
  runExternalCommand,
  runRuntimeBoundary,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";

export type CommonHarnessProviderOptions = {
  command?: string;
  installHooks?: boolean;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
  resume?: boolean;
  now?: () => Date | string;
  timeoutMs?: number;
  runner?: ExternalCommandRunner;
};

export type HarnessCommandSpec = {
  envVar?: string;
  fallback: string;
};

export type HarnessHealthSpec = {
  args: string[];
  unavailable: {
    code: string;
    message: string;
    hint?: string;
  };
  diagnostics?: (result: ExternalCommandResult) => Record<string, string>;
  okDoctorCheck?: {
    name: string;
    okMessage: string;
    errorMessage: string;
    stopOnFailure?: boolean;
  };
};

export type HarnessHookDoctorResult = {
  status: "ok" | "warn";
  installed: boolean;
  missing?: readonly unknown[];
  message: string;
};

export type HarnessHookDoctorSpec<
  TOptions extends CommonHarnessProviderOptions,
  THookOptions,
  THookResult extends HarnessHookDoctorResult,
> = {
  doctor: (options: THookOptions) => Promise<THookResult>;
  buildOptions: (options: TOptions, context?: ProviderDoctorContext) => THookOptions;
  checkName: string;
  failure: {
    tag: string;
    code: string;
    message: string;
  };
  formatCheckMessage: (result: THookResult) => string;
  exposeHooksStatus?: boolean;
};

export type TerminalBoundHarnessProviderSpec<
  TOptions extends CommonHarnessProviderOptions,
  TLaunchOptions,
  THookOptions = never,
  THookResult extends HarnessHookDoctorResult = HarnessHookDoctorResult,
> = {
  id: ProviderId;
  displayName: string;
  command: HarnessCommandSpec;
  baseCapabilities: HarnessCapabilities;
  health?: HarnessHealthSpec;
  hooks?: HarnessHookDoctorSpec<TOptions, THookOptions, THookResult>;
  buildLaunchOptions: (options: TOptions, command: string) => TLaunchOptions;
  buildLaunch: (
    request: BuildHarnessLaunchRequest,
    options: TLaunchOptions,
  ) => HarnessLaunchPlan | Promise<HarnessLaunchPlan>;
  classifyRun: (
    run: HarnessRunObservation,
    context: HarnessClassificationContext,
  ) => HarnessStatusObservation | Promise<HarnessStatusObservation>;
  normalizeEvent?: (
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ) => HarnessEventObservation[] | Promise<HarnessEventObservation[]>;
  extraDoctorChecks?: (
    options: TOptions,
    provider: TerminalBoundHarnessProvider<TOptions, TLaunchOptions, THookOptions, THookResult>,
  ) => Promise<ProviderDoctorCheck[]>;
};

export class TerminalBoundHarnessProvider<
  TOptions extends CommonHarnessProviderOptions,
  TLaunchOptions,
  THookOptions = never,
  THookResult extends HarnessHookDoctorResult = HarnessHookDoctorResult,
> implements HarnessProvider
{
  readonly id: ProviderId;

  protected readonly spec: TerminalBoundHarnessProviderSpec<
    TOptions,
    TLaunchOptions,
    THookOptions,
    THookResult
  >;
  protected readonly providerOptions: TOptions;

  constructor(
    spec: TerminalBoundHarnessProviderSpec<TOptions, TLaunchOptions, THookOptions, THookResult>,
    options: TOptions,
  ) {
    this.spec = spec;
    this.providerOptions = options;
    this.id = spec.id;
  }

  command(): string {
    return harnessCommand(this.providerOptions, this.spec.command);
  }

  capabilities(): HarnessCapabilities {
    return harnessCapabilities(this.spec.baseCapabilities, this.providerOptions);
  }

  async health(): Promise<ProviderHealth> {
    if (this.spec.health === undefined) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "healthy",
        lastCheckedAt: harnessNow(this.providerOptions),
        capabilities: this.capabilities(),
      };
    }
    const checkedAt = harnessNow(this.providerOptions);
    try {
      const result = await runExternalCommand(
        {
          command: this.command(),
          args: this.spec.health.args,
          timeoutMs: this.providerOptions.timeoutMs ?? 5000,
          maxOutputChars: 4096,
        },
        this.providerOptions.runner,
      );
      const health: ProviderHealth = {
        providerId: this.id,
        providerType: "harness",
        status: "healthy",
        lastCheckedAt: checkedAt,
        capabilities: this.capabilities(),
      };
      const diagnostics = this.spec.health.diagnostics?.(result);
      if (diagnostics !== undefined) health.diagnostics = diagnostics;
      return health;
    } catch (error) {
      return {
        providerId: this.id,
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: this.unavailableErrorFromUnknown(error),
        capabilities: this.capabilities(),
      };
    }
  }

  async doctorChecks(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck[]> {
    const checks: ProviderDoctorCheck[] = [];
    if (this.spec.health?.okDoctorCheck !== undefined) {
      const health = await this.health();
      if (health.status === "healthy") {
        checks.push({
          name: this.spec.health.okDoctorCheck.name,
          status: "ok",
          message: this.spec.health.okDoctorCheck.okMessage,
        });
      } else {
        const check: ProviderDoctorCheck = {
          name: this.spec.health.okDoctorCheck.name,
          status: "error",
          message: this.spec.health.okDoctorCheck.errorMessage,
        };
        if (health.lastError !== undefined) check.error = health.lastError;
        checks.push(check);
        if (this.spec.health.okDoctorCheck.stopOnFailure === true) return checks;
      }
    }

    if (this.spec.extraDoctorChecks !== undefined) {
      checks.push(...(await this.spec.extraDoctorChecks(this.providerOptions, this)));
    }
    if (this.spec.hooks !== undefined) {
      checks.push(await this.hookDoctorCheck(context));
    }
    return checks;
  }

  async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    return this.spec.buildLaunch(
      request,
      this.spec.buildLaunchOptions(this.providerOptions, this.command()),
    );
  }

  async discoverRuns(context: HarnessDiscoveryContext): Promise<HarnessRunObservation[]> {
    return discoverTerminalBoundHarnessRuns(context, {
      harnessProvider: this.id,
      displayName: this.spec.displayName,
      role: "main-agent",
    });
  }

  async classifyRun(
    run: HarnessRunObservation,
    context: HarnessClassificationContext,
  ): Promise<HarnessStatusObservation> {
    return this.spec.classifyRun(run, context);
  }

  async ingestEvent(
    event: RawHarnessEvent,
    context: HarnessEventContext,
  ): Promise<HarnessEventObservation[]> {
    if (this.spec.normalizeEvent === undefined) return [];
    const result = await runRuntimeBoundary(
      {
        operation: `provider.${this.id}.ingestEvent`,
        error: {
          tag: "HarnessProviderError",
          code: `HARNESS_${this.id.toUpperCase()}_EVENT_INGEST_FAILED`,
          message: `The ${this.spec.displayName} harness provider failed to ingest an event.`,
          provider: this.id,
        },
      },
      async () => this.spec.normalizeEvent?.(event, context) ?? [],
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  protected async hookStatus(context?: ProviderDoctorContext): Promise<HarnessHooksStatus> {
    const hooks = this.spec.hooks;
    if (hooks === undefined || hooks.exposeHooksStatus !== true) {
      throw new Error(`${this.id} hooks status is not supported.`);
    }
    const result = await hooks.doctor(hooks.buildOptions(this.providerOptions, context));
    return {
      provider: this.id,
      installed: result.installed,
      requested: this.providerOptions.installHooks === true,
      missing: (result.missing ?? []).map((name) => String(name)),
      message: result.message,
    };
  }

  protected async hookDoctorCheck(context?: ProviderDoctorContext): Promise<ProviderDoctorCheck> {
    const hooks = this.spec.hooks;
    if (hooks === undefined) throw new Error("unreachable");
    try {
      const hookResult = await hooks.doctor(hooks.buildOptions(this.providerOptions, context));
      return {
        name: hooks.checkName,
        status: hookResult.status,
        message: hooks.formatCheckMessage(hookResult),
      };
    } catch (cause) {
      return {
        name: hooks.checkName,
        status: "error",
        message: hooks.failure.message,
        error: safeErrorFromUnknown(cause, {
          tag: hooks.failure.tag,
          code: hooks.failure.code,
          message: hooks.failure.message,
          provider: this.id,
        }),
      };
    }
  }

  protected unavailableErrorFromUnknown(error: unknown) {
    const health = this.spec.health;
    const safeFallback: {
      tag: "HarnessProviderError";
      code: string;
      message: string;
      hint?: string;
      provider: ProviderId;
    } = {
      tag: "HarnessProviderError",
      code: health?.unavailable.code ?? `HARNESS_${this.id.toUpperCase()}_UNAVAILABLE`,
      message: health?.unavailable.message ?? `${this.spec.displayName} is not available.`,
      provider: this.id,
    };
    if (health?.unavailable.hint !== undefined) safeFallback.hint = health.unavailable.hint;
    return Object.assign(
      new Error(`${safeFallback.code}: ${safeFallback.message}`, { cause: error }),
      safeFallback,
    );
  }
}

export class TerminalBoundHarnessProviderWithHooksStatus<
  TOptions extends CommonHarnessProviderOptions,
  TLaunchOptions,
  THookOptions = never,
  THookResult extends HarnessHookDoctorResult = HarnessHookDoctorResult,
> extends TerminalBoundHarnessProvider<TOptions, TLaunchOptions, THookOptions, THookResult> {
  async hooksStatus(context?: ProviderDoctorContext): Promise<HarnessHooksStatus> {
    return this.hookStatus(context);
  }
}

function harnessCommand(
  options: Pick<CommonHarnessProviderOptions, "command">,
  spec: HarnessCommandSpec,
): string {
  const envCommand = spec.envVar === undefined ? undefined : process.env[spec.envVar];
  return options.command ?? envCommand ?? spec.fallback;
}

function harnessNow(options: Pick<CommonHarnessProviderOptions, "now">): string {
  const value = options.now?.() ?? systemClock.now();
  return toIsoTimestamp(value instanceof Date ? value : new Date(value));
}

function harnessCapabilities(
  baseCapabilities: HarnessCapabilities,
  options: Pick<CommonHarnessProviderOptions, "resume">,
): HarnessCapabilities {
  return {
    ...baseCapabilities,
    canResume: options.resume === true,
  };
}

export function hookOptions<
  TOptions extends Partial<CommonHarnessProviderOptions> & { configPath?: string },
>(options: TOptions, context?: ProviderDoctorContext) {
  const output: {
    enabled: boolean;
    observerSocketPath?: string;
    stateDir?: string;
    hookSpoolDir?: string;
    autoStartFromHooks?: boolean;
    stationConfigPath?: string;
  } = {
    enabled: options.installHooks === true,
  };
  if (options.observerSocketPath !== undefined)
    output.observerSocketPath = options.observerSocketPath;
  if (options.stateDir !== undefined) output.stateDir = options.stateDir;
  if (options.hookSpoolDir !== undefined) output.hookSpoolDir = options.hookSpoolDir;
  if (options.autoStartFromHooks !== undefined)
    output.autoStartFromHooks = options.autoStartFromHooks;
  if (context?.stationConfigPath !== undefined) {
    output.stationConfigPath = context.stationConfigPath;
  } else if (options.configPath !== undefined) {
    output.stationConfigPath = options.configPath;
  }
  return output;
}
