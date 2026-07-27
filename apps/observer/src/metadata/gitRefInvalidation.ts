import { existsSync, type FSWatcher, lstatSync, readFileSync, watch } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { toSafeError } from "../diagnostics/errors.js";
import type { StationLogger } from "../stationLogger.js";
import {
  type LocalGitMetadataWorktree,
  matchesExpectedLocalGitMetadataTarget,
  type ResolveLocalGitMetadataWorktree,
} from "./localGitWorktree.js";
import type { WorktreeMetadataInvalidationSource, WorktreeMetadataTarget } from "./ports.js";

export type CreateLocalGitWorktreeMetadataInvalidationSourceOptions = {
  resolveWorktree: ResolveLocalGitMetadataWorktree;
  requestReconcile(reason: string): void;
  debounceMs?: number;
  logger?: StationLogger;
  watchDirectory?: WatchDirectory;
};

export type GitRefInvalidationTarget = {
  path: string;
};

type DirectoryWatcher = Pick<FSWatcher, "close"> & {
  on?(event: "error", listener: (error: Error) => void): unknown;
};

type WatchDirectory = (
  directory: string,
  listener: (changedFile: string | undefined) => void,
) => DirectoryWatcher;

type WatchedDirectory = {
  path: string;
  watcher: DirectoryWatcher;
};

type ActiveRegistration = {
  target: WorktreeMetadataTarget;
  signature: string;
  active: boolean;
  watchers: Map<string, WatchedDirectory>;
  warnedStartFailures: Set<string>;
};

const defaultDebounceMs = 100;

/**
 * ADAPTER
 *
 * Translates Station worktree identity into local Git ref watches and owns
 * replacement, per-target retry, debounce, failure cleanup, and deterministic shutdown.
 */
export function createLocalGitWorktreeMetadataInvalidationSource(
  options: CreateLocalGitWorktreeMetadataInvalidationSourceOptions,
): WorktreeMetadataInvalidationSource {
  return new LocalGitWorktreeMetadataInvalidationAdapter(options);
}

class LocalGitWorktreeMetadataInvalidationAdapter implements WorktreeMetadataInvalidationSource {
  readonly #debounceMs: number;
  readonly #registrations = new Map<string, ActiveRegistration>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #watchDirectory: WatchDirectory;
  #stopped = false;

