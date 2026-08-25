import { writeFile } from "node:fs/promises";
import {
  createObserverClient,
  IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX,
} from "@station/protocol";
import { z } from "zod";

export const OBSERVER_TRANSPORT_DELIVERY_PROBE_PATH_ENV =
  "STATION_QUICK_SESSION_IDLE_TRANSPORT_PROBE_PATH";

type ProbeCompletion = {
  status: "complete" | "failed";
  requestId: string;
};

type ProbeInput = {
  socketPath: string;
  expectedBuildVersion: string;
  completionPath: string;
};

type ProbeDependencies = {
  requestHealth?: () => Promise<{ status: string; version: string }>;
  writeCompletion?: (path: string, contents: string) => Promise<void>;
  addSignalListener?: (listener: () => void) => void;
  removeSignalListener?: (listener: () => void) => void;
};

const pathSchema = z.string().min(1);

export function installObserverTransportDeliveryProbeFromEnvironment(
  input: { socketPath: string; expectedBuildVersion?: string },
  environment: NodeJS.ProcessEnv = process.env,
): { dispose(): void } {
  const rawCompletionPath = environment[OBSERVER_TRANSPORT_DELIVERY_PROBE_PATH_ENV];
  if (rawCompletionPath === undefined) return { dispose: () => undefined };
  return installObserverTransportDeliveryProbe({
    socketPath: pathSchema.parse(input.socketPath),
    expectedBuildVersion: pathSchema.parse(input.expectedBuildVersion),
    completionPath: pathSchema.parse(rawCompletionPath),
  });
}

export function installObserverTransportDeliveryProbe(
  input: ProbeInput,
  dependencies: ProbeDependencies = {},
): { dispose(): void } {
  const requestId = `${IDLE_RESPONSE_DELIVERY_REQUEST_ID_PREFIX}${process.pid}`;
  const requestHealth =
    dependencies.requestHealth ??
    (() =>
      createObserverClient({
        socketPath: input.socketPath,
        timeoutMs: 5_000,
        requestId: () => requestId,
        idleHealthResponseDeliveryDiagnostic: true,
      }).health());
  const writeCompletion = dependencies.writeCompletion ?? writeFile;
  const addSignalListener =
    dependencies.addSignalListener ?? ((listener) => process.on("SIGUSR2", listener));
  const removeSignalListener =
    dependencies.removeSignalListener ?? ((listener) => process.off("SIGUSR2", listener));
  let armed = true;

  const onSignal = (): void => {
    if (!armed) return;
    armed = false;
    removeSignalListener(onSignal);
    void runProbe().catch(() => undefined);
  };

  const runProbe = async (): Promise<void> => {
    let completion: ProbeCompletion;
    try {
      const health = await requestHealth();
      completion = {
        status:
          health.status === "healthy" && health.version === input.expectedBuildVersion
            ? "complete"
            : "failed",
        requestId,
      };
    } catch {
      completion = { status: "failed", requestId };
    }
    await writeCompletion(input.completionPath, `${JSON.stringify(completion)}\n`);
  };

  // Removing the handler before I/O makes repeated signals incapable of duplicating the probe.
  addSignalListener(onSignal);
  return {
    dispose: () => {
      if (!armed) return;
      armed = false;
      removeSignalListener(onSignal);
    },
  };
}
