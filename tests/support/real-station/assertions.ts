import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionView, StationSnapshot, WorktreeRow } from "@station/contracts";

export function findRowByBranch(snapshot: StationSnapshot, branch: string): WorktreeRow {
  const row = snapshot.rows.find((candidate) => candidate.branch === branch);
  if (row === undefined) {
    throw new Error(`Snapshot does not contain branch ${branch}.`);
  }
  return row;
}

export function findRowByWorktreeId(snapshot: StationSnapshot, worktreeId: string): WorktreeRow {
  const row = snapshot.rows.find((candidate) => candidate.id === worktreeId);
  if (row === undefined) {
    throw new Error(`Snapshot does not contain worktree ${worktreeId}.`);
  }
  return row;
}

export function findSessionByTitle(snapshot: StationSnapshot, title: string): SessionView {
  const session = snapshot.sessions.find((candidate) => candidate.title === title);
  if (session === undefined) {
    throw new Error(`Snapshot does not contain session title ${title}.`);
  }
  return session;
}

export function findRowBySessionTitle(snapshot: StationSnapshot, title: string): WorktreeRow {
  const session = findSessionByTitle(snapshot, title);
  return findRowByWorktreeId(snapshot, session.worktreeId);
}

export function assertProviderHealth(snapshot: StationSnapshot, providerId: string): void {
  const health = snapshot.providerHealth[providerId];
  if (health === undefined) {
    throw new Error(`Snapshot does not include provider health for ${providerId}.`);
  }
}

export async function assertDebugBundleContains(
  bundlePath: string,
  fileName: string,
  text: string,
): Promise<void> {
  const filePath = join(bundlePath, fileName);
  await access(filePath);
  const content = await readFile(filePath, "utf8");
  if (!content.includes(text)) {
    throw new Error(`${fileName} in ${bundlePath} does not contain ${text}.`);
  }
}
