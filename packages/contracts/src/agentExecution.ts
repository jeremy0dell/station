import { z } from "zod";
import { ProviderIdSchema, SessionIdSchema } from "./ids.js";
import type { ObservedStatus } from "./observations.js";
import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "./providers.js";

export const AgentExecutionIntentSchema = z.object({ provider: ProviderIdSchema }).strict();
export type AgentExecutionIntent = z.infer<typeof AgentExecutionIntentSchema>;

export const AgentExecutionViewSchema = z
  .object({
    provider: ProviderIdSchema,
    state: z.enum(["starting", "running", "stopped", "unavailable", "destroyed"]),
    expiresAt: z.iso.datetime().optional(),
    resultDirectory: z.string().min(1).optional(),
  })
  .strict();
export type AgentExecutionView = z.infer<typeof AgentExecutionViewSchema>;

export const CollectSessionCommandSchema = z
  .object({
    type: z.literal("session.collect"),
    payload: z.object({ sessionId: SessionIdSchema }).strict(),
  })
  .strict();

/**
 * DRIVEN PORT
 *
 * Owns remote agent execution independently of local terminal presentation. The session retains
 * placement; adapters retain opaque remote identity and never retry an uncertain launch as a new one.
 * Adapters may require a persistent local terminal without giving Host remote process authority.
 */
export interface AgentExecutionProvider {
  readonly id: string;
  preflight(harness: string): Promise<void>;
  launch(
    request: BuildHarnessLaunchRequest & { sessionId: string; harness: string },
  ): Promise<HarnessLaunchPlan>;
  attach(sessionId: string): Promise<HarnessLaunchPlan>;
  observe(sessionId: string): Promise<{ execution: AgentExecutionView; status: ObservedStatus }>;
  collect(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  destroy(sessionId: string, options?: { discardResults?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
