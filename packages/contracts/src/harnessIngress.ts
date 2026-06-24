export type HarnessStatusIntent = "starting" | "working" | "idle" | "needs_attention" | "exited";

export type HarnessStatusConfidence = "low" | "medium" | "high";

export type HarnessIngressRule<Provider extends string, EventType extends string> = {
  provider: Provider;
  eventType: EventType;
  statusIntents?: readonly HarnessStatusIntent[];
  confidences?: readonly HarnessStatusConfidence[];
};
