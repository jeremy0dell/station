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

export const TuiRendererDismissFocusTargetRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("dismiss-focus-target"),
    focusRequestId: TuiRendererControlRequestIdSchema,
  })
  .strict();

export type TuiRendererDismissFocusTargetRequest = z.infer<
  typeof TuiRendererDismissFocusTargetRequestSchema
>;

export const TuiRendererResolveFocusTargetRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("resolve-focus-target"),
  })
  .strict();

export type TuiRendererResolveFocusTargetRequest = z.infer<
  typeof TuiRendererResolveFocusTargetRequestSchema
>;

export const TuiRendererControlRequestSchema = z.discriminatedUnion("type", [
  TuiRendererDismissRequestSchema,
  TuiRendererDismissFocusTargetRequestSchema,
  TuiRendererResolveFocusTargetRequestSchema,
]);

export type TuiRendererControlRequest = z.infer<typeof TuiRendererControlRequestSchema>;

export const TuiRendererDismissedResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("dismissed"),
  })
  .strict();

export type TuiRendererDismissedResponse = z.infer<typeof TuiRendererDismissedResponseSchema>;

export const TuiRendererFocusTargetResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("focus-target"),
    origin: TerminalFocusOriginSchema,
  })
  .strict();

export type TuiRendererFocusTargetResponse = z.infer<typeof TuiRendererFocusTargetResponseSchema>;

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
  TuiRendererFocusTargetResponseSchema,
  TuiRendererControlErrorResponseSchema,
]);

export type TuiRendererControlResponse = z.infer<typeof TuiRendererControlResponseSchema>;
