import { z } from "zod";
import {
  ProjectIdSchema,
  ProviderIdSchema,
  SessionGroupIdSchema,
  SessionIdSchema,
  TerminalTargetIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

/** A PID is only useful when it is paired with the operating system start token. */
export const TerminalCallerProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    startToken: nonEmptyStringSchema,
  })
  .strict();

/**
 * Raw caller claims arrive only at the terminal-integration boundary. They are
 * deliberately not included in a resolved context or command result.
 */
export const TerminalCallerContextRequestSchema = z
  .object({
    process: TerminalCallerProcessSchema,
    claims: z.record(nonEmptyStringSchema, z.string()),
  })
  .strict();

export type TerminalCallerContextRequest = z.infer<typeof TerminalCallerContextRequestSchema>;

/** A short-lived public reference to provider-validated placement authority. */
export const TerminalPlacementSourceSchema = z
  .object({
    provider: ProviderIdSchema,
    targetId: TerminalTargetIdSchema,
    generation: nonEmptyStringSchema,
    authorityId: nonEmptyStringSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export type TerminalPlacementSource = z.infer<typeof TerminalPlacementSourceSchema>;

export const TerminalPlacementIntentSchema = z.enum(["sibling", "detached"]);
export type TerminalPlacementIntent = z.infer<typeof TerminalPlacementIntentSchema>;

/**
 * `detached` is intentionally source-free and creates an unselected provider
 * target. Every presented destination instead requires a freshly validated source.
 */
export const TerminalPlacementRequestSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("sibling"), source: TerminalPlacementSourceSchema }).strict(),
  z.object({ intent: z.literal("detached") }).strict(),
]);

export type TerminalPlacementRequest = z.infer<typeof TerminalPlacementRequestSchema>;

/** Public result for the exact target created by a successful placement mutation. */
export const ResolvedTerminalPlacementSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("sibling"),
      provider: ProviderIdSchema,
      targetId: TerminalTargetIdSchema,
      generation: nonEmptyStringSchema,
      presentation: z.literal("presented"),
    })
    .strict(),
  z
    .object({
      intent: z.literal("detached"),
      provider: ProviderIdSchema,
      targetId: TerminalTargetIdSchema,
      generation: nonEmptyStringSchema,
      presentation: z.literal("detached"),
    })
    .strict(),
]);

export type ResolvedTerminalPlacement = z.infer<typeof ResolvedTerminalPlacementSchema>;

export const CurrentSessionContextSchema = z
  .object({
    source: TerminalPlacementSourceSchema,
    presentation: z.literal("presented"),
    session: z
      .object({
        id: SessionIdSchema,
        projectId: ProjectIdSchema,
        worktreeId: WorktreeIdSchema,
        group: z
          .object({ id: SessionGroupIdSchema, name: nonEmptyStringSchema })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CurrentSessionContext = z.infer<typeof CurrentSessionContextSchema>;
