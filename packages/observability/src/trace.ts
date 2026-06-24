import { randomUUID } from "node:crypto";
import type { TraceContext } from "@station/contracts";

export type CreateTraceContextOptions = {
  operation?: string;
  traceId?: string;
  parentSpanId?: string;
};

export function createTraceContext(options: CreateTraceContextOptions = {}): TraceContext {
  return {
    traceId: options.traceId ?? `trc_${randomUUID()}`,
    spanId: `spn_${randomUUID()}`,
    ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
    ...(options.operation === undefined
      ? {}
      : { operation: stableOperationName(options.operation) }),
  };
}

export function createChildSpan(parent: TraceContext, operation?: string): TraceContext {
  return createTraceContext({
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    ...(operation === undefined ? {} : { operation }),
  });
}

export function stableOperationName(input: string): string {
  return input
    .trim()
    .replaceAll(/\s+/g, ".")
    .replaceAll(/[^a-zA-Z0-9_.-]/g, "");
}
