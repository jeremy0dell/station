import type {
  HarnessRunObservation,
  ProviderId,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { sameObservedPath, WorktreeObservationSchema } from "@station/contracts";
import { harnessRunCanActivateSession, terminalCanActivateSession } from "../sessionActivation.js";
import type { SqlDatabase } from "../sqlite/driver.js";
import { resolveWorktreeDisplayTitle } from "../worktreeDisplayTitle.js";
import { maxIso } from "./json.js";
import { insertProviderObservation } from "./observations.js";
import { providerObservationExpiresAt } from "./retention.js";
import { type SqliteSessionRow, sessionFromRow } from "./rows.js";
import type {
  ObserverIdFactory,
  PersistedSession,
  PersistedWorktreeDisplayTitle,
  PersistReconcileResultInput,
} from "./types.js";
import {
  deleteWorktreeDisplayTitle,
  insertMissingWorktreeDisplayTitles,
  listWorktreeDisplayTitles,
  readWorktreeDisplayTitle,
  synchronizeSessionTitleProjections,
  upsertWorktreeDisplayTitle,
} from "./worktreeDisplayTitles.js";

export function persistReconcileResult(
  database: SqlDatabase,
  input: PersistReconcileResultInput,
  options: { observedAt: string; idFactory: ObserverIdFactory },
): void {
  for (const worktree of input.worktrees.map((value) => WorktreeObservationSchema.parse(value))) {
    rememberWorktreeIdentity(database, worktree);
  }
  if (input.providerHealth !== undefined) {
    for (const health of Object.values(input.providerHealth)) {
      insertProviderObservation(database, {
        id: options.idFactory.observationId(),
        provider: health.providerId,
        providerType: "observer",
        entityKind: "provider_health",
        entityKey: health.providerId,
        payload: health,
        observedAt: health.lastCheckedAt,
        expiresAt: expiresAtFor(input, health.lastCheckedAt),
        coalesceUnchanged: true,
      });
    }
  }
  const resolvedTitles = resolveReconcileWorktreeDisplayTitles(database, input, options.observedAt);
  const insertedTitles = insertMissingWorktreeDisplayTitles(database, resolvedTitles);
  const persistedTitles = resolvedTitles.map((title) => {
    const persisted = readWorktreeDisplayTitle(database, title);
    if (persisted === undefined) {
      throw new Error(`Failed to initialize worktree display title for ${title.worktreeId}.`);
    }
    if (insertedTitles > 0) synchronizeSessionTitleProjections(database, persisted);
    return persisted;
  });
  upsertSessions(database, input.terminalTargets, input.harnessRuns, persistedTitles);
}

function expiresAtFor(input: PersistReconcileResultInput, observedAt: string): string | undefined {
  if (input.providerObservationRetentionDays !== undefined) {
    return providerObservationExpiresAt(observedAt, input.providerObservationRetentionDays);
  }
  return input.expiresAt;
}

export function listSessions(database: SqlDatabase): PersistedSession[] {
  return (database.prepare("SELECT * FROM sessions ORDER BY id").all() as SqliteSessionRow[]).map(
    sessionFromRow,
  );
}

type RememberedHarnessSessionRow = {
  id: string;
  worktree_id: string;
  harness: ProviderId;
  created_at: string;
  last_seen_at: string;
  worktree_path: string | null;
};

export function findRememberedHarnessProviderForWorktree(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string; worktreePath: string },
): ProviderId | undefined {
  const rows = database
    .prepare(
      `
        SELECT
          sessions.id,
          sessions.worktree_id,
          sessions.harness,
          sessions.created_at,
          sessions.last_seen_at,
          worktrees.path AS worktree_path
        FROM sessions
        LEFT JOIN worktrees
          ON worktrees.id = sessions.worktree_id
          AND worktrees.project_id = sessions.project_id
        WHERE sessions.project_id = ?
          AND sessions.harness IS NOT NULL
        ORDER BY sessions.last_seen_at DESC, sessions.created_at DESC, sessions.id DESC
      `,
    )
    .all(input.projectId) as RememberedHarnessSessionRow[];

  const directMatch = rows.find((row) => row.worktree_id === input.worktreeId);
  if (directMatch !== undefined) {
    return directMatch.harness;
  }
  return rows.find(
    (row) => row.worktree_path !== null && sameObservedPath(row.worktree_path, input.worktreePath),
  )?.harness;
}

export function renameSession(
  database: SqlDatabase,
  input: { sessionId: string; title: string; renamedAt: string },
): PersistedSession | undefined {
  const existing = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  if (existing === undefined) return undefined;

  const canonical = upsertWorktreeDisplayTitle(database, {
    projectId: existing.project_id,
    worktreeId: existing.worktree_id,
    title: input.title,
    createdAt: input.renamedAt,
    updatedAt: input.renamedAt,
  });
  synchronizeSessionTitleProjections(database, canonical);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  return row === undefined ? undefined : sessionFromRow(row);
}

