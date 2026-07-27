import { existsSync, type FSWatcher, lstatSync, readFileSync, watch } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SafeError } from "@station/contracts";
import { toSafeError } from "../diagnostics/errors.js";
import type { StationLogger } from "../stationLogger.js";
import type {
  LocalGitMetadataWorktree,
  ResolveLocalGitMetadataWorktree,
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
  watchers: WatchedDirectory[];
};

const defaultDebounceMs = 100;

/**
 * ADAPTER
 *
 * Translates Station worktree identity into local Git ref watches and owns
 * replacement, debounce, failure cleanup, and deterministic shutdown.
 */
export function createLocalGitWorktreeMetadataInvalidationSource(
  options: CreateLocalGitWorktreeMetadataInvalidationSourceOptions,
): WorktreeMetadataInvalidationSource {
  const debounceMs = options.debounceMs ?? defaultDebounceMs;
  const registrations = new Map<string, ActiveRegistration>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  let stopped = false;

  return {
    replaceWatchedWorktrees: async (targets) => {
      if (stopped) return;

      const desired = new Map(targets.map((target) => [target.worktreeId, target]));
      for (const [worktreeId, registration] of registrations) {
        if (!desired.has(worktreeId)) {
          closeRegistration(registration);
        }
      }

      for (const target of desired.values()) {
        if (stopped) return;
        const worktree = options.resolveWorktree(target);
        if (worktree === undefined || !matchesExpectedTarget(worktree, target)) {
          const existing = registrations.get(target.worktreeId);
          if (existing !== undefined) closeRegistration(existing);
          continue;
        }

        const refTargets = gitRefInvalidationTargetsForWorktree(worktree.path, worktree.branch);
        const signature = registrationSignature(worktree, refTargets);
        const existing = registrations.get(target.worktreeId);
        if (existing?.signature === signature && existing.active) {
          continue;
        }
        if (existing !== undefined) closeRegistration(existing);
        if (refTargets.length === 0) continue;

        armRegistration(target, signature, refTargets);
      }
    },
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const registration of [...registrations.values()]) {
        closeRegistration(registration);
      }
    },
  };

  function armRegistration(
    target: WorktreeMetadataTarget,
    signature: string,
    refTargets: readonly GitRefInvalidationTarget[],
  ): void {
    const registration: ActiveRegistration = {
      target,
      signature,
      active: true,
      watchers: [],
    };
    registrations.set(target.worktreeId, registration);

    try {
      for (const refTarget of refTargets) {
        const directory = dirname(refTarget.path);
        if (!existsSync(directory)) {
          throw localGitWatcherError(
            "LOCAL_GIT_WATCH_DIRECTORY_MISSING",
            "Git metadata watch directory does not exist.",
          );
        }
        const fileName = basename(refTarget.path);
        const watcher = watchDirectory(directory, (changedFile) => {
          if (!isCurrent(registration)) return;
          if (changedFile !== undefined && changedFile !== fileName) return;
          scheduleReconcile(registration);
        });
        registration.watchers.push({ path: refTarget.path, watcher });
        watcher.on?.("error", (error) => {
          if (!isCurrent(registration)) return;
          logFailure("Git metadata watcher failed.", error, registration, refTarget.path);
          closeRegistration(registration);
        });
        if (!isCurrent(registration)) return;
      }
    } catch (error) {
      logFailure("Git metadata watcher could not start.", error, registration);
      closeRegistration(registration);
    }
  }

  function scheduleReconcile(registration: ActiveRegistration): void {
    if (!isCurrent(registration)) return;
    const worktreeId = registration.target.worktreeId;
    const existing = timers.get(worktreeId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(worktreeId);
      if (!isCurrent(registration)) return;
      try {
        options.requestReconcile(`metadata:git-ref:${worktreeId}`);
      } catch (error) {
        logFailure("Git metadata watcher reconcile request failed.", error, registration);
      }
    }, debounceMs);
    timers.set(worktreeId, timer);
  }

  function isCurrent(registration: ActiveRegistration): boolean {
    return (
      !stopped &&
      registration.active &&
      registrations.get(registration.target.worktreeId) === registration
    );
  }

  function closeRegistration(registration: ActiveRegistration): void {
    registration.active = false;
    const worktreeId = registration.target.worktreeId;
    if (registrations.get(worktreeId) === registration) registrations.delete(worktreeId);
    const timer = timers.get(worktreeId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(worktreeId);
    }

    for (const watched of registration.watchers) {
      try {
        watched.watcher.close();
      } catch (error) {
        logFailure("Git metadata watcher could not close.", error, registration, watched.path);
      }
    }
    registration.watchers.length = 0;
  }

  function logFailure(
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
      void options.logger?.warn(message, attributes).catch(() => undefined);
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

function matchesExpectedTarget(
  worktree: LocalGitMetadataWorktree,
  target: WorktreeMetadataTarget,
): boolean {
  return (
    worktree.worktreeId === target.worktreeId &&
    worktree.projectId === target.projectId &&
    worktree.branch === target.branch &&
    worktree.registrationIdentity === target.registrationIdentity
  );
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

function localGitWatcherError(code: string, message: string): SafeError {
  return {
    tag: "LocalGitMetadataError",
    code,
    message,
  };
}

function defaultWatchDirectory(
  directory: string,
  listener: (changedFile: string | undefined) => void,
): DirectoryWatcher {
  return watch(directory, (_event, changedFile) => {
    listener(changedFile === null ? undefined : changedFile.toString());
  });
}
