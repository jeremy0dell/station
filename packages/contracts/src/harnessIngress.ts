import type { z } from "zod";
import type { AgentState, ConfidenceSchema } from "./observations.js";

export type HarnessStatusIntent = Extract<
  AgentState,
  "starting" | "working" | "idle" | "needs_attention" | "exited"
>;

export type HarnessStatusConfidence = z.infer<typeof ConfidenceSchema>;

export type HarnessIngressRule<Provider extends string, EventType extends string> = {
  provider: Provider;
  eventType: EventType;
  statusIntents?: readonly HarnessStatusIntent[];
  confidences?: readonly HarnessStatusConfidence[];
};
