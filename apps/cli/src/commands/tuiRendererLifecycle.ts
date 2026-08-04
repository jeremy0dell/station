import { randomUUID } from "node:crypto";
import type { SafeError, UiRendererEntry, UiRendererSignal, UiRunId } from "@station/contracts";
import { createUiLifecycleRecorder, type JsonlLogger } from "@station/observability";

export type TuiRendererLifecycleWitness = {
  spawned(rendererPid: number): Promise<void>;
  spawnFailed(error: SafeError): Promise<void>;
  exited(input: {
    rendererPid: number;
    exitCode: number | null;
    signal: UiRendererSignal | null;
  }): Promise<void>;
  flush(): Promise<void>;
};

/** Record launcher-owned renderer outcomes without letting evidence failures alter the command. */
export function createTuiRendererLifecycleWitness(input: {
  logger: JsonlLogger;
  uiRunId: UiRunId;
  entry: UiRendererEntry;
  pid?: number;
}): TuiRendererLifecycleWitness {
  const pid = input.pid ?? process.pid;
  const recorder = createUiLifecycleRecorder({
    logger: input.logger,
    component: "cli",
    sourceId: `launcher_${pid}_${randomUUID()}`,
    pid,
  });

  const record = async (
    event: Parameters<typeof recorder.record>[0],
    level: Parameters<typeof recorder.record>[1],
  ): Promise<void> => {
    try {
      await recorder.record(event, level);
    } catch {
      // Lifecycle evidence is best-effort and cannot replace the renderer outcome.
    }
  };

  return {
    spawned: (rendererPid) =>
      record(
        {
          kind: "renderer.spawned",
          uiRunId: input.uiRunId,
          rendererPid,
          entry: input.entry,
        },
        "info",
      ),
    spawnFailed: (error) =>
      record(
        {
          kind: "renderer.spawn_failed",
          uiRunId: input.uiRunId,
          entry: input.entry,
          error,
        },
        "error",
      ),
    exited: ({ rendererPid, exitCode, signal }) =>
      record(
        {
          kind: "renderer.exited",
          uiRunId: input.uiRunId,
          rendererPid,
          exitCode,
          signal,
        },
        "info",
      ),
    async flush() {
      try {
        await recorder.flush();
      } catch {
        // A failed flush is still subordinate to the exact child process result.
      }
    },
  };
}
