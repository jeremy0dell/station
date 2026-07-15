import type {
  ProviderId,
  ProviderProjectConfig,
  RepositoryRemote,
  WorktreeObservation,
} from "@station/contracts";
import { normalizeObservedPath, WorktreeObservationSchema } from "@station/contracts";
import { stableName } from "@station/runtime";
import { WorktrunkProviderError } from "./errors.js";
import {
  applyMetadataToObservation,
  providerNativeMetadataFromWorktrunkItem,
  type WorktrunkMetadata,
} from "./metadata.js";

export type ParseWorktrunkListOptions = {
  project: ProviderProjectConfig;
  providerId?: ProviderId;
  observedAt: string;
};

export type WorktrunkListItem = Record<string, unknown>;

export function parseWorktrunkListJson(
  stdout: string,
  options: ParseWorktrunkListOptions,
): WorktreeObservation[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (cause) {
    throw new WorktrunkProviderError(
      "WORKTRUNK_INVALID_OUTPUT",
      "Worktrunk list output is not valid JSON.",
      { cause },
    );
  }

  return parseWorktrunkListPayload(payload, options);
}

export function parseWorktrunkListPayload(
  payload: unknown,
  options: ParseWorktrunkListOptions,
): WorktreeObservation[] {
  const items = normalizePayload(payload);
  return items
    .filter((item) => hasWorktreePath(item))
    .map((item) => parseWorktrunkListItem(item, options));
}

export function parseWorktrunkListItem(
  item: WorktrunkListItem,
  options: ParseWorktrunkListOptions,
): WorktreeObservation {
  const path = stringField(item, "path") ?? stringField(item, "worktree_path");
  if (path === undefined) {
    throw new WorktrunkProviderError(
      "WORKTRUNK_INVALID_OUTPUT",
      "Worktrunk list output did not include a worktree path.",
    );
  }

  const metadata = providerNativeMetadataFromWorktrunkItem(item);
  const branch = branchFromItem(item);
  const main = recordField(item, "main");
  const ahead = numberField(main, "ahead");
  const behind = numberField(main, "behind");
  const dirty = dirtyFromItem(item);
  const isPrimaryCheckout = booleanField(item, "is_main");
  const remote = repositoryRemoteFromItem(item);
  const headSha = headShaFromItem(item);
  const observationInput: WorktreeObservation = {
    id: metadata?.worktreeId ?? worktreeId(options.project.id, path),
    provider: options.providerId ?? "worktrunk",
    projectId: options.project.id,
    branch,
    path,
    state: stateFromItem(item),
    source: "worktrunk",
    confidence: "high",
    reason: "Worktrunk listed this worktree.",
    observedAt: options.observedAt,
    providerData: {
      worktrunk: safeProviderData(item),
      ...(metadata === undefined ? {} : { metadata }),
    },
  };
  if (isPrimaryCheckout !== undefined) observationInput.isPrimaryCheckout = isPrimaryCheckout;
  if (dirty !== undefined) observationInput.dirty = dirty;
  if (ahead !== undefined) observationInput.ahead = ahead;
  if (behind !== undefined) observationInput.behind = behind;
  if (remote !== undefined) observationInput.remote = remote;
  if (headSha !== undefined) observationInput.headSha = headSha;
  const observation = WorktreeObservationSchema.parse(observationInput);

  return applyMetadataToObservation(observation, metadata);
}

function normalizePayload(payload: unknown): WorktrunkListItem[] {
  // Accept known Worktrunk shapes across versions: a raw array, a wrapper object, or a single item.
  if (Array.isArray(payload)) {
    return payload.map(assertItem);
  }

  const record = asRecord(payload);
  if (record !== undefined) {
    const nested = record.worktrees ?? record.items ?? record.results;
    if (Array.isArray(nested)) {
      return nested.map(assertItem);
    }
    if (hasWorktreePath(record)) {
      return [record];
    }
  }

  throw new WorktrunkProviderError(
    "WORKTRUNK_INVALID_OUTPUT",
    "Worktrunk list output must be an array or object containing worktrees.",
  );
}

function assertItem(value: unknown): WorktrunkListItem {
  const record = asRecord(value);
  if (record === undefined) {
    throw new WorktrunkProviderError(
      "WORKTRUNK_INVALID_OUTPUT",
      "Worktrunk list entries must be JSON objects.",
    );
  }
  return record;
}

function branchFromItem(item: WorktrunkListItem): string {
  const explicit = stringField(item, "branch") ?? stringField(item, "name");
  if (explicit !== undefined) {
    return explicit;
  }

  // Detached worktrees may not expose a branch; prefer a short SHA, then path basename.
  const git = recordField(item, "git");
  const commit = recordField(item, "commit");
  const detached =
    stringField(git, "short_sha") ??
    stringField(git, "shortSha") ??
    stringField(commit, "short_sha") ??
    stringField(commit, "shortSha") ??
    stringField(item, "short_sha") ??
    stringField(item, "shortSha") ??
    stringField(git, "sha")?.slice(0, 12) ??
    stringField(commit, "sha")?.slice(0, 12) ??
    stringField(item, "sha")?.slice(0, 12);

  if (detached !== undefined) {
    return `detached:${detached}`;
  }

  const path = stringField(item, "path") ?? "unknown";
  return `detached:${basename(path)}`;
}

