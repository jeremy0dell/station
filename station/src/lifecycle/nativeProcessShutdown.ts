import type { UiShutdownReason } from "@station/contracts";

/** Hard product bound for releasing a lost native terminal and its TTY claim. */
export const NATIVE_TERMINAL_LOSS_SHUTDOWN_DEADLINE_MS = 5_000;
const SIGHUP_RERAISE_FAILSAFE_MS = 100;
type NativeShutdownResult = "success" | "failure";
type Timer = number | ReturnType<typeof setTimeout>;

/** Own native SIGHUP admission, failure presence, deadline, HMR, and process settlement. */
export function createNativeProcessShutdown(options: {
  startCleanup(
    reason: UiShutdownReason,
    failure?: { readonly error: unknown },
  ): Promise<NativeShutdownResult>;
  finalizeLocal(deadlineExpired: boolean): boolean;
  onAdmitted(settled: Promise<void>): void;
  process?: Pick<NodeJS.Process, "pid" | "on" | "off" | "kill" | "exit">;
  timers?: { setTimeout(callback: () => void, ms: number): Timer; clearTimeout(timer: Timer): void };
}) {
  const processControl = options.process ?? process;
  const timers = options.timers ?? { setTimeout, clearTimeout };
  let reason: UiShutdownReason | undefined;
  let failure: { readonly error: unknown } | undefined;
  let disposed = false;
  let finalized = false;
  let deadline: Timer | undefined;
  let resolveSettled: (() => void) | undefined;
  let settled = Promise.resolve();

  const numericExit = (code: number): void => {
    processControl.exit(code);
    resolveSettled?.();
  };
  const finalize = (deadlineExpired: boolean, result: NativeShutdownResult): void => {
    if (finalized) return;
    finalized = true;
    if (deadline !== undefined) timers.clearTimeout(deadline);
    let succeeded = result === "success" && failure === undefined && reason !== "fatal";
    try {
      succeeded = options.finalizeLocal(deadlineExpired) && succeeded;
    } catch {
      succeeded = false;
    }
    processControl.off("SIGHUP", onSighup);
    if (deadline === undefined) return numericExit(succeeded ? 0 : 1);

    try {
      if (processControl.kill(processControl.pid, "SIGHUP")) {
        timers.setTimeout(() => numericExit(129), SIGHUP_RERAISE_FAILSAFE_MS);
        return;
      }
    } catch {
      // Fall through to the numeric signal-status fallback.
    }
    numericExit(129);
  };
  function request(
    requestedReason: UiShutdownReason,
    suppliedFailure?: { readonly error: unknown },
  ): Promise<void> {
    if (requestedReason === "fatal") failure ??= suppliedFailure ?? { error: undefined };
    else if (suppliedFailure !== undefined) failure ??= suppliedFailure;
    if (disposed) return settled;
    if (reason !== undefined) return settled;
    reason = requestedReason;
    settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    try {
      options.onAdmitted(settled);
    } catch (error) {
      failure ??= { error };
    }
    let cleanup: Promise<NativeShutdownResult>;
    try {
      cleanup = Promise.resolve(options.startCleanup(reason, failure));
    } catch (error) {
      cleanup = Promise.reject(error);
    }
    cleanup.then(
      (result) => finalize(false, result),
      (error: unknown) => {
        failure ??= { error };
        finalize(false, "failure");
      },
    );
    return settled;
  }
  function onSighup(): void {
    if (disposed || finalized) return;
    deadline ??= timers.setTimeout(
      () => finalize(true, "failure"),
      NATIVE_TERMINAL_LOSS_SHUTDOWN_DEADLINE_MS,
    );
    void request("terminal_loss");
  }

  processControl.on("SIGHUP", onSighup);
  return {
    request,
    beginHotReload(): "hot_reload" | "process_shutdown" {
      if (reason !== undefined) return "process_shutdown";
      disposed = true;
      processControl.off("SIGHUP", onSighup);
      return "hot_reload";
    },
  };
}
