import {
  SafeErrorSchema,
  WorktreeChangeSummarySchema,
  WorktreeChecksSummarySchema,
  WorktreePullRequestSchema,
} from "@station/contracts";
import type { SqlDatabase, SqlParam } from "../sqlite/driver.js";
import { parseJson, stringifyJson } from "./json.js";
import type {
  PersistedWorktreeMetadataCurrent,
  WorktreeMetadataCurrentKind,
  WorktreeMetadataCurrentPayloadByKind,
} from "./types.js";

type SqliteWorktreeMetadataCurrentRow = {
  worktree_id: string;
  kind: WorktreeMetadataCurrentKind;
  payload_json: string;
  cache_key: string | null;
  updated_at: string;
  expires_at: string | null;
  stale: number;
  last_error_json: string | null;
};

export function upsertWorktreeMetadataCurrent<TKind extends WorktreeMetadataCurrentKind>(
  database: SqlDatabase,
  input: {
    worktreeId: string;
    kind: TKind;
    payload: WorktreeMetadataCurrentPayloadByKind[TKind];
    updatedAt: string;
    cacheKey?: string;
    expiresAt?: string | undefined;
    stale?: boolean;
    lastError?: unknown;
  },
): PersistedWorktreeMetadataCurrent<TKind> {
  const payload = validateWorktreeMetadataPayload(input.kind, input.payload);
  const lastError =
    input.lastError === undefined ? undefined : SafeErrorSchema.parse(input.lastError);

  database
    .prepare(
      `
        INSERT INTO worktree_metadata_current
          (worktree_id, kind, payload_json, cache_key, updated_at, expires_at, stale, last_error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_id, kind) DO UPDATE SET
          payload_json = excluded.payload_json,
          cache_key = excluded.cache_key,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          stale = excluded.stale,
          last_error_json = excluded.last_error_json
      `,
    )
    .run(
      input.worktreeId,
      input.kind,
      stringifyJson(payload),
      input.cacheKey ?? null,
      input.updatedAt,
      input.expiresAt ?? null,
      input.stale === true ? 1 : 0,
      lastError === undefined ? null : stringifyJson(lastError),
    );

  return mustWorktreeMetadataCurrentFromRow(
    readWorktreeMetadataCurrent(database, input.worktreeId, input.kind),
    input.updatedAt,
  ) as PersistedWorktreeMetadataCurrent<TKind>;
}

export function listWorktreeMetadataCurrent<TKind extends WorktreeMetadataCurrentKind>(
  database: SqlDatabase,
  options: {
    kind?: TKind | readonly TKind[];
    includeExpired?: boolean;
    referenceTime: string;
  },
): PersistedWorktreeMetadataCurrent<TKind>[] {
  const query = buildListWorktreeMetadataCurrentQuery(options);
  const rows = database
    .prepare(query.sql)
    .all(...query.params) as SqliteWorktreeMetadataCurrentRow[];
  return rows
    .map((row) => worktreeMetadataCurrentFromRow(row, options.referenceTime))
    .filter((row): row is PersistedWorktreeMetadataCurrent<TKind> => row !== undefined);
}

export function deleteWorktreeMetadataCurrent(
  database: SqlDatabase,
  input: {
    worktreeId: string;
    kind?: WorktreeMetadataCurrentKind;
  },
): number {
  const result =
    input.kind === undefined
      ? database
          .prepare("DELETE FROM worktree_metadata_current WHERE worktree_id = ?")
          .run(input.worktreeId)
      : database
          .prepare("DELETE FROM worktree_metadata_current WHERE worktree_id = ? AND kind = ?")
          .run(input.worktreeId, input.kind);
  return Number(result.changes);
}

function buildListWorktreeMetadataCurrentQuery<TKind extends WorktreeMetadataCurrentKind>(options: {
  kind?: TKind | readonly TKind[];
  includeExpired?: boolean;
  referenceTime: string;
}): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];

  if (options.kind !== undefined) {
    const kinds = typeof options.kind === "string" ? [options.kind] : [...options.kind];
    if (kinds.length === 0) {
      return {
        sql: "SELECT * FROM worktree_metadata_current WHERE 1 = 0 ORDER BY updated_at, worktree_id, kind",
        params: [],
      };
    }
    clauses.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }

  if (options.includeExpired !== true) {
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(options.referenceTime);
  }

  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  return {
    sql: `SELECT * FROM worktree_metadata_current${where} ORDER BY updated_at, worktree_id, kind`,
    params,
  };
}

function readWorktreeMetadataCurrent(
  database: SqlDatabase,
  worktreeId: string,
  kind: WorktreeMetadataCurrentKind,
): SqliteWorktreeMetadataCurrentRow {
  return database
    .prepare("SELECT * FROM worktree_metadata_current WHERE worktree_id = ? AND kind = ?")
    .get(worktreeId, kind) as SqliteWorktreeMetadataCurrentRow;
}

function mustWorktreeMetadataCurrentFromRow(
  row: SqliteWorktreeMetadataCurrentRow,
  referenceTime: string,
): PersistedWorktreeMetadataCurrent {
  const parsed = worktreeMetadataCurrentFromRow(row, referenceTime);
  if (parsed === undefined) {
    throw new Error("Invalid worktree metadata current row.");
  }
  return parsed;
}

function worktreeMetadataCurrentFromRow(
  row: SqliteWorktreeMetadataCurrentRow,
  referenceTime: string,
): PersistedWorktreeMetadataCurrent | undefined {
  const payload = parseWorktreeMetadataPayload(row.kind, parseJson(row.payload_json));
  if (payload === undefined) {
    return undefined;
  }

  const expiresAt = row.expires_at ?? undefined;
  const current: PersistedWorktreeMetadataCurrent = {
    worktreeId: row.worktree_id,
    kind: row.kind,
    payload,
    updatedAt: row.updated_at,
    expired: expiresAt === undefined ? false : Date.parse(expiresAt) <= Date.parse(referenceTime),
    stale: row.stale === 1,
  };
  if (row.cache_key !== null) current.cacheKey = row.cache_key;
  if (expiresAt !== undefined) current.expiresAt = expiresAt;
  if (row.last_error_json !== null) {
    const parsedError = SafeErrorSchema.safeParse(parseJson(row.last_error_json));
    if (parsedError.success) {
      current.lastError = parsedError.data;
    }
  }
  return current;
}

function parseWorktreeMetadataPayload(
  kind: WorktreeMetadataCurrentKind,
  payload: unknown,
): PersistedWorktreeMetadataCurrent["payload"] | undefined {
  const parsed = metadataPayloadSchema(kind).safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function validateWorktreeMetadataPayload<TKind extends WorktreeMetadataCurrentKind>(
  kind: TKind,
  payload: unknown,
): WorktreeMetadataCurrentPayloadByKind[TKind] {
  return metadataPayloadSchema(kind).parse(payload) as WorktreeMetadataCurrentPayloadByKind[TKind];
}

function metadataPayloadSchema(kind: WorktreeMetadataCurrentKind) {
  if (kind === "change_summary") {
    return WorktreeChangeSummarySchema;
  }
  if (kind === "pull_request") {
    return WorktreePullRequestSchema;
  }
  return WorktreeChecksSummarySchema;
}
