import type { LogRecord, ObserverLifecycleFailure, SafeError } from "@station/contracts";
import { ObserverLifecycleFailureSchema, SafeErrorSchema } from "@station/contracts";

const LifecycleLogAttributesSchema = ObserverLifecycleFailureSchema.passthrough();
const SafeErrorViewSchema = SafeErrorSchema.strip();

export type LifecycleErrorSummary = {
  tag: string;
  code: string;
  message: string;
  hint?: string;
  provider?: string;
  diagnosticId?: string;
  traceId?: string;
};

export function parseLifecycleLogEvidence(
  attributes: LogRecord["attributes"] | undefined,
): ObserverLifecycleFailure | undefined {
  const parsed = LifecycleLogAttributesSchema.safeParse(attributes);
  return parsed.success ? parsed.data : undefined;
}

export function parseLogSafeError(value: unknown): SafeError | undefined {
  const parsed = SafeErrorViewSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function summarizeLifecycleError(error: SafeError): LifecycleErrorSummary {
  const summary: LifecycleErrorSummary = {
    tag: error.tag,
    code: error.code,
    message: error.message,
  };
  if (error.hint !== undefined) summary.hint = error.hint;
  if (error.provider !== undefined) summary.provider = error.provider;
  if (error.diagnosticId !== undefined) summary.diagnosticId = error.diagnosticId;
  if (error.traceId !== undefined) summary.traceId = error.traceId;
  return summary;
}
