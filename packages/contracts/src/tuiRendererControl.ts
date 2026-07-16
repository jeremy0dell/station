import { z } from "zod";
import { TerminalFocusOriginSchema } from "./commands.js";
import { SafeErrorSchema } from "./errors.js";

export const TUI_RENDERER_CONTROL_PROTOCOL_VERSION = 1 as const;

export const TuiRendererControlRequestIdSchema = z.string().min(1).max(128);

export type TuiRendererControlRequestId = z.infer<typeof TuiRendererControlRequestIdSchema>;

const frameShape = {
  protocolVersion: z.literal(TUI_RENDERER_CONTROL_PROTOCOL_VERSION),
  requestId: TuiRendererControlRequestIdSchema,
};

export const TuiRendererDismissRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("dismiss"),
  })
  .strict();

export type TuiRendererDismissRequest = z.infer<typeof TuiRendererDismissRequestSchema>;

export const TuiRendererResolveFocusOriginRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("resolve-focus-origin"),
  })
  .strict();

export type TuiRendererResolveFocusOriginRequest = z.infer<
  typeof TuiRendererResolveFocusOriginRequestSchema
>;

export const TuiRendererControlRequestSchema = z.discriminatedUnion("type", [
  TuiRendererDismissRequestSchema,
  TuiRendererResolveFocusOriginRequestSchema,
]);

export type TuiRendererControlRequest = z.infer<typeof TuiRendererControlRequestSchema>;

export const TuiRendererDismissedResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("dismissed"),
  })
  .strict();

export type TuiRendererDismissedResponse = z.infer<typeof TuiRendererDismissedResponseSchema>;

export const TuiRendererFocusOriginResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("focus-origin"),
    origin: TerminalFocusOriginSchema,
  })
  .strict();

export type TuiRendererFocusOriginResponse = z.infer<typeof TuiRendererFocusOriginResponseSchema>;

export const TuiRendererControlErrorResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("error"),
    error: SafeErrorSchema,
  })
  .strict();

export type TuiRendererControlErrorResponse = z.infer<typeof TuiRendererControlErrorResponseSchema>;

export const TuiRendererControlResponseSchema = z.discriminatedUnion("type", [
  TuiRendererDismissedResponseSchema,
  TuiRendererFocusOriginResponseSchema,
  TuiRendererControlErrorResponseSchema,
]);

export type TuiRendererControlResponse = z.infer<typeof TuiRendererControlResponseSchema>;