  constructor(private readonly options: CreateLocalGitWorktreeMetadataInvalidationSourceOptions) {
    this.#debounceMs = options.debounceMs ?? defaultDebounceMs;
    this.#watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  }

  replaceWatchedWorktrees(targets: readonly WorktreeMetadataTarget[]): Promise<void> {
    if (this.#stopped) return Promise.resolve();

    const desired = new Map(targets.map((target) => [target.worktreeId, target]));
    for (const [worktreeId, registration] of this.#registrations) {
      if (!desired.has(worktreeId)) this.#closeRegistration(registration);
    }

    for (const target of desired.values()) {
      if (this.#stopped) return Promise.resolve();
      this.#replaceTarget(target);
    }
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const registration of [...this.#registrations.values()]) {
      this.#closeRegistration(registration);
    }
    return Promise.resolve();
  }

  #replaceTarget(target: WorktreeMetadataTarget): void {
    const resolution = this.options.resolveWorktree(target);
    if (
      resolution.status !== "resolved" ||
      !matchesExpectedLocalGitMetadataTarget(resolution.worktree, target)
    ) {
      const existing = this.#registrations.get(target.worktreeId);
      if (existing !== undefined) this.#closeRegistration(existing);
      return;
    }

    const { worktree } = resolution;
    const refTargets = gitRefInvalidationTargetsForWorktree(worktree.path, worktree.branch);
    const signature = registrationSignature(worktree, refTargets);
    const existing = this.#registrations.get(target.worktreeId);
    if (existing?.signature === signature && existing.active) {
      this.#armMissingTargets(existing, refTargets);
      return;
    }
    if (existing !== undefined) this.#closeRegistration(existing);
    if (refTargets.length === 0) return;

    this.#armRegistration(target, signature, refTargets);
  }

  #armRegistration(
    target: WorktreeMetadataTarget,
    signature: string,
    refTargets: readonly GitRefInvalidationTarget[],
  ): void {
    const registration: ActiveRegistration = {
      target,
      signature,
      active: true,
      watchers: new Map(),
      warnedStartFailures: new Set(),
    };
    this.#registrations.set(target.worktreeId, registration);
    this.#armMissingTargets(registration, refTargets);
  }

  #armMissingTargets(
    registration: ActiveRegistration,
    refTargets: readonly GitRefInvalidationTarget[],
  ): void {
    for (const refTarget of refTargets) {
      if (!this.#isCurrent(registration) || registration.watchers.has(refTarget.path)) continue;
      const directory = dirname(refTarget.path);
      // Keep healthy sibling watches; the next full-set replacement retries this target.
      if (!existsSync(directory)) continue;
      this.#armTarget(registration, refTarget, directory);
    }
  }

  #armTarget(
    registration: ActiveRegistration,
    refTarget: GitRefInvalidationTarget,
    directory: string,
  ): void {
    let watched: WatchedDirectory | undefined;
    try {
      const fileName = basename(refTarget.path);
      const watcher = this.#watchDirectory(directory, (changedFile) => {
        if (watched === undefined || !this.#isCurrentWatcher(registration, watched)) return;
        if (changedFile !== undefined && changedFile !== fileName) return;
        this.#scheduleReconcile(registration);
      });
      watched = { path: refTarget.path, watcher };
      registration.watchers.set(refTarget.path, watched);
      watcher.on?.("error", (error) => {
        if (watched === undefined || !this.#isCurrentWatcher(registration, watched)) return;
        this.#logFailure("Git metadata watcher failed.", error, registration, refTarget.path);
        this.#closeWatchedDirectory(registration, watched);
      });
      registration.warnedStartFailures.delete(refTarget.path);
    } catch (error) {
      if (watched !== undefined) this.#closeWatchedDirectory(registration, watched);
      if (!registration.warnedStartFailures.has(refTarget.path)) {
        registration.warnedStartFailures.add(refTarget.path);
        this.#logFailure(
          "Git metadata watcher could not start.",
          error,
          registration,
          refTarget.path,
        );
      }
    }
  }

  #scheduleReconcile(registration: ActiveRegistration): void {
    if (!this.#isCurrent(registration)) return;
    const worktreeId = registration.target.worktreeId;
    const existing = this.#timers.get(worktreeId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.#timers.delete(worktreeId);
      if (!this.#isCurrent(registration)) return;
      try {
        this.options.requestReconcile(`metadata:git-ref:${worktreeId}`);
      } catch (error) {
        this.#logFailure("Git metadata watcher reconcile request failed.", error, registration);
      }
    }, this.#debounceMs);
    this.#timers.set(worktreeId, timer);
  }

  #isCurrent(registration: ActiveRegistration): boolean {
    return (
      !this.#stopped &&
      registration.active &&
      this.#registrations.get(registration.target.worktreeId) === registration
    );
  }

  #isCurrentWatcher(registration: ActiveRegistration, watched: WatchedDirectory): boolean {
    return this.#isCurrent(registration) && registration.watchers.get(watched.path) === watched;
  }

  #closeWatchedDirectory(registration: ActiveRegistration, watched: WatchedDirectory): void {
    if (registration.watchers.get(watched.path) === watched) {
      registration.watchers.delete(watched.path);
    }
    try {
      watched.watcher.close();
    } catch (error) {
      this.#logFailure("Git metadata watcher could not close.", error, registration, watched.path);
    }
  }

  #closeRegistration(registration: ActiveRegistration): void {
    registration.active = false;
    const worktreeId = registration.target.worktreeId;
    if (this.#registrations.get(worktreeId) === registration) {
      this.#registrations.delete(worktreeId);
    }
    const timer = this.#timers.get(worktreeId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(worktreeId);
    }

    for (const watched of [...registration.watchers.values()]) {
      this.#closeWatchedDirectory(registration, watched);
    }
  }

  #logFailure(
    message: string,
    error: unknown,
    registration: ActiveRegistration,
    path?: string,
  ): void {
    const safeError = toSafeError(error, {
      tag: "LocalGitMetadataError",
      code: "LOCAL_GIT_REF_WATCH_FAILED",
      message,
    });
    const attributes: Record<string, unknown> = {
      error: safeError,
      projectId: registration.target.projectId,
      worktreeId: registration.target.worktreeId,
    };
    if (path !== undefined) attributes.path = path;
    try {
      void this.options.logger?.warn(message, attributes).catch(() => undefined);
    } catch {
      // Logging is best-effort and must not disrupt watcher cleanup.
    }
  }
}