function stateFromItem(item: WorktrunkListItem): WorktreeObservation["state"] {
  const worktree = recordField(item, "worktree");
  const state = (stringField(worktree, "state") ?? stringField(item, "state") ?? "").toLowerCase();
  if (state === "prunable" || state === "missing" || state === "no_worktree") {
    return "missing";
  }
  if (state === "orphaned" || state === "orphan") {
    return "orphaned";
  }
  return "exists";
}

function dirtyFromItem(item: WorktrunkListItem): boolean | undefined {
  const workingTree = recordField(item, "working_tree");
  const dirty =
    booleanField(item, "dirty") ??
    booleanField(recordField(item, "git"), "dirty") ??
    booleanField(workingTree, "dirty") ??
    booleanField(workingTree, "is_dirty") ??
    booleanField(workingTree, "has_changes");
  if (dirty !== undefined) {
    return dirty;
  }

  const worktree = recordField(item, "worktree");
  const changes: number[] = [];
  appendWorktreeChangeCounts(changes, worktree);
  appendWorktreeChangeCounts(changes, workingTree);

  return changes.length === 0 ? undefined : changes.some((value) => value > 0);
}

function appendWorktreeChangeCounts(
  changes: number[],
  worktree: Record<string, unknown> | undefined,
): void {
  appendNumber(changes, numberField(worktree, "staged"));
  appendNumber(changes, numberField(worktree, "modified"));
  appendNumber(changes, numberField(worktree, "untracked"));
  appendNumber(changes, numberField(worktree, "renamed"));
  appendNumber(changes, numberField(worktree, "deleted"));
  const diff = recordField(worktree, "diff");
  appendNumber(changes, numberField(diff, "added"));
  appendNumber(changes, numberField(diff, "deleted"));
}

function appendNumber(values: number[], value: number | undefined): void {
  if (value !== undefined) values.push(value);
}

function repositoryRemoteFromItem(item: WorktrunkListItem): RepositoryRemote | undefined {
  const repo = recordField(item, "repo");
  const host = stringField(repo, "host");
  const owner = stringField(repo, "owner");
  const name = stringField(repo, "name");
  if (host === undefined || owner === undefined || name === undefined) {
    return undefined;
  }
  const url = stringField(repo, "url");
  const remote: RepositoryRemote = { host, owner, repo: name };
  if (url !== undefined) remote.url = url;
  return remote;
}

function headShaFromItem(item: WorktrunkListItem): string | undefined {
  const sha =
    stringField(item, "sha") ??
    stringField(recordField(item, "git"), "sha") ??
    stringField(recordField(item, "commit"), "sha");
  return sha !== undefined && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha) ? sha : undefined;
}

function safeProviderData(item: WorktrunkListItem): Record<string, unknown> {
  // Keep providerData small and schema-neutral instead of storing the full Worktrunk payload.
  const metadata = providerNativeMetadataFromWorktrunkItem(item);
  const workingTreeDiff = safeWorkingTreeDiff(item);
  const kind = stringField(item, "kind");
  const state = stringField(item, "state");
  const isCurrentSnake = booleanField(item, "is_current");
  const isCurrentCamel = booleanField(item, "isCurrent");
  const isMain = booleanField(item, "is_main");
  const isPrevious = booleanField(item, "is_previous");
  const symbols = stringField(item, "symbols");
  const providerData: Record<string, unknown> = {};
  if (kind !== undefined) providerData.kind = kind;
  if (state !== undefined) providerData.state = state;
  if (isCurrentSnake !== undefined) providerData.isCurrent = isCurrentSnake;
  if (isCurrentCamel !== undefined) providerData.isCurrent = isCurrentCamel;
  if (isMain !== undefined) providerData.isMain = isMain;
  if (isPrevious !== undefined) providerData.isPrevious = isPrevious;
  if (symbols !== undefined) providerData.symbols = symbols;
  if (metadata !== undefined) providerData.metadata = safeMetadata(metadata);
  if (workingTreeDiff !== undefined) providerData.workingTreeDiff = workingTreeDiff;
  return providerData;
}

function safeMetadata(metadata: WorktrunkMetadata): WorktrunkMetadata {
  return metadata;
}

function safeWorkingTreeDiff(item: WorktrunkListItem): Record<string, number> | undefined {
  const diff = recordField(recordField(item, "working_tree"), "diff");
  const added = numberField(diff, "added");
  const deleted = numberField(diff, "deleted");
  if (added === undefined && deleted === undefined) {
    return undefined;
  }

  const workingTreeDiff: Record<string, number> = {};
  if (added !== undefined) workingTreeDiff.added = added;
  if (deleted !== undefined) workingTreeDiff.deleted = deleted;
  return workingTreeDiff;
}

function hasWorktreePath(item: unknown): item is WorktrunkListItem {
  const record = asRecord(item);
  return (
    record !== undefined &&
    (typeof record.path === "string" || typeof record.worktree_path === "string")
  );
}

function worktreeId(projectId: string, path: string): string {
  const identityPath = normalizeObservedPath(path);
  const stableDisplayName = pathDisplaySlug(identityPath);
  return stableName({
    prefix: "wt",
    profile: "id",
    display: [projectId, stableDisplayName],
    unique: ["worktree", projectId, identityPath],
    hash: "always",
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

function pathDisplaySlug(path: string): string {
  return basename(path) || "worktree";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(record?.[key]);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function booleanField(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}