export function markSessionsEnded(
  database: SqlDatabase,
  input: {
    subject:
      | { kind: "session"; sessionId: string }
      | { kind: "worktree"; projectId: string; worktreeId: string };
    endedAt: string;
  },
): number {
  const result =
    input.subject.kind === "session"
      ? database
          .prepare(
            `
              UPDATE sessions
              SET lifecycle = 'ended', ended_at = ?
              WHERE id = ? AND (lifecycle IS NULL OR lifecycle = 'open')
            `,
          )
          .run(input.endedAt, input.subject.sessionId)
      : database
          .prepare(
            `
              UPDATE sessions
              SET lifecycle = 'ended', ended_at = ?
              WHERE project_id = ? AND worktree_id = ?
                AND (lifecycle IS NULL OR lifecycle = 'open')
            `,
          )
          .run(input.endedAt, input.subject.projectId, input.subject.worktreeId);
  return Number(result.changes);
}

export function reopenSession(
  database: SqlDatabase,
  sessionId: string,
): PersistedSession | undefined {
  database
    .prepare("UPDATE sessions SET lifecycle = 'open', ended_at = NULL WHERE id = ?")
    .run(sessionId);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | SqliteSessionRow
    | undefined;
  return row === undefined ? undefined : sessionFromRow(row);
}

export function seedSession(
  database: SqlDatabase,
  input: {
    sessionId: string;
    projectId: string;
    worktreeId: string;
    initialTitle: string;
    createdAt: string;
    lastSeenAt: string;
  },
): PersistedSession {
  const title = resolveWorktreeDisplayTitle({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    branch: input.initialTitle,
    canonicalTitles: listCanonicalTitle(database, input),
    sessions: listSessions(database),
  });
  insertMissingWorktreeDisplayTitles(database, [
    {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      title,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  ]);
  const canonical = readWorktreeDisplayTitle(database, input);
  if (canonical === undefined) {
    throw new Error(`Failed to seed worktree display title for ${input.worktreeId}.`);
  }
  synchronizeSessionTitleProjections(database, canonical);

  database
    .prepare(
      `
        INSERT INTO sessions
          (id, project_id, worktree_id, title, created_at, ended_at, last_seen_at, lifecycle)
        VALUES (?, ?, ?, ?, ?, NULL, ?, 'open')
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          worktree_id = excluded.worktree_id,
          title = excluded.title,
          last_seen_at = excluded.last_seen_at,
          lifecycle = CASE
            WHEN sessions.lifecycle = 'ended' THEN 'ended'
            ELSE 'open'
          END
      `,
    )
    .run(
      input.sessionId,
      input.projectId,
      input.worktreeId,
      canonical.title,
      input.createdAt,
      input.lastSeenAt,
    );

  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as
    | SqliteSessionRow
    | undefined;
  if (row === undefined) {
    throw new Error(`Failed to seed session for ${input.sessionId}.`);
  }
  return sessionFromRow(row);
}

export function discardSessionSeed(
  database: SqlDatabase,
  input: {
    sessionId: string;
    removedWorktree?: { projectId: string; worktreeId: string };
  },
): { discardedSessions: number; discardedWorktreeTitles: number } {
  const sessionResult = database.prepare("DELETE FROM sessions WHERE id = ?").run(input.sessionId);
  const discardedWorktreeTitles =
    input.removedWorktree === undefined
      ? 0
      : deleteWorktreeDisplayTitle(database, input.removedWorktree);
  return {
    discardedSessions: Number(sessionResult.changes),
    discardedWorktreeTitles,
  };
}

export function retireRemovedWorktreeSessionState(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string; endedAt: string },
): { endedSessions: number; deletedWorktreeTitles: number } {
  const endedSessions = markSessionsEnded(database, {
    subject: { kind: "worktree", projectId: input.projectId, worktreeId: input.worktreeId },
    endedAt: input.endedAt,
  });
  const deletedWorktreeTitles = deleteWorktreeDisplayTitle(database, input);
  return { endedSessions, deletedWorktreeTitles };
}

function resolveReconcileWorktreeDisplayTitles(
  database: SqlDatabase,
  input: PersistReconcileResultInput,
  observedAt: string,
): PersistedWorktreeDisplayTitle[] {
  if (input.worktreeDisplayTitles !== undefined) return input.worktreeDisplayTitles;

  const canonicalTitles = listWorktreeDisplayTitles(database);
  const sessions = listSessions(database);
  return input.worktrees
    .filter((worktree) => worktree.state === "exists")
    .map((worktree) => {
      const existing = canonicalTitles.find(
        (title) => title.projectId === worktree.projectId && title.worktreeId === worktree.id,
      );
      if (existing !== undefined) return existing;
      return {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        title: resolveWorktreeDisplayTitle({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch: worktree.branch,
          canonicalTitles,
          sessions,
        }),
        createdAt: observedAt,
        updatedAt: observedAt,
      };
    });
}

