import type {
  CommandId,
  DiagnosticDetail,
  ErrorEnvelope,
  SafeError,
  StationCommand,
} from "@station/contracts";
import { ErrorEnvelopeSchema, SafeErrorSchema, StationCommandSchema } from "@station/contracts";
import type { SqlDatabase } from "../sqlite/driver.js";
import { stringifyJson } from "./json.js";
import {
  commandErrorFromRow,
  commandFromRow,
  eventFromRow,
  type SqliteCommandErrorRow,
  type SqliteCommandRow,
  type SqliteEventRow,
} from "./rows.js";
import type { PersistedCommand, PersistedCommandError } from "./types.js";

export function recordCommandAccepted(
  database: SqlDatabase,
  input: {
    commandId: CommandId;
    command: StationCommand;
    createdAt: string;
    traceId?: string;
    spanId?: string;
  },
): PersistedCommand {
  const command = StationCommandSchema.parse(input.command);
  database
    .prepare(
      `
        INSERT INTO commands (id, type, payload_json, status, created_at, trace_id, span_id)
        VALUES (?, ?, ?, 'accepted', ?, ?, ?)
      `,
    )
    .run(
      input.commandId,
      command.type,
      stringifyJson(command),
      input.createdAt,
      input.traceId ?? null,
      input.spanId ?? null,
    );
  return readCommand(database, input.commandId);
}

export function markCommandStarted(
  database: SqlDatabase,
  commandId: CommandId,
  startedAt: string,
): PersistedCommand {
  database
    .prepare("UPDATE commands SET status = 'started', started_at = ? WHERE id = ?")
    .run(startedAt, commandId);
  return readCommand(database, commandId);
}

export function markCommandSucceeded(
  database: SqlDatabase,
  commandId: CommandId,
  finishedAt: string,
): PersistedCommand {
  database
    .prepare(
      "UPDATE commands SET status = 'succeeded', finished_at = ?, error_json = NULL WHERE id = ?",
    )
    .run(finishedAt, commandId);
  return readCommand(database, commandId);
}

