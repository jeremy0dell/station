import type { CurrentSessionContext, TerminalCallerContextRequest } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import {
  createLocalProcessEvidence,
  type ProcessEvidence,
  runRuntimeBoundaryWithTimeout,
} from "@station/runtime";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../../observerProcess.js";
import { resolveObserverPaths } from "../../paths.js";
import type { SessionCommandOptions } from "./options.js";

export async function runCurrentSessionCommand(
  options: SessionCommandOptions,
  deps: ObserverProcessDeps,
): Promise<CurrentSessionContext> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({
      socketPath: paths.socketPath,
      timeoutMs,
      ...(status.health.version === undefined
        ? {}
        : { expectedBuildVersion: status.health.version }),
    });
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.session.current",
      timeoutMs,
      error: {
        tag: "SessionCommandError",
        code: "SESSION_CURRENT_RPC_FAILED",
        message: "Session current could not contact the Observer.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "SESSION_CURRENT_RPC_TIMEOUT",
        message: "Session current timed out while contacting the Observer.",
      },
    },
    () =>
      client.getCurrentSessionContext(
        options.caller?.() ??
          currentCaller(options.processEvidence, options.environment, options.captureCallerClaims),
      ),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

function currentCaller(
  processEvidence: ProcessEvidence = createLocalProcessEvidence(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  captureCallerClaims: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Record<string, string> = () => ({}),
): TerminalCallerContextRequest {
  const processIdentity = processEvidence.read(process.pid);
  if (processIdentity === undefined) {
    throw {
      tag: "SessionCommandError",
      code: "SESSION_CURRENT_PROCESS_EVIDENCE_UNAVAILABLE",
      message: "STATION could not verify the invoking process identity.",
    };
  }
  return {
    process: { pid: processIdentity.pid, startToken: processIdentity.startToken },
    claims: captureCallerClaims(environment),
  };
}

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") throw new Error(observerStatusErrorMessage(status));
}