function listCanonicalTitle(
  database: SqlDatabase,
  input: { projectId: string; worktreeId: string },
): PersistedWorktreeDisplayTitle[] {
  const title = readWorktreeDisplayTitle(database, input);
  return title === undefined ? [] : [title];
}

function rememberWorktreeIdentity(database: SqlDatabase, worktree: WorktreeObservation): void {
  database
    .prepare(
      `
        INSERT INTO worktrees
          (id, project_id, path, provider, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
    )
    .run(worktree.id, worktree.projectId, worktree.path, worktree.provider, worktree.observedAt);
}

function upsertSessions(
  database: SqlDatabase,
  terminalTargets: TerminalTargetObservation[],
  harnessRuns: HarnessRunObservation[],
  worktreeDisplayTitles: readonly PersistedWorktreeDisplayTitle[],
): void {
  // Sessions are reconstructed from two partial truths: terminal bindings identify
  // the workspace, while harness runs supply agent state.
  const titlesByWorktree = new Map(
    worktreeDisplayTitles.map((title) => [
      worktreeTitleKey(title.projectId, title.worktreeId),
      title,
    ]),
  );
  const sessions = new Map<string, PersistedSession>();

  for (const target of terminalTargets) {
    if (
      target.sessionId === undefined ||
      target.projectId === undefined ||
      target.worktreeId === undefined
    ) {
      continue;
    }
    const existing = sessions.get(target.sessionId);
    const activates = terminalCanActivateSession({ target, runs: harnessRuns });
    const session: PersistedSession = {
      id: target.sessionId,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      lifecycle: activates || existing?.lifecycle === "open" ? "open" : "legacy",
      terminalProvider: target.provider,
      state: target.state,
      createdAt: existing?.createdAt ?? target.observedAt,
      lastSeenAt: maxIso(existing?.lastSeenAt, target.observedAt),
    };
    const title = titlesByWorktree.get(worktreeTitleKey(target.projectId, target.worktreeId));
    if (title !== undefined) {
      session.title = title.title;
    } else if (existing?.title !== undefined) {
      session.title = existing.title;
    }
    if (existing?.harness !== undefined) {
      session.harness = existing.harness;
    }
    sessions.set(target.sessionId, session);
  }

  for (const run of harnessRuns) {
    if (
      run.sessionId === undefined ||
      run.projectId === undefined ||
      run.worktreeId === undefined
    ) {
      continue;
    }
    const existing = sessions.get(run.sessionId);
    const activates = harnessRunCanActivateSession({
      run,
      terminals: terminalTargets,
      runs: harnessRuns,
    });
    const session: PersistedSession = {
      id: run.sessionId,
      projectId: run.projectId,
      worktreeId: run.worktreeId,
      lifecycle: activates || existing?.lifecycle === "open" ? "open" : "legacy",
      harness: run.provider,
      state: run.status.value,
      createdAt: existing?.createdAt ?? run.observedAt,
      lastSeenAt: maxIso(existing?.lastSeenAt, run.observedAt),
    };
    const title = titlesByWorktree.get(worktreeTitleKey(run.projectId, run.worktreeId));
    if (title !== undefined) {
      session.title = title.title;
    } else if (existing?.title !== undefined) {
      session.title = existing.title;
    }
    if (existing?.terminalProvider !== undefined) {
      session.terminalProvider = existing.terminalProvider;
    }
    sessions.set(run.sessionId, session);
  }

  for (const session of sessions.values()) {
    database
      .prepare(
        `
          INSERT INTO sessions
            (id, project_id, worktree_id, title, harness, terminal_provider, state, created_at, ended_at, last_seen_at, lifecycle)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            worktree_id = excluded.worktree_id,
            title = COALESCE(excluded.title, sessions.title),
            harness = COALESCE(excluded.harness, sessions.harness),
            terminal_provider = COALESCE(excluded.terminal_provider, sessions.terminal_provider),
            state = excluded.state,
            last_seen_at = excluded.last_seen_at,
            lifecycle = CASE
              WHEN sessions.lifecycle = 'ended' THEN 'ended'
              WHEN sessions.lifecycle = 'open' OR excluded.lifecycle = 'open' THEN 'open'
              ELSE NULL
            END
        `,
      )
      .run(
        session.id,
        session.projectId,
        session.worktreeId,
        session.title ?? null,
        session.harness ?? null,
        session.terminalProvider ?? null,
        session.state ?? null,
        session.createdAt,
        session.lastSeenAt,
        session.lifecycle === "legacy" ? null : session.lifecycle,
      );
  }
}

function worktreeTitleKey(projectId: string, worktreeId: string): string {
  return `${projectId}\u0000${worktreeId}`;
}
