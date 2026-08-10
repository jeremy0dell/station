import type {
  HarnessCapabilities,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import {
  forEachConcurrent,
  publicSafeErrorFromUnknown,
  type RuntimeClock,
  runRuntimeBoundaryWithRetryAndTimeout,
  toIsoTimestamp,
} from "@station/runtime";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StationLogger } from "../stationLogger.js";
import { safeErrorToProviderHealth } from "./graph.js";
import type { ObserverHarnessRun } from "./harnessEventStatus.js";

export type ProviderReadOptions = {
  clock: RuntimeClock;
  timeoutMs: number;
  retries: number;
  logger?: StationLogger;
};

// Caps concurrent provider subprocesses (wt list / listTargets) per reconcile.
const providerReadConcurrency = 4;

/**
 * Reads worktrees with bounded provider concurrency while preserving project order and health errors.
 */
export async function readWorktreeObservations(input: {
  providers: ProviderRegistry;
  projects: ProviderProjectConfig[];
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  worktrees: WorktreeObservation[];
  projectsScanned: number;
}> {
  const provider = input.providers.worktree;
  const capabilities = provider.capabilities();

  input.providerHealth[provider.id] = cachedProviderHealth({
    providers: input.providers,
    providerId: provider.id,
    providerType: "worktree",
    capabilities,
    clock: input.read.clock,
  });

  // Indexed collection keeps worktree order deterministic (config project order)
  // while listWorktrees calls run concurrently.
  const worktreesByProject: WorktreeObservation[][] = input.projects.map(() => []);
  let projectsScanned = 0;
  // One provider-level failure stops the remaining project scans: a hung
  // provider would otherwise burn its full timeout budget once per project.
  let providerFailed = false;
  await forEachConcurrent(
    input.projects,
    { concurrency: providerReadConcurrency },
    async (project, index) => {
      if (providerFailed) {
        return;
      }
      const result = await runProviderReadBoundary(
        {
          operation: `provider.${provider.id}.listWorktrees`,
          clock: input.read.clock,
          timeoutMs: input.read.timeoutMs,
          retries: input.read.retries,
          error: {
            tag: "WorktreeProviderError",
            code: "WORKTREE_LIST_FAILED",
            message: "The worktree provider failed to list worktrees.",
            provider: provider.id,
          },
        },
        () => provider.listWorktrees(project),
      );
      if (!result.ok) {
        providerFailed = true;
        await recordProviderReadFailure({
          providers: input.providers,
          providerId: provider.id,
          providerType: "worktree",
          message: "Worktree provider list failed.",
          error: result.error,
          timing: result.timing,
          capabilities,
          providerHealth: input.providerHealth,
          errors: input.errors,
          logger: input.read.logger,
        });
        return;
      }

      projectsScanned += 1;
      worktreesByProject[index] = result.value;
    },
  );

  return { worktrees: worktreesByProject.flat(), projectsScanned };
}

/**
 * Reads all terminal providers concurrently, retaining registration order and failure health.
 */
export async function readTerminalTargetObservations(input: {
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  terminalTargets: TerminalTargetObservation[];
}> {
  const providers = Array.from(input.providers.terminals.values());
  // Indexed collection keeps target order deterministic (provider registration
  // order) while listTargets calls run concurrently.
  const targetsByProvider: TerminalTargetObservation[][] = providers.map(() => []);

  await forEachConcurrent(
    providers,
    { concurrency: providerReadConcurrency },
    async (provider, index) => {
      const capabilities = provider.capabilities();

      input.providerHealth[provider.id] = cachedProviderHealth({
        providers: input.providers,
        providerId: provider.id,
        providerType: "terminal",
        capabilities,
        clock: input.read.clock,
      });

      const result = await runProviderReadBoundary(
        {
          operation: `provider.${provider.id}.listTargets`,
          clock: input.read.clock,
          timeoutMs: input.read.timeoutMs,
          retries: input.read.retries,
          error: {
            tag: "TerminalProviderError",
            code: "TERMINAL_LIST_FAILED",
            message: "The terminal provider failed to list targets.",
            provider: provider.id,
          },
        },
        () => provider.listTargets(),
      );
      if (result.ok) {
        targetsByProvider[index] = result.value;
      } else {
        await recordProviderReadFailure({
          providers: input.providers,
          providerId: provider.id,
          providerType: "terminal",
          message: "Terminal provider list failed.",
          error: result.error,
          timing: result.timing,
          capabilities,
          providerHealth: input.providerHealth,
          errors: input.errors,
          logger: input.read.logger,
        });
      }
    },
  );

  return { terminalTargets: targetsByProvider.flat() };
}

/**
 * Discovers and classifies harness runs sequentially per provider with the shared read boundary.
 */
export async function readHarnessObservations(input: {
  providers: ProviderRegistry;
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  harnessRuns: ObserverHarnessRun[];
  harnessCapabilities: Record<string, HarnessCapabilities>;
}> {
  const harnessRuns: ObserverHarnessRun[] = [];
  const harnessCapabilities: Record<string, HarnessCapabilities> = {};

  for (const provider of input.providers.harnesses.values()) {
    const capabilities = provider.capabilities();
    harnessCapabilities[provider.id] = capabilities;
    input.providerHealth[provider.id] = cachedProviderHealth({
      providers: input.providers,
      providerId: provider.id,
      providerType: "harness",
      capabilities,
      clock: input.read.clock,
    });

    const result = await runProviderReadBoundary(
      {
        operation: `provider.${provider.id}.discoverRuns`,
        clock: input.read.clock,
        timeoutMs: input.read.timeoutMs,
        retries: input.read.retries,
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_DISCOVER_FAILED",
          message: "The harness provider failed to discover runs.",
          provider: provider.id,
        },
      },
      () =>
        provider.discoverRuns({
          projects: input.projects,
          worktrees: input.worktrees,
          terminalTargets: input.terminalTargets,
        }),
    );

    if (result.ok) {
      const classifiedRuns = await classifyHarnessRuns({
        providers: input.providers,
        provider,
        capabilities,
        runs: result.value,
        projects: input.projects,
        worktrees: input.worktrees,
        terminalTargets: input.terminalTargets,
        read: input.read,
        providerHealth: input.providerHealth,
        errors: input.errors,
      });
      harnessRuns.push(...classifiedRuns);
      continue;
    }

    await recordProviderReadFailure({
      providers: input.providers,
      providerId: provider.id,
      providerType: "harness",
      message: "Harness provider discovery failed.",
      error: result.error,
      timing: result.timing,
      capabilities,
      providerHealth: input.providerHealth,
      errors: input.errors,
      logger: input.read.logger,
    });
  }

  return { harnessRuns, harnessCapabilities };
}

/**
 * Reads repository provider health from the out-of-band cache without waiting for probes.
 */
export function readRepositoryProviderHealth(input: {
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
}): void {
  for (const provider of input.providers.repositories.values()) {
    input.providerHealth[provider.id] = cachedProviderHealth({
      providers: input.providers,
      providerId: provider.id,
      providerType: "repository",
      capabilities: provider.capabilities(),
      clock: input.read.clock,
    });
  }
}

async function classifyHarnessRuns(input: {
  providers: ProviderRegistry;
  provider: HarnessProvider;
  capabilities: HarnessCapabilities;
  runs: HarnessRunObservation[];
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<ObserverHarnessRun[]> {
  const classifiedRuns: ObserverHarnessRun[] = [];
  for (const run of input.runs) {
    const classification = await runProviderReadBoundary(
      {
        operation: `provider.${input.provider.id}.classifyRun`,
        clock: input.read.clock,
        timeoutMs: input.read.timeoutMs,
        retries: input.read.retries,
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_CLASSIFY_FAILED",
          message: "The harness provider failed to classify a run.",
          provider: input.provider.id,
        },
      },
      () =>
        input.provider.classifyRun(run, {
          projects: input.projects,
          worktrees: input.worktrees,
          terminalTargets: input.terminalTargets,
        }),
    );

    if (classification.ok) {
      classifiedRuns.push(runWithStatus(run, classification.value));
      continue;
    }

    await recordProviderReadFailure({
      providers: input.providers,
      providerId: input.provider.id,
      providerType: "harness",
      message: "Harness provider classification failed.",
      error: classification.error,
      timing: classification.timing,
      capabilities: input.capabilities,
      providerHealth: input.providerHealth,
      errors: input.errors,
      logger: input.read.logger,
    });
  }

  return classifiedRuns;
}

// Reconcile never awaits a health probe: it reads the out-of-band cache and
// reports "unknown" until the first probe lands.
function cachedProviderHealth(input: {
  providers: ProviderRegistry;
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  capabilities: Record<string, boolean>;
  clock: RuntimeClock;
}): ProviderHealth {
  const cached = input.providers.healthCache.read(input.providerId);
  if (cached !== undefined) {
    return cached;
  }
  return {
    providerId: input.providerId,
    providerType: input.providerType,
    status: "unknown",
    lastCheckedAt: toIsoTimestamp(input.clock.now()),
    capabilities: input.capabilities,
  };
}

function runProviderReadBoundary<T>(
  input: {
    operation: string;
    clock: RuntimeClock;
    timeoutMs: number;
    retries: number;
    error: {
      tag: string;
      code: string;
      message: string;
      provider: string;
    };
  },
  task: () => Promise<T>,
) {
  return runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: input.operation,
      clock: input.clock,
      timeoutMs: input.timeoutMs,
      error: input.error,
      timeoutError: {
        tag: "TimeoutError",
        code: "PROVIDER_TIMEOUT",
        message: "Provider operation timed out.",
        provider: input.error.provider,
      },
      retry: {
        retries: input.retries,
        delayMs: 10,
      },
    },
    task,
  );
}

async function recordProviderReadFailure(input: {
  providers: ProviderRegistry;
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  message: string;
  error: SafeError;
  timing: { finishedAt: string; durationMs: number };
  capabilities: Record<string, boolean>;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
  logger: StationLogger | undefined;
}): Promise<void> {
  input.errors.push(
    publicSafeErrorFromUnknown(input.error, {
      tag: input.error.tag,
      code: input.error.code,
      message: input.error.message,
      provider: input.providerId,
    }),
  );
  await input.logger?.error(input.message, {
    provider: input.providerId,
    error: input.error,
    durationMs: input.timing.durationMs,
  });
  input.providerHealth[input.providerId] = failedProviderHealth({
    providerId: input.providerId,
    providerType: input.providerType,
    lastCheckedAt: input.timing.finishedAt,
    lastError: input.error,
    latencyMs: input.timing.durationMs,
    capabilities: input.capabilities,
  });
  // Re-probe only when the cache still says healthy; a fresh cached failure
  // needs no confirmation, and read() already schedules stale refreshes.
  if (input.providers.healthCache.read(input.providerId)?.status === "healthy") {
    void input.providers.healthCache.refresh(input.providerId);
  }
}

function failedProviderHealth(input: {
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  lastCheckedAt: string;
  lastError: SafeError;
  latencyMs: number;
  capabilities: Record<string, boolean>;
}): ProviderHealth {
  return safeErrorToProviderHealth({
    providerId: input.providerId,
    providerType: input.providerType,
    lastCheckedAt: input.lastCheckedAt,
    lastError: publicSafeErrorFromUnknown(input.lastError, {
      tag: input.lastError.tag,
      code: input.lastError.code,
      message: input.lastError.message,
      provider: input.providerId,
    }),
    latencyMs: input.latencyMs,
    capabilities: input.capabilities,
  });
}

function runWithStatus(
  run: HarnessRunObservation,
  classification: HarnessStatusObservation,
): ObserverHarnessRun {
  const nextRun: HarnessRunObservation = {
    id: run.id,
    provider: run.provider,
    state: classification.status.value,
    confidence: classification.status.confidence,
    reason: classification.status.reason,
    observedAt: run.observedAt,
  };
  const projectId = classification.projectId ?? run.projectId;
  const worktreeId = classification.worktreeId ?? run.worktreeId;
  const sessionId = classification.sessionId ?? run.sessionId;
  const providerData = classification.providerData ?? run.providerData;
  if (projectId !== undefined) nextRun.projectId = projectId;
  if (worktreeId !== undefined) nextRun.worktreeId = worktreeId;
  if (sessionId !== undefined) nextRun.sessionId = sessionId;
  if (run.nativeSessionId !== undefined) nextRun.nativeSessionId = run.nativeSessionId;
  if (run.pid !== undefined) nextRun.pid = run.pid;
  if (run.cwd !== undefined) nextRun.cwd = run.cwd;
  if (providerData !== undefined) nextRun.providerData = providerData;
  return {
    run: nextRun,
    status: classification.status,
  };
}
