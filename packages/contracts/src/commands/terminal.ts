import { z } from "zod";
import { ProviderIdSchema, SessionIdSchema, WorktreeIdSchema } from "../ids.js";
import { nonEmptyStringSchema } from "../shared.js";

export const TerminalFocusOriginSchema = z
  .object({
    provider: ProviderIdSchema,
    clientId: nonEmptyStringSchema.optional(),
  })
  .strict();

export type TerminalFocusOrigin = z.infer<typeof TerminalFocusOriginSchema>;

export const TerminalCommandOptionsSchema = z
  .object({
    provider: ProviderIdSchema,
    layout: z.enum(["default", "agent-only", "agent-build-shell"]).optional(),
    focus: z.boolean().optional(),
    origin: TerminalFocusOriginSchema.optional(),
  })
  .strict();

/** Create/fork never infer presentation or focus from terminal configuration. */
export const SessionTerminalCommandOptionsSchema = z
  .object({
    provider: ProviderIdSchema,
    layout: z.enum(["default", "agent-only", "agent-build-shell"]).optional(),
  })
  .strict();

export const TerminalFocusPayloadSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    origin: TerminalFocusOriginSchema.optional(),
  })
  .strict()
  .refine(
    (payload) => payload.sessionId ?? payload.worktreeId,
    "terminal.focus requires sessionId or worktreeId",
  );

export type TerminalFocusPayload = z.infer<typeof TerminalFocusPayloadSchema>;

export const TerminalClosePayloadSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    worktreeId: WorktreeIdSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine(
    (payload) => payload.sessionId ?? payload.worktreeId,
    "terminal.close requires sessionId or worktreeId",
  );

export type TerminalClosePayload = z.infer<typeof TerminalClosePayloadSchema>;

export const TerminalFocusCommandSchema = z
  .object({ type: z.literal("terminal.focus"), payload: TerminalFocusPayloadSchema })
  .strict();

export const TerminalCloseCommandSchema = z
  .object({ type: z.literal("terminal.close"), payload: TerminalClosePayloadSchema })
  .strict();
