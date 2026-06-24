import { z } from "zod";
import { codexHarnessError } from "../errors.js";
import type { CodexAppServerEvent } from "./types.js";

const nonEmptyStringSchema = z.string().min(1);
const requestIdSchema = z.union([nonEmptyStringSchema, z.number().int()]);

const CodexAppServerMessageSchema = z
  .object({
    method: nonEmptyStringSchema,
    id: requestIdSchema.optional(),
    params: z.unknown().optional(),
  })
  .strict();

const ThreadStatusChangedParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    status: z
      .object({
        type: nonEmptyStringSchema,
        activeFlags: z.array(nonEmptyStringSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const TurnParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turn: z
      .object({
        id: nonEmptyStringSchema,
        status: nonEmptyStringSchema,
      })
      .passthrough(),
  })
  .passthrough();

const ItemCompletedParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    item: z
      .object({
        id: nonEmptyStringSchema,
        type: nonEmptyStringSchema,
      })
      .passthrough(),
  })
  .passthrough();

const ItemPlanDeltaParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    itemId: nonEmptyStringSchema,
    delta: z.string(),
  })
  .passthrough();

const TurnPlanUpdatedParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    explanation: z.string().nullable().optional(),
    plan: z.array(
      z
        .object({
          step: nonEmptyStringSchema,
          status: nonEmptyStringSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

const ServerRequestParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    itemId: nonEmptyStringSchema,
  })
  .passthrough();

const ServerRequestResolvedParamsSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    requestId: requestIdSchema,
  })
  .passthrough();

const ErrorParamsSchema = z
  .object({
    message: nonEmptyStringSchema.optional(),
  })
  .passthrough();

export function parseCodexAppServerEvent(input: unknown): CodexAppServerEvent {
  const message = parseMessage(input);
  switch (message.method) {
    case "thread/status/changed": {
      const params = parseParams(ThreadStatusChangedParamsSchema, message.params, message.method);
      return {
        kind: "thread-status-changed",
        method: message.method,
        threadId: params.threadId,
        threadStatusType: params.status.type,
        activeFlags: params.status.activeFlags ?? [],
      };
    }
    case "turn/started":
    case "turn/completed": {
      const params = parseParams(TurnParamsSchema, message.params, message.method);
      return {
        kind: message.method === "turn/started" ? "turn-started" : "turn-completed",
        method: message.method,
        threadId: params.threadId,
        turnId: params.turn.id,
        turnStatus: params.turn.status,
      };
    }
    case "item/completed": {
      const params = parseParams(ItemCompletedParamsSchema, message.params, message.method);
      return {
        kind: "item-completed",
        method: message.method,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.item.id,
        itemType: params.item.type,
      };
    }
    case "item/plan/delta": {
      const params = parseParams(ItemPlanDeltaParamsSchema, message.params, message.method);
      return {
        kind: "plan-delta",
        method: message.method,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
      };
    }
    case "turn/plan/updated": {
      const params = parseParams(TurnPlanUpdatedParamsSchema, message.params, message.method);
      return {
        kind: "turn-plan-updated",
        method: message.method,
        threadId: params.threadId,
        turnId: params.turnId,
        planStepCount: params.plan.length,
        completedPlanStepCount: params.plan.filter((step) => step.status === "completed").length,
      };
    }
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
    case "tool/requestUserInput": {
      const params = parseParams(ServerRequestParamsSchema, message.params, message.method);
      return {
        kind: "server-request",
        method: message.method,
        requestId: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
      };
    }
    case "serverRequest/resolved": {
      const params = parseParams(ServerRequestResolvedParamsSchema, message.params, message.method);
      return {
        kind: "server-request-resolved",
        method: message.method,
        threadId: params.threadId,
        requestId: params.requestId,
      };
    }
    case "error": {
      const params = parseParams(ErrorParamsSchema, message.params ?? {}, message.method);
      return {
        kind: "error",
        method: message.method,
        message: params.message,
      };
    }
    default:
      return {
        kind: "unsupported",
        method: message.method,
        requestId: message.id,
      };
  }
}

function parseMessage(input: unknown): z.infer<typeof CodexAppServerMessageSchema> {
  const result = CodexAppServerMessageSchema.safeParse(input);
  if (!result.success) {
    throw codexHarnessError(
      "HARNESS_CODEX_EVENT_INVALID",
      "Codex app-server message did not match a supported envelope schema.",
      result.error,
    );
  }
  return result.data;
}

function parseParams<T extends z.ZodType>(schema: T, input: unknown, method: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw codexHarnessError(
      "HARNESS_CODEX_EVENT_INVALID",
      `Codex app-server ${method} params did not match a supported schema.`,
      result.error,
    );
  }
  return result.data;
}
