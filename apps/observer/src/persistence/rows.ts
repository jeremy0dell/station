import type { StationCommand } from "@station/contracts";
import {
  ErrorEnvelopeSchema,
  SafeErrorSchema,
  StationCommandSchema,
  StationEventSchema,
} from "@station/contracts";
import { parseJson } from "./json.js";
import { parseProviderObservation } from "./observationParser.js";
import type {
  PersistedCommand,
  PersistedCommandError,
  PersistedCommandStatus,
  PersistedEvent,
  PersistedProviderObservation,
  PersistedSession,
  ProviderObservationType,
} from "./types.js";

export type SqliteCommandRow = {
  id: string;
  type: StationCommand["type"];
  payload_json: string;
  status: PersistedCommandStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  trace_id: string | null;
  span_id: string | null;
  error_json: string | null;
};

export type SqliteCommandErrorRow = {
  id: string;
  command_id: string;
  envelope_json: string;
  created_at: string;
};

export type SqliteEventRow = {
  id: string;
  type: string;
  source: string;
  command_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  payload_json: string;
  created_at: string;
};

export type SqliteProviderObservationRow = {
  id: string;
  provider: string;
  provider_type: ProviderObservationType;
  entity_kind: string;
  entity_key: string;
  payload_json: string;
  observed_at: string;
  expires_at: string | null;
};

export type SqliteSessionRow = {
  id: string;
  project_id: string;
  worktree_id: string;
  title: string | null;
  harness: string | null;
  terminal_provider: string | null;
  state: string | null;
  created_at: string;
  ended_at: string | null;
  last_seen_at: string;
};

export function commandFromRow(row: SqliteCommandRow): PersistedCommand {
  const command = StationCommandSchema.parse(parseJson(row.payload_json));
  const persistedCommand: PersistedCommand = {
    id: row.id,
    type: command.type,
    command,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.started_at !== null) persistedCommand.startedAt = row.started_at;
  if (row.finished_at !== null) persistedCommand.finishedAt = row.finished_at;
  if (row.trace_id !== null) persistedCommand.traceId = row.trace_id;
  if (row.span_id !== null) persistedCommand.spanId = row.span_id;
  if (row.error_json !== null) {
    persistedCommand.error = SafeErrorSchema.parse(parseJson(row.error_json));
  }
  return persistedCommand;
}

export function commandErrorFromRow(row: SqliteCommandErrorRow): PersistedCommandError {
  return {
    id: row.id,
    commandId: row.command_id,
    envelope: ErrorEnvelopeSchema.parse(parseJson(row.envelope_json)),
    createdAt: row.created_at,
  };
}

export function eventFromRow(row: SqliteEventRow): PersistedEvent {
  const event = StationEventSchema.parse(parseJson(row.payload_json));
  const persistedEvent: PersistedEvent = {
    id: row.id,
    type: event.type,
    source: row.source,
    event,
    createdAt: row.created_at,
  };
  if (row.command_id !== null) persistedEvent.commandId = row.command_id;
  if (row.trace_id !== null) persistedEvent.traceId = row.trace_id;
  if (row.span_id !== null) persistedEvent.spanId = row.span_id;
  return persistedEvent;
}

export function providerObservationFromRow(
  row: SqliteProviderObservationRow,
  referenceTime: string,
): PersistedProviderObservation {
  const expiresAt = row.expires_at ?? undefined;
  const parsed = parseProviderObservation(row.entity_kind, parseJson(row.payload_json));
  const observation: PersistedProviderObservation = {
    id: row.id,
    provider: row.provider,
    providerType: row.provider_type,
    entityKey: row.entity_key,
    observedAt: row.observed_at,
    expired: expiresAt === undefined ? false : Date.parse(expiresAt) <= Date.parse(referenceTime),
    ...parsed,
  };
  if (expiresAt !== undefined) observation.expiresAt = expiresAt;
  return observation;
}

export function sessionFromRow(row: SqliteSessionRow): PersistedSession {
  const session: PersistedSession = {
    id: row.id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
  if (row.title !== null) session.title = row.title;
  if (row.harness !== null) session.harness = row.harness;
  if (row.terminal_provider !== null) session.terminalProvider = row.terminal_provider;
  if (row.state !== null) session.state = row.state;
  if (row.ended_at !== null) session.endedAt = row.ended_at;
  return session;
}
