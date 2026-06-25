// Crush PreToolUse hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md
// STATION ingress flow: docs/harness-ingress.md. Native stdin payload {event,session_id,cwd,tool_name,tool_input}
// is parsed STRICT here; upstream field drift breaks ingestion.
import type {
  HarnessEventContext,
  HarnessEventObservation,
  RawHarnessEvent,
} from "@station/contracts";
import { applyCorrelation, correlateTerminalBoundHarnessEvent } from "@station/harness-shared";
import { z } from "zod";

export type CrushHookPayload = z.infer<typeof CrushHookPayloadSchema>;

const nonEmptyStringSchema = z.string().min(1);

export const CrushHookPayloadSchema = z
  .object({
    event: z.literal("PreToolUse"),
    session_id: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    tool_name: nonEmptyStringSchema.optional(),
    tool_input: z.unknown().optional(),
    station_project_id: nonEmptyStringSchema.optional(),
    station_worktree_id: nonEmptyStringSchema.optional(),
    station_worktree_path: nonEmptyStringSchema.optional(),
    station_session_id: nonEmptyStringSchema.optional(),
    station_terminal_provider: nonEmptyStringSchema.optional(),
    station_terminal_target_id: nonEmptyStringSchema.optional(),
  })
  .strict();

export function parseCrushHookPayload(input: unknown): CrushHookPayload {
  const result = CrushHookPayloadSchema.safeParse(input);
  if (!result.success) {
    throw crushHarnessError(
      "HARNESS_CRUSH_EVENT_INVALID",
      "Crush hook event did not match the supported PreToolUse schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizeCrushRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const event = parseCrushHookPayload(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlateTerminalBoundHarnessEvent({
    provider: "crush",
    identity: event,
    context,
    cwd: event.cwd ?? event.station_worktree_path,
    nativeSessionId: event.session_id,
    includeProjectId: true,
    includeTerminalTargetId: true,
    includeCwd: true,
  });
  const observation: HarnessEventObservation = {
    provider: "crush",
    rawEventType: event.event,
    observedAt,
    providerData: providerDataFromCrushEvent(event),
  };
  applyCorrelation(observation, correlation);
  return [observation];
}

function providerDataFromCrushEvent(event: CrushHookPayload): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    hookEventName: event.event,
  };
  if (event.session_id !== undefined) providerData.crushSessionId = event.session_id;
  if (event.cwd !== undefined) providerData.cwd = event.cwd;
  if (event.tool_name !== undefined) providerData.toolName = event.tool_name;
  if (event.station_project_id !== undefined)
    providerData.stationProjectId = event.station_project_id;
  if (event.station_worktree_id !== undefined)
    providerData.stationWorktreeId = event.station_worktree_id;
  if (event.station_worktree_path !== undefined) {
    providerData.stationWorktreePath = event.station_worktree_path;
  }
  if (event.station_session_id !== undefined)
    providerData.stationSessionId = event.station_session_id;
  if (event.station_terminal_provider !== undefined) {
    providerData.stationTerminalProvider = event.station_terminal_provider;
  }
  if (event.station_terminal_target_id !== undefined) {
    providerData.stationTerminalTargetId = event.station_terminal_target_id;
  }
  return providerData;
}

function crushHarnessError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(`${code}: ${message}`, { cause }), {
    tag: "HarnessProviderError",
    code,
    provider: "crush",
  });
}
