import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ObserverPaths } from "@station/config";
import type {
  ProviderHookEvent,
  ProviderHookPayloadSummary,
  ProviderHookReceipt,
  SafeError,
} from "@station/contracts";
import { ProviderHookReceiptSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { safeErrorFromUnknown, stationObserverBuildVersion, systemClock } from "@station/runtime";
import { classifyObserverHealth, observerHandoffRefusedError } from "../observerProcess/health.js";
import {
  getProviderHookObserverStatus,
  type ProviderHookObserverCommand,
  type ProviderHookObserverStartupDeps,
  startProviderHookObserver,
  waitForProviderHookObserverHealth,
} from "./observerStartup.js";

export type ProviderDeliveryAttempt = {
  receipt?: ProviderHookReceipt;
  error?: SafeError;
};

type ReceiptRecorder = (input: {
  paths: ObserverPaths;
  event: ProviderHookEvent;
  payloadSummary: ProviderHookPayloadSummary;
  receipt: ProviderHookReceipt;
}) => ProviderHookReceipt | Promise<ProviderHookReceipt>;

const autoStartLockName = "hook-autostart.lock";
const minimumAutoStartLockStaleMs = 5000;
const nonSpoolableErrorCodes = new Set([
  "OBSERVER_BUILD_MISMATCH",
  "OBSERVER_HANDOFF_PENDING",
  "OBSERVER_HANDOFF_REFUSED",
  "PROTOCOL_SCHEMA_MISMATCH",
]);

/**
 * USE CASE
 *
 * Gates provider-hook delivery on Observer build compatibility, negotiates an
 * allowed replacement before retrying, spools offline events, and rejects known incompatibility.
 */
export async function deliverProviderHookWithSpooling(input: {
  paths: ObserverPaths;
  event: ProviderHookEvent;
  payloadSummary: ProviderHookPayloadSummary;
  autoStart: boolean;
  startupTimeoutMs: number;
  rateLimitMs: number;
  configPath?: string;
  observerCommand?: ProviderHookObserverCommand;
  deps: ProviderHookObserverStartupDeps;
  /** Sends only through a client pinned to the selector proven by readiness. */
  deliver: (expectedBuildVersion: string) => Promise<ProviderDeliveryAttempt>;
  spoolReceipt: (error: SafeError | undefined) => Promise<ProviderHookReceipt>;
  recordReceipt?: ReceiptRecorder;
}): Promise<ProviderHookReceipt> {
  const startupDeadlineMs = Date.now() + input.startupTimeoutMs;
  const readiness = await prepareObserverForDelivery(input, startupDeadlineMs);
  if (!readiness.ok) {
    return settleUndelivered(input, readiness.error);
  }

  const firstDelivery = await input.deliver(readiness.buildVersion);
  if (firstDelivery.receipt !== undefined) {
    return recordReceipt(input, firstDelivery.receipt);
  }

  if (input.autoStart) {
    const startupInput: Parameters<typeof maybeStartObserver>[0] = {
      paths: input.paths,
      startupDeadlineMs,
      rateLimitMs: input.rateLimitMs,
      deps: input.deps,
    };
    if (input.configPath !== undefined) {
      startupInput.configPath = input.configPath;
    }
    if (input.observerCommand !== undefined) {
      startupInput.observerCommand = input.observerCommand;
    }
    const startResult = await maybeStartObserver(startupInput);
    if (startResult.ok) {
      const retryDelivery = await input.deliver(startResult.buildVersion);
      if (retryDelivery.receipt !== undefined) {
        return recordReceipt(input, retryDelivery.receipt);
      }
      return settleUndelivered(input, retryDelivery.error);
    }
    return settleUndelivered(input, startResult.error);
  }

  return settleUndelivered(input, firstDelivery.error);
}

async function settleUndelivered(
  input: Parameters<typeof deliverProviderHookWithSpooling>[0],
  error: SafeError | undefined,
): Promise<ProviderHookReceipt> {
  if (error?.code !== undefined && nonSpoolableErrorCodes.has(error.code)) {
    return recordReceipt(
      input,
      ProviderHookReceiptSchema.parse({
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: input.event.hookId ?? `hook_rejected_${Date.now()}`,
        provider: input.event.provider,
        event: input.event.event,
        accepted: false,
        status: "rejected",
        receivedAt: input.event.receivedAt,
        error,
      }),
    );
  }
  return recordReceipt(input, await input.spoolReceipt(error));
}

async function prepareObserverForDelivery(
  input: {
    paths: ObserverPaths;
    autoStart: boolean;
    startupTimeoutMs: number;
    rateLimitMs: number;
    configPath?: string;
    observerCommand?: ProviderHookObserverCommand;
    deps: ProviderHookObserverStartupDeps;
  },
  startupDeadlineMs: number,
): Promise<{ ok: true; buildVersion: string } | { ok: false; error: SafeError }> {
  const statusTimeoutMs = remainingStartupBudgetMs(startupDeadlineMs);
  if (statusTimeoutMs === undefined) return providerHookStartupTimedOut();
  const statusOptions: Parameters<typeof getProviderHookObserverStatus>[0] = {
    paths: input.paths,
    timeoutMs: statusTimeoutMs,
  };
  if (input.configPath !== undefined) statusOptions.configPath = input.configPath;
  if (input.observerCommand !== undefined) {
    statusOptions.observerCommand = input.observerCommand;
  }
  const status = await getProviderHookObserverStatus(statusOptions, input.deps);
  if (status.status === "running") {
    const buildVersion = input.deps.buildVersion ?? stationObserverBuildVersion();
    const classification = classifyObserverHealth(status.health, buildVersion);
    if (classification.action === "attach") {
      if (status.health.version !== undefined) {
        return { ok: true, buildVersion: status.health.version };
      }
      return {
        ok: false,
        error: observerHandoffRefusedError(
          status.health,
          buildVersion,
          "The running Observer did not report a build version.",
        ),
      };
    }
    if (classification.action === "refuse" || !input.autoStart) {
      return {
        ok: false,
        error: observerHandoffRefusedError(
          status.health,
          buildVersion,
          classification.action === "refuse"
            ? classification.reason
            : "The running Observer is older and provider-hook auto-start is disabled.",
        ),
      };
    }
  } else if (status.error?.code === "PROTOCOL_SCHEMA_MISMATCH" || !input.autoStart) {
    return {
      ok: false,
      error:
        status.error ??
        safeErrorFromUnknown(undefined, {
          tag: "ObserverConnectionError",
          code: "OBSERVER_NOT_RUNNING",
          message: "Observer is not running.",
        }),
    };
  }

  const startupInput: Parameters<typeof maybeStartObserver>[0] = {
    paths: input.paths,
    startupDeadlineMs,
    rateLimitMs: input.rateLimitMs,
    deps: input.deps,
  };
  if (input.configPath !== undefined) startupInput.configPath = input.configPath;
  if (input.observerCommand !== undefined) {
    startupInput.observerCommand = input.observerCommand;
  }
  return maybeStartObserver(startupInput);
}

async function recordReceipt(
  input: {
    paths: ObserverPaths;
    event: ProviderHookEvent;
    payloadSummary: ProviderHookPayloadSummary;
    recordReceipt?: ReceiptRecorder;
  },
  receipt: ProviderHookReceipt,
): Promise<ProviderHookReceipt> {
  if (input.recordReceipt === undefined) {
    return receipt;
  }
  return input.recordReceipt({
    paths: input.paths,
    event: input.event,
    payloadSummary: input.payloadSummary,
    receipt,
  });
}

async function maybeStartObserver(input: {
  paths: ObserverPaths;
  configPath?: string;
  observerCommand?: ProviderHookObserverCommand;
  startupDeadlineMs: number;
  rateLimitMs: number;
  deps: ProviderHookObserverStartupDeps;
}) {
  const timeoutMs = remainingStartupBudgetMs(input.startupDeadlineMs);
  if (timeoutMs === undefined) return providerHookStartupTimedOut();
  const lock = await acquireAutoStartLock({
    paths: input.paths,
    staleMs: Math.max(input.rateLimitMs, timeoutMs, minimumAutoStartLockStaleMs),
    deps: input.deps,
  });

  if (lock.status === "contended") {
    const contendedTimeoutMs = remainingStartupBudgetMs(input.startupDeadlineMs);
    if (contendedTimeoutMs === undefined) return providerHookStartupTimedOut();
    return waitForContendedAutoStart({
      paths: input.paths,
      timeoutMs: contendedTimeoutMs,
      deps: input.deps,
    });
  }
  if (lock.status === "failed") {
    return { ok: false as const, error: lock.error };
  }

  try {
    const startupTimeoutMs = remainingStartupBudgetMs(input.startupDeadlineMs);
    if (startupTimeoutMs === undefined) return providerHookStartupTimedOut();
    const startupOptions: Parameters<typeof startProviderHookObserver>[0] = {
      paths: input.paths,
      timeoutMs: startupTimeoutMs,
      startupDeadlineMs: input.startupDeadlineMs,
    };
    if (input.configPath !== undefined) {
      startupOptions.configPath = input.configPath;
    }
    if (input.observerCommand !== undefined) {
      startupOptions.observerCommand = input.observerCommand;
    }
    const started = await startProviderHookObserver(startupOptions, input.deps);
    if (started.status === "running") {
      if (started.health.version !== undefined) {
        return { ok: true as const, buildVersion: started.health.version };
      }
      return {
        ok: false as const,
        error: observerHandoffRefusedError(
          started.health,
          input.deps.buildVersion ?? stationObserverBuildVersion(),
          "The running Observer did not report a build version.",
        ),
      };
    }
    return {
      ok: false as const,
      error:
        started.error ??
        safeErrorFromUnknown(undefined, {
          tag: "ObserverStartupError",
          code: "OBSERVER_START_FAILED",
          message: "Observer could not be started for provider hook delivery.",
        }),
    };
  } finally {
    await lock.release();
  }
}

function remainingStartupBudgetMs(deadlineMs: number): number | undefined {
  const remainingMs = Math.floor(deadlineMs - Date.now());
  return remainingMs > 0 ? remainingMs : undefined;
}

function providerHookStartupTimedOut(): { ok: false; error: SafeError } {
  return {
    ok: false,
    error: {
      tag: "ObserverStartupError",
      code: "OBSERVER_START_FAILED",
      message: "Observer did not become healthy before the startup timeout.",
    },
  };
}

type AutoStartLock =
  | {
      status: "acquired";
      release(): Promise<void>;
    }
  | {
      status: "contended";
    }
  | {
      status: "failed";
      error: SafeError;
    };

async function acquireAutoStartLock(input: {
  paths: ObserverPaths;
  staleMs: number;
  deps: ProviderHookObserverStartupDeps;
}): Promise<AutoStartLock> {
  const lockDir = autoStartLockDir(input.paths);
  try {
    await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      status: "failed",
      error: safeErrorFromUnknown(error, {
        tag: "HookAutoStartLockError",
        code: "HOOK_AUTOSTART_LOCK_FAILED",
        message: "Observer auto-start lock directory could not be prepared.",
      }),
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeAutoStartLockOwner(lockDir, input.deps);
      return {
        status: "acquired",
        release: async () => {
          await rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          status: "failed",
          error: safeErrorFromUnknown(error, {
            tag: "HookAutoStartLockError",
            code: "HOOK_AUTOSTART_LOCK_FAILED",
            message: "Observer auto-start lock could not be acquired.",
          }),
        };
      }
      if (await isAutoStartLockStale(lockDir, input.staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      return { status: "contended" };
    }
  }

  return { status: "contended" };
}

async function waitForContendedAutoStart(input: {
  paths: ObserverPaths;
  timeoutMs: number;
  deps: ProviderHookObserverStartupDeps;
}) {
  try {
    const health = await waitForProviderHookObserverHealth(
      {
        paths: input.paths,
        timeoutMs: input.timeoutMs,
      },
      input.deps,
    );
    if (health.version === undefined) {
      throw new Error("The running Observer did not report a build version.");
    }
    return { ok: true as const, buildVersion: health.version };
  } catch (error) {
    return {
      ok: false as const,
      error: safeErrorFromUnknown(error, {
        tag: "HookAutoStartLockError",
        code: "HOOK_AUTOSTART_LOCKED",
        message: "Observer did not become healthy while another hook was starting it.",
      }),
    };
  }
}

function autoStartLockDir(paths: ObserverPaths): string {
  // This state-dir lock throttles hook spawns only; the child claim owns Observer boot.
  return join(paths.stateDir, "run", autoStartLockName);
}

async function writeAutoStartLockOwner(
  lockDir: string,
  deps: ProviderHookObserverStartupDeps,
): Promise<void> {
  const clock = deps.clock ?? systemClock;
  try {
    await writeFile(
      join(lockDir, "owner.json"),
      `${JSON.stringify(
        {
          pid: process.pid,
          acquiredAt: clock.now().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Owner metadata is diagnostic-only; the directory itself gates hook rate limiting.
  }
}

async function isAutoStartLockStale(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    return true;
  }
}
