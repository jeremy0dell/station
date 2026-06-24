import type { TerminalTargetObservation } from "@station/contracts";
import { TerminalTargetObservationSchema } from "@station/contracts";
import { isRecord } from "../utils/guards.js";

export function stripTerminalProviderData(
  observation: TerminalTargetObservation,
): TerminalTargetObservation {
  const stripped: TerminalTargetObservation = {
    id: observation.id,
    provider: observation.provider,
    state: observation.state,
    confidence: observation.confidence,
    reason: observation.reason,
    observedAt: observation.observedAt,
  };
  if (observation.projectId !== undefined) stripped.projectId = observation.projectId;
  if (observation.worktreeId !== undefined) stripped.worktreeId = observation.worktreeId;
  if (observation.sessionId !== undefined) stripped.sessionId = observation.sessionId;
  if (observation.harnessRunId !== undefined) stripped.harnessRunId = observation.harnessRunId;
  if (observation.focusable !== undefined) stripped.focusable = observation.focusable;
  if (observation.closeable !== undefined) stripped.closeable = observation.closeable;
  if (observation.cwd !== undefined) stripped.cwd = observation.cwd;
  if (observation.pid !== undefined) stripped.pid = observation.pid;
  if (observation.title !== undefined) stripped.title = observation.title;
  if (observation.harnessBinding !== undefined)
    stripped.harnessBinding = observation.harnessBinding;
  return stripped;
}

export function sanitizeTerminalObservationPayload(payload: unknown): unknown {
  const parsed = TerminalTargetObservationSchema.safeParse(payload);
  if (parsed.success) {
    return stripTerminalProviderData(parsed.data);
  }

  if (!isRecord(payload)) {
    return payload;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "providerData") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
