import { componentLogPath, createJsonlLogger, type JsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";

export function createObserverLogger(input: {
  stateDir: string;
  clock?: RuntimeClock;
}): JsonlLogger {
  return createJsonlLogger({
    component: "observer",
    path: componentLogPath(input.stateDir, "observer"),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}
