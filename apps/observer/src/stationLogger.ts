import type { LogLevel, LogRecord, ObserverOperationalEvent } from "@station/contracts";

export type StationOperationalEventRecord = {
  level: LogLevel;
  operationalEvent: ObserverOperationalEvent;
} & Partial<
  Pick<
    LogRecord,
    "traceId" | "spanId" | "commandId" | "projectId" | "worktreeId" | "sessionId" | "provider"
  >
>;

/**
 * DRIVEN PORT
 *
 * Records typed operational evidence and narrative messages without exposing
 * their storage representation or destination.
 */
export interface StationLogger {
  recordOperationalEvent(record: StationOperationalEventRecord): Promise<void>;
  info(message: string, attributes?: Record<string, unknown>): Promise<void>;
  warn(message: string, attributes?: Record<string, unknown>): Promise<void>;
  error(message: string, attributes?: Record<string, unknown>): Promise<void>;
}
