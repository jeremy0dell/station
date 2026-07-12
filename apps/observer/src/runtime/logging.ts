import { componentLogPath, createJsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import type { StationLogger } from "../stationLogger.js";

/**
 * ADAPTER
 *
 * Writes Observer operational events as redacted JSONL while retaining path and
 * record representations at the logging boundary.
 */
export function createObserverLogger(input: {
  stateDir: string;
  clock?: RuntimeClock;
}): StationLogger {
  const logger = createJsonlLogger({
    component: "observer",
    path: componentLogPath(input.stateDir, "observer"),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  return {
    async info(message, attributes) {
      await logger.info(message, attributes);
    },
    async warn(message, attributes) {
      await logger.warn(message, attributes);
    },
    async error(message, attributes) {
      await logger.error(message, attributes);
    },
  };
}
