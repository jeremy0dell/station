import type { UiShutdownReason } from "@station/contracts";
import { settleCleanupSteps, type CleanupStep } from "./cleanup.js";

const TERMINAL_LOSS_TIMEOUT_MS = 2_000;
type NativeShutdownReason = Exclude<UiShutdownReason, "fatal">;

type ProcessControl = {
  readonly pid: number;
  on(signal: "SIGHUP", listener: () => void): void;
  off(signal: "SIGHUP", listener: () => void): void;
  kill(pid: number, signal: "SIGHUP"): boolean;
  exit(code: number): void;
};

export type NativeProcessLifecycle = {
  install(): void;
  request(reason: NativeShutdownReason): Promise<void>;
  dispose(): void;
};

/**
 * Coordinates first-wins native shutdown and preserves a real SIGHUP outcome
 * by releasing Station resources and exact TTY ownership before self-signaling.
 */
export function createNativeProcessLifecycle(input: {
  stopSurfaceObservation(): void;
  cleanupSteps: readonly CleanupStep[];
  lifecycle: {
    shutdownRequested(reason: UiShutdownReason): Promise<void>;
    shutdownCompleted(reason: UiShutdownReason): Promise<void>;
    fatal(error: unknown): Promise<void>;
    flush(): Promise<void>;
  };
  releaseTty(): void;
  processControl?: ProcessControl;
  terminalLossTimeoutMs?: number;
}): NativeProcessLifecycle {
  const processControl = input.processControl ?? process;
  const timeoutMs = input.terminalLossTimeoutMs ?? TERMINAL_LOSS_TIMEOUT_MS;
  let installed = false;
  let shutdown: Promise<void> | undefined;

  const onTerminalLoss = (): void => {
    void request("terminal_loss");
  };
  const dispose = (): void => {
    if (!installed) return;
    processControl.off("SIGHUP", onTerminalLoss);
    installed = false;
  };
  const terminate = (reason: NativeShutdownReason, failed: boolean): void => {
    let finalizationFailed = failed;
    // Keep later hangups coalesced until ownership release is attempted, and always terminate.
    try {
      input.releaseTty();
    } catch {
      finalizationFailed = true;
    }
    try {
      dispose();
    } catch {
      finalizationFailed = true;
    }
    if (reason !== "terminal_loss") {
      processControl.exit(finalizationFailed ? 1 : 0);
      return;
    }
    try {
      if (!processControl.kill(processControl.pid, "SIGHUP")) processControl.exit(129);
    } catch {
      processControl.exit(129);
    }
  };
  const request = (reason: NativeShutdownReason): Promise<void> => {
    if (shutdown !== undefined) return shutdown;
    shutdown = (async () => {
      let failure: unknown;
      try {
        input.stopSurfaceObservation();
      } catch (error) {
        failure = error;
      }
      await input.lifecycle.shutdownRequested(reason);
      const cleanup = settleCleanupSteps(
        input.cleanupSteps,
        "Native renderer shutdown cleanup failed.",
      );
      try {
        if (reason === "terminal_loss") {
          await settleBeforeTimeout(cleanup, timeoutMs);
        } else {
          await cleanup;
        }
      } catch (error) {
        failure ??= error;
      }
      if (failure === undefined) {
        await input.lifecycle.shutdownCompleted(reason);
      } else {
        await input.lifecycle.fatal(failure);
      }
      await input.lifecycle.flush();
      terminate(reason, failure !== undefined);
    })();
    return shutdown;
  };

  return {
    install: () => {
      if (installed) return;
      processControl.on("SIGHUP", onTerminalLoss);
      installed = true;
    },
    request,
    dispose,
  };
}

async function settleBeforeTimeout(settlement: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Native terminal-loss cleanup timed out.")), timeoutMs);
  });
  try {
    await Promise.race([settlement, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