export function gitRefInvalidationTargetsForWorktree(
  worktreePath: string,
  branch: string,
): GitRefInvalidationTarget[] {
  const dotGit = join(worktreePath, ".git");
  const gitDir = resolveGitDir(dotGit);
  if (gitDir === undefined) {
    return [];
  }

  const targets: GitRefInvalidationTarget[] = [{ path: dotGit }, { path: join(gitDir, "HEAD") }];
  const headRef = readHeadRef(join(gitDir, "HEAD"));
  const commonDir = resolveCommonDir(gitDir);
  const refName = headRef ?? `refs/heads/${branch}`;
  targets.push({ path: join(commonDir, refName) });
  targets.push({ path: join(commonDir, "packed-refs") });
  return uniqueTargets(targets);
}

function registrationSignature(
  worktree: LocalGitMetadataWorktree,
  targets: readonly GitRefInvalidationTarget[],
): string {
  return JSON.stringify({
    worktreeId: worktree.worktreeId,
    projectId: worktree.projectId,
    branch: worktree.branch,
    registrationIdentity: worktree.registrationIdentity,
    path: worktree.path,
    targets: targets.map((target) => target.path),
  });
}

function resolveGitDir(dotGit: string): string | undefined {
  if (!existsSync(dotGit)) {
    return undefined;
  }

  try {
    if (lstatSync(dotGit).isDirectory()) {
      return dotGit;
    }
    const content = readFileSync(dotGit, "utf8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/i);
    const value = match?.[1]?.trim();
    if (value === undefined || value.length === 0) {
      return undefined;
    }
    return isAbsolute(value) ? value : resolve(dirname(dotGit), value);
  } catch {
    return undefined;
  }
}

function readHeadRef(headPath: string): string | undefined {
  try {
    const content = readFileSync(headPath, "utf8").trim();
    const match = content.match(/^ref:\s*(.+)$/);
    const ref = match?.[1]?.trim();
    return ref === undefined || ref.length === 0 ? undefined : ref;
  } catch {
    return undefined;
  }
}

function resolveCommonDir(gitDir: string): string {
  const commonDirPath = join(gitDir, "commondir");
  try {
    const content = readFileSync(commonDirPath, "utf8").trim();
    if (content.length === 0) {
      return gitDir;
    }
    return isAbsolute(content) ? content : resolve(gitDir, content);
  } catch {
    return gitDir;
  }
}

function uniqueTargets(targets: GitRefInvalidationTarget[]): GitRefInvalidationTarget[] {
  const seen = new Set<string>();
  const unique: GitRefInvalidationTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.path)) {
      continue;
    }
    seen.add(target.path);
    unique.push(target);
  }
  return unique;
}

function defaultWatchDirectory(
  directory: string,
  listener: (changedFile: string | undefined) => void,
): DirectoryWatcher {
  return watch(directory, (_event, changedFile) => {
    listener(changedFile === null ? undefined : changedFile.toString());
  });
}
