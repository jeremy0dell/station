import type { CommandId, StationEvent } from "@station/contracts";
import {
  StationEventSchema,
  stationEventCommandId,
  stationEventTimestamp,
} from "@station/contracts";
import type { SqlDatabase } from "../sqlite/driver.js";
import { stringifyJson } from "./json.js";
import { eventFromRow, type SqliteEventRow } from "./rows.js";
import type { PersistedEvent } from "./types.js";

export function recordEvent(
  database: SqlDatabase,
  event: StationEvent,
  options: {
    eventId: string;
    source: string;
    createdAt: string;
    commandId?: CommandId;
    traceId?: string;
    spanId?: string;
  },
): PersistedEvent {
  const parsedEvent = StationEventSchema.parse(event);
  database
    .prepare(
      `
        INSERT INTO events (id, type, source, command_id, trace_id, span_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      options.eventId,
      parsedEvent.type,
      options.source,
      options.commandId ?? null,
      options.traceId ?? null,
      options.spanId ?? null,
      stringifyJson(parsedEvent),
      options.createdAt,
    );
  return readEvent(database, options.eventId);
}

export function listEvents(
  database: SqlDatabase,
  filter: {
    commandId?: CommandId;
    type?: StationEvent["type"];
  } = {},
): PersistedEvent[] {
  const rows = database
    .prepare("SELECT * FROM events ORDER BY created_at, id")
    .all() as SqliteEventRow[];
  const events: PersistedEvent[] = [];
  for (const row of rows) {
    try {
      events.push(eventFromRow(row));
    } catch {
      // Skip rows whose payload no longer parses against current contracts. Diagnostics list
      // events best-effort so one unparseable row cannot break doctor.
    }
  }
  return events
    .filter((event) => filter.commandId === undefined || event.commandId === filter.commandId)
    .filter((event) => filter.type === undefined || event.type === filter.type);
}

export function eventCommandId(event: StationEvent): CommandId | undefined {
  return stationEventCommandId(event);
}

export function eventTimestamp(event: StationEvent): string | undefined {
  return stationEventTimestamp(event);
}

function readEvent(database: SqlDatabase, eventId: string): PersistedEvent {
  const row = database.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as SqliteEventRow;
  return eventFromRow(row);
}
