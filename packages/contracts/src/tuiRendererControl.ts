import { z } from "zod";
import { TerminalFocusOriginSchema } from "./commands/terminal.js";
import { SafeErrorSchema } from "./errors.js";

export const TUI_RENDERER_CONTROL_PROTOCOL_VERSION = 1 as const;

export const TuiRendererControlRequestIdSchema = z.string().min(1).max(128);

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

export const TuiRendererDismissFocusTargetRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("dismiss-focus-target"),
    focusRequestId: TuiRendererControlRequestIdSchema,
  })
  .strict();

export const TuiRendererResolveFocusTargetRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("resolve-focus-target"),
  })
  .strict();

export const TuiRendererOpenShellRequestSchema = z
  .object({
    ...frameShape,
    type: z.literal("open-shell"),
    cwd: z.string().min(1).max(4096),
  })
  .strict();

export const TuiRendererControlRequestSchema = z.discriminatedUnion("type", [
  TuiRendererDismissRequestSchema,
  TuiRendererDismissFocusTargetRequestSchema,
  TuiRendererResolveFocusTargetRequestSchema,
  TuiRendererOpenShellRequestSchema,
]);

export type TuiRendererControlRequest = z.infer<typeof TuiRendererControlRequestSchema>;

export const TuiRendererDismissedResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("dismissed"),
  })
  .strict();

export const TuiRendererShellOpenedResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("shell-opened"),
  })
  .strict();

export const TuiRendererFocusTargetResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("focus-target"),
    origin: TerminalFocusOriginSchema,
  })
  .strict();

export const TuiRendererControlErrorResponseSchema = z
  .object({
    ...frameShape,
    type: z.literal("error"),
    error: SafeErrorSchema,
  })
  .strict();

export const TuiRendererControlResponseSchema = z.discriminatedUnion("type", [
  TuiRendererDismissedResponseSchema,
  TuiRendererShellOpenedResponseSchema,
  TuiRendererFocusTargetResponseSchema,
  TuiRendererControlErrorResponseSchema,
]);

export type TuiRendererControlResponse = z.infer<typeof TuiRendererControlResponseSchema>;
