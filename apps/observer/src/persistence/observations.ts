import type { ProviderId } from "@station/contracts";
import type { SqlDatabase, SqlParam } from "../sqlite/driver.js";
import { parseJson, stringifyJson } from "./json.js";
import {
  parseProviderObservation,
  stableProviderObservationPayloadKey,
} from "./observationParser.js";
import { providerObservationFromRow, type SqliteProviderObservationRow } from "./rows.js";
import type {
  CurrentProviderObservationKind,
  PersistedProviderObservation,
  ProviderObservationKind,
  ProviderObservationType,
  RecordProviderObservationInput,
} from "./types.js";

type InsertProviderObservationInput = RecordProviderObservationInput & {
  id: string;
  observedAt: string;
  coalesceUnchanged?: boolean;
};

export function insertProviderObservation(
  database: SqlDatabase,
  input: InsertProviderObservationInput,
): PersistedProviderObservation {
  const observation = parseProviderObservation(input.entityKind, input.payload);
  const payloadJson = stringifyJson(observation.payload);
  if (input.coalesceUnchanged === true) {
    const latest = latestProviderObservationRow(database, input);
    if (
      latest !== undefined &&
      stableProviderObservationPayloadKey(
        parseProviderObservation(latest.entity_kind, parseJson(latest.payload_json)).payload,
      ) === stableProviderObservationPayloadKey(observation.payload)
    ) {
      database
        .prepare(
          `
            UPDATE provider_observations
            SET payload_json = ?, observed_at = ?, expires_at = ?
            WHERE id = ?
          `,
        )
        .run(payloadJson, input.observedAt, input.expiresAt ?? null, latest.id);
      return providerObservationFromRow(
        readProviderObservation(database, latest.id),
        input.observedAt,
      );
    }
  }

  database
    .prepare(
      `
        INSERT OR REPLACE INTO provider_observations
          (id, provider, provider_type, entity_kind, entity_key, payload_json, observed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.provider,
      input.providerType,
      observation.entityKind,
      input.entityKey,
      payloadJson,
      input.observedAt,
      input.expiresAt ?? null,
    );

  return providerObservationFromRow(readProviderObservation(database, input.id), input.observedAt);
}

export function listProviderObservations(
  database: SqlDatabase,
  options: {
    entityKind?: ProviderObservationKind | readonly ProviderObservationKind[];
    includeExpired?: boolean;
    latestOnly?: boolean;
    referenceTime: string;
  },
): PersistedProviderObservation[] {
  const query = buildProviderObservationQuery(options);
  return (database.prepare(query.sql).all(...query.params) as SqliteProviderObservationRow[]).map(
    (row) => providerObservationFromRow(row, options.referenceTime),
  );
}

export function listCurrentProviderEntityObservations(
  database: SqlDatabase,
  options: {
    entityKind?: CurrentProviderObservationKind | readonly CurrentProviderObservationKind[];
    includeExpired?: boolean;
    referenceTime: string;
  },
): PersistedProviderObservation[] {
  const query = buildCurrentProviderEntityObservationQuery(options);
  return (database.prepare(query.sql).all(...query.params) as SqliteProviderObservationRow[]).map(
    (row) => providerObservationFromRow(row, options.referenceTime),
  );
}

export function pruneExpiredProviderObservations(
  database: SqlDatabase,
  expiresBefore: string,
): number {
  const expiredResult = database
    .prepare("DELETE FROM provider_observations WHERE expires_at IS NOT NULL AND expires_at <= ?")
    .run(expiresBefore);
  return Number(expiredResult.changes);
}

function buildCurrentProviderEntityObservationQuery(options: {
  entityKind?: CurrentProviderObservationKind | readonly CurrentProviderObservationKind[];
  includeExpired?: boolean;
  referenceTime: string;
}): { sql: string; params: SqlParam[] } {
  const kinds =
    options.entityKind === undefined
      ? (["worktree", "terminal_target"] satisfies CurrentProviderObservationKind[])
      : typeof options.entityKind === "string"
        ? [options.entityKind]
        : [...options.entityKind];
  if (kinds.length === 0) {
    return {
      sql: "SELECT * FROM provider_observations WHERE 1 = 0 ORDER BY observed_at, id",
      params: [],
    };
  }

  const keySelects: string[] = [];
  if (kinds.includes("worktree")) {
    keySelects.push(
      "SELECT provider, 'worktree' AS provider_type, 'worktree' AS entity_kind, id AS entity_key FROM worktrees",
    );
  }
  if (kinds.includes("terminal_target")) {
    keySelects.push(
      "SELECT provider, 'terminal' AS provider_type, 'terminal_target' AS entity_kind, id AS entity_key FROM terminal_targets",
    );
  }
  const latestExpiryClause =
    options.includeExpired === true ? "" : " AND (i.expires_at IS NULL OR i.expires_at > ?)";
  const params: SqlParam[] = options.includeExpired === true ? [] : [options.referenceTime];
  return {
    sql: `
      WITH keys AS (
        ${keySelects.join("\n        UNION ALL\n        ")}
      )
      SELECT po.*
      FROM keys
      JOIN provider_observations po ON po.id = (
        SELECT i.id
        FROM provider_observations i
        WHERE i.provider = keys.provider
          AND i.provider_type = keys.provider_type
          AND i.entity_kind = keys.entity_kind
          AND i.entity_key = keys.entity_key${latestExpiryClause}
        ORDER BY i.observed_at DESC, i.id DESC
        LIMIT 1
      )
      ORDER BY po.observed_at, po.id
    `,
    params,
  };
}

function buildProviderObservationQuery(options: {
  entityKind?: ProviderObservationKind | readonly ProviderObservationKind[];
  includeExpired?: boolean;
  latestOnly?: boolean;
  referenceTime: string;
}): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];

  if (options.entityKind !== undefined) {
    const kinds =
      typeof options.entityKind === "string" ? [options.entityKind] : [...options.entityKind];
    if (kinds.length === 0) {
      return {
        sql: "SELECT * FROM provider_observations WHERE 1 = 0 ORDER BY observed_at, id",
        params: [],
      };
    }
    clauses.push(`entity_kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }

  if (options.includeExpired !== true) {
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(options.referenceTime);
  }

  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  if (options.latestOnly === true) {
    const latestParams = [...params];
    const latestExpiryClause =
      options.includeExpired === true ? "" : " AND (i.expires_at IS NULL OR i.expires_at > ?)";
    if (options.includeExpired !== true) {
      latestParams.push(options.referenceTime);
    }
    return {
      sql: `
        WITH keys AS (
          SELECT DISTINCT provider, provider_type, entity_kind, entity_key
          FROM provider_observations${where}
        )
        SELECT po.*
        FROM keys
        JOIN provider_observations po ON po.id = (
          SELECT i.id
          FROM provider_observations i
          WHERE i.provider = keys.provider
            AND i.provider_type = keys.provider_type
            AND i.entity_kind = keys.entity_kind
            AND i.entity_key = keys.entity_key${latestExpiryClause}
          ORDER BY i.observed_at DESC, i.id DESC
          LIMIT 1
        )
        ORDER BY po.observed_at, po.id
      `,
      params: latestParams,
    };
  }
  return {
    sql: `SELECT * FROM provider_observations${where} ORDER BY observed_at, id`,
    params,
  };
}

function latestProviderObservationRow(
  database: SqlDatabase,
  input: {
    provider: ProviderId;
    providerType: ProviderObservationType;
    entityKind: ProviderObservationKind;
    entityKey: string;
  },
): SqliteProviderObservationRow | undefined {
  return database
    .prepare(
      `
        SELECT * FROM provider_observations
        WHERE provider = ?
          AND provider_type = ?
          AND entity_kind = ?
          AND entity_key = ?
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(input.provider, input.providerType, input.entityKind, input.entityKey) as
    | SqliteProviderObservationRow
    | undefined;
}

function readProviderObservation(database: SqlDatabase, id: string): SqliteProviderObservationRow {
  return database
    .prepare("SELECT * FROM provider_observations WHERE id = ?")
    .get(id) as SqliteProviderObservationRow;
}
