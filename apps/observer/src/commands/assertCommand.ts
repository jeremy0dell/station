import type { StationCommand } from "@station/contracts";
import type { CommandHandlerContext } from "./queue.js";

export function assertCommandType<TType extends StationCommand["type"]>(
  context: CommandHandlerContext,
  type: TType,
): asserts context is CommandHandlerContext & {
  command: Extract<StationCommand, { type: TType }>;
} {
  if (context.command.type !== type) {
    throw new Error(`Expected ${type} command, received ${context.command.type}.`);
  }
}
