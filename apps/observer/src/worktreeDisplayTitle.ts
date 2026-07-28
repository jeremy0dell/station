import type { PersistedSession, PersistedWorktreeDisplayTitle } from "./persistence/types.js";

export type ResolveWorktreeDisplayTitleInput = {
  projectId: string;
  worktreeId: string;
  branch: string;
  canonicalTitles: readonly PersistedWorktreeDisplayTitle[];
  sessions: readonly PersistedSession[];
};

/**
 * POLICY
 *
 * Resolves one durable display title from worktree authority and deterministic legacy session evidence.
 */
export function resolveWorktreeDisplayTitle(input: ResolveWorktreeDisplayTitleInput): string {
  const canonical = input.canonicalTitles.find(
    (title) => title.projectId === input.projectId && title.worktreeId === input.worktreeId,
  );
  if (canonical !== undefined) {
    return canonical.title;
  }

  const evidence = input.sessions
    .filter(
      (session) =>
        session.projectId === input.projectId &&
        session.worktreeId === input.worktreeId &&
        session.lifecycle !== "ended" &&
        session.title !== undefined &&
        session.title.trim().length > 0,
    )
    .sort(compareSessionTitleEvidence);
  const custom = evidence.find((session) => session.title !== input.branch);
  return custom?.title ?? evidence[0]?.title ?? input.branch;
}

function compareSessionTitleEvidence(left: PersistedSession, right: PersistedSession): number {
  return (
    right.lastSeenAt.localeCompare(left.lastSeenAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}
