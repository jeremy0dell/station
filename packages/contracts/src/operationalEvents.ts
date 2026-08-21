import { z } from "zod";
import { ProviderIdSchema, TerminalTargetIdSchema } from "./ids.js";
import { TerminalStateSchema } from "./observations.js";
import { nonEmptyStringSchema } from "./shared.js";

export const TerminalFocusSelectionBasisSchema = z.enum([
  "session-main-agent",
  "session",
  "worktree-main-agent",
  "worktree",
  "cwd-fallback",
]);
export type TerminalFocusSelectionBasis = z.infer<typeof TerminalFocusSelectionBasisSchema>;

const TerminalFocusSelectedResolutionSchema = z
  .object({
    kind: z.literal("selected"),
    totalTargetCount: z.number().int().nonnegative(),
    matchingTargetCount: z.number().int().nonnegative(),
    targetId: TerminalTargetIdSchema,
    targetState: TerminalStateSchema,
    selectionBasis: TerminalFocusSelectionBasisSchema,
  })
  .strict();

export const TerminalFocusResolutionEvidenceSchema = z.discriminatedUnion("kind", [
  TerminalFocusSelectedResolutionSchema,
  z
    .object({
      kind: z.literal("missing"),
      totalTargetCount: z.number().int().nonnegative(),
      matchingTargetCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stale"),
      totalTargetCount: z.number().int().nonnegative(),
      matchingTargetCount: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type TerminalFocusResolutionEvidence = z.infer<typeof TerminalFocusResolutionEvidenceSchema>;

const TerminalFocusDecisionBaseSchema = z.object({
  hasOriginClientId: z.boolean(),
  originProvider: ProviderIdSchema.optional(),
});

export const TerminalFocusOperationalEventSchema = z
  .object({
    kind: z.literal("terminal.focus.decision"),
    decision: z.discriminatedUnion("outcome", [
      TerminalFocusDecisionBaseSchema.extend({
        outcome: z.literal("focused"),
        resolution: TerminalFocusSelectedResolutionSchema,
      }).strict(),
      TerminalFocusDecisionBaseSchema.extend({
        outcome: z.literal("failed"),
        errorCode: nonEmptyStringSchema,
        resolution: TerminalFocusResolutionEvidenceSchema.optional(),
      }).strict(),
    ]),
  })
  .strict();
export type TerminalFocusOperationalEvent = z.infer<typeof TerminalFocusOperationalEventSchema>;

export const ExternalLaunchPreparationRouteSchema = z.enum([
  "existing-managed-attachment",
  "existing-live-session-without-attachment",
  "prepared-managed-attachment",
  "prepared-caller-owned",
]);
export type ExternalLaunchPreparationRoute = z.infer<typeof ExternalLaunchPreparationRouteSchema>;

export const ExternalLaunchPreparationOperationalEventSchema = z
  .object({
    kind: z.literal("agent.prepareExternalLaunch.decision"),
    decision: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("prepared"),
          route: ExternalLaunchPreparationRouteSchema,
          terminalTargetId: TerminalTargetIdSchema.optional(),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("failed"),
          errorCode: nonEmptyStringSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type ExternalLaunchPreparationOperationalEvent = z.infer<
  typeof ExternalLaunchPreparationOperationalEventSchema
>;

export const ObserverOperationalEventSchema = z.discriminatedUnion("kind", [
  TerminalFocusOperationalEventSchema,
  ExternalLaunchPreparationOperationalEventSchema,
]);
export type ObserverOperationalEvent = z.infer<typeof ObserverOperationalEventSchema>;
