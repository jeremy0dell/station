import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ObserverPaths } from "@station/config";
import type {
  ProviderHookEvent,
  ProviderHookPayloadSummary,
  ProviderHookReceipt,
  SafeError,
} from "@station/contracts";
import { safeErrorFromUnknown, systemClock } from "@station/runtime";
import {
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
  deliver: () => Promise<ProviderDeliveryAttempt>;
  spoolReceipt: (error: SafeError | undefined) => Promise<ProviderHookReceipt>;
  recordReceipt?: ReceiptRecorder;
}): Promise<ProviderHookReceipt> {
  const firstDelivery = await input.deliver();
  if (firstDelivery.receipt !== undefined) {
    return recordReceipt(input, firstDelivery.receipt);
  }

  if (input.autoStart) {
    const startupInput: Parameters<typeof maybeStartObserver>[0] = {
      paths: input.paths,
      timeoutMs: input.startupTimeoutMs,
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
      const retryDelivery = await input.deliver();
      if (retryDelivery.receipt !== undefined) {
        return recordReceipt(input, retryDelivery.receipt);
      }
      return recordReceipt(input, await input.spoolReceipt(retryDelivery.error));
    }
    return recordReceipt(input, await input.spoolReceipt(startResult.error));
  }

  return recordReceipt(input, await input.spoolReceipt(firstDelivery.error));
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
  timeoutMs: number;
  rateLimitMs: number;
  deps: ProviderHookObserverStartupDeps;
}) {
  const lock = await acquireAutoStartLock({
    paths: input.paths,
    staleMs: Math.max(input.rateLimitMs, input.timeoutMs, minimumAutoStartLockStaleMs),
    deps: input.deps,
  });

  if (lock.status === "contended") {
    return waitForContendedAutoStart({
      paths: input.paths,
      timeoutMs: input.timeoutMs,
      deps: input.deps,
    });
  }
  if (lock.status === "failed") {
    return { ok: false as const, error: lock.error };
  }

  try {
    const startupOptions: Parameters<typeof startProviderHookObserver>[0] = {
      paths: input.paths,
      timeoutMs: input.timeoutMs,
    };
    if (input.configPath !== undefined) {
      startupOptions.configPath = input.configPath;
    }
    if (input.observerCommand !== undefined) {
      startupOptions.observerCommand = input.observerCommand;
    }
    const started = await startProviderHookObserver(startupOptions, input.deps);
    if (started.status === "running") {
      return { ok: true as const };
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
    await waitForProviderHookObserverHealth(
      {
        paths: input.paths,
        timeoutMs: input.timeoutMs,
      },
      input.deps,
    );
    return { ok: true as const };
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
    // Owner metadata is diagnostic-only; the lock directory itself is the authority.
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
