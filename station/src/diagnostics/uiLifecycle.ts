import { randomUUID } from "node:crypto";
import type {
  SafeError,
  UiLifecycleSurface,
  UiRunContext,
  UiShutdownReason,
  UiSurfaceChangeReason,
} from "@station/contracts";
import { createUiLifecycleRecorder, type JsonlLogger } from "@station/observability";

export type UiLifecycleWitness = {
  readonly context: UiRunContext;
  readonly uiRunId: UiRunContext["uiRunId"];
  started(): Promise<void>;
  ready(surface: UiLifecycleSurface): Promise<void>;
  surfaceChanged(
    before: UiLifecycleSurface,
    after: UiLifecycleSurface,
    reason: UiSurfaceChangeReason,
  ): Promise<void>;
  shutdownRequested(reason: UiShutdownReason): Promise<void>;
  fatal(error: unknown): Promise<void>;
  fatalShutdown(error: unknown): Promise<void>;
  shutdownCompleted(reason: UiShutdownReason): Promise<void>;
  flush(): Promise<void>;
};

/** Record native UI semantics without allowing evidence failures to change renderer behavior. */
export function createUiLifecycleWitness(input: {
  logger: JsonlLogger;
  context: UiRunContext;
  clock?: { now(): Date };
}): UiLifecycleWitness {
  const recorder = createUiLifecycleRecorder({
    logger: input.logger,
    component: "tui",
    sourceId: `tui_${input.context.rendererPid}_${randomUUID()}`,
    pid: input.context.rendererPid,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  let lastSurface: UiLifecycleSurface | undefined;
  let requestedReason: UiShutdownReason | undefined;

  const record = async (
    event: Parameters<typeof recorder.record>[0],
    level: Parameters<typeof recorder.record>[1],
  ): Promise<void> => {
    try {
      await recorder.record(event, level);
    } catch {
      // Local lifecycle evidence must never become a renderer failure source.
    }
  };

  const fatal = async (_error: unknown): Promise<void> => {
    const safeError: SafeError = {
      tag: "TuiRuntimeError",
      code: "TUI_FATAL",
      message: "The native Station UI failed.",
    };
    await record(
      { kind: "ui.fatal", uiRunId: input.context.uiRunId, error: safeError },
      "error",
    );
  };

  const flush = async (): Promise<void> => {
    try {
      await recorder.flush();
    } catch {
      // Flush remains subordinate to the renderer's actual shutdown outcome.
    }
  };

  const witness: UiLifecycleWitness = {
    context: input.context,
    uiRunId: input.context.uiRunId,
    started: () =>
      record(
        {
          kind: "ui.started",
          uiRunId: input.context.uiRunId,
          rendererPid: input.context.rendererPid,
        },
        "info",
      ),
    async ready(surface) {
      lastSurface = surface;
      await record(
        {
          kind: "ui.ready",
          uiRunId: input.context.uiRunId,
          rendererPid: input.context.rendererPid,
          surface,
        },
        "info",
      );
    },
    async surfaceChanged(before, after, reason) {
      if (before === after || lastSurface === after) {
        return;
      }
      lastSurface = after;
      await record(
        {
          kind: "ui.surface.changed",
          uiRunId: input.context.uiRunId,
          before,
          after,
          reason,
        },
        "info",
      );
    },
    async shutdownRequested(reason) {
      if (requestedReason !== undefined) {
        return;
      }
      requestedReason = reason;
      await record(
        { kind: "ui.shutdown.requested", uiRunId: input.context.uiRunId, reason },
        "info",
      );
    },
    fatal,
    async fatalShutdown(error) {
      await witness.shutdownRequested("fatal");
      await fatal(error);
      await flush();
    },
    shutdownCompleted: (reason) =>
      record(
        { kind: "ui.shutdown.completed", uiRunId: input.context.uiRunId, reason },
        "info",
      ),
    flush,
  };

  return witness;
}
