// Scripted-agent events -> STATION HarnessEventObservation (STATION-internal synthetic harness for tests).
// Contract: STATION-native, no external upstream — schema defined in this file (ScriptedAgentEventSchema).
// STATION ingress flow: docs/harness-ingress.md.
import type { ObservedStatus } from "@station/contracts";
import { TimestampSchema } from "@station/contracts";
import { z } from "zod";
import { scriptedHarnessError } from "./errors.js";

const nonEmptyStringSchema = z.string().min(1);

export const ScriptedAgentEventSchema = z
  .object({
    type: z.enum(["started", "activity", "idle", "attention", "exit"]),
    at: TimestampSchema,
    runId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema.optional(),
    worktreeId: nonEmptyStringSchema.optional(),
    sessionId: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive().optional(),
    cwd: nonEmptyStringSchema.optional(),
    message: nonEmptyStringSchema.optional(),
    file: nonEmptyStringSchema.optional(),
    exitCode: z.number().int().optional(),
    signal: nonEmptyStringSchema.optional(),
    turnComplete: z.boolean().optional(),
  })
  .strict();

export type ScriptedAgentEvent = z.infer<typeof ScriptedAgentEventSchema>;

export function parseScriptedAgentEvent(input: unknown): ScriptedAgentEvent {
  const result = ScriptedAgentEventSchema.safeParse(input);
  if (!result.success) {
    throw scriptedHarnessError(
      "HARNESS_SCRIPTED_EVENT_INVALID",
      "Scripted harness event did not match the expected shape.",
      result.error,
    );
  }
  return result.data;
}

export function statusFromScriptedEvent(
  event: ScriptedAgentEvent,
  observedAt = event.at,
): ObservedStatus {
  if (event.type === "attention") {
    return {
      value: "needs_attention",
      confidence: "high",
      reason: event.message ?? "Scripted agent requested attention.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }

  if (event.type === "exit") {
    return {
      value: "exited",
      confidence: "high",
      reason: exitReason(event),
      source: "harness_process",
      updatedAt: observedAt,
    };
  }

  if (event.type === "idle") {
    return {
      value: "idle",
      confidence: "high",
      reason: event.message ?? "Scripted agent reported idle.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }

  if (event.type === "activity") {
    return {
      value: "working",
      confidence: "medium",
      reason: event.message ?? "Scripted agent reported recent activity.",
      source: "harness_process",
      updatedAt: observedAt,
    };
  }

  return {
    value: "starting",
    confidence: "high",
    reason: event.message ?? "Scripted agent started.",
    source: "harness_process",
    updatedAt: observedAt,
  };
}

export function exitReason(
  event: Pick<ScriptedAgentEvent, "exitCode" | "signal" | "message">,
): string {
  if (event.message !== undefined) {
    return event.message;
  }
  if (event.exitCode !== undefined) {
    return `Scripted agent exited with code ${event.exitCode}.`;
  }
  if (event.signal !== undefined) {
    return `Scripted agent exited after signal ${event.signal}.`;
  }
  return "Scripted agent exited.";
}
