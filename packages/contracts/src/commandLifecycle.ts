import { z } from "zod";
import {
  type StationCommand,
  type StationCommandResultFor,
  StationCommandResultSchema,
  StationCommandSchema,
  StationCommandTypeSchema,
} from "./commands.js";
import { DiagnosticDetailSchema, SafeErrorSchema } from "./errors.js";
import { CommandIdSchema, TimestampSchema } from "./ids.js";
import { nonEmptyStringSchema } from "./shared.js";

const CommandReceiptIdentityFields = {
  commandId: CommandIdSchema,
  traceId: nonEmptyStringSchema.optional(),
  spanId: nonEmptyStringSchema.optional(),
} as const;

export const AcceptedCommandReceiptSchema = z
  .object({
    ...CommandReceiptIdentityFields,
    accepted: z.literal(true),
    status: z.literal("accepted"),
    error: z.never().optional(),
  })
  .strict();

export const RejectedCommandReceiptSchema = z
  .object({
    ...CommandReceiptIdentityFields,
    accepted: z.literal(false),
    status: z.literal("rejected"),
    error: SafeErrorSchema.optional(),
  })
  .strict();

export const CommandReceiptSchema = z.discriminatedUnion("status", [
  AcceptedCommandReceiptSchema,
  RejectedCommandReceiptSchema,
]);

export type AcceptedCommandReceipt = z.infer<typeof AcceptedCommandReceiptSchema>;
export type RejectedCommandReceipt = z.infer<typeof RejectedCommandReceiptSchema>;
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

const CommandRecordBaseSchema = z
  .object({
    id: CommandIdSchema,
    type: StationCommandTypeSchema,
    command: StationCommandSchema,
    status: z.enum(["accepted", "started", "succeeded", "failed"]),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
    traceId: nonEmptyStringSchema.optional(),
    spanId: nonEmptyStringSchema.optional(),
    error: SafeErrorSchema.optional(),
    diagnostics: z.array(DiagnosticDetailSchema).optional(),
    result: StationCommandResultSchema.optional(),
  })
  .strict();

type CommandRecordBase = z.infer<typeof CommandRecordBaseSchema>;
export type CommandRecordInput = z.input<typeof CommandRecordBaseSchema>;

type CorrelatedCommandRecord<TCommand extends StationCommand> = Omit<
  CommandRecordBase,
  "type" | "command" | "status" | "result"
> & {
  type: TCommand["type"];
  command: TCommand;
};

type CommandRecordLifecycle<TCommand extends StationCommand> =
  | { status: "accepted" | "started" | "failed"; result?: never }
  | { status: "succeeded"; result?: StationCommandResultFor<TCommand> };

export type CommandRecordFor<TCommand extends StationCommand> = TCommand extends StationCommand
  ? CorrelatedCommandRecord<TCommand> & CommandRecordLifecycle<TCommand>
  : never;

export type CommandRecord = CommandRecordFor<StationCommand>;
export type SucceededCommandRecord = CommandRecord & { status: "succeeded" };
export type FailedCommandRecord = CommandRecord & { status: "failed" };
export type CommandExecutionOutcome =
  | { status: "accepted"; receipt: AcceptedCommandReceipt }
  | { status: "rejected"; receipt: RejectedCommandReceipt }
  | { status: "succeeded"; receipt: AcceptedCommandReceipt; record: SucceededCommandRecord }
  | { status: "failed"; receipt: AcceptedCommandReceipt; record: FailedCommandRecord };

export const CommandRecordSchema = CommandRecordBaseSchema.superRefine((record, context) => {
  if (record.type !== record.command.type) {
    context.addIssue({
      code: "custom",
      message: "Command record type must match the embedded command type.",
      path: ["type"],
    });
  }
  if (record.result !== undefined && record.status !== "succeeded") {
    context.addIssue({
      code: "custom",
      message: "Only a succeeded command record may contain a result.",
      path: ["result"],
    });
  }
  if (record.result !== undefined && record.result.type !== record.command.type) {
    context.addIssue({
      code: "custom",
      message: "Command result type must match the embedded command type.",
      path: ["result", "type"],
    });
  }
}) as z.ZodType<CommandRecord>;

const TerminalCommandOutcomeSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    receipt: AcceptedCommandReceiptSchema,
    record: CommandRecordSchema,
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.receipt.commandId !== outcome.record.id) {
      context.addIssue({
        code: "custom",
        message: "Outcome receipt and record command ids must match.",
        path: ["record", "id"],
      });
    }
    if (outcome.status !== outcome.record.status) {
      context.addIssue({
        code: "custom",
        message: "Outcome and record terminal statuses must match.",
        path: ["record", "status"],
      });
    }
  });

export const CommandExecutionOutcomeSchema = z.union([
  z.object({ status: z.literal("accepted"), receipt: AcceptedCommandReceiptSchema }).strict(),
  z.object({ status: z.literal("rejected"), receipt: RejectedCommandReceiptSchema }).strict(),
  TerminalCommandOutcomeSchema,
]) as z.ZodType<CommandExecutionOutcome>;