export function markCommandFailed(
  database: SqlDatabase,
  input: {
    commandId: CommandId;
    safeError: SafeError;
    envelope: ErrorEnvelope;
    finishedAt: string;
  },
): PersistedCommand {
  const safeError = SafeErrorSchema.parse(input.safeError);
  const envelope = ErrorEnvelopeSchema.parse(input.envelope);
  database
    .prepare("UPDATE commands SET status = 'failed', finished_at = ?, error_json = ? WHERE id = ?")
    .run(input.finishedAt, stringifyJson(safeError), input.commandId);
  database
    .prepare(
      `
        INSERT OR REPLACE INTO command_errors (id, command_id, envelope_json, created_at)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(envelope.id, input.commandId, stringifyJson(envelope), envelope.createdAt);
  return readCommand(database, input.commandId);
}

export function getCommand(
  database: SqlDatabase,
  commandId: CommandId,
): PersistedCommand | undefined {
  const row = getCommandRow(database, commandId);
  return row === undefined
    ? undefined
    : commandWithDiagnostics(commandFromRow(row), commandErrorRows(database, commandId));
}

export function listCommands(database: SqlDatabase): PersistedCommand[] {
  const rows = database
    .prepare("SELECT * FROM commands ORDER BY created_at, id")
    .all() as SqliteCommandRow[];
  const errorRows = commandErrorRows(database);
  const errorRowsByCommandId = new Map<string, SqliteCommandErrorRow[]>();
  for (const row of errorRows) {
    const existing = errorRowsByCommandId.get(row.command_id);
    if (existing === undefined) {
      errorRowsByCommandId.set(row.command_id, [row]);
    } else {
      existing.push(row);
    }
  }
  const commands: PersistedCommand[] = [];
  for (const row of rows) {
    try {
      commands.push(
        commandWithDiagnostics(commandFromRow(row), errorRowsByCommandId.get(row.id) ?? []),
      );
    } catch {
      // Skip rows whose payload no longer parses against current command contracts. Diagnostics
      // list commands best-effort so one unparseable row does not poison doctor/debug output.
    }
  }
  return commands;
}

export function listCommandRecoveryCandidates(
  database: SqlDatabase,
  input: { failedCommandTypes: StationCommand["type"][] },
): PersistedCommand[] {
  const invalidSucceededEventCommandIds = invalidSucceededEventCommands(database);
  const conditions = [
    `(status = 'accepted')`,
    `(status = 'succeeded' AND NOT EXISTS (
      SELECT 1 FROM events WHERE events.command_id = commands.id AND events.type = 'command.succeeded'
    ))`,
    `(status = 'started' AND type = 'worktree.remove')`,
  ];
  if (input.failedCommandTypes.length > 0) {
    conditions.push(
      `(status = 'failed' AND type IN (${input.failedCommandTypes.map(() => "?").join(", ")}))`,
    );
  }
  const rows = database
    .prepare(`SELECT * FROM commands WHERE ${conditions.join(" OR ")} ORDER BY created_at, id`)
    .all(...input.failedCommandTypes) as SqliteCommandRow[];
  if (invalidSucceededEventCommandIds.length > 0) {
    const invalid = new Set(invalidSucceededEventCommandIds);
    rows.push(
      ...(
        database
          .prepare("SELECT * FROM commands WHERE status = 'succeeded'")
          .all() as SqliteCommandRow[]
      ).filter((row) => invalid.has(row.id)),
    );
    rows.sort(
      (left, right) =>
        (left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  }
  const commands: PersistedCommand[] = [];
  for (const row of rows) {
    try {
      commands.push(
        commandWithDiagnostics(commandFromRow(row), commandErrorRows(database, row.id)),
      );
    } catch {
      // Recovery is best effort across legacy rows; invalid payloads remain available to diagnostics.
    }
  }
  return commands;
}

function invalidSucceededEventCommands(database: SqlDatabase): string[] {
  const recordedRows = database
    .prepare(
      `SELECT DISTINCT command_id FROM events
       WHERE type = 'command.succeeded' AND command_id IS NOT NULL`,
    )
    .all() as { command_id: string }[];
  // SQLite rejects only invalid JSON syntax; the shared event schema still owns validity.
  const rows = database
    .prepare(
      `SELECT * FROM events
       WHERE type = 'command.succeeded' AND json_valid(payload_json)`,
    )
    .all() as SqliteEventRow[];
  const recorded = new Set(recordedRows.map(({ command_id }) => command_id));
  const valid = new Set<string>();
  for (const row of rows) {
    try {
      const event = eventFromRow(row);
      if (event.event.type === "command.succeeded") valid.add(event.event.commandId);
    } catch {
      // Indexed row metadata is only coarse evidence; the shared schema owns payload validity.
    }
  }
  return [...recorded].filter((commandId) => !valid.has(commandId));
}

export function listCommandErrors(
  database: SqlDatabase,
  commandId?: CommandId,
): PersistedCommandError[] {
  const rows =
    commandId === undefined
      ? (database
          .prepare("SELECT * FROM command_errors ORDER BY created_at, id")
          .all() as SqliteCommandErrorRow[])
      : (database
          .prepare("SELECT * FROM command_errors WHERE command_id = ? ORDER BY created_at, id")
          .all(commandId) as SqliteCommandErrorRow[]);
  return rows.map(commandErrorFromRow);
}

function readCommand(database: SqlDatabase, commandId: string): PersistedCommand {
  const row = getCommandRow(database, commandId);
  if (row === undefined) {
    throw new Error(`Command ${commandId} was not found.`);
  }
  return commandWithDiagnostics(commandFromRow(row), commandErrorRows(database, commandId));
}

function getCommandRow(database: SqlDatabase, commandId: string): SqliteCommandRow | undefined {
  return database.prepare("SELECT * FROM commands WHERE id = ?").get(commandId) as
    | SqliteCommandRow
    | undefined;
}

function commandErrorRows(database: SqlDatabase, commandId?: CommandId): SqliteCommandErrorRow[] {
  return commandId === undefined
    ? (database
        .prepare("SELECT * FROM command_errors ORDER BY created_at, id")
        .all() as SqliteCommandErrorRow[])
    : (database
        .prepare("SELECT * FROM command_errors WHERE command_id = ? ORDER BY created_at, id")
        .all(commandId) as SqliteCommandErrorRow[]);
}

function commandWithDiagnostics(
  command: PersistedCommand,
  errorRows: readonly SqliteCommandErrorRow[],
): PersistedCommand {
  const diagnostics = commandDiagnostics(errorRows);
  if (diagnostics.length === 0) {
    return command;
  }
  return {
    ...command,
    diagnostics,
  };
}

function commandDiagnostics(errorRows: readonly SqliteCommandErrorRow[]): DiagnosticDetail[] {
  const diagnostics: DiagnosticDetail[] = [];
  const seen = new Set<string>();
  for (const row of errorRows) {
    try {
      for (const detail of commandErrorFromRow(row).envelope.diagnostics ?? []) {
        const key = stringifyJson(detail);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        diagnostics.push(detail);
      }
    } catch {
      // Command records remain useful even if an old command_errors row cannot be parsed.
    }
  }
  return diagnostics;
}
