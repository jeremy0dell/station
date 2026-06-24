import type { CommandRecord } from "@station/contracts";
import type { PersistedCommand } from "../persistence/index.js";

export function commandRecordFromPersisted(command: PersistedCommand): CommandRecord {
  const record: CommandRecord = {
    id: command.id,
    type: command.type,
    command: command.command,
    status: command.status,
    createdAt: command.createdAt,
  };
  if (command.startedAt !== undefined) record.startedAt = command.startedAt;
  if (command.finishedAt !== undefined) record.finishedAt = command.finishedAt;
  if (command.traceId !== undefined) record.traceId = command.traceId;
  if (command.spanId !== undefined) record.spanId = command.spanId;
  if (command.error !== undefined) record.error = command.error;
  if (command.diagnostics !== undefined) record.diagnostics = command.diagnostics;
  return record;
}
