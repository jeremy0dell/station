import {
  HarnessEventObservationSchema,
  HarnessRunObservationSchema,
  ProviderHealthSchema,
  TerminalTargetObservationSchema,
  WorktreeObservationSchema,
} from "@station/contracts";
import { z } from "zod";
import { isRecord } from "../utils/guards.js";
import { stringifyJson } from "./json.js";
import { stripTerminalProviderData } from "./terminalObservations.js";
import type { ProviderObservation } from "./types.js";

const ProviderObservationSchema = z.discriminatedUnion("entityKind", [
  z
    .object({
      entityKind: z.literal("worktree"),
      payload: WorktreeObservationSchema,
    })
    .strict(),
  z
    .object({
      entityKind: z.literal("terminal_target"),
      payload: TerminalTargetObservationSchema,
    })
    .strict(),
  z
    .object({
      entityKind: z.literal("harness_run"),
      payload: HarnessRunObservationSchema,
    })
    .strict(),
  z
    .object({
      entityKind: z.literal("harness_event"),
      payload: HarnessEventObservationSchema,
    })
    .strict(),
  z
    .object({
      entityKind: z.literal("provider_health"),
      payload: ProviderHealthSchema,
    })
    .strict(),
]);

export function parseProviderObservation(
  entityKind: unknown,
  payload: unknown,
): ProviderObservation {
  const observation = ProviderObservationSchema.parse({ entityKind, payload });
  return observation.entityKind === "terminal_target"
    ? {
        ...observation,
        payload: stripTerminalProviderData(observation.payload),
      }
    : observation;
}

export function stableProviderObservationPayloadKey(
  payload: ProviderObservation["payload"],
): string {
  return stringifyJson(normalizeProviderObservationPayloadForCoalescing(payload, true));
}

function normalizeProviderObservationPayloadForCoalescing(
  payload: unknown,
  omitVolatileFields: boolean,
): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => normalizeProviderObservationPayloadForCoalescing(item, false));
  }
  if (!isRecord(payload)) {
    return payload;
  }
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    if (
      omitVolatileFields &&
      (key === "observedAt" || key === "lastCheckedAt" || key === "latencyMs")
    ) {
      continue;
    }
    stable[key] = normalizeProviderObservationPayloadForCoalescing(payload[key], false);
  }
  return stable;
}
